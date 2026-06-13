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
import { preferPrimaryTicker } from "../sec-tickers.js";
import { fetchEdgarDailyIndex } from "../reconcile/sec-edgar-index.js";

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
    // Primary-ticker pick for multi-class CIKs (shared helper; see sec-tickers).
    cikToTicker[cikPadded] = preferPrimaryTicker(cikToTicker[cikPadded], ticker);
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
  maxFilings = 100000,
): Promise<MaterialEvent[]> {
  const end = new Date();

  // Enumerate via EDGAR's COMPLETE daily index, NOT full-text search. FTS
  // silently caps/under-reports — measured at only ~60% recent-window coverage
  // before this fix (the worst of the SEC feeds; same leak class fixed for
  // N-PORT and Form D). The daily index gives (cik, accession); the item codes,
  // period-of-report and primary document all come from the per-CIK submissions
  // API (cached), so there's no per-filing fetch — one submissions call per
  // unique filer covers all its 8-Ks in the window.
  const refs = new Map<
    string,
    { accession: string; cikPadded: string; filedAt: string; isAmendment: boolean }
  >();
  for (let dayOffset = 0; dayOffset <= lookbackDays; dayOffset++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - dayOffset);
    const dayISO = dt.toISOString().split("T")[0] ?? "";
    if (!dayISO) continue;
    let idx: Awaited<ReturnType<typeof fetchEdgarDailyIndex>>;
    try {
      idx = await fetchEdgarDailyIndex(dayISO, ["8-K", "8-K/A"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[8k live] daily-index ${dayISO}: SKIP — ${msg}`);
      continue;
    }
    for (const f of idx) {
      if (f.formType !== "8-K" && f.formType !== "8-K/A") continue;
      if (refs.has(f.accession)) continue;
      if (refs.size >= maxFilings) break;
      refs.set(f.accession, {
        accession: f.accession,
        cikPadded: f.cik.padStart(10, "0"),
        filedAt: f.dateFiled,
        isAmendment: f.formType === "8-K/A",
      });
    }
  }

  console.error(
    `[8k live] ${refs.size} 8-K filings in last ${lookbackDays}d (daily-index)`,
  );

  const out: MaterialEvent[] = [];
  for (const ref of refs.values()) {
    let periodOfReport = "";
    let primaryDocument = "";
    let itemCodes: string[] = [];
    let filedAt = ref.filedAt;
    try {
      const subs = await getSubmissions(ref.cikPadded);
      const recent = subs.filings?.recent;
      if (recent) {
        const i = recent.accessionNumber.findIndex((a) => a === ref.accession);
        if (i >= 0) {
          periodOfReport = recent.reportDate?.[i] ?? "";
          primaryDocument = recent.primaryDocument?.[i] ?? "";
          itemCodes = parseItemCodes(recent.items?.[i]);
          if (recent.filingDate?.[i]) filedAt = recent.filingDate[i]!;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[8k live]   ${ref.accession}: submissions SKIP — ${msg}`);
      // Still record the filing with what we have from the index (don't drop it).
    }

    const cikRaw = ref.cikPadded.replace(/^0+/, "");
    const ticker = await getTickerFromCik(ref.cikPadded);
    const companyName = await getNameFromCik(ref.cikPadded);
    out.push(
      buildMaterialEvent({
        accession: ref.accession,
        cikPadded: ref.cikPadded,
        cikRaw,
        ticker,
        companyName,
        filingDate: filedAt,
        periodOfReport,
        primaryDocument,
        isAmendment: ref.isAmendment,
        itemCodes,
      }),
    );
  }

  console.error(
    `[8k live] TOTAL: ${out.length} unique 8-K filings (${out.filter((m) => m.is_amendment).length} amendments, ${out.filter((m) => m.item_codes.length === 0).length} with empty items)`,
  );
  return out;
}
