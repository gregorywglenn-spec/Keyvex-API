/**
 * Pre-B+-deploy INSUFFICIENT_DATA census on the 4 remaining INSUFF funds
 * from the 16:00Z tick snapshot. Mirrors the Coastline cross-check shape
 * (declared / raw / aggregated / stored / sample verification_actual)
 * across all 4 in one run.
 *
 * Captured against FROZEN PRE-FIX STAMPS — runs BEFORE B+ commits/deploys,
 * so the per-fund classification is archivable as v4 record material
 * rather than reconstructed after post-deploy re-stamping overwrites
 * the pre-fix state via merge:true.
 *
 * Targets (per Gemini directive):
 *   - Atlas Brown, Inc.                  | CIK 0001388168 | Period 2026-03-31
 *   - Energy Income Partners, LLC        | CIK 0001388814 | Period 2026-03-31
 *   - Park West Asset Management LLC     | CIK 0001386928 | Period 2026-03-31
 *   - Harvest Management LLC             | CIK 0001140315 | Period 2026-03-31
 *
 * Outcomes per Greg's framing:
 *   (a) raw == declared, stored ≠ aggregated → genuine omission, heal candidate
 *   (b) raw == declared, aggregated == verification_actual → B+ artifact, flips
 *       VERIFIED on B+ deploy
 *   (c) raw != declared → filing header/body mismatch OR parser excluding
 *       lines tableEntryTotal counts. B+ doesn't cleanly sort.
 *
 * READ-ONLY. EDGAR + parser + Firestore count. No state changes.
 */
import { parse13FXml } from "../src/scrapers/13f.js";
import { getLiveDb } from "../src/firestore.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";

interface Target {
  alias: string;
  fund_cik: string; // padded to 10 digits
  period: string;
}

const TARGETS: Target[] = [
  { alias: "Atlas Brown, Inc.", fund_cik: "0001388168", period: "2026-03-31" },
  { alias: "Energy Income Partners, LLC", fund_cik: "0001388814", period: "2026-03-31" },
  { alias: "Park West Asset Management LLC", fund_cik: "0001386928", period: "2026-03-31" },
  { alias: "Harvest Management LLC", fund_cik: "0001140315", period: "2026-03-31" },
];

// ───────────────────────────────────────────────────────────────────────────
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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

async function findAccessionForPeriod(
  cik: string,
  period: string,
): Promise<{ accession: string; filingDate: string; entityName: string } | null> {
  const url = `${SEC_DATA}/submissions/CIK${cik}.json`;
  const data = await fetchJson<SubmissionsResponse>(url);
  const r = data.filings?.recent;
  if (!r) return null;
  // Find most-recent 13F-HR or 13F-HR/A matching the period
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if ((form === "13F-HR" || form === "13F-HR/A") && r.reportDate[i] === period) {
      return {
        accession: r.accessionNumber[i] ?? "",
        filingDate: r.filingDate[i] ?? "",
        entityName: data.name ?? cik,
      };
    }
  }
  return null;
}

interface IndexResponse {
  directory?: { item?: Array<{ name: string }> };
}

async function findFilingUrls(
  cikRaw: string,
  accession: string,
): Promise<{ primaryDocUrl: string; holdingsUrl: string }> {
  const accNoSlash = accession.replace(/-/g, "");
  // Try fund CIK first (mirrors fetchLatest13F behavior); fall back to
  // accession filer prefix.
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
        primaryDocUrl: `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/${primary.name}`,
        holdingsUrl: `${SEC}/Archives/edgar/data/${cik}/${accNoSlash}/${holdings.name}`,
      };
    } catch {
      // try next CIK
    }
  }
  throw new Error(`Could not find filing URLs for ${accession}`);
}

interface CensusResult {
  alias: string;
  fund_cik: string;
  period: string;
  accession: string;
  reportType: string;
  otherMgrsCount: number;
  managerType: "single-manager" | "multi-manager";
  declared: number | null;
  declaredValueTotal: number | null;
  rawRowCount: number;
  rawValueSum: number;
  aggregated: number;
  stored: number;
  sampleVerStatus: string;
  sampleVerExpected: number | string;
  sampleVerActual: number | string;
  outcome: "a" | "b" | "c" | "anomaly";
  outcomeNote: string;
  valueGate: "PASS" | "FAIL" | "N/A";
}

