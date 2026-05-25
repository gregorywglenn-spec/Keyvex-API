/**
 * Step 4a teeth probe — RECLASSIFY 3 candidates with corrected
 * namespace-aware grep.
 *
 * v2 found 3 mismatches initially flagged as "parser-bug" because the
 * independent grep used `<infoTable\b` which doesn't match namespace-
 * prefixed `<ns1:infoTable>`. parse13FXml uses removeNSPrefix:true so
 * it counts correctly; the grep regex needed updating.
 *
 * Corrected regex: `<(?:[a-zA-Z0-9_]+:)?infoTable\b`
 *
 * If, under corrected grep, the three filings show:
 *   parse13FXml rawRowCount === independent_grep
 *   declared > parser_raw
 * → they are GENUINE 1-row shortfalls (branch 1, OR branch 2 for the
 * amendment if additive). Need the full inspection tree.
 *
 * READ-ONLY.
 */
import { parse13FXml } from "../src/scrapers/13f.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";

const CANDIDATES = [
  { cik: "0001765690", accession: "0001765690-25-000005", form: "13F-HR/A" },
  { cik: "0002056922", accession: "0002056922-25-000003", form: "13F-HR" },
  { cik: "0002045082", accession: "0002045082-25-000001", form: "13F-HR" },
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

function parseReportType(xml: string): string {
  const m = xml.match(/<reportType>([^<]+)<\/reportType>/i);
  return m && m[1] ? m[1].trim() : "";
}

function parseAdditionalInformation(xml: string): string {
  const m = xml.match(/<additionalInformation>([\s\S]*?)<\/additionalInformation>/i);
  return m && m[1] ? m[1].trim() : "";
}

function parseFilingManagerName(xml: string): string {
  const m = xml.match(/<filingManager>[\s\S]*?<name>([^<]+)<\/name>/i);
  return m && m[1] ? m[1].trim() : "";
}

/** Namespace-aware count of <infoTable> opening tags. */
function independentInfoTableCount(xml: string): number {
  const matches = xml.match(/<(?:[a-zA-Z0-9_]+:)?infoTable\b[^>]*>/g);
  return matches ? matches.length : 0;
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
      // try next CIK
    }
  }
  throw new Error(`Could not resolve filing URLs for ${accession}`);
}

interface FullClassification {
  cik: string;
  accession: string;
  formType: string;
  filer: string;
  declared: number | null;
  parserRawCount: number;
  independentGrepNS: number;
  parserMatchesGrep: boolean;
  mismatch: boolean;
  mismatchDelta: number; // declared - raw
  reportType: string;
  additionalInfo: string;
  classification: string;
  details: string;
}

