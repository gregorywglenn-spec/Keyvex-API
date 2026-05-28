/**
 * Coastline shortfall cross-check (2026-05-25, gates B+ commit decision).
 *
 * Wire probe found Coastline (CIK 0001324279) serving
 *   verification_expected: 578
 *   verification_actual:   408
 * That's a 170-row gap. Three independent numbers must be established
 * before treating Coastline as a B+ false-positive:
 *
 *   1. Declared = primary_doc.xml <tableEntryTotal>          (from EDGAR)
 *   2. Raw      = parse13FXml({...}).rawRowCount             (B+ instrumentation)
 *   3. Stored   = Firestore doc count for (fund_cik, quarter) (from our DB)
 *
 * Plus one secondary read to interpret the 408: under pre-fix code,
 * verification_actual = allHoldings.length (the AGGREGATED-by-CUSIP +
 * options-filtered count), NOT the raw count. Post-B+ it would be raw.
 * That matters for which of Greg's three outcomes applies.
 *
 * Outcomes (Greg's framing):
 *   (a) raw == 578, stored ≠ 408 → genuine ingestion omission
 *   (b) raw == 578, aggregated == 408 → B+ aggregation artifact, flips
 *       VERIFIED on B+ deploy
 *   (c) raw == 408, declared == 578 → filing header/body mismatch OR
 *       parser legitimately excluding lines tableEntryTotal counts.
 *       B+ does NOT cleanly sort this case — flag loudly.
 *
 * READ-ONLY. EDGAR + parser + Firestore count. No edits, no commit, no
 * deploy. One accession only — start with Coastline and report back
 * before widening to the other 4 INSUFF funds.
 */
import { XMLParser } from "fast-xml-parser";
import { parse13FXml } from "../src/scrapers/13f.js";
import { getLiveDb } from "../src/firestore.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";

const FUND_CIK = "0001324279"; // Coastline Trust Co
const FUND_CIK_RAW = "1324279";
const ACCESSION = "0001062993-26-001837";
const ACCESSION_NO_SLASH = ACCESSION.replace(/-/g, "");
const QUARTER = "2026-03-31";

