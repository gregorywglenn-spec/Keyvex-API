/**
 * Step 4a teeth probe — read-only EDGAR search for a genuine raw < declared
 * 13F filing. Four-inspection classification on any candidate. 15-min hard
 * time box.
 *
 * Highest-probability targets first (per Greg's directive):
 *   - 6 ancient-period accessions already surfaced by the 16:00Z FTS sweep
 *     (especially NEW GENERATION ADVISORS, which pre-fix stamped
 *     INSUFFICIENT_DATA — could be a real shortfall vs aggregation-class
 *     artifact)
 *   - If time remains: ~50 recent 13F-HR/A amendments via EDGAR FTS
 *
 * READ-ONLY. NO Firestore writes. NO --save. 4b is a separate gate.
 *
 * Branch outcomes per Greg's directive:
 *   (1) Genuine shortfall: original 13F-HR with declared > raw, independent
 *       grep confirms → valid 4b target. STOP, report.
 *   (2) B+ amendment false-positive class: 13F-HR/A additive amendment
 *       where declared inherits combined scope, file delivers delta only.
 *       STOP and ESCALATE — this is a foundation finding, outranks teeth.
 *   parser-bug: independent grep ≠ parse13FXml rawRowCount → parser issue,
 *       not a teeth observation. STOP, report.
 *   (3) Ambiguous: document, don't write.
 *   None found: calibrated negative report.
 */
import { parse13FXml } from "../src/scrapers/13f.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";
const TIME_BOX_MS = 15 * 60 * 1000; // 15 min hard cap

const PRIMARY_TARGETS = [
  { name: "NEW GENERATION ADVISORS, LLC", cik: "0001107211", period: "2020-09-30" },
  { name: "Hermes Investment Management Ltd", cik: "0001013143", period: "2018-06-30" },
  { name: "Tekla Capital Management LLC", cik: "0001300336", period: "2023-06-30" },
  { name: "Lane Five Capital Management, LP", cik: "0001410352", period: "2014-06-30" },
  { name: "Trafelet Capital Management, L.P.", cik: "0001387672", period: "2019-03-31" },
  { name: "GARCIA HAMILTON & ASSOCIATES LP/DE", cik: "0000887813", period: "2017-12-31" },
];

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

