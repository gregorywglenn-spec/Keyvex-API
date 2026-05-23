/**
 * Form 4 scraper — open-market insider transactions from SEC EDGAR.
 *
 * Ported from C:\CapitalEdge-API\reference\form4_scraper.js (browser version)
 * to Node + TypeScript:
 *   - DOMParser/querySelector → fast-xml-parser
 *   - Browser-only IIFE wrapper dropped → ES module exports
 *   - Direct Firestore write removed → returns InsiderTransaction[],
 *     caller decides what to do with the results (save, return, etc.)
 *   - MIN_TRADE_VALUE filter dropped → API/MCP customer should filter,
 *     not the scraper
 *   - signal_weight dropped from output → that's a derived field that
 *     belongs to the dashboard product, not the data product (MCP/API
 *     stays in pure-publisher posture per TOOL_DESIGN.md)
 *
 * Data source: SEC EDGAR (https://data.sec.gov, free, no API key).
 * Rate limit: 10 req/sec per IP. We use 150ms delays = ~6 req/sec.
 * Required header: User-Agent identifying the requester.
 */

import { XMLParser } from "fast-xml-parser";
import type { InsiderTransaction } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  /**
   * 110ms ≈ 9 req/s — SEC's published ceiling is 10/s; 9/s leaves burst
   * headroom. Bumped 2026-05-23 from 150 → 110 per the Form 4 backfill
   * brief (also hardens the existing prod scrapers — they get one more
   * request/sec of throughput for the same SEC-relationship cost).
   */
  RATE_LIMIT_MS: 110,
  /** Max retries on 429 + 5xx. After this many failures, the per-filing
   *  caller skips and continues; doesn't propagate the failure upward. */
  MAX_RETRIES: 5,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch helper with exponential backoff on 429 + 5xx + network errors.
 * Honors Retry-After header on 429 when present (SEC uses this).
 *
 * Greg's 2026-05-23 finding: the previous fetch helpers threw on first
 * failure, leaving prod scrapers fragile against any transient SEC
 * blip. This adds 429 + 5xx retry-with-backoff to BOTH backfill code
 * AND existing live scrapers (since they share fetchText/fetchJson).
 *
 * Returns the Response on success; throws after MAX_RETRIES with the
 * last error message.
 */
async function fetchWithBackoff(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let lastErr: string = "";
  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    await sleep(CONFIG.RATE_LIMIT_MS);
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastErr = `network: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < CONFIG.MAX_RETRIES) {
        const wait = Math.min(60000, 1000 * Math.pow(2, attempt));
        console.error(
          `[edgar] ${url.slice(-60)}: network error, retry ${attempt + 1}/${CONFIG.MAX_RETRIES} in ${wait}ms — ${lastErr}`,
        );
        await sleep(wait);
        continue;
      }
      throw new Error(`EDGAR network failed after ${CONFIG.MAX_RETRIES} retries: ${lastErr} — ${url}`);
    }

    // 429: rate-limited. Honor Retry-After if present; else exponential backoff.
    if (res.status === 429) {
      const retryAfterRaw = res.headers.get("retry-after") ?? "";
      const retryAfterSec = parseInt(retryAfterRaw, 10);
      const wait = !Number.isNaN(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : Math.min(60000, 1000 * Math.pow(2, attempt));
      if (attempt < CONFIG.MAX_RETRIES) {
        console.error(
          `[edgar] ${url.slice(-60)}: 429 rate-limited, wait ${wait}ms (Retry-After=${retryAfterRaw || "none"}), retry ${attempt + 1}/${CONFIG.MAX_RETRIES}`,
        );
        await sleep(wait);
        continue;
      }
      throw new Error(`EDGAR 429 after ${CONFIG.MAX_RETRIES} retries — ${url}`);
    }

    // 5xx: server-side transient — retry with exponential backoff.
    if (res.status >= 500 && res.status < 600) {
      lastErr = `${res.status} ${res.statusText}`;
      if (attempt < CONFIG.MAX_RETRIES) {
        const wait = Math.min(60000, 1000 * Math.pow(2, attempt));
        console.error(
          `[edgar] ${url.slice(-60)}: ${lastErr}, retry ${attempt + 1}/${CONFIG.MAX_RETRIES} in ${wait}ms`,
        );
        await sleep(wait);
        continue;
      }
      throw new Error(`EDGAR ${lastErr} after ${CONFIG.MAX_RETRIES} retries — ${url}`);
    }

    return res;
  }
  throw new Error(`EDGAR unreachable after ${CONFIG.MAX_RETRIES} retries: ${lastErr} — ${url}`);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetchWithBackoff(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    // Non-retryable status (404, 403, etc.) — propagate as-is
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithBackoff(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

const formatAccession = (a: string): string => a.replace(/-/g, "");

function businessDaysBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const d1 = new Date(start);
  const d2 = new Date(end);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  let count = 0;
  const cur = new Date(Math.min(d1.getTime(), d2.getTime()));
  const stop = new Date(Math.max(d1.getTime(), d2.getTime()));
  while (cur < stop) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Form 4 XML uses <value> wrappers on fields that may carry footnote refs.
 * fast-xml-parser yields either a bare string/number or { value: ... }.
 * This walks either shape and returns a string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function read(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && node.value !== undefined) {
    return read(node.value);
  }
  return "";
}

// ─── Ticker → CIK lookup ────────────────────────────────────────────────────

interface TickerInfo {
  /** 10-digit zero-padded CIK */
  cik: string;
  /** un-padded CIK, used in EDGAR archive URL paths */
  cikRaw: string;
  /** Issuer name */
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;

export async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
  if (!tickerCache) {
    const data = (await fetchJson(
      `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
    )) as Record<string, { ticker: string; cik_str: number; title: string }>;
    tickerCache = {};
    for (const entry of Object.values(data)) {
      tickerCache[entry.ticker.toUpperCase()] = {
        cik: String(entry.cik_str).padStart(10, "0"),
        cikRaw: String(entry.cik_str),
        name: entry.title,
      };
    }
  }
  return tickerCache[ticker.toUpperCase()] ?? null;
}

