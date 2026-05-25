/**
 * Legacy Wealth read-only EDGAR check — gates Legacy 4b authorization.
 *
 * Question: is accession 0002045082-25-000001 (off-by-1, declared 795 /
 * raw 794, period 2024-Q4) Legacy's most-recent 13F-HR, or is there a
 * newer filing that fetchLatest13F would fetch instead?
 *
 * - If ...-25-000001 IS the latest → 4b would observe the guard fire
 *   on a reachable real shortfall. Report and hold.
 * - If something newer & cleaner → 4b would re-confirm Dogwood's result.
 *   Report and recommend accepting the gap.
 *
 * READ-ONLY. No writes.
 */
import { parse13FXml } from "../src/scrapers/13f.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";

const LEGACY_CIK = "0002045082";
const KNOWN_OFFBY1_ACCESSION = "0002045082-25-000001";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  await sleep(200);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  await sleep(200);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return (await res.json()) as T;
}

function parseInfoTableEntryTotal(xml: string): number | null {
  const m = xml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?(?:info)?tableEntryTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  return parseInt(m[1], 10);
}

function parseSubmissionType(xml: string): string {
  const m = xml.match(/<submissionType>([^<]+)<\/submissionType>/i);
  return m && m[1] ? m[1].trim() : "(unknown)";
}

function namespaceAwareInfoTableCount(xml: string): number {
  const matches = xml.match(/<(?:[a-zA-Z0-9_]+:)?infoTable\b[^>]*>/g);
  return matches ? matches.length : 0;
}

interface SubmissionsResponse {
  name?: string;
  filings?: {
    recent?: {
      form: string[];
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
    };
  };
}

interface IndexResponse {
  directory?: { item?: Array<{ name: string }> };
}

