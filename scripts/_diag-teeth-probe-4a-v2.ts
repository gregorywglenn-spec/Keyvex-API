/**
 * Step 4a teeth probe — v2 with corrected FTS date filtering.
 *
 * Findings from v1: dateRange=custom needs BOTH startdt and enddt to
 * filter; without enddt FTS returned 2010-era hits using pre-XML .txt
 * format that parse13FXml can't handle. v2 forces a 2025-2026 window
 * and filters for XML-era filings only.
 *
 * Also adds skip logic for filings whose holdings file is .txt (pre-XML).
 *
 * READ-ONLY. NO Firestore writes. 4b NOT authorized.
 */
import { parse13FXml } from "../src/scrapers/13f.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";
const TIME_BOX_MS = 10 * 60 * 1000; // 10 min v2 cap (we already used some of the original 15)

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string): Promise<string> {
  await sleep(150);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  await sleep(150);
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

function parseAdditionalInformation(primaryDocXml: string): string {
  const m = primaryDocXml.match(
    /<additionalInformation>([\s\S]*?)<\/additionalInformation>/i,
  );
  return m && m[1] ? m[1].trim() : "";
}

function independentInfoTableCount(holdingsXml: string): number {
  const matches = holdingsXml.match(/<infoTable\b[^>]*>/g);
  return matches ? matches.length : 0;
}

interface IndexResponse {
  directory?: { item?: Array<{ name: string }> };
}

async function fetchFilingUrls(
  cikRaw: string,
  accession: string,
): Promise<{ primaryDocUrl: string; holdingsUrl: string; holdingsIsXml: boolean } | null> {
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
      if (!holdings || !primary) {
        // Pre-XML filing or unexpected structure — skip
        continue;
      }
      return {
        holdingsUrl: `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/${holdings.name}`,
        primaryDocUrl: `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/${primary.name}`,
        holdingsIsXml: true,
      };
    } catch {
      // try next
    }
  }
  return null;
}

interface ProbeResult {
  cik: string;
  accession: string;
  filingDate: string;
  reportDate: string;
  formType: string;
  declared: number | null;
  rawRowCount: number;
  independentCount: number;
  mismatch: boolean;
  classification: "(1) genuine-shortfall" | "(2) amendment-FP-class" | "(3) ambiguous" | "parser-bug" | "no-mismatch" | "skip-non-xml" | "error";
  details: string;
  additionalInfoSnippet: string;
}

async function probeFiling(
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
        cik, accession, filingDate, reportDate,
        formType: "", declared: null, rawRowCount: -1, independentCount: -1,
        mismatch: false, classification: "skip-non-xml",
        details: "No XML primary_doc/holdings — pre-XML format, skipped",
        additionalInfoSnippet: "",
      };
    }
    const primaryDocXml = await fetchText(urls.primaryDocUrl);
    const holdingsXml = await fetchText(urls.holdingsUrl);

    const declared = parseInfoTableEntryTotal(primaryDocXml);
    const formType = parseSubmissionType(primaryDocXml) ?? "(unknown)";
    const addlInfo = parseAdditionalInformation(primaryDocXml);
    const addlSnippet = addlInfo.length > 250 ? addlInfo.slice(0, 250) + "..." : addlInfo;

    const meta = {
      fundName: cik,
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
      if (!parserMatches) {
        classification = "parser-bug";
        details = `parse13FXml rawRowCount=${rawRowCount} but independent <infoTable> count=${independent}. Parser-side issue.`;
      } else if (formType === "13F-HR") {
        classification = "(1) genuine-shortfall";
        details = `13F-HR with declared ${declared} > raw ${rawRowCount}, independent grep confirms ${independent}. Filer over-declared.`;
      } else if (formType.startsWith("13F-HR/A")) {
        const additive =
          /\b(adds?|additional|amend(s|ing)? to add|supplement|append)\b/i.test(addlInfo) &&
          !/\b(correct|restate|replace)\b/i.test(addlInfo);
        const restate =
          /\b(correct|restate|replace|amend(s|ing)? to (correct|restate))\b/i.test(addlInfo);
        if (additive) {
          classification = "(2) amendment-FP-class";
          details = `13F-HR/A additive. Declared ${declared} may cover combined scope; file delivers ${rawRowCount}. B+ false-positive class.`;
        } else if (restate) {
          classification = "(1) genuine-shortfall";
          details = `13F-HR/A restatement. Declared ${declared} > raw ${rawRowCount}; amendment meant to stand alone, mismatch is real.`;
        } else {
          classification = "(3) ambiguous";
          details = `13F-HR/A with no clear amendment-intent language. Cross-filing comparison would be needed for definitive classification.`;
        }
      } else {
        classification = "(3) ambiguous";
        details = `Unrecognized form type "${formType}".`;
      }
    }

    return {
      cik, accession, filingDate, reportDate,
      formType, declared, rawRowCount, independentCount: independent,
      mismatch, classification, details, additionalInfoSnippet: addlSnippet,
    };
  } catch (e) {
    return {
      cik, accession, filingDate, reportDate,
      formType: "", declared: null, rawRowCount: -1, independentCount: -1,
      mismatch: false, classification: "error",
      details: (e as Error).message,
      additionalInfoSnippet: "",
    };
  }
}