// ─── Filing metadata ────────────────────────────────────────────────────────

interface FilingMeta {
  accession: string;
  companyCik: string;
  filedAt: string;
  url: string;
}

// ─── XML parsing ────────────────────────────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

/**
 * Codes we capture. Skips J/K (rare "other"/pledge) for signal-to-noise.
 * Includes:
 *   P open-market purchase, S open-market sale
 *   A grant/award/RSU vest, M exercise of derivative
 *   X exercise of in-the-money or at-the-money derivative
 *   C conversion of derivative, F payment of exercise price or tax with shares
 *   G bona fide gift, D disposition to issuer (forced)
 *   I discretionary 401(k)/ESPP, V voluntary
 */
const ACCEPTED_CODES = new Set([
  "P",
  "S",
  "A",
  "M",
  "X",
  "C",
  "F",
  "G",
  "D",
  "I",
  "V",
]);

/**
 * Direction derivation. P/S are open-market and unambiguous; for the rest,
 * trust `acquired_disposed` if present, otherwise fall back to code semantics
 * (A/M/X/C/I = acquisition; F/G/D = disposition).
 */
function deriveType(code: string, acqDisp: string): "buy" | "sell" {
  if (code === "P") return "buy";
  if (code === "S") return "sell";
  if (acqDisp === "A") return "buy";
  if (acqDisp === "D") return "sell";
  return /^(A|M|X|C|I)$/.test(code) ? "buy" : "sell";
}

/**
 * Parse a Form 4 (or Form 5) XML document into structured trade records.
 *
 * Form 4 and Form 5 share the identical `ownershipDocument` XML schema —
 * Form 5 is just the annual catch-up filing for transactions exempt from
 * or missed on Form 4. The same parser handles both; `dataSource` tags
 * which form the records came from.
 *
 * Captures both `nonDerivativeTable` (direct common-stock transactions) and
 * `derivativeTable` (options, RSUs, warrants, convertibles) rows across the
 * full common-code set (P/S/A/M/X/C/F/G/D/I/V). Skips J/K and unknown codes.
 *
 * Doc-ID format preserves backwards-idempotency for the original P/S non-
 * derivative records: those keep the legacy `${accession}-${date}-${code}-
 * ${roundedShares}` format. New code paths (non-P/S non-derivative, all
 * derivative rows) use row-index suffixes to stay collision-free without
 * touching the existing namespace.
 */
