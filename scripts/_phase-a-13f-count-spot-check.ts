/**
 * Phase A acceptance #2: 13F count-spot-check on 10 historical filings.
 *
 * Picks 10 random 13F accessions, fetches the holdings XML + primary_doc.xml
 * directly from SEC EDGAR, parses both, and reports:
 *   - parsed-row count (post-options-filter, equity-only)
 *   - SEC declared infoTableEntryTotal
 *   - the verification_status the loader WOULD stamp for each
 *
 * This is defense-in-depth confirmation that the count check is sound on
 * real historical data — independent of what's in our Firestore.
 *
 * READ-ONLY. No writes. Polite SEC rate limit (300ms between requests).
 */
import { XMLParser } from "fast-xml-parser";
import { getLiveDb } from "../src/firestore.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const RATE_MS = 300;

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  await delay(RATE_MS);
  return res.text();
}

function parseInfoTableEntryTotal(primaryDocXml: string): number | null {
  // VERIFIED 2026-05-24 against live primary_doc.xml: the canonical SEC
  // schema element is `tableEntryTotal` (in <summaryPage>), NOT
  // `infoTableEntryTotal` as the original Phase A spec assumed. Accept
  // both spellings to be defensive.
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?(?:info)?tableEntryTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface IndexFile {
  name: string;
  type?: string;
}

interface IndexResponse {
  directory?: {
    item?: IndexFile[];
  };
}

async function fetchAccessionFiles(
  cikRaw: string,
  accession: string,
): Promise<{ holdingsUrl: string; primaryDocUrl: string | null }> {
  const accNoSlash = accession.replace(/-/g, "");
  const indexUrl = `${SEC}/Archives/edgar/data/${cikRaw}/${accNoSlash}/index.json`;
  const indexRes = await fetch(indexUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!indexRes.ok) throw new Error(`Index fetch HTTP ${indexRes.status}`);
  const index = (await indexRes.json()) as IndexResponse;
  await delay(RATE_MS);
  const items = index.directory?.item ?? [];
  const xmlFiles = items.filter((f) => f.name.endsWith(".xml"));
  const holdingsFile =
    xmlFiles.find((f) => f.name.toLowerCase().includes("infotable")) ??
    xmlFiles.find((f) => !f.name.toLowerCase().includes("primary_doc"));
  if (!holdingsFile) throw new Error(`No holdings XML in ${accession}`);
  const primaryDocFile = xmlFiles.find((f) =>
    f.name.toLowerCase().includes("primary_doc"),
  );
  return {
    holdingsUrl: `${SEC}/Archives/edgar/data/${cikRaw}/${accNoSlash}/${holdingsFile.name}`,
    primaryDocUrl: primaryDocFile
      ? `${SEC}/Archives/edgar/data/${cikRaw}/${accNoSlash}/${primaryDocFile.name}`
      : null,
  };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function countEquityRows(holdingsXml: string): number {
  // Parse and count rows where putCall is NOT "Put"/"Call" (equity-only,
  // matching 13f.ts's filter). The schema is informationTable.infoTable.
  const parsed = xml.parse(holdingsXml);
  const table =
    parsed?.informationTable?.infoTable ?? parsed?.["ns1:informationTable"]?.["ns1:infoTable"];
  if (!table) return 0;
  const rows = Array.isArray(table) ? table : [table];
  return rows.filter((r) => {
    const putCall = r?.putCall ?? r?.["ns1:putCall"];
    if (!putCall) return true;
    const v = String(putCall).toLowerCase();
    return v !== "put" && v !== "call";
  }).length;
}

async function main() {
  const db = await getLiveDb();
  // Pull 10 random distinct accessions from our institutional_holdings
  // collection. Sample by ordering by a stable field (filing_date) and
  // stepping through to get a spread across time.
  const snap = await db
    .collection("institutional_holdings")
    .select("accession_number", "fund_cik", "fund_name", "quarter")
    .orderBy("filing_date", "desc")
    .limit(2000)
    .get();

  // Dedupe to distinct accessions, then take 10 evenly-spaced
  const seen = new Set<string>();
  const all: { accession: string; cik: string; fund: string; quarter: string }[] = [];
  for (const d of snap.docs) {
    const data = d.data() as {
      accession_number?: string;
      fund_cik?: string;
      fund_name?: string;
      quarter?: string;
    };
    if (!data.accession_number || !data.fund_cik) continue;
    if (seen.has(data.accession_number)) continue;
    seen.add(data.accession_number);
    all.push({
      accession: data.accession_number,
      cik: data.fund_cik,
      fund: data.fund_name ?? "?",
      quarter: data.quarter ?? "?",
    });
  }
  if (all.length === 0) {
    console.log("No 13F accessions in Firestore to sample. Aborting.");
    process.exit(1);
  }

  const stride = Math.max(1, Math.floor(all.length / 10));
  const sample = [];
  for (let i = 0; i < 10 && i * stride < all.length; i++) {
    sample.push(all[i * stride]!);
  }

  console.log("=================================================================");
  console.log("Phase A — 13F count spot-check on 10 historical filings");
  console.log("=================================================================\n");
  console.log(`Sample drawn from ${all.length} distinct accessions in DB.\n`);

  const results: Array<{
    accession: string;
    fund: string;
    quarter: string;
    parsedRows: number | null;
    declared: number | null;
    status: "VERIFIED" | "INSUFFICIENT_DATA" | "ERROR";
    error?: string;
  }> = [];

  for (const item of sample) {
    process.stdout.write(`  ${item.accession.padEnd(24)} ${item.fund.slice(0, 30).padEnd(30)} ${item.quarter}  ... `);
    try {
      const cikRaw = String(parseInt(item.cik, 10)); // strip leading zeros
      const { holdingsUrl, primaryDocUrl } = await fetchAccessionFiles(
        cikRaw,
        item.accession,
      );

      const holdingsXml = await fetchText(holdingsUrl);
      const parsedRows = countEquityRows(holdingsXml);

      let declared: number | null = null;
      if (primaryDocUrl) {
        const primaryDocXml = await fetchText(primaryDocUrl);
        declared = parseInfoTableEntryTotal(primaryDocXml);
      }

      // Per the loader logic in 13f.ts: VERIFIED iff parsedRows === declared
      // (and declared !== null). No-count case → INSUFFICIENT_DATA.
      // For the spot check, we use >= rather than == since options-bearing
      // filings will have parsed < declared (we drop options); per the §1
      // comment in 13f.ts, when uncertain → INSUFFICIENT_DATA.
      let status: "VERIFIED" | "INSUFFICIENT_DATA";
      if (declared === null) status = "INSUFFICIENT_DATA";
      else if (parsedRows === declared) status = "VERIFIED";
      else status = "INSUFFICIENT_DATA";

      results.push({
        accession: item.accession,
        fund: item.fund,
        quarter: item.quarter,
        parsedRows,
        declared,
        status,
      });
      console.log(`parsed=${parsedRows} declared=${declared ?? "(none)"} → ${status}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      results.push({
        accession: item.accession,
        fund: item.fund,
        quarter: item.quarter,
        parsedRows: null,
        declared: null,
        status: "ERROR",
        error: msg,
      });
      console.log(`ERROR: ${msg.slice(0, 60)}`);
    }
  }

  console.log("\n=================================================================");
  console.log("RESULTS");
  console.log("=================================================================\n");
  console.log(
    `accession                  | fund                           | quarter     | parsed | declared | status`,
  );
  console.log(
    `---------------------------|--------------------------------|-------------|--------|----------|--------------------`,
  );
  for (const r of results) {
    console.log(
      `${r.accession.padEnd(26)} | ${r.fund.slice(0, 30).padEnd(30)} | ${r.quarter.padEnd(11)} | ${String(r.parsedRows ?? "-").padStart(6)} | ${String(r.declared ?? "-").padStart(8)} | ${r.status}`,
    );
  }

  const verifiedCount = results.filter((r) => r.status === "VERIFIED").length;
  const insufficientCount = results.filter((r) => r.status === "INSUFFICIENT_DATA").length;
  const errorCount = results.filter((r) => r.status === "ERROR").length;

  console.log(`\n  VERIFIED:           ${verifiedCount}`);
  console.log(`  INSUFFICIENT_DATA:  ${insufficientCount}`);
  console.log(`  ERROR:              ${errorCount}`);
  console.log(
    `\nNote: INSUFFICIENT_DATA on a filing with options is expected — the loader's`,
  );
  console.log(
    `parser drops options rows; the SEC count includes them. The check correctly`,
  );
  console.log(
    `tags such filings as not-fully-verified (better than confidently wrong).`,
  );
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