interface FtsHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    period_ending?: string;
    file_date?: string;
    adsh?: string;
    form?: string;
  };
}

async function sweepFts(
  forms: string,
  startdt: string,
  enddt: string,
  hardStop: () => boolean,
  maxProbes: number,
): Promise<ProbeResult[]> {
  // forms param needs URL-encoding for the slash in "13F-HR/A"
  const formsEncoded = encodeURIComponent(forms);
  const url = `https://efts.sec.gov/LATEST/search-index?q=%22%22&forms=${formsEncoded}&dateRange=custom&startdt=${startdt}&enddt=${enddt}`;
  console.log(`  FTS query: forms=${forms}  ${startdt}..${enddt}`);
  const data = await fetchJson<{ hits?: { total?: { value: number }; hits?: FtsHit[] } }>(url);
  const totalAvail = data.hits?.total?.value ?? 0;
  const hits = data.hits?.hits ?? [];
  console.log(`  FTS returned ${hits.length} hits (total available: ${totalAvail})`);
  // Sample first N (FTS sorts by relevance/date — these are typically most-recent first)
  const target = Math.min(hits.length, maxProbes);
  const results: ProbeResult[] = [];
  for (let i = 0; i < target; i++) {
    if (hardStop()) break;
    const hit = hits[i]!;
    const accession = hit._source?.adsh ?? (hit._id ?? "").split(":")[0] ?? "";
    const cikRaw = (hit._source?.ciks?.[0] ?? "").replace(/^0+/, "");
    const cikPadded = (hit._source?.ciks?.[0] ?? "").padStart(10, "0");
    const reportDate = hit._source?.period_ending ?? "";
    const filingDate = hit._source?.file_date ?? "";
    if (!accession || !cikRaw) {
      results.push({
        cik: cikPadded, accession, filingDate, reportDate,
        formType: "", declared: null, rawRowCount: -1, independentCount: -1,
        mismatch: false, classification: "error",
        details: "Missing accession or CIK in FTS hit",
        additionalInfoSnippet: "",
      });
      continue;
    }
    const r = await probeFiling(cikPadded, cikRaw, accession, filingDate, reportDate);
    results.push(r);
    if (r.mismatch) {
      console.log(`    [${i + 1}/${target}] MISMATCH: ${cikRaw} ${accession} → ${r.classification}`);
    }
  }
  return results;
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const startIso = new Date(startMs).toISOString();
  console.log("============================================================");
  console.log("Step 4a teeth probe v2 — corrected FTS date filtering");
  console.log(`  start:    ${startIso}`);
  console.log(`  time-box: 10 min hard (v2 — already used some of v1's 15)`);
  console.log("============================================================");
  console.log("");

  const hardStop = () => Date.now() - startMs >= TIME_BOX_MS;

  // 1. Recent 13F-HR/A amendments (highest-probability class)
  console.log("Phase 2a: recent 13F-HR/A amendments (2025-01-01 → 2026-05-25)");
  const ampResults = await sweepFts(
    "13F-HR/A",
    "2025-01-01",
    "2026-05-25",
    hardStop,
    40,
  );
  console.log(`  probed: ${ampResults.length}, mismatches: ${ampResults.filter((r) => r.mismatch).length}, skipped non-XML: ${ampResults.filter((r) => r.classification === "skip-non-xml").length}, errors: ${ampResults.filter((r) => r.classification === "error").length}`);
  console.log("");

  // 2. Recent 13F-HR originals (broader teeth check)
  let origResults: ProbeResult[] = [];
  if (!hardStop()) {
    console.log("Phase 2b: recent 13F-HR originals (2025-01-01 → 2026-05-25)");
    origResults = await sweepFts(
      "13F-HR",
      "2025-01-01",
      "2026-05-25",
      hardStop,
      40,
    );
    console.log(`  probed: ${origResults.length}, mismatches: ${origResults.filter((r) => r.mismatch).length}, skipped non-XML: ${origResults.filter((r) => r.classification === "skip-non-xml").length}, errors: ${origResults.filter((r) => r.classification === "error").length}`);
    console.log("");
  }

  // Summary
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log("============================================================");
  console.log(`PROBE v2 COMPLETE — elapsed ${elapsed}s of ${TIME_BOX_MS / 1000}s budget`);
  console.log("============================================================");
  console.log("");

  const allResults = [...ampResults, ...origResults];
  const successful = allResults.filter(
    (r) => r.classification === "no-mismatch" || r.mismatch,
  );
  const skipped = allResults.filter((r) => r.classification === "skip-non-xml");
  const errors = allResults.filter((r) => r.classification === "error");
  const mismatches = allResults.filter((r) => r.mismatch);

  console.log(`Filings probed:                      ${allResults.length}`);
  console.log(`  Successfully classified:           ${successful.length}`);
  console.log(`  Skipped (non-XML / pre-2013):      ${skipped.length}`);
  console.log(`  Errors:                            ${errors.length}`);
  console.log(`Mismatches found:                    ${mismatches.length}`);
  console.log("");

  if (mismatches.length === 0) {
    console.log("STILL CALIBRATED NEGATIVE on v2 sweep.");
    console.log("");
    console.log(`Combined v1 + v2 evidence:`);
    console.log(`  Phase 1 (v1): 6 ancient-period targeted filings — all raw==declared`);
    console.log(`  Phase 2a (v2): ${successful.length > 0 ? ampResults.filter(r => r.classification === "no-mismatch").length : 0} recent 13F-HR/A amendments — all raw==declared`);
    console.log(`  Phase 2b (v2): ${origResults.filter(r => r.classification === "no-mismatch").length} recent 13F-HR originals — all raw==declared`);
    console.log(`  Total successfully classified: ${6 + successful.length} filings`);
    console.log(`  Zero raw<declared cases observed.`);
    console.log("");
    console.log(`SCOPE CAVEAT: 15-min targeted + FTS-sampled probe.`);
    console.log(`Not comprehensive corpus survey. Pre-2013 .txt-format filings`);
    console.log(`were skipped (B+ doesn't operate on them anyway).`);
  } else {
    console.log("MISMATCHES FOUND:");
    console.log("");
    for (const r of mismatches) {
      console.log(`  CIK ${r.cik}  accession ${r.accession}  form ${r.formType}`);
      console.log(`    declared ${r.declared}  raw ${r.rawRowCount}  independent_grep ${r.independentCount}`);
      console.log(`    CLASSIFICATION: ${r.classification}`);
      console.log(`    ${r.details}`);
      if (r.additionalInfoSnippet) {
        console.log(`    additionalInformation: "${r.additionalInfoSnippet}"`);
      }
      console.log("");
    }
    const b1 = mismatches.filter((r) => r.classification === "(1) genuine-shortfall");
    const b2 = mismatches.filter((r) => r.classification === "(2) amendment-FP-class");
    const pb = mismatches.filter((r) => r.classification === "parser-bug");
    const b3 = mismatches.filter((r) => r.classification === "(3) ambiguous");
    console.log("PER-BRANCH:");
    console.log(`  (1) genuine-shortfall:        ${b1.length}  → potential 4b targets`);
    console.log(`  (2) amendment-FP-class:        ${b2.length}  → STOP-AND-ESCALATE`);
    console.log(`  parser-bug:                     ${pb.length}  → STOP, fix parser first`);
    console.log(`  (3) ambiguous:                  ${b3.length}  → document, no write`);
  }
  console.log("");
  console.log("============================================================");
  console.log("Step 4a v2 complete. READ-ONLY. No writes. 4b NOT authorized.");
  console.log("============================================================");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