export function parseForm4Xml(
  xmlText: string,
  meta: FilingMeta,
  dataSource: InsiderTransaction["data_source"] = "SEC_EDGAR_FORM4",
): InsiderTransaction[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = xml.parse(xmlText);
  const doc = parsed.ownershipDocument;
  if (!doc) return [];

  // Handle the multi-owner case. 10%+ holder / fund-entity filings often have
  // multiple reportingOwner elements — the primary entity plus sub-accounts.
  // fast-xml-parser returns an array in that case; without this guard, every
  // such filing's officer_name silently became "unknown" (caught April 29 in
  // the Avis Budget Group sell-spree records).
  const reportingOwnerRaw = doc.reportingOwner;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportingOwners: any[] = Array.isArray(reportingOwnerRaw)
    ? reportingOwnerRaw
    : reportingOwnerRaw
      ? [reportingOwnerRaw]
      : [];

  const ownerNames = reportingOwners
    .map((o) => read(o?.reportingOwnerId?.rptOwnerName))
    .filter((n) => n);
  const officerName =
    ownerNames.length > 0 ? ownerNames.join(" / ") : "unknown";

  const titles = reportingOwners
    .map((o) => read(o?.reportingOwnerRelationship?.officerTitle))
    .filter((t) => t);
  const isDirector = reportingOwners.some(
    (o) => read(o?.reportingOwnerRelationship?.isDirector) === "1",
  );
  const officerTitle =
    titles.length > 0 ? titles[0]! : isDirector ? "Director" : "";

  const issuer = doc.issuer;
  const ticker = read(issuer?.issuerTradingSymbol).toUpperCase();
  const companyName = read(issuer?.issuerName) || null;
  const cik = read(issuer?.issuerCik) || meta.companyCik;

  const trades: InsiderTransaction[] = [];

  // ── Non-derivative table (direct common-stock transactions) ──────────────
  const ndRaw = doc.nonDerivativeTable?.nonDerivativeTransaction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ndArray: any[] = Array.isArray(ndRaw) ? ndRaw : ndRaw ? [ndRaw] : [];

  let ndIdx = 0;
  for (const tx of ndArray) {
    const code = read(tx.transactionCoding?.transactionCode);
    if (!ACCEPTED_CODES.has(code)) continue;

    const shares =
      parseFloat(read(tx.transactionAmounts?.transactionShares)) || 0;
    const price =
      parseFloat(read(tx.transactionAmounts?.transactionPricePerShare)) || 0;
    const txDate = read(tx.transactionDate);
    const sharesAfterRaw = read(
      tx.postTransactionAmounts?.sharesOwnedFollowingTransaction,
    );
    const sharesAfter = sharesAfterRaw ? parseFloat(sharesAfterRaw) : null;
    const acqDispRaw = read(
      tx.transactionAmounts?.transactionAcquiredDisposedCode,
    );
    const securityTitle = read(tx.securityTitle) || null;
    const totalValue = shares * price;

    if (!txDate || shares === 0) continue;
    // Year sanity guard (Greg's 2026-05-23 brief item 4): reject any
    // transaction_date with year outside [2012, current_year+1]. The
    // House PTR scraper hit a year-3031 corruption class; defending
    // against the same pattern here prevents silent garbage from
    // older Form 4 XMLs (paper-filing fallback, malformed dates, etc.)
    // before it can poison the collection.
    const txYearStr = txDate.slice(0, 4);
    const txYear = parseInt(txYearStr, 10);
    const maxYear = new Date().getUTCFullYear() + 1;
    if (isNaN(txYear) || txYear < 2012 || txYear > maxYear) {
      console.error(
        `[form4] ${meta.accession}: transaction_date "${txDate}" out of [2012, ${maxYear}] — skipping row`,
      );
      continue;
    }

    // Preserve the legacy P/S doc-ID format so prior writes stay idempotent.
    // Use row-index suffix for all other codes (new namespace, no collision).
    const id =
      code === "P" || code === "S"
        ? `${meta.accession}-${txDate}-${code}-${Math.round(shares)}`
        : `${meta.accession}-${txDate}-${code}-${ndIdx}`;

    trades.push({
      id,
      ticker,
      company_name: companyName,
      company_cik: cik,
      officer_name: officerName,
      officer_title: officerTitle,
      is_director: isDirector,
      transaction_type: deriveType(code, acqDispRaw),
      transaction_code: code,
      security_title: securityTitle,
      is_derivative: false,
      underlying_security_title: null,
      underlying_security_shares: null,
      conversion_or_exercise_price: null,
      transaction_date: txDate,
      disclosure_date: meta.filedAt,
      reporting_lag_days: businessDaysBetween(txDate, meta.filedAt),
      shares,
      price_per_share: price,
      total_value: totalValue,
      shares_owned_after: sharesAfter,
      acquired_disposed:
        acqDispRaw === "A" || acqDispRaw === "D" ? acqDispRaw : null,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: dataSource,
    });
    ndIdx++;
  }

  // ── Derivative table (options, RSUs, warrants, convertibles) ─────────────
  const dRaw = doc.derivativeTable?.derivativeTransaction;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dArray: any[] = Array.isArray(dRaw) ? dRaw : dRaw ? [dRaw] : [];

  let dIdx = 0;
  for (const tx of dArray) {
    const code = read(tx.transactionCoding?.transactionCode);
    if (!ACCEPTED_CODES.has(code)) continue;

    const shares =
      parseFloat(read(tx.transactionAmounts?.transactionShares)) || 0;
    const price =
      parseFloat(read(tx.transactionAmounts?.transactionPricePerShare)) || 0;
    const txDate = read(tx.transactionDate);
    const sharesAfterRaw = read(
      tx.postTransactionAmounts?.sharesOwnedFollowingTransaction,
    );
    const sharesAfter = sharesAfterRaw ? parseFloat(sharesAfterRaw) : null;
    const acqDispRaw = read(
      tx.transactionAmounts?.transactionAcquiredDisposedCode,
    );
    const securityTitle = read(tx.securityTitle) || null;

    const conversionPriceRaw = read(tx.conversionOrExercisePrice);
    const conversionPrice = conversionPriceRaw
      ? parseFloat(conversionPriceRaw) || null
      : null;
    const underlyingTitle =
      read(tx.underlyingSecurity?.underlyingSecurityTitle) || null;
    const underlyingSharesRaw = read(
      tx.underlyingSecurity?.underlyingSecurityShares,
    );
    const underlyingShares = underlyingSharesRaw
      ? parseFloat(underlyingSharesRaw) || null
      : null;

    if (!txDate || shares === 0) continue;
    // Year sanity guard (Greg's 2026-05-23 brief item 4): reject any
    // transaction_date with year outside [2012, current_year+1]. The
    // House PTR scraper hit a year-3031 corruption class; defending
    // against the same pattern here prevents silent garbage from
    // older Form 4 XMLs (paper-filing fallback, malformed dates, etc.)
    // before it can poison the collection.
    const txYearStr = txDate.slice(0, 4);
    const txYear = parseInt(txYearStr, 10);
    const maxYear = new Date().getUTCFullYear() + 1;
    if (isNaN(txYear) || txYear < 2012 || txYear > maxYear) {
      console.error(
        `[form4] ${meta.accession}: transaction_date "${txDate}" out of [2012, ${maxYear}] — skipping row`,
      );
      continue;
    }

    trades.push({
      id: `${meta.accession}-D-${txDate}-${code}-${dIdx}`,
      ticker,
      company_name: companyName,
      company_cik: cik,
      officer_name: officerName,
      officer_title: officerTitle,
      is_director: isDirector,
      transaction_type: deriveType(code, acqDispRaw),
      transaction_code: code,
      security_title: securityTitle,
      is_derivative: true,
      underlying_security_title: underlyingTitle,
      underlying_security_shares: underlyingShares,
      conversion_or_exercise_price: conversionPrice,
      transaction_date: txDate,
      disclosure_date: meta.filedAt,
      reporting_lag_days: businessDaysBetween(txDate, meta.filedAt),
      shares,
      price_per_share: price,
      total_value: shares * price,
      shares_owned_after: sharesAfter,
      acquired_disposed:
        acqDispRaw === "A" || acqDispRaw === "D" ? acqDispRaw : null,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: dataSource,
    });
    dIdx++;
  }

  return trades;
}

