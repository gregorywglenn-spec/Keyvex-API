/**
 * Schedule 13D / 13G scraper — beneficial-ownership disclosures from SEC EDGAR.
 *
 * Anyone acquiring ≥5% of a registered class of equity securities must file
 * within 5 business days (10 calendar days under prior rule). Two flavors:
 *
 *   - **13D**: activist filer, signals intent to influence control. Triggers
 *     are takeover bids, proxy fights, governance demands.
 *   - **13G**: passive filer, no intent to influence. Used by institutional
 *     investors (banks, insurers, registered investment advisers, mutual
 *     funds) and by certain qualified passive holders.
 *
 * As of October 2023, both must be filed in structured XML format. Pre-2023
 * filings ship HTML/text only — this parser silently produces 0 rows for
 * those (acceptable for v1, current-window focused).
 *
 * **Critical schema gotcha** captured in CLAUDE.md Hard Lessons:
 * 13D and 13G use *different* XML schemas, not just naming variations.
 * Branching by submissionType is mandatory.
 *
 * Architecture mirrors src/scrapers/form3.ts and form144.ts:
 *   - Same EDGAR plumbing (submissions API + full-text search)
 *   - Same rawXmlPath() to strip xsl<schema>/ prefix from primaryDocument
 *   - Same multi-owner OR-handling (joint-filer disclosures)
 *   - CIK→ticker reverse lookup since neither schema includes ticker
 *
 * Form code in EDGAR full-text search: "SCHEDULE 13D" / "SCHEDULE 13G" /
 * "SCHEDULE 13D/A" / "SCHEDULE 13G/A" — NOT "SC 13D" (returns zero hits).
 *
 * Data source: SEC EDGAR (https://data.sec.gov, free, no API key).
 */

import { XMLParser } from "fast-xml-parser";
import { preferPrimaryTicker } from "../sec-tickers.js";
import type { ActivistOwnership } from "../types.js";
import { fetchEdgarDailyIndex, fetchPrimaryDocUrl } from "../reconcile/sec-edgar-index.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

const formatAccession = (a: string): string => a.replace(/-/g, "");

/** Strip the xsl<schema>/ prefix from primaryDocument. Same gotcha as Form 144/3. */
function rawXmlPath(primaryDoc: string): string {
  return primaryDoc.replace(/^xsl[A-Z0-9]+\//, "");
}

/** Defensive ticker normalization — strips exchange prefix (NYSE/TRN → TRN). */
function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!t) return "";
  const slashIdx = t.lastIndexOf("/");
  if (slashIdx >= 0) return t.slice(slashIdx + 1);
  return t;
}

