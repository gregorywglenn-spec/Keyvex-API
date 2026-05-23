/**
 * SPIKE: validate parseForm4Xml on real 2016-2018 Form 4 XMLs.
 *
 * Per Greg's 2026-05-23 brief Adjustment 1: cheaply validate the
 * parser-vs-old-format assumption BEFORE building the bulk-index
 * harness around it. Throwaway script, no new production code.
 *
 * Sampling strategy: 30 filings, mix of years (2016/2017/2018),
 * mix of issuer sizes (mega-cap + smaller), with at least one
 * derivative-heavy and one multi-owner filing expected to surface
 * naturally in the cross-section.
 *
 * What gets checked per filing:
 *   1. parsed.ownershipDocument is defined (the silent-empty foot-gun)
 *   2. parser returned ≥1 trade row (filings with 0 transactions are
 *      legitimate but worth flagging in the audit table)
 *   3. transactionDate year in [2012, current+1] (no year-3031 class)
 *   4. value == shares × price on every parsed row (rounding-tolerant)
 *   5. is_derivative populated (boolean true|false, not undefined)
 *   6. multi-owner array-shape handled when present
 *
 * Output: a markdown-ish table + summary counts. No DB writes.
 */

import { parseForm4Xml } from "../src/scrapers/form4.ts";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const SLEEP_MS = 110; // ~9 req/s target rate (validated here)

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface FtsHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    display_names?: string[];
  };
}

interface FtsResp {
  hits?: { hits?: FtsHit[]; total?: { value?: number } };
}

