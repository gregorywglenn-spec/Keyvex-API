/**
 * MONECO cross-filing inspection (Step 4 Directive A, read-only).
 *
 * The amendment: MONECO Advisors LLC, CIK 0001765690, accession
 * 0001765690-25-000005 (13F-HR/A, declared 466, raw 465, off by 1).
 * additionalInformation is empty, so inspection 2 can't classify
 * additive-vs-restate from intent text.
 *
 * Inspection 3: fetch the ORIGINAL 13F-HR for the same period, compare
 * row counts. Decision tree:
 *   - amendment_declared == original_declared AND amendment_raw < declared
 *     → additive amendment (declared inherits combined scope) → BRANCH (2)
 *   - amendment_declared > original_declared
 *     → amendment declares net-new but doesn't deliver → BRANCH (1)
 *   - amendment_declared < original_declared AND amendment_raw === amendment_declared - 1
 *     → standalone restatement with a manual-count typo → BRANCH (1) restatement
 *   - other shapes → BRANCH (3) ambiguous
 *
 * READ-ONLY. No writes.
 */
import { parse13FXml } from "../src/scrapers/13f.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";

const MONECO_CIK = "0001765690";
const AMENDMENT_ACCESSION = "0001765690-25-000005";

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

function parsePeriod(xml: string): string {
  const m = xml.match(/<periodOfReport>([^<]+)<\/periodOfReport>/i);
  return m && m[1] ? m[1].trim() : "";
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

interface FilingProbe {
  accession: string;
  form: string;
  filingDate: string;
  period: string;
  declared: number | null;
  parserRaw: number;
  independentGrep: number;
  parserMatchesGrep: boolean;
}

async function probeOne(cikRaw: string, accession: string, filingDate: string): Promise<FilingProbe> {
  const urls = await fetchFilingUrls(cikRaw, accession);
  const primaryDocXml = await fetchText(urls.primaryDocUrl);
  const holdingsXml = await fetchText(urls.holdingsUrl);
  const declared = parseInfoTableEntryTotal(primaryDocXml);
  const form = parseSubmissionType(primaryDocXml);
  const period = parsePeriod(primaryDocXml);
  const meta = {
    fundName: cikRaw, fundCik: cikRaw.padStart(10, "0"),
    accession, filingDate, period, url: urls.holdingsUrl,
    infoTableEntryTotal: declared, tableValueTotal: null,
  } as Parameters<typeof parse13FXml>[1];
  const { rawRowCount } = parse13FXml(holdingsXml, meta);
  const independent = namespaceAwareInfoTableCount(holdingsXml);
  return {
    accession, form, filingDate, period,
    declared, parserRaw: rawRowCount, independentGrep: independent,
    parserMatchesGrep: rawRowCount === independent,
  };
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log("Step 4 Directive A — MONECO cross-filing inspection");
  console.log(`  filer:     MONECO Advisors LLC (CIK ${MONECO_CIK})`);
  console.log(`  amendment: ${AMENDMENT_ACCESSION} (13F-HR/A, declared 466 / raw 465)`);
  console.log("============================================================");
  console.log("");

  const cikRaw = MONECO_CIK.replace(/^0+/, "");

  // Probe the amendment to confirm + get its period
  console.log("Step 1: re-probe the amendment to confirm its period");
  const amendment = await probeOne(cikRaw, AMENDMENT_ACCESSION, "");
  console.log(`  amendment form:     ${amendment.form}`);
  console.log(`  amendment period:   ${amendment.period}`);
  console.log(`  amendment declared: ${amendment.declared}`);
  console.log(`  amendment raw:      ${amendment.parserRaw}`);
  console.log(`  amendment indep:    ${amendment.independentGrep}`);
  console.log(`  parser matches grep: ${amendment.parserMatchesGrep}`);
  console.log("");

  if (!amendment.period) {
    console.log("⚠️  Amendment has no periodOfReport — cannot find original.");
    process.exit(1);
  }

  // Find the original 13F-HR (non-amendment) for the same period
  console.log(`Step 2: find original 13F-HR for period ${amendment.period}`);
  const subs = await fetchJson<SubmissionsResponse>(
    `${SEC_DATA}/submissions/CIK${MONECO_CIK}.json`,
  );
  const r = subs.filings?.recent;
  if (!r) {
    console.log("  No submissions feed for filer.");
    process.exit(1);
  }
  console.log(`  filer name: ${subs.name}`);
  const candidateOriginals: Array<{ accession: string; filingDate: string }> = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if (form === "13F-HR" && r.reportDate[i] === amendment.period) {
      candidateOriginals.push({
        accession: r.accessionNumber[i] ?? "",
        filingDate: r.filingDate[i] ?? "",
      });
    }
  }
  console.log(`  candidate originals (13F-HR for period ${amendment.period}): ${candidateOriginals.length}`);
  for (const c of candidateOriginals) {
    console.log(`    ${c.accession}  filed ${c.filingDate}`);
  }
  console.log("");

  if (candidateOriginals.length === 0) {
    console.log("⚠️  NO ORIGINAL 13F-HR found for the period. This is itself unusual:");
    console.log(`    A 13F-HR/A amendment ordinarily amends a prior 13F-HR for the same period.`);
    console.log(`    No matching original means either (a) the amendment is standing in as the`);
    console.log(`    sole filing for this period (no original was filed), OR (b) the original`);
    console.log(`    was filed under a different period that was later restated to ${amendment.period}.`);
    console.log("");
    console.log("CLASSIFICATION: (3) ambiguous — cross-filing comparison impossible without original.");
    console.log("  No additive-vs-restate determination possible read-only.");
    console.log("  Documented as Branch (3); proceed to Directive B (the 13F-HR teeth target is unrelated).");
    return;
  }

  // Probe each candidate original
  console.log("Step 3: probe original(s)");
  for (const c of candidateOriginals) {
    console.log(`\n  ── ${c.accession} (filed ${c.filingDate}) ──`);
    try {
      const original = await probeOne(cikRaw, c.accession, c.filingDate);
      console.log(`    form:     ${original.form}`);
      console.log(`    period:   ${original.period}`);
      console.log(`    declared: ${original.declared}`);
      console.log(`    raw:      ${original.parserRaw}`);
      console.log(`    indep:    ${original.independentGrep}`);

      // Classification logic
      console.log("");
      console.log("============================================================");
      console.log("CLASSIFICATION DECISION");
      console.log("============================================================");
      console.log(`  Amendment: declared ${amendment.declared}  raw ${amendment.parserRaw}`);
      console.log(`  Original:  declared ${original.declared}  raw ${original.parserRaw}`);
      console.log("");

      const ampDecl = amendment.declared ?? 0;
      const origDecl = original.declared ?? 0;
      const ampRaw = amendment.parserRaw;
      const origRaw = original.parserRaw;

      if (ampDecl === origDecl && ampRaw < ampDecl) {
        console.log(`  PATTERN: amendment_declared (${ampDecl}) === original_declared (${origDecl})`);
        console.log(`           amendment_raw (${ampRaw}) < declared.`);
        console.log("");
        console.log(`  → If the amendment delivers FEWER rows than the original — and amendment_declared`);
        console.log(`    matches original_declared — it might be the additive-scope pattern (declared`);
        console.log(`    inherits combined scope; amendment file is partial). BUT this could also be`);
        console.log(`    a near-identical restatement with a 1-row drop. Cannot distinguish from counts`);
        console.log(`    alone.`);
        console.log(``);
        console.log(`  Compare amendment_raw (${ampRaw}) to original_raw (${origRaw}):`);
        if (ampRaw < origRaw) {
          console.log(`    amendment_raw < original_raw → amendment delivers FEWER rows than original.`);
          console.log(`    Likely a delta/additive amendment.`);
          console.log("");
          console.log(`  CLASSIFICATION: (2) amendment-FP-class candidate.`);
          console.log(`    STOP. ESCALATE. This is the false-positive class the protocol`);
          console.log(`    was built to detect.`);
        } else if (ampRaw === origRaw - 1) {
          console.log(`    amendment_raw === original_raw - 1.`);
          console.log(`    Amendment matches original except 1 row was removed.`);
          console.log(`    Filer's declared total didn't update (still 466). MANUAL-count typo on`);
          console.log(`    summary page during amendment.`);
          console.log("");
          console.log(`  CLASSIFICATION: (1) genuine-shortfall (restatement with count-typo).`);
          console.log(`    Not Branch (2); the amendment IS standalone, just has an off-by-1 typo on its`);
          console.log(`    declared summary.`);
        } else if (ampRaw > origRaw) {
          console.log(`    amendment_raw > original_raw → amendment delivers MORE rows than original`);
          console.log(`    but its declared total didn't bump. Manual count not updated.`);
          console.log("");
          console.log(`  CLASSIFICATION: (1) genuine-shortfall (with stale declared)`);
        } else {
          console.log(`    amendment_raw === original_raw — but declared > raw on amendment.`);
          console.log(`    Both have the same content; amendment's count is wrong.`);
          console.log(`    CLASSIFICATION: (1) genuine-shortfall (typo on amendment summary)`);
        }
      } else if (ampDecl > origDecl) {
        console.log(`  PATTERN: amendment_declared (${ampDecl}) > original_declared (${origDecl})`);
        console.log(`           amendment delivers ${ampRaw} but declares more than original did.`);
        console.log("");
        console.log(`  CLASSIFICATION: (1) genuine-shortfall.`);
        console.log(`    Amendment declares net-new content (declared > original_declared) but`);
        console.log(`    doesn't actually deliver enough rows to match its declared count.`);
      } else if (ampDecl < origDecl) {
        console.log(`  PATTERN: amendment_declared (${ampDecl}) < original_declared (${origDecl})`);
        console.log("");
        console.log(`  → Amendment declares fewer rows than original (possible restatement that`);
        console.log(`    removes positions). amendment_raw=${ampRaw} vs amendment_declared=${ampDecl}.`);
        console.log(`    raw < declared by ${ampDecl - ampRaw} → small typo.`);
        console.log("");
        console.log(`  CLASSIFICATION: (1) genuine-shortfall (restatement with count-typo).`);
      } else {
        console.log(`  PATTERN: unhandled combination — declared/raw/original_declared/original_raw =`);
        console.log(`           ${ampDecl}/${ampRaw}/${origDecl}/${origRaw}`);
        console.log("");
        console.log(`  CLASSIFICATION: (3) ambiguous — needs deeper read.`);
      }
    } catch (e) {
      console.log(`    ERROR: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
