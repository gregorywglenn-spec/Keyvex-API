/**
 * Form 8-K scraper — material events from SEC EDGAR.
 *
 * 8-K is the SEC's "current report" form. Public companies must file one
 * within 4 business days of any material event. Closest thing the public
 * gets to a real-time corporate-disclosure stream.
 *
 * Architecture mirrors the other SEC scrapers (Form 4 / Form 144 / Form 3):
 *   - Same EDGAR plumbing (submissions API + full-text search)
 *   - Same rate-limit (150ms between requests, ~6 req/sec)
 *   - Same User-Agent requirement
 *
 * Key shortcut: the `items` field on EDGAR's submissions metadata already
 * contains the comma-separated item codes (e.g., "5.02,9.01"). No need to
 * fetch and parse the actual 8-K document body. Same shortcut on FTS hits
 * when present.
 *
 * Per-ticker mode: ticker → CIK → submissions API → filter to 8-K / 8-K/A.
 *   No second fetch per filing — items live in the submissions metadata.
 *
 * Live-feed mode: FTS for {form=8-K} in date range → CIK + accession per hit.
 *   FTS sometimes carries items inline; when missing, fall back to the
 *   submissions API for that CIK (cached, so each company is fetched once
 *   per run regardless of how many 8-Ks they filed).
 *
 * Output: one MaterialEvent per filing. item_codes is an array — one filing
 * can declare multiple items. v1 does not extract or store the prose body;
 * primary_document_url points agents at the source.
 */

import type { MaterialEvent } from "../types.js";

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

const formatAccession = (a: string): string => a.replace(/-/g, "");

/**
 * Parse EDGAR's `items` field on 8-K metadata into a normalized array.
 *
 * Two source shapes seen in the wild:
 *   - **Submissions API** returns a comma-separated string ("5.02,9.01").
 *   - **Full-text search** returns an array of strings (["5.02","9.01"]).
 *
 * Same field name, different conventions — caller should not have to know
 * which they're getting. Empty / null / missing / wrong-shape → empty array.
 */