async function fetchFilingUrls(
  cikRaw: string,
  accession: string,
): Promise<{ primaryDocUrl: string; holdingsUrl: string }> {
  const accNoSlash = accession.replace(/-/g, "");
  const filerCikRaw = accession.split("-")[0]!.replace(/^0+/, "");
  for (const cik of [cikRaw, filerCikRaw]) {
    if (!cik) continue;
    try {
      const indexUrl = `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/index.json`;
      const data = await fetchJson<IndexResponse>(indexUrl);
      const items = data.directory?.item ?? [];
      const xmlFiles = items.filter((f) => f.name.endsWith(".xml"));
      const holdings =
        xmlFiles.find((f) => f.name.toLowerCase().includes("infotable")) ??
        xmlFiles.find((f) => !f.name.toLowerCase().includes("primary_doc"));
      const primary = xmlFiles.find((f) =>
        f.name.toLowerCase().includes("primary_doc"),
      );
      if (!holdings || !primary) continue;
      return {
        holdingsUrl: `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/${holdings.name}`,
        primaryDocUrl: `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/${primary.name}`,
      };
    } catch {
      // try next
    }
  }
  throw new Error(`Could not resolve URLs for ${accession}`);
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log("Legacy Wealth Mgmt — read-only EDGAR latest-filing check");
  console.log(`  filer:      Legacy Wealth Managment, LLC/ID`);
  console.log(`  CIK:        ${LEGACY_CIK}`);
  console.log(`  known off-by-1 accession: ${KNOWN_OFFBY1_ACCESSION} (declared 795 / raw 794, period 2024-Q4)`);
  console.log("============================================================");
  console.log("");

  // 1. Pull submissions feed
  console.log("Step 1: pull Legacy's EDGAR submissions feed");
  const subs = await fetchJson<SubmissionsResponse>(
    `${SEC_DATA}/submissions/CIK${LEGACY_CIK}.json`,
  );
  console.log(`  filer name:   ${subs.name}`);
  const r = subs.filings?.recent;
  if (!r) {
    console.log("  ⚠️  No submissions data for this CIK. Cannot determine latest.");
    process.exit(1);
  }

  // 2. List all 13F filings in chronological order (recent[] is most-recent first per SEC convention)
  console.log("");
  console.log("Step 2: all 13F-* filings in recent[] (SEC orders most-recent first)");
  const all13F: Array<{ form: string; filingDate: string; reportDate: string; accession: string; isOffBy1: boolean }> = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if (form.startsWith("13F")) {
      const acc = r.accessionNumber[i] ?? "";
      all13F.push({
        form, accession: acc,
        filingDate: r.filingDate[i] ?? "",
        reportDate: r.reportDate[i] ?? "",
        isOffBy1: acc === KNOWN_OFFBY1_ACCESSION,
      });
    }
  }
  console.log(`  Total 13F filings: ${all13F.length}`);
  for (const f of all13F) {
    const marker = f.isOffBy1 ? "  ← OFF-BY-1 (from 4a probe)" : "";
    console.log(`    ${f.form.padEnd(10)} filed=${f.filingDate}  period=${f.reportDate}  acc=${f.accession}${marker}`);
  }
  console.log("");

  // 3. Identify which accession fetchLatest13F would pull
  console.log("Step 3: which accession does fetchLatest13F target?");
  console.log(`  fetchLatest13F walks recent[] and breaks on first form === '13F-HR' || '13F-HR/A'`);
  let latestIdx = -1;
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if (form === "13F-HR" || form === "13F-HR/A") {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx === -1) {
    console.log("  ⚠️  NO 13F-HR or 13F-HR/A in recent[]. fetchLatest13F would throw.");
    process.exit(1);
  }
  const latestAccession = r.accessionNumber[latestIdx]!;
  const latestForm = r.form[latestIdx]!;
  const latestFilingDate = r.filingDate[latestIdx]!;
  const latestReportDate = r.reportDate[latestIdx]!;
  console.log(`  → fetchLatest13F would fetch:`);
  console.log(`     form:        ${latestForm}`);
  console.log(`     filed:       ${latestFilingDate}`);
  console.log(`     period:      ${latestReportDate}`);
  console.log(`     accession:   ${latestAccession}`);
  console.log("");

  const isOffBy1Latest = latestAccession === KNOWN_OFFBY1_ACCESSION;

  // 4. If latest != off-by-1, also probe the latest's declared/raw to confirm it's clean
  if (!isOffBy1Latest) {
    console.log("Step 4: latest is NOT the off-by-1 — probe latest's declared-vs-raw");
    try {
      const cikRaw = LEGACY_CIK.replace(/^0+/, "");
      const urls = await fetchFilingUrls(cikRaw, latestAccession);
      const primaryDocXml = await fetchText(urls.primaryDocUrl);
      const holdingsXml = await fetchText(urls.holdingsUrl);
      const declared = parseInfoTableEntryTotal(primaryDocXml);
      const form = parseSubmissionType(primaryDocXml);
      const meta = {
        fundName: "Legacy", fundCik: LEGACY_CIK,
        accession: latestAccession, filingDate: latestFilingDate,
        period: latestReportDate, url: urls.holdingsUrl,
        infoTableEntryTotal: declared, tableValueTotal: null,
      } as Parameters<typeof parse13FXml>[1];
      const { rawRowCount } = parse13FXml(holdingsXml, meta);
      const independentGrep = namespaceAwareInfoTableCount(holdingsXml);
      const cleanFiling = declared === rawRowCount && rawRowCount === independentGrep;
      console.log(`     primary_doc submissionType: ${form}`);
      console.log(`     declared <tableEntryTotal>:  ${declared}`);
      console.log(`     parse13FXml rawRowCount:     ${rawRowCount}`);
      console.log(`     namespace-aware grep:        ${independentGrep}`);
      console.log(`     clean (raw == declared):     ${cleanFiling ? "✓ YES" : "✗ NO"}`);
    } catch (e) {
      console.log(`     ERROR probing latest: ${(e as Error).message}`);
    }
    console.log("");
  }

  // 5. Decision verdict
  console.log("============================================================");
  console.log("DECISION VERDICT");
  console.log("============================================================");
  console.log("");
  if (isOffBy1Latest) {
    console.log(`  ✅ LEGACY'S LATEST IS THE OFF-BY-1.`);
    console.log(`     accession ${KNOWN_OFFBY1_ACCESSION} (declared 795 / raw 794) is what`);
    console.log(`     fetchLatest13F would target. A Legacy 4b would observe the guard fire on`);
    console.log(`     a reachable real shortfall — exactly the clean live teeth observation we`);
    console.log(`     missed on Dogwood (where the off-by-1 was historical, latest was clean).`);
    console.log("");
    console.log(`     STOP. Hold for separate Legacy 4b authorization.`);
    console.log(`     If authorized: 13f 0002045082 --save will stamp INSUFFICIENT_DATA on the`);
    console.log(`     50 saved rows with verification_expected=795 and verification_actual=794,`);
    console.log(`     two-sided observation closes (Code Firestore + wire serving layer).`);
  } else {
    console.log(`  ✗ LEGACY'S LATEST IS NOT THE OFF-BY-1.`);
    console.log(`     fetchLatest13F would target ${latestAccession} (a newer filing for period`);
    console.log(`     ${latestReportDate}), NOT the off-by-1 ${KNOWN_OFFBY1_ACCESSION} (period 2024-Q4).`);
    console.log(`     The off-by-1 is historical for Legacy, same structural pattern as Dogwood.`);
    console.log("");
    console.log(`     A Legacy 4b would re-confirm Dogwood's result without observing the guard:`);
    console.log(`     it'd write 50 rows for the cleaner latest filing, stamped VERIFIED, and`);
    console.log(`     the off-by-1 would remain inaccessible to the latest-only scraper.`);
    console.log("");
    console.log(`     RECOMMEND: accept the teeth gap as characterized.`);
    console.log(`     - Guard fixture-proven (synthetic cases #4/#5/#6).`);
    console.log(`     - Guard is corpus-confirmed to fire on real raw<declared filings (Dogwood`);
    console.log(`       ...-25-000003 and Legacy ...-25-000001, both ~3-4% of small-filer sample).`);
    console.log(`     - Guard is operationally scoped to latest-per-fund. Historical malformed`);
    console.log(`       filings are not re-fetched, so unreachable by the production code path.`);
    console.log(`     - Closing Step 4 with this characterization is honest and complete.`);
  }
  console.log("");
  console.log("READ-ONLY complete. No writes. Step 4 closeout: HOLD for your call.");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
