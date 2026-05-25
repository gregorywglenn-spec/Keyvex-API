/**
 * Acceptance fixture for Phase A §1 count-check fix (2026-05-25).
 *
 * Validates that `parse13FXml` returns the RAW <infoTable> element count
 * (BEFORE option filtering or CUSIP aggregation) so the §1 verification
 * check can match the SEC filer's own declared `<tableEntryTotal>` exactly.
 *
 * Pre-fix bug: §1 compared aggregated-by-CUSIP storage count vs raw
 * declared count. False-positive'd as INSUFFICIENT_DATA on every filing
 * with sub-account dupes — i.e. essentially every major filer.
 *
 * Acceptance criteria (Greg, 2026-05-25):
 *   "A combination report and a dupe-having holdings report both stamp
 *   VERIFIED when fully parsed."
 *
 * Synthetic cases (offline, fast):
 *   1. CLEAN     — 3 rows, no dupes, no options. tableEntryTotal=3.
 *                  Expect VERIFIED, rawRowCount=3, holdings=3.
 *   2. DUPES     — 5 rows, 2 share a CUSIP (sub-account dupes).
 *                  tableEntryTotal=5. Expect VERIFIED, raw=5, holdings=4.
 *   3. OPTIONS   — 4 rows, 1 Call option. tableEntryTotal=4.
 *                  Expect VERIFIED, raw=4, holdings=3 (option filtered out).
 *   4. TRUNCATED — 3 rows but primary_doc declares 5 (simulating dropped
 *                  rows / truncation). Expect INSUFFICIENT_DATA, raw=3.
 *
 * Real-world cases (live SEC EDGAR fetch):
 *   5. BERKSHIRE Q1-2026 — 90-row holdings report. Expect VERIFIED.
 *   6. BLACKROCK Q1-2026 — 50,651-row combination report (23 MB XML).
 *                          Expect VERIFIED. THIS is the case the bug
 *                          was hiding from. Run with --real to enable
 *                          (skip by default for fast iteration).
 *
 * Basket scan (--scan): the 10 TRACKED_FUNDS CIKs (BlackRock corrected to
 * the post-2024 entity 2012383). Confirms raw vs declared AND Σ <value> vs
 * <tableValueTotal> across diverse filer shapes — combination reports,
 * included-managers holdings reports, pod-style multi-sub-account, and
 * single-row-per-position filers.
 *
 * SCOPE CAVEAT — recorded 2026-05-25:
 *   "12/12 PASS" across this basket is sufficient evidence that the §1
 *   integrity primitive holds across the universe KeyVex CURRENTLY tracks.
 *   It is NOT proof that raw count + raw value sum match declared totals
 *   for every 13F filer in EDGAR. A future audit that adds non-US
 *   managers, restated / amended filings, or filers using less-common
 *   schema dialects should re-probe before treating the basket result as
 *   universal. The §1 guard itself is the safety net: any filer using a
 *   different convention gets stamped INSUFFICIENT_DATA, which is the
 *   honest failure direction.
 *
 * READ-ONLY. No writes, no Firestore.
 */

import { XMLParser } from "fast-xml-parser";
import { parse13FXml } from "../src/scrapers/13f.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://www.sec.gov";
const SEC_DATA = "https://data.sec.gov";

// MUST mirror the XMLParser config inside src/scrapers/13f.ts exactly. Different
// settings produce different parsed shapes — the whole point of the
// aggregation probe is to compare raw XML against the parser's own output,
// not against a divergent interpretation.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function readField(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["#text"] !== undefined) return readField(o["#text"]);
    if (o.value !== undefined) return readField(o.value);
  }
  return "";
}