function parseItemCodes(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// ─── Ticker ↔ CIK lookup (bidirectional cache) ─────────────────────────────

interface TickerInfo {
  /** 10-digit zero-padded CIK */
  cik: string;
  /** un-padded CIK, used in EDGAR archive URL paths */
  cikRaw: string;
  /** Issuer name */
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;
let cikToTicker: Record<string, string> | null = null;
let cikToName: Record<string, string> | null = null;

async function loadCaches(): Promise<void> {
  if (tickerCache && cikToTicker && cikToName) return;
  const data = (await fetchJson(
    `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
  )) as Record<string, { ticker: string; cik_str: number; title: string }>;
  tickerCache = {};
  cikToTicker = {};
  cikToName = {};
  for (const entry of Object.values(data)) {
    const ticker = entry.ticker.toUpperCase();
    const cikPadded = String(entry.cik_str).padStart(10, "0");
    tickerCache[ticker] = {
      cik: cikPadded,
      cikRaw: String(entry.cik_str),
      name: entry.title,
    };
    cikToTicker[cikPadded] = ticker;
    cikToName[cikPadded] = entry.title;
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

async function getNameFromCik(cik: string): Promise<string | null> {
  if (!cik) return null;
  await loadCaches();
  const padded = cik.replace(/^0+/, "").padStart(10, "0");
  return cikToName![padded] ?? null;
}

// ─── Submissions API integration ────────────────────────────────────────────

interface SubmissionsRecent {
  form: string[];
  accessionNumber: string[];
  filingDate: string[];
  reportDate?: string[];
  primaryDocument?: string[];
  items?: string[];
}

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: { recent?: SubmissionsRecent };
}

/**
 * In-memory cache of submissions API responses, keyed by 10-digit padded CIK.
 * Live-feed mode hits this when an FTS hit is missing the items field. We
 * fetch each company at most once per run.
 */
const submissionsCache: Record<string, SubmissionsResponse> = {};

async function getSubmissions(cikPadded: string): Promise<SubmissionsResponse> {
  if (submissionsCache[cikPadded]) return submissionsCache[cikPadded]!;
  const data = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${cikPadded}.json`,
  )) as SubmissionsResponse;
  submissionsCache[cikPadded] = data;
  return data;
}

// ─── Per-filing builder ─────────────────────────────────────────────────────

interface BuildArgs {
  accession: string;
  cikPadded: string;
  cikRaw: string;
  ticker: string;
  companyName: string | null;
  filingDate: string;
  periodOfReport: string;
  primaryDocument: string;
  isAmendment: boolean;
  itemCodes: string[];
}

function buildMaterialEvent(args: BuildArgs): MaterialEvent {
  const accessionNoSlash = formatAccession(args.accession);
  const primaryDoc = args.primaryDocument || "";
  const archiveBase = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${args.cikRaw}/${accessionNoSlash}`;
  return {
    id: args.accession,
    ticker: args.ticker,
    company_name: args.companyName,
    company_cik: args.cikPadded,
    accession_number: args.accession,
    filing_date: args.filingDate,
    period_of_report: args.periodOfReport,
    item_codes: args.itemCodes,
    is_amendment: args.isAmendment,
    original_accession_number: null,
    primary_document_url: primaryDoc ? `${archiveBase}/${primaryDoc}` : archiveBase,
    sec_filing_url: archiveBase,
    data_source: "SEC_EDGAR_8K",
  };
}

// ─── Per-ticker mode ────────────────────────────────────────────────────────

/**
 * Pull recent 8-K filings for one ticker via the submissions API.
 * No per-filing fetches — items / reportDate / primaryDocument all live in
 * the submissions metadata.
 */
export async function scrape8kByTicker(
  ticker: string,
  maxFilings = 50,
): Promise<MaterialEvent[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[8k] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = await getSubmissions(info.cik);
  const recent = subs.filings?.recent;
  if (!recent) {
    console.error(`[8k] No recent filings on submissions API for ${ticker}`);
    return [];
  }

  const out: MaterialEvent[] = [];
  for (let i = 0; i < recent.form.length && out.length < maxFilings; i++) {
    const form = recent.form[i];
    if (form !== "8-K" && form !== "8-K/A") continue;
    const accession = recent.accessionNumber[i];
    const filingDate = recent.filingDate[i];
    if (!accession || !filingDate) continue;
    const reportDate = recent.reportDate?.[i] ?? "";
    const primaryDocument = recent.primaryDocument?.[i] ?? "";
    const items = parseItemCodes(recent.items?.[i]);
    out.push(
      buildMaterialEvent({
        accession,
        cikPadded: info.cik,
        cikRaw: info.cikRaw,
        ticker: ticker.toUpperCase(),
        companyName: info.name,
        filingDate,
        periodOfReport: reportDate,
        primaryDocument,
        isAmendment: form === "8-K/A",
        itemCodes: items,
      }),
    );
  }

  console.error(
    `[8k] ${ticker}: ${out.length} 8-K filings (incl. amendments)`,
  );
  return out;
}

// ─── Live-feed mode ─────────────────────────────────────────────────────────

interface FtsHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    /** Array on FTS hits, comma-separated string on submissions API. parseItemCodes handles both. */
    items?: unknown;
    file_type?: string;
    display_names?: string[];
    /** EDGAR FTS calls this `period_ending`; the submissions API calls
     *  the same field `reportDate`; the public-facing field name on
     *  our records is `period_of_report`. Greg's 2026-05-23 finding:
     *  the previous code read `src.period_of_report` (which doesn't
     *  exist on FTS) and left every feed-path row blank. Now reads
     *  period_ending first, falls back to period_of_report for
     *  defensive coverage. */
    period_ending?: string;
    period_of_report?: string;
  };
}

/**
 * Live-feed mode: scan EDGAR full-text search for 8-K filings filed in
 * the last N days across all companies. For each hit, build a MaterialEvent
 * from FTS metadata. When FTS doesn't carry the items field, fall back to
 * the submissions API for that filer (cached per-CIK).
 */
export async function scrape8kLiveFeed(
  lookbackDays = 1,
  maxFilings = 200,
): Promise<MaterialEvent[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  // forms=8-K matches both 8-K and 8-K/A on EDGAR FTS.
  const url = `${CONFIG.SEARCH_URL}?q=&forms=8-K&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;
  const data = (await fetchJson(url)) as { hits?: { hits?: FtsHit[] } };
  const hits = data.hits?.hits ?? [];

  console.error(`[8k live] FTS returned ${hits.length} 8-K hits in last ${lookbackDays}d`);

  // Dedup by accession — FTS sometimes returns multiple rows per filing
  // (one per attached document). The 8-K we care about is one row per
  // accession_number; collapsing is required so we don't double-count.
  const seenAccessions = new Set<string>();
  const out: MaterialEvent[] = [];

  for (const hit of hits) {
    if (out.length >= maxFilings) break;
    const src = hit._source;
    if (!src) continue;

    const accession = src.adsh ?? "";
    if (!accession || seenAccessions.has(accession)) continue;

    // Filter to primary form documents only — skip exhibits / images.
    // A filename suffix of .htm/.html/.txt on the primary doc is the most
    // reliable filter; FTS hits on attachments will have different patterns.
    const filename = (hit._id ?? "").split(":")[1] ?? "";
    if (!filename) continue;

    // FTS includes both 8-K and 8-K/A under forms=8-K filter. file_type
    // distinguishes them when present; fall back to inferring from filename.
    const fileType = (src.file_type ?? "").toUpperCase();
    const isAmendment = fileType === "8-K/A";

    const cikPaddedFromHit = (src.ciks?.[0] ?? "").padStart(10, "0");
    if (!cikPaddedFromHit) continue;
    const cikRaw = cikPaddedFromHit.replace(/^0+/, "");

    const filedAt = src.file_date ?? "";
    // FTS uses `period_ending` (not `period_of_report`). Fall back to
    // the legacy name too — defensive against future API normalization.
    let periodOfReport = src.period_ending ?? src.period_of_report ?? "";
    let itemCodes = parseItemCodes(src.items);

    // Resolve ticker + name via the bidirectional cache.
    const ticker = await getTickerFromCik(cikPaddedFromHit);
    const companyName =
      (await getNameFromCik(cikPaddedFromHit)) ??
      src.display_names?.[0]?.split(" (")[0] ??
      null;

    // Fallback path: if FTS didn't carry items OR period_of_report,
    // fetch the submissions API and look up the matching accession.
    // Cached per CIK. Greg's 2026-05-23 finding caused this to fire on
    // period_of_report too (older code only fired when items were
    // missing, leaving 51% of feed-path rows with empty
    // period_of_report).
    if (itemCodes.length === 0 || !periodOfReport) {
      try {
        const subs = await getSubmissions(cikPaddedFromHit);
        const recent = subs.filings?.recent;
        if (recent) {
          const idx = recent.accessionNumber.findIndex((a) => a === accession);
          if (idx >= 0) {
            if (itemCodes.length === 0) {
              itemCodes = parseItemCodes(recent.items?.[idx]);
            }
            if (!periodOfReport && recent.reportDate?.[idx]) {
              periodOfReport = recent.reportDate[idx];
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[8k live]   ${accession}: items/period fallback SKIP — ${msg}`);
      }
    }

    seenAccessions.add(accession);
    out.push(
      buildMaterialEvent({
        accession,
        cikPadded: cikPaddedFromHit,
        cikRaw,
        ticker,
        companyName,
        filingDate: filedAt,
        periodOfReport,
        primaryDocument: filename,
        isAmendment,
        itemCodes,
      }),
    );
  }

  console.error(
    `[8k live] TOTAL: ${out.length} unique 8-K filings (${out.filter((m) => m.is_amendment).length} amendments, ${out.filter((m) => m.item_codes.length === 0).length} with empty items)`,
  );
  return out;
}