async function classifyOne(
  cik: string,
  accession: string,
): Promise<FullClassification> {
  const cikRaw = cik.replace(/^0+/, "");
  const urls = await fetchFilingUrls(cikRaw, accession);
  const primaryDocXml = await fetchText(urls.primaryDocUrl);
  const holdingsXml = await fetchText(urls.holdingsUrl);

  const declared = parseInfoTableEntryTotal(primaryDocXml);
  const formType = parseSubmissionType(primaryDocXml);
  const reportType = parseReportType(primaryDocXml);
  const addlInfo = parseAdditionalInformation(primaryDocXml);
  const filer = parseFilingManagerName(primaryDocXml);

  const meta = {
    fundName: filer || cik,
    fundCik: cik,
    accession,
    filingDate: "",
    period: "",
    url: urls.holdingsUrl,
    infoTableEntryTotal: declared,
    tableValueTotal: null,
  } as Parameters<typeof parse13FXml>[1];
  const { rawRowCount } = parse13FXml(holdingsXml, meta);
  const independentGrepNS = independentInfoTableCount(holdingsXml);
  const parserMatchesGrep = rawRowCount === independentGrepNS;
  const mismatch = declared !== null && rawRowCount < declared;
  const mismatchDelta = declared !== null ? declared - rawRowCount : 0;

  let classification = "unclassified";
  let details = "";

  if (!mismatch) {
    classification = "no-mismatch";
    details = `declared ${declared} === raw ${rawRowCount}`;
  } else if (!parserMatchesGrep) {
    classification = "parser-bug";
    details = `parse13FXml=${rawRowCount} but namespace-aware grep=${independentGrepNS}. Parser-side issue.`;
  } else if (formType === "13F-HR") {
    classification = "(1) genuine-shortfall";
    details = `Original 13F-HR. declared=${declared}, parser_raw=${rawRowCount}, independent_grep=${independentGrepNS}. Filer over-declared by ${mismatchDelta} row(s).`;
  } else if (formType.startsWith("13F-HR/A")) {
    const additive =
      /\b(adds?|additional|amend(s|ing)? to add|supplement|append)\b/i.test(addlInfo) &&
      !/\b(correct|restate|replace)\b/i.test(addlInfo);
    const restate =
      /\b(correct|restate|replace|amend(s|ing)? to (correct|restate))\b/i.test(addlInfo);
    if (additive) {
      classification = "(2) amendment-FP-class";
      details = `13F-HR/A additive amendment. additionalInformation indicates ADDS not CORRECTS. Declared ${declared} likely covers combined scope; file delivers ${rawRowCount} (delta). B+ false-positive class for amendments.`;
    } else if (restate) {
      classification = "(1) genuine-shortfall";
      details = `13F-HR/A restatement amendment. declared=${declared}, parser_raw=${rawRowCount}. Amendment meant to stand alone, mismatch is real (off by ${mismatchDelta}).`;
    } else {
      classification = "(3) ambiguous";
      details = `13F-HR/A with no clear additive/restate language in additionalInformation. Cross-filing comparison needed.`;
    }
  } else {
    classification = "(3) ambiguous";
    details = `Unrecognized form type "${formType}".`;
  }

  return {
    cik, accession, formType, filer,
    declared, parserRawCount: rawRowCount, independentGrepNS,
    parserMatchesGrep, mismatch, mismatchDelta,
    reportType, additionalInfo: addlInfo,
    classification, details,
  };
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log("Step 4a RECLASSIFY — 3 candidates with namespace-aware grep");
  console.log("============================================================");
  console.log("");

  const results: FullClassification[] = [];
  for (const c of CANDIDATES) {
    console.log(`────── ${c.cik}  ${c.accession}  (initial form ${c.form}) ──────`);
    try {
      const r = await classifyOne(c.cik, c.accession);
      results.push(r);
      console.log(`  filer:                       ${r.filer}`);
      console.log(`  submissionType:              ${r.formType}`);
      console.log(`  reportType:                  ${r.reportType}`);
      console.log(`  declared <tableEntryTotal>:  ${r.declared}`);
      console.log(`  parse13FXml rawRowCount:     ${r.parserRawCount}`);
      console.log(`  namespace-aware grep count:  ${r.independentGrepNS}`);
      console.log(`  parser_matches_grep:         ${r.parserMatchesGrep}`);
      console.log(`  mismatch (declared > raw):   ${r.mismatch}  (delta ${r.mismatchDelta})`);
      if (r.additionalInfo) {
        const snip = r.additionalInfo.length > 400 ? r.additionalInfo.slice(0, 400) + "..." : r.additionalInfo;
        console.log(`  additionalInformation:`);
        console.log(`    "${snip}"`);
      } else {
        console.log(`  additionalInformation:       (none)`);
      }
      console.log(`  CLASSIFICATION: ${r.classification}`);
      console.log(`    ${r.details}`);
    } catch (e) {
      console.log(`  ERROR: ${(e as Error).message}`);
    }
    console.log("");
  }

  // Summary
  console.log("============================================================");
  console.log("FINAL CLASSIFICATION SUMMARY");
  console.log("============================================================");
  console.log("");
  const b1 = results.filter((r) => r.classification === "(1) genuine-shortfall");
  const b2 = results.filter((r) => r.classification === "(2) amendment-FP-class");
  const pb = results.filter((r) => r.classification === "parser-bug");
  const b3 = results.filter((r) => r.classification === "(3) ambiguous");
  console.log(`  (1) genuine-shortfall:                    ${b1.length}`);
  console.log(`  (2) amendment-FP-class:                    ${b2.length}  (STOP-AND-ESCALATE)`);
  console.log(`  parser-bug:                                ${pb.length}`);
  console.log(`  (3) ambiguous:                              ${b3.length}`);
  console.log("");
  if (b2.length > 0) {
    console.log(`  ⚠️  BRANCH (2) FOUND — B+ amendment false-positive class.`);
    console.log(`     This outranks the teeth question. STOP. ESCALATE.`);
    console.log(`     Do NOT authorize 4b for any of these accessions.`);
  } else if (b1.length > 0) {
    console.log(`  ✅ BRANCH (1) FOUND — ${b1.length} valid 4b target(s):`);
    for (const r of b1) {
      console.log(`     ${r.filer} (CIK ${r.cik}) accession ${r.accession}: declared ${r.declared}, raw ${r.parserRawCount} (off by ${r.mismatchDelta})`);
    }
    console.log(`     STOP. Hold for separate 4b authorization.`);
  } else if (pb.length > 0) {
    console.log(`  ⚠️  PARSER-BUG cases remain after namespace fix. Investigate further.`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