async function fetchText(url: string): Promise<string> {
  await sleep(SLEEP_MS);
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchJson(url: string): Promise<unknown> {
  await sleep(SLEEP_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Pull Form 4 filings from EDGAR FTS for a date window. Returns up to
 * `take` filings; trims tightly to keep total sample small. Returns
 * (cik, accession, primaryDoc, filedAt) tuples.
 */
async function sampleFormFour(
  startDt: string,
  endDt: string,
  take: number,
): Promise<
  Array<{
    cik: string;
    accession: string;
    primary: string;
    filedAt: string;
    displayName: string;
  }>
> {
  const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt=${startDt}&enddt=${endDt}`;
  const data = (await fetchJson(url)) as FtsResp;
  const hits = data.hits?.hits ?? [];
  const totalForRange = data.hits?.total?.value ?? hits.length;
  console.error(`  [fts] ${startDt}..${endDt}: total=${totalForRange}, returned hits=${hits.length}, sampling ${take}`);
  // Stride-sample so the take spans the whole window evenly, not just the head.
  const stride = Math.max(1, Math.floor(hits.length / take));
  const out: Array<{ cik: string; accession: string; primary: string; filedAt: string; displayName: string }> = [];
  for (let i = 0; i < hits.length && out.length < take; i += stride) {
    const h = hits[i];
    if (!h?._source) continue;
    const ciks = h._source.ciks ?? [];
    // For Form 4, ciks[0] is the reporting owner; ciks[1] is the issuer.
    // The primary XML lives under the issuer's archive.
    const issuerCik = (ciks[1] ?? ciks[0] ?? "").replace(/^0+/, "");
    const accession = h._source.adsh ?? "";
    const filename = (h._id ?? "").split(":")[1] ?? "";
    const filedAt = h._source.file_date ?? "";
    const displayName = h._source.display_names?.[0] ?? "";
    if (!issuerCik || !accession || !filename) continue;
    out.push({ cik: issuerCik, accession, primary: filename, filedAt, displayName });
  }
  return out;
}

interface SpikeResult {
  filedAt: string;
  accession: string;
  cik: string;
  displayName: string;
  ownershipDocDefined: boolean;
  rowsParsed: number;
  multiOwnerCount: number;
  hasDerivativeRow: boolean;
  yearOutOfRange: boolean;
  valueMismatchRows: number;
  isDerivativeAlwaysBool: boolean;
  notes: string;
}

async function probe(
  meta: { cik: string; accession: string; primary: string; filedAt: string; displayName: string },
): Promise<SpikeResult> {
  const accNoSlash = meta.accession.replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${meta.cik}/${accNoSlash}/${meta.primary}`;
  const result: SpikeResult = {
    filedAt: meta.filedAt,
    accession: meta.accession,
    cik: meta.cik,
    displayName: meta.displayName.slice(0, 28),
    ownershipDocDefined: false,
    rowsParsed: 0,
    multiOwnerCount: 0,
    hasDerivativeRow: false,
    yearOutOfRange: false,
    valueMismatchRows: 0,
    isDerivativeAlwaysBool: true,
    notes: "",
  };
  let xml: string;
  try {
    xml = await fetchText(url);
  } catch (e) {
    result.notes = `fetch fail: ${(e as Error).message}`;
    return result;
  }
  // Quick raw check for ownershipDocument presence in the XML text
  result.ownershipDocDefined = /<ownershipDocument/i.test(xml);
  if (!result.ownershipDocDefined) {
    result.notes = "no <ownershipDocument> element in XML";
    return result;
  }
  // Check for multi-owner shape in raw XML
  const reportingOwnerMatches = xml.match(/<reportingOwner>/g);
  result.multiOwnerCount = reportingOwnerMatches ? reportingOwnerMatches.length : 0;
  try {
    const trades = parseForm4Xml(xml, {
      accession: meta.accession,
      companyCik: meta.cik,
      filedAt: meta.filedAt,
      url,
    });
    result.rowsParsed = trades.length;
    const maxAllowedYear = new Date().getUTCFullYear() + 1;
    for (const t of trades) {
      if (t.is_derivative === true) result.hasDerivativeRow = true;
      if (typeof t.is_derivative !== "boolean") result.isDerivativeAlwaysBool = false;
      const yr = parseInt((t.transaction_date || "").slice(0, 4), 10);
      if (isNaN(yr) || yr < 2012 || yr > maxAllowedYear) result.yearOutOfRange = true;
      // value == shares × price within $0.01 (penny tolerance)
      const expected = t.shares * t.price_per_share;
      if (Math.abs(t.total_value - expected) > 0.01) result.valueMismatchRows++;
    }
  } catch (e) {
    result.notes = `parser threw: ${(e as Error).message.slice(0, 100)}`;
  }
  return result;
}

async function main() {
  console.error("=== Form 4 parser SPIKE — 2016/2017/2018 sample ===\n");

  // Sample 10 filings per year (30 total). Stride-sampled across each year.
  const samples: Array<{ cik: string; accession: string; primary: string; filedAt: string; displayName: string }> = [];
  for (const yr of [2016, 2017, 2018]) {
    const yearSamples = await sampleFormFour(`${yr}-01-01`, `${yr}-12-31`, 10);
    console.error(`  collected ${yearSamples.length} samples for ${yr}`);
    samples.push(...yearSamples);
  }

  console.error(`\n=== Probing ${samples.length} filings (throttled ~9 req/s) ===`);
  const results: SpikeResult[] = [];
  let i = 0;
  for (const s of samples) {
    i++;
    const r = await probe(s);
    results.push(r);
    const flag = r.notes ? "FAIL" : r.yearOutOfRange || r.valueMismatchRows > 0 ? "WARN" : "OK  ";
    console.error(`  [${i}/${samples.length}] ${flag}  filed=${r.filedAt}  ${r.accession}  rows=${r.rowsParsed}  ${r.notes}`);
  }

  console.error(`\n=== RESULT TABLE ===`);
  console.log(`| filed_date | issuer (28ch)              | rows | multi_owner | has_deriv | year_OK | value_eq_shares_x_price | is_deriv_bool | notes |`);
  console.log(`|------------|-----------------------------|------|-------------|-----------|---------|-------------------------|---------------|-------|`);
  for (const r of results) {
    const yearOk = r.yearOutOfRange ? "NO" : "YES";
    const valueEq = r.valueMismatchRows === 0 ? "YES" : `NO (${r.valueMismatchRows} bad)`;
    const derivBool = r.isDerivativeAlwaysBool ? "YES" : "NO";
    console.log(`| ${r.filedAt} | ${r.displayName.padEnd(27)} | ${String(r.rowsParsed).padStart(4)} | ${String(r.multiOwnerCount).padStart(11)} | ${(r.hasDerivativeRow ? "YES" : "no").padStart(9)} | ${yearOk.padStart(7)} | ${valueEq.padStart(23)} | ${derivBool.padStart(13)} | ${r.notes || ""} |`);
  }

  // Summary
  const total = results.length;
  const ownershipDocFailures = results.filter((r) => !r.ownershipDocDefined).length;
  const parseThrew = results.filter((r) => r.notes.startsWith("parser threw")).length;
  const fetchFails = results.filter((r) => r.notes.startsWith("fetch fail")).length;
  const yearOOR = results.filter((r) => r.yearOutOfRange).length;
  const valueIssues = results.filter((r) => r.valueMismatchRows > 0).length;
  const nonBoolDeriv = results.filter((r) => !r.isDerivativeAlwaysBool).length;
  const zeroRowsButOK = results.filter((r) => r.rowsParsed === 0 && r.ownershipDocDefined && !r.notes).length;
  const multiOwnerHit = results.filter((r) => r.multiOwnerCount > 1).length;
  const derivHit = results.filter((r) => r.hasDerivativeRow).length;

  console.error(`\n=== SUMMARY ===`);
  console.error(`  total sampled:                  ${total}`);
  console.error(`  fetch failures:                 ${fetchFails}`);
  console.error(`  parser threw:                   ${parseThrew}`);
  console.error(`  ownershipDocument missing:      ${ownershipDocFailures}  (silent-empty foot-gun if any > 0)`);
  console.error(`  parsed 0 rows despite OK doc:   ${zeroRowsButOK}  (legitimate if filing had no qualifying tx codes)`);
  console.error(`  transaction year out of range:  ${yearOOR}  (year-3031 class)`);
  console.error(`  value ≠ shares × price rows:    ${valueIssues}  (penny tolerance)`);
  console.error(`  is_derivative non-boolean rows: ${nonBoolDeriv}`);
  console.error(`  multi-owner filings hit:        ${multiOwnerHit}  (need ≥1 for coverage)`);
  console.error(`  derivative-row filings hit:     ${derivHit}  (need ≥1 for coverage)`);

  const cleanGate =
    fetchFails === 0 &&
    parseThrew === 0 &&
    ownershipDocFailures === 0 &&
    yearOOR === 0 &&
    valueIssues === 0 &&
    nonBoolDeriv === 0 &&
    multiOwnerHit >= 1 &&
    derivHit >= 1;
  console.error(`\n  CLEAN GATE: ${cleanGate ? "PASS" : "FAIL"}`);
  if (!cleanGate) {
    console.error(`    → DO NOT build the harness. Investigate the failure(s) above first.`);
  } else {
    console.error(`    → Proceed to harness build (items 1-8).`);
  }
}

main().catch((e) => {
  console.error("UNHANDLED:", e);
  process.exit(1);
});