async function probeOne(target: Target, db: FirebaseFirestore.Firestore): Promise<CensusResult> {
  const cikRaw = target.fund_cik.replace(/^0+/, "");
  console.log(`\n─── ${target.alias} (CIK ${target.fund_cik}, period ${target.period}) ───`);

  const latest = await findAccessionForPeriod(target.fund_cik, target.period);
  if (!latest) {
    console.log(`  NO 13F-HR or 13F-HR/A found for period ${target.period}. Skipping.`);
    throw new Error(`no filing for ${target.alias} period ${target.period}`);
  }
  console.log(`  Accession: ${latest.accession}  filed=${latest.filingDate}`);

  const { primaryDocUrl, holdingsUrl } = await findFilingUrls(cikRaw, latest.accession);

  // STEP 1: declared
  const primaryDocXml = await fetchText(primaryDocUrl);
  const declared = parseInfoTableEntryTotal(primaryDocXml);
  const declaredValueTotal = parseTableValueTotal(primaryDocXml);
  const reportType =
    primaryDocXml.match(/<reportType>([^<]+)<\/reportType>/i)?.[1] ?? "(unknown)";
  const otherMgrsStr =
    primaryDocXml.match(/<otherIncludedManagersCount>(\d+)<\/otherIncludedManagersCount>/i)?.[1] ?? "0";
  const otherMgrsCount = parseInt(otherMgrsStr, 10);
  const managerType: "single-manager" | "multi-manager" =
    otherMgrsCount === 0 ? "single-manager" : "multi-manager";
  console.log(`  reportType=${reportType}  otherIncludedManagersCount=${otherMgrsCount}  (${managerType})`);
  console.log(`  declared <tableEntryTotal>=${declared}  <tableValueTotal>=$${declaredValueTotal?.toLocaleString() ?? "(missing)"}`);

  // STEP 2: raw (via parse13FXml)
  const holdingsXml = await fetchText(holdingsUrl);
  const meta = {
    fundName: target.alias,
    fundCik: target.fund_cik,
    accession: latest.accession,
    filingDate: latest.filingDate,
    period: target.period,
    url: holdingsUrl,
    infoTableEntryTotal: declared,
    tableValueTotal: declaredValueTotal,
  } as Parameters<typeof parse13FXml>[1];
  const { holdings, rawRowCount, rawValueSum } = parse13FXml(holdingsXml, meta);
  console.log(`  rawRowCount=${rawRowCount}  rawValueSum=$${rawValueSum.toLocaleString()}  aggregated=${holdings.length}`);

  // STEP 3: stored (Firestore)
  const storedSnap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", target.fund_cik)
    .where("quarter", "==", target.period)
    .get();
  const stored = storedSnap.docs.length;
  const sample =
    stored > 0 ? (storedSnap.docs[0]!.data() as Record<string, unknown>) : {};
  const sampleVerStatus = (sample.verification_status as string | undefined) ?? "(absent)";
  const sampleVerExpected = (sample.verification_expected as number | undefined) ?? "(absent)";
  const sampleVerActual = (sample.verification_actual as number | undefined) ?? "(absent)";
  console.log(`  stored=${stored}  sample.verification_status=${sampleVerStatus}  expected=${sampleVerExpected}  actual=${sampleVerActual}`);

  // CLASSIFY
  let outcome: "a" | "b" | "c" | "anomaly" = "anomaly";
  let outcomeNote = "";
  let valueGate: "PASS" | "FAIL" | "N/A" = "N/A";
  if (declaredValueTotal !== null) {
    valueGate = rawValueSum === declaredValueTotal ? "PASS" : "FAIL";
  }
  if (declared !== null && rawRowCount === declared) {
    // raw matches declared
    if (
      typeof sampleVerActual === "number" &&
      sampleVerActual === holdings.length
    ) {
      outcome = "b";
      outcomeNote =
        `B+ artifact — pre-fix logged aggregated (${holdings.length}) vs declared (${declared}); ` +
        `post-B+ logs raw (${rawRowCount}) === declared → flips VERIFIED`;
    } else {
      outcome = "anomaly";
      outcomeNote = `raw matches declared but sample.verification_actual (${sampleVerActual}) doesn't match aggregated (${holdings.length}). Investigate.`;
    }
  } else if (declared !== null && rawRowCount !== declared) {
    outcome = "c";
    outcomeNote = `RAW (${rawRowCount}) != DECLARED (${declared}). Filing header/body mismatch OR parser excluding ${declared - rawRowCount} lines tableEntryTotal counts. B+ does NOT cleanly sort.`;
  } else {
    outcome = "anomaly";
    outcomeNote = "Missing declared count from primary_doc.xml.";
  }

  return {
    alias: target.alias,
    fund_cik: target.fund_cik,
    period: target.period,
    accession: latest.accession,
    reportType,
    otherMgrsCount,
    managerType,
    declared,
    declaredValueTotal,
    rawRowCount,
    rawValueSum,
    aggregated: holdings.length,
    stored,
    sampleVerStatus,
    sampleVerExpected,
    sampleVerActual,
    outcome,
    outcomeNote,
    valueGate,
  };
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log("Pre-B+-deploy INSUFFICIENT_DATA census — 4-fund widen");
  console.log(`Snapshot at: ${new Date().toISOString()}`);
  console.log("READ-ONLY. Frozen against pre-fix stamps for v4 record.");
  console.log("============================================================");

  const db = await getLiveDb();
  const results: CensusResult[] = [];

  for (const target of TARGETS) {
    try {
      const r = await probeOne(target, db);
      results.push(r);
    } catch (e) {
      console.log(`  ERROR on ${target.alias}: ${(e as Error).message}`);
    }
  }

  console.log("\n\n============================================================");
  console.log("CENSUS SUMMARY");
  console.log("============================================================");
  console.log("");
  console.log("Per-fund three-number census + outcome classification:");
  console.log("");
  console.log(
    `  alias                            | CIK         | accession                | report_type            | mgr_type        | declared | raw    | agg  | stored | sample_ver_actual | value_gate | outcome`,
  );
  console.log(
    `  ---------------------------------|-------------|--------------------------|------------------------|-----------------|----------|--------|------|--------|--------------------|------------|--------`,
  );
  for (const r of results) {
    console.log(
      `  ${r.alias.padEnd(32)} | ${r.fund_cik} | ${r.accession.padEnd(24)} | ${r.reportType.padEnd(22)} | ${r.managerType.padEnd(15)} | ${String(r.declared ?? "-").padStart(8)} | ${String(r.rawRowCount).padStart(6)} | ${String(r.aggregated).padStart(4)} | ${String(r.stored).padStart(6)} | ${String(r.sampleVerActual).padStart(18)} | ${r.valueGate.padStart(10)} | ${r.outcome}`,
    );
  }
  console.log("");
  console.log("Outcome notes:");
  for (const r of results) {
    console.log(`  ${r.alias}: ${r.outcomeNote}`);
  }
  console.log("");
  const outcomes = results.reduce<Record<string, number>>((a, r) => {
    a[r.outcome] = (a[r.outcome] ?? 0) + 1;
    return a;
  }, {});
  console.log("Outcome counts:");
  for (const [k, v] of Object.entries(outcomes)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("");
  if ((outcomes.b ?? 0) === results.length) {
    console.log(`  ✅ ALL ${results.length} FUNDS RESOLVE TO OUTCOME (b). Quarantined 261 population: aggregation artifacts across the board (5/5 INSUFF funds confirmed). B+ commit cleanly unblocked.`);
  } else if ((outcomes.c ?? 0) > 0 || (outcomes.anomaly ?? 0) > 0) {
    console.log(`  ⚠️  ${outcomes.c ?? 0} OUTCOME (c) and/or ${outcomes.anomaly ?? 0} anomalies. B+ commit GATED pending review — these are NOT pure artifacts.`);
  } else if ((outcomes.a ?? 0) > 0) {
    console.log(`  ⚠️  ${outcomes.a} OUTCOME (a) — genuine ingestion omissions. Not blocking B+ commit (B+ is the right fix; these would survive as real INSUFFICIENT_DATA post-deploy as heal candidates) but worth flagging for v4.`);
  }
  console.log("");
  console.log("============================================================");
  console.log("Read-only complete. B+ NOT committed/deployed. Phase B LOCKED.");
  console.log("============================================================");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