// ─── Inlined parseInfoTableEntryTotal (mirrors 13f.ts; not exported) ──────
function parseInfoTableEntryTotal(primaryDocXml: string): number | null {
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?(?:info)?tableEntryTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseTableValueTotal(primaryDocXml: string): number | null {
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?tableValueTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

interface IndexResponse {
  directory?: { item?: Array<{ name: string }> };
}

async function findFilingUrls(): Promise<{
  primaryDocUrl: string;
  holdingsUrl: string;
}> {
  // EDGAR mirrors at fund.cikRaw OR filer.cikRaw paths — use fund.cikRaw
  // first (matches scraper's behavior in 13f.ts:fetchLatest13F).
  const candidates = [FUND_CIK_RAW, "1062993"];
  let indexData: IndexResponse | null = null;
  let basePath = "";
  for (const cik of candidates) {
    const indexUrl = `${SEC}/Archives/edgar/data/${cik}/${ACCESSION_NO_SLASH}/index.json`;
    try {
      const res = await fetch(indexUrl, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (res.ok) {
        indexData = (await res.json()) as IndexResponse;
        basePath = `${SEC}/Archives/edgar/data/${cik}/${ACCESSION_NO_SLASH}`;
        console.log(`  index.json found at /Archives/edgar/data/${cik}/${ACCESSION_NO_SLASH}/`);
        break;
      }
    } catch {
      // try next
    }
  }
  if (!indexData) {
    throw new Error(`Could not fetch index.json at any candidate CIK path`);
  }
  const items = indexData.directory?.item ?? [];
  const xmlFiles = items.filter((f) => f.name.endsWith(".xml"));
  const holdingsFile =
    xmlFiles.find((f) => f.name.toLowerCase().includes("infotable")) ??
    xmlFiles.find((f) => !f.name.toLowerCase().includes("primary_doc"));
  const primaryDocFile = xmlFiles.find((f) =>
    f.name.toLowerCase().includes("primary_doc"),
  );
  if (!holdingsFile) throw new Error("No holdings XML in accession");
  if (!primaryDocFile) throw new Error("No primary_doc.xml in accession");
  return {
    primaryDocUrl: `${basePath}/${primaryDocFile.name}`,
    holdingsUrl: `${basePath}/${holdingsFile.name}`,
  };
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log("Coastline shortfall cross-check");
  console.log(`  Fund:      Coastline Trust Co (CIK ${FUND_CIK})`);
  console.log(`  Accession: ${ACCESSION}`);
  console.log(`  Period:    ${QUARTER}`);
  console.log("============================================================");
  console.log("");

  // ── Resolve filing URLs ─────────────────────────────────────────────────
  console.log("STEP 0 — locate filing on EDGAR:");
  const { primaryDocUrl, holdingsUrl } = await findFilingUrls();
  console.log(`  primary_doc:  ${primaryDocUrl}`);
  console.log(`  holdings XML: ${holdingsUrl}`);
  console.log("");

  // ── Number 1: DECLARED (from primary_doc.xml) ──────────────────────────
  console.log("STEP 1 — DECLARED from primary_doc.xml <tableEntryTotal>:");
  const primaryDocXml = await fetchText(primaryDocUrl);
  const declared = parseInfoTableEntryTotal(primaryDocXml);
  const declaredValueTotal = parseTableValueTotal(primaryDocXml);
  // Also check what the filing self-reports as report type, included
  // managers count, etc. — useful context for interpreting outcome (c).
  const reportType = primaryDocXml.match(/<reportType>([^<]+)<\/reportType>/i)?.[1] ?? "(unknown)";
  const otherMgrs = primaryDocXml.match(/<otherIncludedManagersCount>(\d+)<\/otherIncludedManagersCount>/i)?.[1] ?? "(unknown)";
  console.log(`  reportType:                  ${reportType}`);
  console.log(`  otherIncludedManagersCount:  ${otherMgrs}`);
  console.log(`  tableEntryTotal (DECLARED):  ${declared ?? "(missing)"}`);
  console.log(`  tableValueTotal:             $${declaredValueTotal !== null ? declaredValueTotal.toLocaleString() : "(missing)"}`);
  console.log("");

  // ── Number 2: RAW (parse13FXml's rawRowCount) ──────────────────────────
  console.log("STEP 2 — RAW <infoTable> count via parse13FXml (B+ instrumentation):");
  const holdingsXml = await fetchText(holdingsUrl);
  const meta = {
    fundName: "Coastline Trust Co",
    fundCik: FUND_CIK,
    accession: ACCESSION,
    filingDate: "2026-04-03",
    period: QUARTER,
    url: holdingsUrl,
    infoTableEntryTotal: declared,
    tableValueTotal: declaredValueTotal,
  } as Parameters<typeof parse13FXml>[1];
  const { holdings, rawRowCount, rawValueSum } = parse13FXml(holdingsXml, meta);
  console.log(`  rawRowCount (every <infoTable> element):   ${rawRowCount}`);
  console.log(`  rawValueSum (Σ raw <value>):               $${rawValueSum.toLocaleString()}`);
  console.log(`  aggregated holdings (post-CUSIP dedup,`);
  console.log(`     post-options-filter, pre-TOP_N):        ${holdings.length}`);
  console.log("");

  // ── Number 3: STORED (Firestore actual doc count) ──────────────────────
  console.log("STEP 3 — STORED doc count in Firestore:");
  const db = await getLiveDb();
  const storedSnap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", FUND_CIK)
    .where("quarter", "==", QUARTER)
    .get();
  const stored = storedSnap.docs.length;
  console.log(`  institutional_holdings docs where fund_cik=${FUND_CIK} AND quarter=${QUARTER}:`);
  console.log(`     ${stored}`);
  // Sample one doc's verification fields to confirm what verification_actual
  // logs under PRE-FIX (production) code.
  if (storedSnap.docs.length > 0) {
    const sample = storedSnap.docs[0]!.data() as Record<string, unknown>;
    console.log(`  sample doc verification fields:`);
    console.log(`     verification_status:   ${sample.verification_status ?? "(absent)"}`);
    console.log(`     verification_expected: ${sample.verification_expected ?? "(absent)"}`);
    console.log(`     verification_actual:   ${sample.verification_actual ?? "(absent)"}`);
    if (sample.verification_value_expected !== undefined) {
      console.log(`     verification_value_expected: ${sample.verification_value_expected}  ← B+ field, would be absent on pre-fix writes`);
    }
    if (sample.verification_value_actual !== undefined) {
      console.log(`     verification_value_actual:   ${sample.verification_value_actual}  ← B+ field, would be absent on pre-fix writes`);
    }
  }
  console.log("");

  // ── Interpretation ─────────────────────────────────────────────────────
  console.log("============================================================");
  console.log("INTERPRETATION");
  console.log("============================================================");
  console.log(`  Declared (primary_doc <tableEntryTotal>): ${declared}`);
  console.log(`  Raw (B+ rawRowCount):                     ${rawRowCount}`);
  console.log(`  Aggregated (post-CUSIP-dedup, post-opts): ${holdings.length}`);
  console.log(`  Stored (Firestore docs in collection):    ${stored}  (capped at TOP_N=50 per filing)`);
  console.log("");
  console.log(`  Wire-probe served: verification_expected=578, verification_actual=408`);
  console.log("");

  // What does verification_actual=408 mean under pre-fix code?
  // Pre-fix: verification_actual = allHoldings.length = AGGREGATED count.
  // So 408 should equal `holdings.length` from parse13FXml above.
  const wireExpected = 578;
  const wireActual = 408;
  console.log(`  Confirming wire-probe values map to parser output:`);
  console.log(`     verification_expected (wire) ${wireExpected === declared ? "===" : "≠"} declared (${declared}) ${wireExpected === declared ? "✓" : "✗"}`);
  console.log(`     verification_actual (wire) ${wireActual === holdings.length ? "===" : "≠"} aggregated (${holdings.length}) ${wireActual === holdings.length ? "✓ (pre-fix logs aggregated)" : "✗"}`);
  console.log("");

  console.log("  Pattern classification per Greg's framing:");
  if (rawRowCount === declared) {
    console.log(`     raw (${rawRowCount}) === declared (${declared})`);
    if (holdings.length === wireActual && wireActual !== declared) {
      console.log(`     aggregated (${holdings.length}) === wire's verification_actual (${wireActual})`);
      console.log(`     => OUTCOME (b): B+ aggregation artifact.`);
      console.log(`        Pre-fix code stamped verification_actual=${holdings.length} (aggregated) vs declared ${declared}`);
      console.log(`        → INSUFFICIENT_DATA. Post-B+ deploys: verification_actual will be ${rawRowCount} (raw)`);
      console.log(`        → equals declared → VERIFIED. Wire-probe's flag withdrawn for this filing.`);
    } else {
      console.log(`     => Anomaly: raw matches declared but aggregated (${holdings.length}) doesn't match wire's verification_actual (${wireActual}). Investigate.`);
    }
  } else if (rawRowCount === wireActual) {
    console.log(`     raw (${rawRowCount}) === wire's verification_actual (${wireActual}), declared (${declared}) differs`);
    console.log(`     => OUTCOME (c): RAW != DECLARED. Filing's primary_doc declares ${declared}`);
    console.log(`        but XML physically contains ${rawRowCount} <infoTable> elements.`);
    console.log(`        Either: (i) the filing has a header/body inconsistency, OR`);
    console.log(`        (ii) the parser is excluding lines tableEntryTotal counts.`);
    console.log(`        ⚠️  B+ does NOT cleanly sort this — review BEFORE deploy.`);
  } else {
    console.log(`     raw (${rawRowCount}) ≠ declared (${declared}) AND raw ≠ wire's verification_actual (${wireActual})`);
    console.log(`     => OUTCOME (a) or anomaly: investigate further.`);
    if (stored !== holdings.length && stored < holdings.length) {
      console.log(`        Stored (${stored}) < aggregated (${holdings.length}) — TOP_N=50 filter is dropping rows (expected),`);
      console.log(`        but verification_actual logic predates TOP_N so this isn't the deficit source.`);
    }
  }
  console.log("");

  console.log("============================================================");
  console.log("Read-only complete. B+ NOT committed, NOT deployed. Phase B LOCKED.");
  console.log("============================================================");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