function parseInfoTableEntryTotal(primaryDocXml: string): number | null {
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?(?:info)?tableEntryTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseSubmissionType(primaryDocXml: string): string | null {
  const m = primaryDocXml.match(/<submissionType>([^<]+)<\/submissionType>/i);
  return m && m[1] ? m[1].trim() : null;
}

function parseReportType(primaryDocXml: string): string | null {
  const m = primaryDocXml.match(/<reportType>([^<]+)<\/reportType>/i);
  return m && m[1] ? m[1].trim() : null;
}

function parseAdditionalInformation(primaryDocXml: string): string {
  const m = primaryDocXml.match(
    /<additionalInformation>([\s\S]*?)<\/additionalInformation>/i,
  );
  return m && m[1] ? m[1].trim() : "";
}

function parseFileNumber(primaryDocXml: string): string | null {
  const m = primaryDocXml.match(
    /<form13FFileNumber>([^<]+)<\/form13FFileNumber>/i,
  );
  return m && m[1] ? m[1].trim() : null;
}

/** Independent count of <infoTable> opening tags. */
function independentInfoTableCount(holdingsXml: string): number {
  const matches = holdingsXml.match(/<infoTable\b[^>]*>/g);
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

async function findAccessionsForPeriod(
  cik: string,
  period: string,
): Promise<Array<{ form: string; filingDate: string; accession: string }>> {
  const url = `${SEC_DATA}/submissions/CIK${cik}.json`;
  const data = await fetchJson<SubmissionsResponse>(url);
  const r = data.filings?.recent;
  if (!r) return [];
  const matches: Array<{ form: string; filingDate: string; accession: string }> = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if ((form === "13F-HR" || form === "13F-HR/A") && r.reportDate[i] === period) {
      matches.push({
        form,
        filingDate: r.filingDate[i] ?? "",
        accession: r.accessionNumber[i] ?? "",
      });
    }
  }
  return matches;
}

async function fetchFilingUrls(
  cikRaw: string,
  accession: string,
): Promise<{ primaryDocUrl: string; holdingsUrl: string } | null> {
  const accNoSlash = accession.replace(/-/g, "");
  // Try fund CIK first, then accession filer prefix
  const filerCikRaw = accession.split("-")[0]!.replace(/^0+/, "");
  for (const cik of [cikRaw, filerCikRaw]) {
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
  return null;
}

interface ProbeResult {
  alias: string;
  cik: string;
  accession: string;
  filingDate: string;
  reportDate: string;
  formType: string;
  declared: number | null;
  rawRowCount: number;
  independentCount: number;
  parserMatchesIndependent: boolean;
  reportType: string;
  additionalInfoSnippet: string;
  mismatch: boolean;
  classification: "(1) genuine-shortfall" | "(2) amendment-FP-class" | "(3) ambiguous" | "parser-bug" | "no-mismatch" | "error";
  classificationDetails: string;
}

async function probeFiling(
  alias: string,
  cik: string,
  cikRaw: string,
  accession: string,
  filingDate: string,
  reportDate: string,
): Promise<ProbeResult> {
  try {
    const urls = await fetchFilingUrls(cikRaw, accession);
    if (!urls) {
      return {
        alias, cik, accession, filingDate, reportDate,
        formType: "(could not resolve)", declared: null, rawRowCount: -1,
        independentCount: -1, parserMatchesIndependent: false,
        reportType: "", additionalInfoSnippet: "",
        mismatch: false, classification: "error",
        classificationDetails: "Could not resolve filing URLs",
      };
    }
    const primaryDocXml = await fetchText(urls.primaryDocUrl);
    const holdingsXml = await fetchText(urls.holdingsUrl);

    const declared = parseInfoTableEntryTotal(primaryDocXml);
    const formType = parseSubmissionType(primaryDocXml) ?? "(unknown)";
    const reportType = parseReportType(primaryDocXml) ?? "";
    const addlInfo = parseAdditionalInformation(primaryDocXml);
    const addlSnippet = addlInfo.length > 300 ? addlInfo.slice(0, 300) + "..." : addlInfo;

    const meta = {
      fundName: alias,
      fundCik: cik,
      accession,
      filingDate,
      period: reportDate,
      url: urls.holdingsUrl,
      infoTableEntryTotal: declared,
      tableValueTotal: null,
    } as Parameters<typeof parse13FXml>[1];
    const { rawRowCount } = parse13FXml(holdingsXml, meta);
    const independent = independentInfoTableCount(holdingsXml);
    const parserMatches = rawRowCount === independent;

    const mismatch = declared !== null && rawRowCount < declared;

    let classification: ProbeResult["classification"];
    let details = "";

    if (!mismatch) {
      classification = "no-mismatch";
      details = `raw ${rawRowCount} === declared ${declared}`;
    } else {
      // Inspection 4: parser sanity
      if (!parserMatches) {
        classification = "parser-bug";
        details = `parse13FXml rawRowCount=${rawRowCount} but independent <infoTable> count=${independent}. Parser-side issue, not a filing-side teeth observation.`;
      } else if (formType === "13F-HR") {
        // Inspection 1: original form → genuine shortfall
        classification = "(1) genuine-shortfall";
        details = `Original 13F-HR with declared ${declared} > raw ${rawRowCount}, independent grep confirms ${independent} infoTable elements. Filer over-declared.`;
      } else if (formType.startsWith("13F-HR/A")) {
        // Inspection 2: amendment intent
        const additive =
          /\b(adds?|additional|amend(s|ing)? to add|supplement|append)\b/i.test(addlInfo) &&
          !/\b(correct|restate|replace)\b/i.test(addlInfo);
        const restate =
          /\b(correct|restate|replace|amend(s|ing)? to (correct|restate))\b/i.test(addlInfo);
        if (additive) {
          classification = "(2) amendment-FP-class";
          details = `13F-HR/A with additive language ("${additive}"). Declared ${declared} may cover combined original+amendment scope; file delivers delta=${rawRowCount}. B+ amendment false-positive class.`;
        } else if (restate) {
          // Restatement: mismatch is real on amendment scope
          classification = "(1) genuine-shortfall";
          details = `13F-HR/A restatement. Declared ${declared} > raw ${rawRowCount}; amendment is meant to stand alone, so mismatch is real.`;
        } else {
          classification = "(3) ambiguous";
          details = `13F-HR/A with no clear amendment-intent language. Cross-filing comparison needed (inspection 3).`;
        }
      } else {
        classification = "(3) ambiguous";
        details = `Unrecognized form type "${formType}". Read more carefully before classifying.`;
      }
    }

    return {
      alias, cik, accession, filingDate, reportDate,
      formType, declared, rawRowCount,
      independentCount: independent, parserMatchesIndependent: parserMatches,
      reportType, additionalInfoSnippet: addlSnippet,
      mismatch, classification, classificationDetails: details,
    };
  } catch (e) {
    return {
      alias, cik, accession, filingDate, reportDate,
      formType: "(error)", declared: null, rawRowCount: -1,
      independentCount: -1, parserMatchesIndependent: false,
      reportType: "", additionalInfoSnippet: "",
      mismatch: false, classification: "error",
      classificationDetails: (e as Error).message,
    };
  }
}

interface FtsHit {
  _id?: string;
  _source?: { ciks?: string[]; form?: string; period_of_report?: string; file_date?: string };
}

async function probeRecentAmendments(
  remainingBudgetMs: number,
  hardStop: () => boolean,
): Promise<ProbeResult[]> {
  if (remainingBudgetMs < 60_000) return [];
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22%22&forms=13F-HR/A&dateRange=custom&startdt=2025-01-01`;
  const data = await fetchJson<{ hits?: { hits?: FtsHit[] } }>(url);
  const hits = data.hits?.hits ?? [];
  console.log(`  FTS sweep: ${hits.length} 13F-HR/A hits in 2025-present, probing up to ${Math.min(hits.length, 30)}...`);
  const results: ProbeResult[] = [];
  for (let i = 0; i < Math.min(hits.length, 30); i++) {
    if (hardStop()) break;
    const hit = hits[i]!;
    const accId = hit._id ?? "";
    // accession from FTS _id is like "0001234567-26-001234:primary_doc.xml"; strip
    const accession = accId.split(":")[0] ?? "";
    const cikRaw = (hit._source?.ciks?.[0] ?? "").replace(/^0+/, "");
    if (!accession || !cikRaw) continue;
    const reportDate = hit._source?.period_of_report ?? "";
    const filingDate = hit._source?.file_date ?? "";
    const r = await probeFiling(cikRaw, cikRaw.padStart(10, "0"), cikRaw, accession, filingDate, reportDate);
    results.push(r);
    if (r.mismatch) {
      console.log(`    [${i + 1}] ${cikRaw} ${accession}: MISMATCH (declared=${r.declared}, raw=${r.rawRowCount}, classification=${r.classification})`);
    }
  }
  return results;
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const startIso = new Date(startMs).toISOString();
  console.log("============================================================");
  console.log("Step 4a teeth probe — read-only EDGAR search");
  console.log(`  start:    ${startIso}`);
  console.log(`  time-box: 15 min hard`);
  console.log("============================================================");
  console.log("");
  console.log("READ-ONLY. No --save. No Firestore writes. No 4b authorization.");
  console.log("");

  const hardStop = () => Date.now() - startMs >= TIME_BOX_MS;

  // ── Phase 1: 6 ancient-period candidates from the 16:00Z FTS sweep ────
  console.log("Phase 1: 6 ancient-period candidates (already surfaced by FTS)");
  console.log("");
  const phase1Results: ProbeResult[] = [];
  for (const t of PRIMARY_TARGETS) {
    if (hardStop()) {
      console.log(`  ⏱  Time budget exhausted at ${t.alias}`);
      break;
    }
    console.log(`  ── ${t.alias} (CIK ${t.cik}, period ${t.period}) ──`);
    const accessions = await findAccessionsForPeriod(t.cik, t.period);
    if (accessions.length === 0) {
      console.log(`     NO 13F-HR/A for period ${t.period}. Skipping.`);
      continue;
    }
    // Probe each matching accession (original + amendments if any)
    for (const a of accessions) {
      const cikRaw = t.cik.replace(/^0+/, "");
      const r = await probeFiling(t.alias, t.cik, cikRaw, a.accession, a.filingDate, a.reportDate);
      phase1Results.push(r);
      console.log(
        `     ${r.formType.padEnd(10)} ${a.accession}: declared=${r.declared}  raw=${r.rawRowCount}  grep=${r.independentCount}  ${r.mismatch ? "❗ MISMATCH" : "match"}`,
      );
      if (r.mismatch) {
        console.log(`        classification: ${r.classification}`);
        console.log(`        ${r.classificationDetails}`);
        if (r.additionalInfoSnippet) {
          console.log(`        additionalInformation: "${r.additionalInfoSnippet.slice(0, 200)}..."`);
        }
      }
    }
  }
  console.log("");

  // ── Phase 2: FTS sweep of recent 13F-HR/A if time remains ────────────
  const remainingMs = TIME_BOX_MS - (Date.now() - startMs);
  console.log(`Phase 2: FTS sweep (remaining budget: ${Math.round(remainingMs / 1000)}s)`);
  console.log("");
  let phase2Results: ProbeResult[] = [];
  if (!hardStop()) {
    phase2Results = await probeRecentAmendments(remainingMs, hardStop);
  } else {
    console.log("  (Time exhausted; skipping FTS sweep)");
  }
  console.log("");

  // ── Summary ──────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("============================================================");
  console.log(`PROBE COMPLETE — elapsed ${elapsed}s of ${TIME_BOX_MS / 1000}s budget`);
  console.log("============================================================");
  console.log("");

  const all = [...phase1Results, ...phase2Results];
  const mismatches = all.filter((r) => r.mismatch);
  const errors = all.filter((r) => r.classification === "error");

  console.log(`Filings probed:     ${all.length}`);
  console.log(`  Phase 1 (targeted): ${phase1Results.length}`);
  console.log(`  Phase 2 (FTS sweep): ${phase2Results.length}`);
  console.log(`  Errors:            ${errors.length}`);
  console.log(`Mismatches found:   ${mismatches.length}`);
  console.log("");

  if (mismatches.length === 0) {
    console.log("CALIBRATED NEGATIVE — no raw < declared filings observed.");
    console.log("");
    console.log(`Searched ${all.length} filings across:`);
    console.log(`  - 6 ancient-period accessions surfaced by 16:00Z FTS (Hermes/Tekla/Lane Five/Trafelet/NEW GENERATION/Garcia Hamilton)`);
    console.log(`  - ${phase2Results.length} recent 13F-HR/A amendments from EDGAR FTS 2025-present sweep`);
    console.log(`Zero raw<declared cases observed. Consistent with SEC filers'`);
    console.log(`high declared-count accuracy — count-check guard exists to catch a`);
    console.log(`rare event, not a common one. Fixture-proven (synthetic case #4 in`);
    console.log(`scripts/_acceptance-13f-count-check.ts); prod-observation pending an`);
    console.log(`organic malformed filing surfacing in a future tick.`);
    console.log(``);
    console.log(`SCOPE CAVEAT: 15-min targeted sample, NOT a comprehensive corpus`);
    console.log(`survey. Older filings (pre-2014), tiny-fund filings, and 13F-HR/A`);
    console.log(`amendments before 2025 not searched.`);
  } else {
    console.log("MISMATCHES — per-filing classification:");
    console.log("");
    for (const r of mismatches) {
      console.log(`  ${r.alias}`);
      console.log(`    CIK ${r.cik}  accession ${r.accession}`);
      console.log(`    form: ${r.formType}  reportType: ${r.reportType}`);
      console.log(`    declared ${r.declared}  raw ${r.rawRowCount}  independent_grep ${r.independentCount}`);
      console.log(`    parser_matches_independent: ${r.parserMatchesIndependent}`);
      console.log(`    CLASSIFICATION: ${r.classification}`);
      console.log(`    ${r.classificationDetails}`);
      if (r.additionalInfoSnippet) {
        console.log(`    additionalInformation: "${r.additionalInfoSnippet}"`);
      }
      console.log("");
    }
    // Per-branch verdict
    const branch1 = mismatches.filter((r) => r.classification === "(1) genuine-shortfall");
    const branch2 = mismatches.filter((r) => r.classification === "(2) amendment-FP-class");
    const parserBugs = mismatches.filter((r) => r.classification === "parser-bug");
    const branch3 = mismatches.filter((r) => r.classification === "(3) ambiguous");
    console.log("PER-BRANCH SUMMARY:");
    console.log(`  Branch (1) genuine shortfall:       ${branch1.length}`);
    console.log(`  Branch (2) amendment FP-class:      ${branch2.length}`);
    console.log(`  Parser-bug:                          ${parserBugs.length}`);
    console.log(`  Branch (3) ambiguous (needs deeper read): ${branch3.length}`);
    console.log("");
    if (branch2.length > 0) {
      console.log(`  ⚠️  BRANCH (2) FOUND — B+ amendment false-positive class.`);
      console.log(`     This OUTRANKS the teeth question. STOP. ESCALATE.`);
      console.log(`     Do NOT authorize 4b for any of these accessions.`);
    } else if (branch1.length > 0) {
      console.log(`  ✅ BRANCH (1) FOUND — valid 4b target(s).`);
      console.log(`     STOP. Hold for separate 4b authorization.`);
    } else if (parserBugs.length > 0) {
      console.log(`  ⚠️  PARSER-BUG cases found. STOP. Fix parser before any 4b.`);
    }
  }
  console.log("");
  console.log("============================================================");
  console.log("Step 4a complete. READ-ONLY. No writes. 4b NOT authorized.");
  console.log("============================================================");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