// ─── Fetcher ────────────────────────────────────────────────────────────────

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
 * Fetch all open-market P/S Form 4 trades for a ticker. Pulls up to
 * `maxFilings` most-recent filings from EDGAR and parses each one.
 */
export async function scrapeForm4ByTicker(
  ticker: string,
  maxFilings = 20,
): Promise<InsiderTransaction[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[form4] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${info.cik}.json`,
  )) as SubmissionsResponse;
  const recent = subs.filings?.recent;
  if (!recent) return [];

  const filings: FilingMeta[] = [];
  for (let i = 0; i < recent.form.length && filings.length < maxFilings; i++) {
    const form = recent.form[i];
    if (form !== "4" && form !== "4/A") continue;
    const accession = recent.accessionNumber[i];
    const filedAt = recent.filingDate[i];
    if (!accession || !filedAt) continue;
    const accessionNoSlash = formatAccession(accession);
    const primaryDoc = recent.primaryDocument?.[i] ?? "";
    filings.push({
      accession,
      companyCik: info.cikRaw,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${info.cikRaw}/${accessionNoSlash}/${primaryDoc}`,
    });
  }

  console.error(`[form4] Found ${filings.length} Form 4 filings`);

  const allTrades: InsiderTransaction[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const trades = parseForm4Xml(xmlText, filing);
      allTrades.push(...trades);
      console.error(`[form4]   ${filing.accession}: ${trades.length} trades`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form4]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  const ndCount = allTrades.filter((t) => !t.is_derivative).length;
  const dCount = allTrades.length - ndCount;
  console.error(
    `[form4] TOTAL: ${allTrades.length} trades for ${ticker} (${ndCount} non-derivative, ${dCount} derivative)`,
  );
  return allTrades;
}