/** Replace any path-illegal char so the value is safe in a Firestore doc ID. */
function sanitizeForDocId(s: string): string {
  return s
    .replace(/[/\\#?\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function read(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node.trim();
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && node.value !== undefined) {
    return read(node.value);
  }
  return "";
}

function parseFloatOrZero(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert MM/DD/YYYY → YYYY-MM-DD. 13G's eventDateRequiresFilingThisStatement
 * comes back in US format despite the rest of the system using ISO. Same
 * gotcha that hit Form 144. Returns the input unchanged if already ISO,
 * empty string if input is empty.
 */
function toIsoDate(raw: string): string {
  if (!raw) return "";
  // Accept 1- or 2-digit month/day (e.g. "5/20/2026" or "05/20/2026") and zero-pad.
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  // Already ISO or unrecognized — pass through (defensive).
  return raw;
}

// ─── Ticker ↔ CIK lookup (bidirectional cache) ─────────────────────────────

interface TickerInfo {
  cik: string;
  cikRaw: string;
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;
let cikToTicker: Record<string, string> | null = null;

async function loadCaches(): Promise<void> {
  if (tickerCache && cikToTicker) return;
  const data = (await fetchJson(
    `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
  )) as Record<string, { ticker: string; cik_str: number; title: string }>;
  tickerCache = {};
  cikToTicker = {};
  for (const entry of Object.values(data)) {
    const ticker = entry.ticker.toUpperCase();
    const cikPadded = String(entry.cik_str).padStart(10, "0");
    tickerCache[ticker] = {
      cik: cikPadded,
      cikRaw: String(entry.cik_str),
      name: entry.title,
    };
    // Primary-ticker pick for multi-class CIKs (shared helper; see sec-tickers).
    cikToTicker[cikPadded] = preferPrimaryTicker(cikToTicker[cikPadded], ticker);
  }
}

export async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
  await loadCaches();
  return tickerCache![ticker.toUpperCase()] ?? null;
}

async function getTickerFromCik(cik: string): Promise<string> {
  if (!cik) return "";
  await loadCaches();
  const padded = cik.replace(/^0+/, "").padStart(10, "0");
  return cikToTicker![padded] ?? "";
}

// ─── Filing metadata ────────────────────────────────────────────────────────

interface FilingMeta {
  accession: string;
  /** CIK that appears in the EDGAR archive URL path. May be issuer or filer. */
  archiveCik: string;
  filedAt: string;
  url: string;
}

// ─── XML parsing ────────────────────────────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Same lesson as 13F/Form 144 — keep numeric-looking strings as strings
  // (CIKs with leading zeros, CUSIPs, etc.).
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * Coerce a "reporting person" container to a uniform array. Both schemas
 * support multiple persons under a single filing (joint filers).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asArray(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null) return [];
  return [raw];
}

/**
 * Parse a Schedule 13D or 13G XML document into structured rows.
 * Branches on the top-level submissionType element since the two schemas
 * are meaningfully different (see CLAUDE.md Hard Lessons).
 *
 * Returns one ActivistOwnership row per reporting person (joint filings
 * emit multiple rows from a single accession).
 */
export async function parseActivistXml(
  xmlText: string,
  meta: FilingMeta,
): Promise<ActivistOwnership[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = xml.parse(xmlText);
  const submission = parsed.edgarSubmission;
  if (!submission) return [];

  const submissionType = read(submission.headerData?.submissionType);
  if (
    submissionType !== "SCHEDULE 13D" &&
    submissionType !== "SCHEDULE 13D/A" &&
    submissionType !== "SCHEDULE 13G" &&
    submissionType !== "SCHEDULE 13G/A"
  ) {
    return [];
  }

  const isActivist =
    submissionType === "SCHEDULE 13D" || submissionType === "SCHEDULE 13D/A";
  const dataSource: ActivistOwnership["data_source"] = isActivist
    ? "SEC_EDGAR_13D"
    : "SEC_EDGAR_13G";

  const formData = submission.formData;
  if (!formData) return [];

  // headerData is a SIBLING of formData under edgarSubmission, NOT inside it.
  // Pass it explicitly so branch parsers can fall back to filer credentials
  // when reportingPersonCIK isn't in the form-side blocks (common in 13G).
  const headerData = submission.headerData;

  if (isActivist) {
    return parseSchedule13D(
      formData,
      headerData,
      meta,
      submissionType,
      dataSource,
    );
  }
  return parseSchedule13G(
    formData,
    headerData,
    meta,
    submissionType,
    dataSource,
  );
}

// ─── 13D branch ─────────────────────────────────────────────────────────────

/**
 * 13D schema: namespace=schedule13D, capital "CIK" in issuerCIK, CUSIPs nested
 * inside issuerCusips wrapper, reporting persons under reportingPersons.
 * reportingPersonInfo, fields aggregateAmountOwned + percentOfClass + dateOfEvent.
 */
async function parseSchedule13D(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formData: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headerData: any,
  meta: FilingMeta,
  submissionType: ActivistOwnership["filing_type"],
  dataSource: ActivistOwnership["data_source"],
): Promise<ActivistOwnership[]> {
  // issuerInfo can live at formData.issuerInfo OR formData.coverPageHeader.issuerInfo
  // depending on schema version / filing template. Try both — the wrong one
  // resolves to undefined and read() flows that to "".
  const issuer =
    formData.issuerInfo ?? formData.coverPageHeader?.issuerInfo ?? {};
  // 13D uses uppercase "CIK" in issuerCIK; some templates use lowercase.
  // Try both for robustness.
  const issuerCik = read(issuer.issuerCIK) || read(issuer.issuerCik);
  const issuerName = read(issuer.issuerName) || null;

  // CUSIPs — multiple possible. Take the first; rare to have a meaningfully
  // different second one for the same filing. Some 13D variants flatten this
  // to a single issuerCusip; check that too.
  const cusipRaw =
    issuer.issuerCusips?.issuerCusipNumber ?? issuer.issuerCusip;
  const cusips = asArray(cusipRaw)
    .map((c) => read(c))
    .filter((c) => c);
  const cusip = cusips[0] ?? "";

  const eventDate = toIsoDate(read(formData.coverPageHeader?.dateOfEvent));
  const securityClass = read(formData.coverPageHeader?.securitiesClassTitle);

  const ticker = await getTickerFromCik(issuerCik);

  // headerData filer CIK as fallback for reporters that don't carry their
  // own CIK in the form-side block.
  const headerFilerCik = read(
    headerData?.filerInfo?.filer?.filerCredentials?.cik,
  );

  const reporters = asArray(formData.reportingPersons?.reportingPersonInfo);
  const out: ActivistOwnership[] = [];

  let lineNo = 0;
  for (const r of reporters) {
    lineNo++;
    const filerCik = read(r.reportingPersonCIK) || headerFilerCik;
    const filerName = read(r.reportingPersonName) || "unknown";
    const filerType = read(r.typeOfReportingPerson);
    const citizenship = read(r.citizenshipOrOrganization);

    const sharesOwned = parseFloatOrZero(read(r.aggregateAmountOwned));
    const percent = parseFloatOrZero(read(r.percentOfClass));
    const soleVoting = parseFloatOrZero(read(r.soleVotingPower));
    const sharedVoting = parseFloatOrZero(read(r.sharedVotingPower));
    const soleDisp = parseFloatOrZero(read(r.soleDispositivePower));
    const sharedDisp = parseFloatOrZero(read(r.sharedDispositivePower));

    out.push({
      id: `${meta.accession}-${sanitizeForDocId(ticker || cusip || issuerCik)}-${lineNo}`,
      ticker,
      company_name: issuerName,
      company_cik: issuerCik,
      cusip,
      filer_name: filerName,
      filer_cik: filerCik,
      filer_type: filerType,
      citizenship_or_organization: citizenship,
      filing_type: submissionType,
      is_activist: true,
      shares_owned: sharesOwned,
      percent_of_class: percent,
      sole_voting_power: soleVoting,
      shared_voting_power: sharedVoting,
      sole_dispositive_power: soleDisp,
      shared_dispositive_power: sharedDisp,
      event_date: eventDate || meta.filedAt,
      filing_date: meta.filedAt,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: dataSource,
    });
  }

  // securityClass isn't on the row (we'd need it on its own field); only
  // used for log context. Surface in v1.1 if filers actually file across
  // multiple classes within one row.
  void securityClass;

  return out;
}

// ─── 13G branch ─────────────────────────────────────────────────────────────

/**
 * 13G schema: namespace=schedule13g, lowercase "Cik" in issuerCik, single
 * flat issuerCusip, reporting persons under coverPageHeaderReportingPersonDetails.
 * Fields reportingPersonBeneficiallyOwnedAggregateNumberOfShares + classPercent
 * + eventDateRequiresFilingThisStatement.
 */
async function parseSchedule13G(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formData: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headerData: any,
  meta: FilingMeta,
  submissionType: ActivistOwnership["filing_type"],
  dataSource: ActivistOwnership["data_source"],
): Promise<ActivistOwnership[]> {
  // issuerInfo on 13G is nested under coverPageHeader, not a sibling of formData.
  // (Bug surfaced in Day 4 smoke test: parser was reading formData.issuerInfo
  // and getting undefined, leaving every record with empty issuer fields.)
  // Try both paths — covers any future template variation.
  const issuer =
    formData.coverPageHeader?.issuerInfo ?? formData.issuerInfo ?? {};
  // 13G uses lowercase "Cik" in issuerCik but defend against template variation.
  const issuerCik = read(issuer.issuerCik) || read(issuer.issuerCIK);
  const issuerName = read(issuer.issuerName) || null;
  // 13G uses the same nested CUSIP structure as 13D — issuerCusips.issuerCusipNumber,
  // not a flat issuerCusip field. (My earlier scout's regex tag-list confused
  // <issuerCusips> with <issuerCusip> because the matcher ate the trailing char.)
  // Try the nested path first, fall back to flat for any unusual template.
  const cusipRaw =
    issuer.issuerCusips?.issuerCusipNumber ?? issuer.issuerCusip;
  const cusips = asArray(cusipRaw)
    .map((c) => read(c))
    .filter((c) => c);
  const cusip = cusips[0] ?? "";

  const eventDate = toIsoDate(
    read(formData.coverPageHeader?.eventDateRequiresFilingThisStatement),
  );

  const ticker = await getTickerFromCik(issuerCik);

  // headerData filer CIK as fallback. headerData is a SIBLING of formData
  // under edgarSubmission — passed in as a separate arg, not formData.headerData.
  const headerFilerCik = read(
    headerData?.filerInfo?.filer?.filerCredentials?.cik,
  );

  const reporters = asArray(formData.coverPageHeaderReportingPersonDetails);
  const out: ActivistOwnership[] = [];

  let lineNo = 0;
  for (const r of reporters) {
    lineNo++;
    const filerCik =
      read(r.reportingPersonCIK) || read(r.cik) || headerFilerCik;
    const filerName = read(r.reportingPersonName) || "unknown";
    const filerType = read(r.typeOfReportingPerson);
    const citizenship = read(r.citizenshipOrOrganization);

    const sharesOwned = parseFloatOrZero(
      read(r.reportingPersonBeneficiallyOwnedAggregateNumberOfShares),
    );
    const percent = parseFloatOrZero(read(r.classPercent));
    const soleVoting = parseFloatOrZero(read(r.soleVotingPower));
    const sharedVoting = parseFloatOrZero(read(r.sharedVotingPower));
    const soleDisp = parseFloatOrZero(read(r.soleDispositivePower));
    const sharedDisp = parseFloatOrZero(read(r.sharedDispositivePower));

    out.push({
      id: `${meta.accession}-${sanitizeForDocId(ticker || cusip || issuerCik)}-${lineNo}`,
      ticker,
      company_name: issuerName,
      company_cik: issuerCik,
      cusip,
      filer_name: filerName,
      filer_cik: filerCik,
      filer_type: filerType,
      citizenship_or_organization: citizenship,
      filing_type: submissionType,
      is_activist: false,
      shares_owned: sharesOwned,
      percent_of_class: percent,
      sole_voting_power: soleVoting,
      shared_voting_power: sharedVoting,
      sole_dispositive_power: soleDisp,
      shared_dispositive_power: sharedDisp,
      event_date: eventDate || meta.filedAt,
      filing_date: meta.filedAt,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: dataSource,
    });
  }

  return out;
}

// ─── Fetcher: by ticker (issuer-side) ───────────────────────────────────────

interface SubmissionsResponse {
  filings?: {
    recent?: {
      form: string[];
      accessionNumber: string[];
      filingDate: string[];
      primaryDocument?: string[];
    };
  };
}

/**
 * Fetch all 13D/13G beneficial-ownership disclosures filed AGAINST a ticker
 * (i.e., filings reporting stakes in this company). Pulls up to maxFilings
 * most-recent ones from the issuer's submissions feed.
 */
export async function scrapeActivistByTicker(
  ticker: string,
  maxFilings = 30,
): Promise<ActivistOwnership[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[13d-g] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${info.cik}.json`,
  )) as SubmissionsResponse;
  const recent = subs.filings?.recent;
  if (!recent) return [];

  const filings: FilingMeta[] = [];
  for (let i = 0; i < recent.form.length && filings.length < maxFilings; i++) {
    const form = recent.form[i];
    if (
      form !== "SC 13D" &&
      form !== "SC 13D/A" &&
      form !== "SC 13G" &&
      form !== "SC 13G/A"
    )
      continue;
    const accession = recent.accessionNumber[i];
    const filedAt = recent.filingDate[i];
    if (!accession || !filedAt) continue;
    const accessionNoSlash = formatAccession(accession);
    const primaryDoc = rawXmlPath(recent.primaryDocument?.[i] ?? "");
    filings.push({
      accession,
      archiveCik: info.cikRaw,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${info.cikRaw}/${accessionNoSlash}/${primaryDoc}`,
    });
  }

  console.error(`[13d-g] Found ${filings.length} 13D/13G filings`);

  const allRows: ActivistOwnership[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const rows = await parseActivistXml(xmlText, filing);
      allRows.push(...rows);
      console.error(`[13d-g]   ${filing.accession}: ${rows.length} reporters`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[13d-g]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[13d-g] TOTAL: ${allRows.length} ownership rows for ${ticker}`,
  );
  return allRows;
}

// ─── Fetcher: live feed (cross-issuer) ──────────────────────────────────────

interface EdgarSearchHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    form?: string;
    display_names?: string[];
  };
}

/**
 * Live-feed scan of EDGAR full-text search for recent 13D/13G filings
 * across all issuers. Form codes are "SCHEDULE 13D", "SCHEDULE 13D/A",
 * "SCHEDULE 13G", "SCHEDULE 13G/A" (NOT "SC 13D" — captured as a Hard
 * Lesson). Each form is searched separately to handle EDGAR's per-form
 * 100-result-per-page cap.
 */
export async function scrapeActivistLiveFeed(
  lookbackDays = 7,
  maxFilingsPerForm = 100,
): Promise<ActivistOwnership[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  // Enumerate via EDGAR's COMPLETE daily index, NOT full-text search. FTS
  // silently caps/under-reports — measured recent-window coverage was only
  // 34.5% before this fix (same leak class fixed for N-PORT / Form D / 8-K /
  // Form 144 / Form 3). EDGAR's daily index uses a MIX of "SCHEDULE 13D/G" and
  // legacy "SC 13D" form strings, so match both. The structured doc filename
  // varies, so resolve each via fetchPrimaryDocUrl (index.json). Issuer/filer
  // CIKs come from the XML itself, so the index CIK is only the archive path.
  const forms = [
    "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A",
    "SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A",
  ];
  const seen = new Map<string, { accession: string; archiveCik: string; filedAt: string }>();
  for (let dayOffset = 0; dayOffset <= lookbackDays; dayOffset++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - dayOffset);
    const dayISO = dt.toISOString().split("T")[0] ?? "";
    if (!dayISO) continue;
    let idx: Awaited<ReturnType<typeof fetchEdgarDailyIndex>>;
    try {
      idx = await fetchEdgarDailyIndex(dayISO, forms);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[13d-g live] daily-index ${dayISO}: SKIP — ${msg}`);
      continue;
    }
    for (const f of idx) {
      if (!forms.includes(f.formType)) continue;
      if (seen.has(f.accession)) continue;
      seen.set(f.accession, {
        accession: f.accession,
        archiveCik: f.cik.replace(/^0+/, ""),
        filedAt: f.dateFiled,
      });
    }
  }

  console.error(
    `[13d-g live] ${seen.size} total 13D/13G filings in last ${lookbackDays}d (daily-index)`,
  );

  const allRows: ActivistOwnership[] = [];
  for (const ref of seen.values()) {
    try {
      const url = await fetchPrimaryDocUrl(ref.archiveCik, ref.accession);
      if (!url) {
        console.error(`[13d-g live]   ${ref.accession}: SKIP — no primary XML`);
        continue;
      }
      const filing: FilingMeta = { ...ref, url };
      const xmlText = await fetchText(filing.url);
      const rows = await parseActivistXml(xmlText, filing);
      allRows.push(...rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[13d-g live]   ${ref.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[13d-g live] TOTAL: ${allRows.length} ownership rows from ${seen.size} filings`,
  );
  return allRows;
}