// ───────────────────────────────────────────────────────────────────────────
// Inlined copy of 13f.ts's parseInfoTableEntryTotal (not exported there).
// Match `<tableEntryTotal>` (canonical) OR `<infoTableEntryTotal>` (alias),
// with optional namespace prefix.
// ───────────────────────────────────────────────────────────────────────────
function parseInfoTableEntryTotal(primaryDocXml: string): number | null {
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?(?:info)?tableEntryTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Pull SEC's declared <tableValueTotal> from primary_doc.xml's summary page.
 * This is the filer's own dollar-total for the filing — the gold-standard
 * cross-check against per-row value sums. If voting-authority-split rows
 * were inflating any sum, this number wouldn't match Σ(raw <value>).
 */
function parseTableValueTotal(primaryDocXml: string): number | null {
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?tableValueTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// (sumRawValueAcrossAllRows removed — parse13FXml now returns rawValueSum
// directly, so the fixture compares the same value production uses to make
// the stamp decision. Per-CUSIP raw_sum via rawByCusip is still needed for
// the aggregation probe and stays below.)

// ───────────────────────────────────────────────────────────────────────────
// Replicate the §1 verification logic exactly as scrape13FByFund applies it.
// Two INDEPENDENT integrity gates, AND'd: row count AND value sum. Either
// failing → INSUFFICIENT_DATA. Missing landmark → INSUFFICIENT_DATA. Mirrors
// production exactly (2026-05-25). NOT decoupled, NOT OR'd — a passing
// value-sum cannot suppress a failing row-count and vice versa.
// ───────────────────────────────────────────────────────────────────────────
function verifyStamp(
  rawRowCount: number,
  declaredRows: number | null,
  rawValueSum: number,
  declaredValue: number | null,
): "VERIFIED" | "INSUFFICIENT_DATA" {
  if (declaredRows === null) return "INSUFFICIENT_DATA";
  if (declaredValue === null) return "INSUFFICIENT_DATA";
  if (rawRowCount !== declaredRows) return "INSUFFICIENT_DATA";
  if (rawValueSum !== declaredValue) return "INSUFFICIENT_DATA";
  return "VERIFIED";
}

// ───────────────────────────────────────────────────────────────────────────
// XML builder for synthetic fixtures.
//
// A real informationTable element shape (per SEC 13F XML schema):
//   <informationTable>
//     <infoTable>
//       <nameOfIssuer>...</nameOfIssuer>
//       <cusip>...</cusip>
//       <value>...</value>
//       <shrsOrPrnAmt>
//         <sshPrnamt>...</sshPrnamt>
//         <sshPrnamtType>SH</sshPrnamtType>
//       </shrsOrPrnAmt>
//       <investmentDiscretion>SOLE</investmentDiscretion>
//       <putCall>Put|Call</putCall>     <!-- optional, only on options -->
//     </infoTable>
//     ...
//   </informationTable>
// ───────────────────────────────────────────────────────────────────────────
interface SyntheticRow {
  name: string;
  cusip: string;
  value: number;
  shares: number;
  putCall?: "Put" | "Call";
}
function buildInformationTableXml(rows: SyntheticRow[]): string {
  const rowXml = rows
    .map(
      (r) => `  <infoTable>
    <nameOfIssuer>${r.name}</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>${r.cusip}</cusip>
    <value>${r.value}</value>
    <shrsOrPrnAmt>
      <sshPrnamt>${r.shares}</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>${r.putCall ? `\n    <putCall>${r.putCall}</putCall>` : ""}
    <votingAuthority>
      <Sole>${r.shares}</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<informationTable>
${rowXml}
</informationTable>`;
}

// Stable test FilingMeta — synthetic rows go through parse13FXml with this
// metadata. Both landmarks (infoTableEntryTotal, tableValueTotal) are
// overridden per-case for the §1 simulation. FilingMeta is internal to
// 13f.ts; we recover its shape via Parameters.
type FilingMeta = Parameters<typeof parse13FXml>[1];

function makeMeta(declared: {
  rows: number | null;
  value: number | null;
}): FilingMeta {
  return {
    fundName: "Test Fund",
    fundCik: "0000000000",
    accession: "0000000000-00-000000",
    filingDate: "2026-03-31",
    period: "2026-03-31",
    url: "https://example.test/fixture",
    infoTableEntryTotal: declared.rows,
    tableValueTotal: declared.value,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Assertion helper. Prints a banner per case and exits with code 1 on
// any failure so CI / repeat runs surface regressions.
// ───────────────────────────────────────────────────────────────────────────
let failures = 0;
function expect<T>(actual: T, expected: T, label: string): void {
  const pass = actual === expected;
  const tag = pass ? "PASS" : "FAIL";
  console.log(`     ${tag.padEnd(4)} ${label}: actual=${String(actual)} expected=${String(expected)}`);
  if (!pass) failures += 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Case runner — drives a synthetic XML through parse13FXml + verifyStamp
// and asserts all FOUR values (rawRowCount, rawValueSum, holdings.length,
// status). The two integrity gates (row count + value sum) are exercised
// independently per case to confirm they're AND'd in production.
// ───────────────────────────────────────────────────────────────────────────
interface SyntheticCase {
  label: string;
  rows: SyntheticRow[];
  declared: { rows: number | null; value: number | null };
  expectRawCount: number;
  expectRawValueSum: number;
  expectHoldingsCount: number;
  expectStatus: "VERIFIED" | "INSUFFICIENT_DATA";
}
function runSyntheticCase(c: SyntheticCase): void {
  console.log(`\n  Case: ${c.label}`);
  const xml = buildInformationTableXml(c.rows);
  const meta = makeMeta(c.declared);
  const { holdings, rawRowCount, rawValueSum } = parse13FXml(xml, meta);
  const status = verifyStamp(
    rawRowCount,
    c.declared.rows,
    rawValueSum,
    c.declared.value,
  );
  expect(rawRowCount, c.expectRawCount, "rawRowCount");
  expect(rawValueSum, c.expectRawValueSum, "rawValueSum");
  expect(holdings.length, c.expectHoldingsCount, "holdings.length");
  expect(status, c.expectStatus, "verifyStamp(...)");
}

// ───────────────────────────────────────────────────────────────────────────
// Real-world fetcher. Polite rate limit (300 ms between requests).
// ───────────────────────────────────────────────────────────────────────────
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface IndexFile {
  name: string;
  type?: string;
}
interface IndexResponse {
  directory?: { item?: IndexFile[] };
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

/**
 * Resolve the latest 13F-HR or 13F-HR/A accession for a CIK. Returns null if
 * the entity exists but has no 13F-HR filings in the most-recent submissions
 * window (e.g., a fund that retired or hasn't filed yet this quarter).
 */
async function findLatestAccession(
  cikPadded: string,
): Promise<{ accession: string; reportDate: string; entityName: string } | null> {
  const url = `${SEC_DATA}/submissions/CIK${cikPadded}.json`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Submissions HTTP ${res.status} for CIK ${cikPadded}`);
  const data = (await res.json()) as SubmissionsResponse;
  await sleep(300);
  const r = data.filings?.recent;
  if (!r) return null;
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (form === "13F-HR" || form === "13F-HR/A") {
      return {
        accession: r.accessionNumber[i] ?? "",
        reportDate: r.reportDate[i] ?? "",
        entityName: data.name ?? cikPadded,
      };
    }
  }
  return null;
}

/**
 * Group the RAW <infoTable> rows by CUSIP, applying the same filters as
 * parse13FXml (drop options, drop zero-value, drop empty). Returns per-CUSIP
 * raw aggregates so we can compare against the parser's stored holdings
 * and confirm aggregation actually SUMS shares/value rather than keeping
 * the first row and dropping the rest.
 */
function rawByCusip(holdingsXml: string): Map<
  string,
  { rawCount: number; shares: number; value: number; issuer: string }
> {
  const parsed = xmlParser.parse(holdingsXml) as Record<string, unknown>;
  const root =
    (parsed.informationTable as Record<string, unknown> | undefined) ?? parsed;
  const entriesRaw = (root as Record<string, unknown>)?.infoTable;
  const entries: unknown[] = Array.isArray(entriesRaw)
    ? entriesRaw
    : entriesRaw
      ? [entriesRaw]
      : [];
  const m = new Map<
    string,
    { rawCount: number; shares: number; value: number; issuer: string }
  >();
  for (const e of entries) {
    const entry = e as Record<string, unknown>;
    const cusip = readField(entry.cusip);
    const issuer = readField(entry.nameOfIssuer);
    const value = parseInt(readField(entry.value), 10) || 0;
    const putCall = readField(entry.putCall);
    const sshRaw = readField(
      (entry.shrsOrPrnAmt as Record<string, unknown> | undefined)?.sshPrnamt,
    );
    const shares = parseInt(sshRaw, 10) || 0;

    // Mirror parse13FXml's filters exactly
    if (putCall === "Put" || putCall === "Call") continue;
    if (!issuer || !cusip || value === 0) continue;

    const cur = m.get(cusip) ?? {
      rawCount: 0,
      shares: 0,
      value: 0,
      issuer,
    };
    cur.rawCount += 1;
    cur.shares += shares;
    cur.value += value;
    m.set(cusip, cur);
  }
  return m;
}

async function fetchAccessionFiles(
  cikRaw: string,
  accession: string,
): Promise<{ holdingsUrl: string; primaryDocUrl: string }> {
  const accNoSlash = accession.replace(/-/g, "");
  const indexUrl = `${SEC}/Archives/edgar/data/${cikRaw}/${accNoSlash}/index.json`;
  const indexRes = await fetch(indexUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!indexRes.ok) throw new Error(`Index HTTP ${indexRes.status}`);
  const index = (await indexRes.json()) as IndexResponse;
  await sleep(300);
  const items = index.directory?.item ?? [];
  const xmlFiles = items.filter((f) => f.name.endsWith(".xml"));
  const holdings =
    xmlFiles.find((f) => f.name.toLowerCase().includes("infotable")) ??
    xmlFiles.find((f) => !f.name.toLowerCase().includes("primary_doc"));
  const primary = xmlFiles.find((f) =>
    f.name.toLowerCase().includes("primary_doc"),
  );
  if (!holdings) throw new Error(`No holdings XML in ${accession}`);
  if (!primary) throw new Error(`No primary_doc.xml in ${accession}`);
  return {
    holdingsUrl: `${SEC}/Archives/edgar/data/${cikRaw}/${accNoSlash}/${holdings.name}`,
    primaryDocUrl: `${SEC}/Archives/edgar/data/${cikRaw}/${accNoSlash}/${primary.name}`,
  };
}

async function runRealCase(
  label: string,
  cikRaw: string,
  accession: string,
  opts: { probeAggregation?: boolean } = {},
): Promise<{
  rawRowCount: number;
  declared: number | null;
  status: "VERIFIED" | "INSUFFICIENT_DATA";
  aggregatedCount: number;
  bytes: number;
}> {
  console.log(`\n  Case: ${label} (${accession})`);
  const t0 = Date.now();
  const { holdingsUrl, primaryDocUrl } = await fetchAccessionFiles(cikRaw, accession);
  const primaryDocXml = await fetchText(primaryDocUrl);
  await sleep(300);
  const declared = parseInfoTableEntryTotal(primaryDocXml);
  const declaredValueTotal = parseTableValueTotal(primaryDocXml);
  console.log(`     SEC declared <tableEntryTotal>  = ${declared ?? "(missing)"}`);
  console.log(`     SEC declared <tableValueTotal>  = ${declaredValueTotal !== null ? "$" + declaredValueTotal.toLocaleString() : "(missing)"}`);
  console.log(`     fetching holdings XML — ${holdingsUrl}`);
  const holdingsXml = await fetchText(holdingsUrl);
  const bytes = Buffer.byteLength(holdingsXml, "utf8");
  console.log(`     received ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  // Both landmarks flow into the meta — parse13FXml itself doesn't use them
  // (it only emits raw counts), but verifyStamp mirrors production's AND-
  // gate using the meta's declared values.
  const meta = makeMeta({ rows: declared, value: declaredValueTotal });
  const { holdings, rawRowCount, rawValueSum } = parse13FXml(holdingsXml, meta);
  const status = verifyStamp(rawRowCount, declared, rawValueSum, declaredValueTotal);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `     parsed in ${elapsed}s: rawRowCount=${rawRowCount}  rawValueSum=$${rawValueSum.toLocaleString()}  aggregated holdings=${holdings.length}  status=${status}`,
  );
  if (declared === null) {
    console.log(`     SKIP row-count assertion (no declared count to compare)`);
  } else {
    expect(rawRowCount, declared, `gate 1: rawRowCount === <tableEntryTotal> (${declared})`);
  }
  if (declaredValueTotal === null) {
    console.log(`     SKIP value-sum assertion (no declared value to compare)`);
  } else {
    const valueOk = rawValueSum === declaredValueTotal;
    if (!valueOk) {
      console.log(
        `     value-sum mismatch: Σ(raw <value>)=$${rawValueSum.toLocaleString()} vs <tableValueTotal>=$${declaredValueTotal.toLocaleString()}`,
      );
    }
    expect(
      rawValueSum,
      declaredValueTotal,
      `gate 2: Σ raw <value> === <tableValueTotal>`,
    );
  }
  if (declared !== null && declaredValueTotal !== null) {
    expect(status, "VERIFIED", "verifyStamp(both gates AND'd)");
  }

  // ───────────── Aggregation probe (Greg, 2026-05-25) ─────────────
  // For the BlackRock 9× collapse case (and any filing with sub-account
  // dupes), confirm the parser is SUMMING shares/value across collapsed
  // rows — not silently keeping the first and dropping the rest. We
  // re-parse the same XML with the SAME XMLParser config and the SAME
  // filters (no options, no zero-value, no empty), bucket per-CUSIP,
  // and compare sum-of-raw against the parser's aggregated holding.
  if (opts.probeAggregation) {
    const raw = rawByCusip(holdingsXml);
    const dupedCusips = Array.from(raw.entries())
      .filter(([, v]) => v.rawCount > 1)
      .sort((a, b) => b[1].rawCount - a[1].rawCount);
    console.log(
      `     aggregation probe: ${dupedCusips.length} CUSIPs have rawCount > 1 (sub-account dupes)`,
    );
    if (dupedCusips.length === 0) {
      console.log(`       (no dupes to probe — nothing to check)`);
    } else {
      const top = dupedCusips.slice(0, 5);
      console.log(
        `       Top ${top.length} duped CUSIPs — raw sums vs parser-aggregated:`,
      );
      const byCusip = new Map(
        holdings.map((h) => [h.cusip, h] as const),
      );
      for (const [cusip, v] of top) {
        const stored = byCusip.get(cusip);
        const sharesMatch = stored?.shares_held === v.shares;
        const valueMatch = stored?.market_value === v.value;
        const tag = sharesMatch && valueMatch ? "PASS" : "FAIL";
        console.log(
          `         ${tag} ${cusip} (${v.issuer.slice(0, 30).padEnd(30)}) rawRows=${v.rawCount}  raw_sum_shares=${v.shares.toLocaleString().padStart(13)}  parser_shares=${(stored?.shares_held ?? 0).toLocaleString().padStart(13)}  raw_sum_value=$${v.value.toLocaleString().padStart(15)}  parser_value=$${(stored?.market_value ?? 0).toLocaleString().padStart(15)}`,
        );
        if (!sharesMatch || !valueMatch) failures += 1;
      }
    }
  }

  return {
    rawRowCount,
    declared,
    status,
    aggregatedCount: holdings.length,
    bytes,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
async function main() {
  const runReal = process.argv.includes("--real");
  const runScan = process.argv.includes("--scan");

  console.log("=================================================================");
  console.log("Phase A §1 count-check — acceptance fixture (2026-05-25)");
  console.log("=================================================================");
  console.log("");
  console.log("Synthetic cases (offline):");

  runSyntheticCase({
    label: "1. CLEAN — 3 rows, no dupes, no options, declared matches both gates",
    rows: [
      { name: "ACME CORP",  cusip: "000000001", value: 1_000_000, shares: 1000 },
      { name: "BETA INC",   cusip: "000000002", value: 2_000_000, shares: 2000 },
      { name: "GAMMA LLC",  cusip: "000000003", value: 3_000_000, shares: 3000 },
    ],
    declared: { rows: 3, value: 6_000_000 },
    expectRawCount: 3,
    expectRawValueSum: 6_000_000,
    expectHoldingsCount: 3,
    expectStatus: "VERIFIED",
  });

  runSyntheticCase({
    label: "2. DUPES — 5 rows, 2 share CUSIP (sub-account dupes), both gates pass",
    rows: [
      { name: "ACME CORP", cusip: "000000001", value: 1_000_000, shares: 1000 },
      { name: "ACME CORP", cusip: "000000001", value:   500_000, shares:  500 },
      { name: "BETA INC",  cusip: "000000002", value: 2_000_000, shares: 2000 },
      { name: "GAMMA LLC", cusip: "000000003", value: 3_000_000, shares: 3000 },
      { name: "GAMMA LLC", cusip: "000000003", value:   100_000, shares:  100 },
    ],
    declared: { rows: 5, value: 6_600_000 },
    expectRawCount: 5,
    expectRawValueSum: 6_600_000,
    expectHoldingsCount: 3, // 5 raw → 3 unique CUSIPs after aggregation
    expectStatus: "VERIFIED",
  });

  runSyntheticCase({
    label: "3. OPTIONS — 4 rows, 1 Call (filtered from storage but counted in raw value sum)",
    rows: [
      { name: "ACME CORP", cusip: "000000001", value: 1_000_000, shares: 1000 },
      { name: "BETA INC",  cusip: "000000002", value: 2_000_000, shares: 2000 },
      { name: "DELTA CO",  cusip: "000000004", value:   500_000, shares:  100, putCall: "Call" },
      { name: "GAMMA LLC", cusip: "000000003", value: 3_000_000, shares: 3000 },
    ],
    declared: { rows: 4, value: 6_500_000 }, // includes the option's $0.5M
    expectRawCount: 4,
    expectRawValueSum: 6_500_000,
    expectHoldingsCount: 3, // option dropped during aggregation
    expectStatus: "VERIFIED",
  });

  runSyntheticCase({
    label: "4. TRUNCATED — 3 rows but primary_doc declares 5 rows / $10M (truncation sim, BOTH gates fail)",
    rows: [
      { name: "ACME CORP", cusip: "000000001", value: 1_000_000, shares: 1000 },
      { name: "BETA INC",  cusip: "000000002", value: 2_000_000, shares: 2000 },
      { name: "GAMMA LLC", cusip: "000000003", value: 3_000_000, shares: 3000 },
    ],
    declared: { rows: 5, value: 10_000_000 },
    expectRawCount: 3,
    expectRawValueSum: 6_000_000,
    expectHoldingsCount: 3,
    expectStatus: "INSUFFICIENT_DATA",
  });

  runSyntheticCase({
    label: "5. ROW-COUNT-PASS-VALUE-FAIL — 3 rows match declared rows but value sum is wrong (synthetic voting-auth-split mock)",
    rows: [
      { name: "ACME CORP", cusip: "000000001", value: 1_000_000, shares: 1000 },
      { name: "BETA INC",  cusip: "000000002", value: 2_000_000, shares: 2000 },
      { name: "GAMMA LLC", cusip: "000000003", value: 3_000_000, shares: 3000 },
    ],
    declared: { rows: 3, value: 4_000_000 }, // rows match, value mismatches → value gate must fire
    expectRawCount: 3,
    expectRawValueSum: 6_000_000,
    expectHoldingsCount: 3,
    expectStatus: "INSUFFICIENT_DATA",
  });

  runSyntheticCase({
    label: "6. VALUE-PASS-ROW-COUNT-FAIL — value sum matches but row count is wrong (independence proof)",
    rows: [
      { name: "ACME CORP", cusip: "000000001", value: 3_000_000, shares: 1000 },
      { name: "BETA INC",  cusip: "000000002", value: 3_000_000, shares: 2000 },
    ],
    declared: { rows: 3, value: 6_000_000 }, // value matches, rows mismatch → row gate must fire
    expectRawCount: 2,
    expectRawValueSum: 6_000_000,
    expectHoldingsCount: 2,
    expectStatus: "INSUFFICIENT_DATA",
  });

  if (!runReal && !runScan) {
    console.log("\n  (Skipping real-world cases. Re-run with --real (named cases) or --scan (basket).)");
  }

  if (runReal) {
    console.log("\nReal-world cases (live SEC EDGAR fetch):");
    try {
      await runRealCase(
        "5. BERKSHIRE Q1-2026 — 90-row holdings report",
        "1067983",
        "0001193125-26-226661",
        { probeAggregation: true },
      );
    } catch (e) {
      console.log(`     ERROR: ${(e as Error).message}`);
      failures += 1;
    }
    try {
      await runRealCase(
        "6. BLACKROCK INC Q1-2026 — 50,651-row combination report (23 MB)",
        "2012383",
        "0002012383-26-001841",
        { probeAggregation: true },
      );
    } catch (e) {
      console.log(`     ERROR: ${(e as Error).message}`);
      failures += 1;
    }
  }

  if (runScan) {
    // The 10 TRACKED_FUNDS CIKs, with BlackRock corrected to the post-2024
    // entity (2012383). The CIK swap itself is queued for "A" — we're using
    // the corrected CIK here ONLY for the test sweep, not modifying the
    // production map.
    const basket: Array<{ alias: string; cik: string }> = [
      { alias: "berkshire",    cik: "0001067983" },
      { alias: "blackrock-new", cik: "0002012383" }, // POST-MIGRATION
      { alias: "vanguard",     cik: "0000102909" },
      { alias: "bridgewater",  cik: "0001350694" },
      { alias: "citadel",      cik: "0001423053" },
      { alias: "point72",      cik: "0001603466" },
      { alias: "deshaw",       cik: "0001009207" },
      { alias: "renaissance",  cik: "0001037389" },
      { alias: "twosigma",     cik: "0001179392" },
      { alias: "millennium",   cik: "0001273087" },
    ];
    console.log("\nBASKET SCAN — latest 13F-HR for each tracked fund:");
    console.log(
      `Goal: confirm raw <infoTable> count === declared <tableEntryTotal> across diverse filers, not just the two we've tested.`,
    );
    const summary: Array<{
      alias: string;
      cik: string;
      reportDate: string;
      rawRowCount: number;
      declared: number | null;
      status: string;
      aggregated: number;
    }> = [];
    for (const f of basket) {
      try {
        const latest = await findLatestAccession(f.cik);
        if (!latest) {
          console.log(`\n  ${f.alias} (CIK ${f.cik}): no 13F-HR in recent submissions — SKIP`);
          summary.push({ alias: f.alias, cik: f.cik, reportDate: "-", rawRowCount: -1, declared: null, status: "NO-FILING", aggregated: -1 });
          continue;
        }
        const cikRaw = f.cik.replace(/^0+/, "");
        const r = await runRealCase(
          `${f.alias} — latest 13F-HR (${latest.entityName}, period ${latest.reportDate})`,
          cikRaw,
          latest.accession,
          { probeAggregation: true },
        );
        summary.push({
          alias: f.alias,
          cik: f.cik,
          reportDate: latest.reportDate,
          rawRowCount: r.rawRowCount,
          declared: r.declared,
          status: r.status,
          aggregated: r.aggregatedCount,
        });
      } catch (e) {
        console.log(`     ERROR: ${(e as Error).message}`);
        summary.push({ alias: f.alias, cik: f.cik, reportDate: "-", rawRowCount: -1, declared: null, status: "ERROR", aggregated: -1 });
        failures += 1;
      }
    }
    console.log("\n  BASKET SCAN SUMMARY");
    console.log(
      `  alias           | cik        | period      | raw     | declared | aggregated | status`,
    );
    console.log(
      `  ----------------|------------|-------------|---------|----------|------------|----------------------`,
    );
    for (const s of summary) {
      console.log(
        `  ${s.alias.padEnd(15)} | ${s.cik}  | ${s.reportDate.padEnd(11)} | ${String(s.rawRowCount === -1 ? "-" : s.rawRowCount).padStart(7)} | ${String(s.declared ?? "-").padStart(8)} | ${String(s.aggregated === -1 ? "-" : s.aggregated).padStart(10)} | ${s.status}`,
      );
    }
  }

  console.log("\n=================================================================");
  console.log(
    failures === 0
      ? "ALL ASSERTIONS PASSED"
      : `${failures} ASSERTION(S) FAILED`,
  );
  console.log("=================================================================");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