interface EdgarSearchHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    display_names?: string[];
  };
}

/**
 * Live-feed mode: scan EDGAR full-text search for recent Form 4 filings
 * across all companies. Useful for "what just got filed today" queries.
 */
export async function scrapeForm4LiveFeed(
  lookbackDays = 2,
  maxFilings = 100,
): Promise<InsiderTransaction[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  const url = `${CONFIG.SEARCH_URL}?q=%22%22&forms=4&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;
  const data = (await fetchJson(url)) as { hits?: { hits?: EdgarSearchHit[] } };
  const hits = data.hits?.hits ?? [];

  console.error(`[form4 live] ${hits.length} Form 4 filings in last ${lookbackDays}d`);

  const filings: FilingMeta[] = [];
  for (const hit of hits.slice(0, maxFilings)) {
    const src = hit._source;
    if (!src) continue;
    const companyCik = (src.ciks?.[1] ?? src.ciks?.[0] ?? "").replace(
      /^0+/,
      "",
    );
    const accession = src.adsh ?? "";
    const filedAt = src.file_date ?? "";
    const filename = (hit._id ?? "").split(":")[1] ?? "";
    if (!accession || !companyCik || !filename) continue;
    filings.push({
      accession,
      companyCik,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${companyCik}/${formatAccession(accession)}/${filename}`,
    });
  }

  const allTrades: InsiderTransaction[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const trades = parseForm4Xml(xmlText, filing);
      allTrades.push(...trades);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form4 live]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  const ndCount = allTrades.filter((t) => !t.is_derivative).length;
  const dCount = allTrades.length - ndCount;
  console.error(
    `[form4 live] TOTAL: ${allTrades.length} trades (${ndCount} non-derivative, ${dCount} derivative)`,
  );
  return allTrades;
}

/**
 * Live-feed mode for Form 5 — the annual catch-up insider filing. Form 5
 * shares the identical `ownershipDocument` XML schema as Form 4, so it
 * reuses parseForm4Xml; records are tagged data_source SEC_EDGAR_FORM5 and
 * land in the same `insider_trades` collection. Form 5 volume is low (it's
 * an annual filing, heavily concentrated after each fiscal year-end), so a
 * wide lookback is cheap.
 */
export async function scrapeForm5LiveFeed(
  lookbackDays = 7,
  maxFilings = 100,
): Promise<InsiderTransaction[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  const url = `${CONFIG.SEARCH_URL}?q=%22%22&forms=5&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;
  const data = (await fetchJson(url)) as { hits?: { hits?: EdgarSearchHit[] } };
  const hits = data.hits?.hits ?? [];

  console.error(`[form5 live] ${hits.length} Form 5 filings in last ${lookbackDays}d`);

  const filings: FilingMeta[] = [];
  for (const hit of hits.slice(0, maxFilings)) {
    const src = hit._source;
    if (!src) continue;
    const companyCik = (src.ciks?.[1] ?? src.ciks?.[0] ?? "").replace(
      /^0+/,
      "",
    );
    const accession = src.adsh ?? "";
    const filedAt = src.file_date ?? "";
    const filename = (hit._id ?? "").split(":")[1] ?? "";
    if (!accession || !companyCik || !filename) continue;
    filings.push({
      accession,
      companyCik,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${companyCik}/${formatAccession(accession)}/${filename}`,
    });
  }

  const allTrades: InsiderTransaction[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const trades = parseForm4Xml(xmlText, filing, "SEC_EDGAR_FORM5");
      allTrades.push(...trades);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form5 live]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  console.error(`[form5 live] TOTAL: ${allTrades.length} Form 5 transactions`);
  return allTrades;
}
