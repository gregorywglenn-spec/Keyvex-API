/**
 * DEF 14A (Schedule 14A Proxy) scraper — v1A metadata-only.
 *
 * The proxy statement is what a public company sends shareholders ahead of
 * an annual meeting. Carries executive compensation tables, board nominees,
 * shareholder proposals, auditor info, and voting matters. The companion
 * to 13D/G (activist stakes) and Form 4 (insider trades) — together they
 * paint the full governance picture.
 *
 * Form types we capture (the full DEF 14A family):
 *   - DEF 14A   — Definitive proxy (annual meeting)
 *   - DEFA14A   — Additional proxy materials (supplements)
 *   - DEFM14A   — Merger-related proxy (M&A vote)
 *   - DEFR14A   — Revised definitive proxy
 *
 * v1A scope: METADATA-ONLY. Same posture as 8-K v1A. The proxy body is
 * 50-200 pages of complex HTML tables; extracting named exec officers,
 * comp totals, vote outcomes, and shareholder proposals is v1.1 territory.
 *
 * Architecture mirrors form8k.ts: same EDGAR plumbing, same per-ticker +
 * live-feed dual mode, same bidirectional ticker cache.
 */
import type { ProxyFiling } from "../types.js";
import { fetchEdgarFilingsByForm } from "../reconcile/sec-edgar-index.js";
import { preferPrimaryTicker } from "../sec-tickers.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
};

const PROXY_FORMS: ReadonlySet<string> = new Set([
  "DEF 14A",
  "DEFA14A",
  "DEFM14A",
  "DEFR14A",
]);

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
 * Coerce an EDGAR form-string into one of our four canonical proxy types.
 * Returns null on anything else (Form 4, 8-K, S-1, etc — caller must skip).
 */
function normalizeProxyForm(form: string): ProxyFiling["filing_type"] | null {
  const f = form.trim().toUpperCase();
  if (f === "DEF 14A") return "DEF 14A";
  if (f === "DEFA14A") return "DEFA14A";
  if (f === "DEFM14A") return "DEFM14A";
  if (f === "DEFR14A") return "DEFR14A";
  return null;
}

// ─── Ticker ↔ CIK lookup (same pattern as form8k.ts) ────────────────────────

interface TickerInfo {
  cik: string;
  cikRaw: string;
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
    cikToName[cikPadded] = entry.title;
    // Primary-ticker pick (multi-class CIKs) — shared helper so the fix can't
    // drift apart across scrapers. See preferPrimaryTicker in sec-tickers.ts.
    cikToTicker[cikPadded] = preferPrimaryTicker(cikToTicker[cikPadded], ticker);
  }
}

async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
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

// ─── Submissions API ────────────────────────────────────────────────────────

interface SubmissionsRecent {
  form: string[];
  accessionNumber: string[];
  filingDate: string[];
  reportDate?: string[];
  primaryDocument?: string[];
}

interface SubmissionsResponse {
  cik?: string;
  name?: string;
  filings?: { recent?: SubmissionsRecent };
}

const submissionsCache: Record<string, SubmissionsResponse> = {};

async function getSubmissions(cikPadded: string): Promise<SubmissionsResponse> {
  if (submissionsCache[cikPadded]) return submissionsCache[cikPadded]!;
  const data = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${cikPadded}.json`,
  )) as SubmissionsResponse;
  submissionsCache[cikPadded] = data;
  return data;
}

// ─── Per-filing builder ────────────────────────────────────────────────────

interface BuildArgs {
  accession: string;
  cikPadded: string;
  cikRaw: string;
  ticker: string;
  companyName: string | null;
  filingType: ProxyFiling["filing_type"];
  filingDate: string;
  periodOfReport: string;
  primaryDocument: string;
}

function buildProxyFiling(args: BuildArgs): ProxyFiling {
  const accessionNoSlash = formatAccession(args.accession);
  const primaryDoc = args.primaryDocument || "";
  const archiveBase = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${args.cikRaw}/${accessionNoSlash}`;
  return {
    id: args.accession,
    ticker: args.ticker,
    company_name: args.companyName,
    company_cik: args.cikPadded,
    accession_number: args.accession,
    filing_type: args.filingType,
    filing_date: args.filingDate,
    period_of_report: args.periodOfReport,
    is_merger_related: args.filingType === "DEFM14A",
    is_amendment: args.filingType === "DEFR14A",
    is_additional_materials: args.filingType === "DEFA14A",
    primary_document_url: primaryDoc ? `${archiveBase}/${primaryDoc}` : archiveBase,
    sec_filing_url: archiveBase,
    data_source: "SEC_EDGAR_DEF14A",
    scraped_at: new Date().toISOString(),
  };
}

// ─── Per-ticker mode ────────────────────────────────────────────────────────

export async function scrapeProxyByTicker(
  ticker: string,
  maxFilings = 50,
): Promise<ProxyFiling[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[proxy] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = await getSubmissions(info.cik);
  const recent = subs.filings?.recent;
  if (!recent) {
    console.error(`[proxy] No recent filings on submissions API for ${ticker}`);
    return [];
  }

  const out: ProxyFiling[] = [];
  for (let i = 0; i < recent.form.length && out.length < maxFilings; i++) {
    const form = recent.form[i];
    if (!form) continue;
    const normalized = normalizeProxyForm(form);
    if (!normalized) continue;

    const accession = recent.accessionNumber[i];
    const filingDate = recent.filingDate[i];
    if (!accession || !filingDate) continue;
    const reportDate = recent.reportDate?.[i] ?? "";
    const primaryDocument = recent.primaryDocument?.[i] ?? "";

    out.push(
      buildProxyFiling({
        accession,
        cikPadded: info.cik,
        cikRaw: info.cikRaw,
        ticker: ticker.toUpperCase(),
        companyName: info.name,
        filingType: normalized,
        filingDate,
        periodOfReport: reportDate,
        primaryDocument,
      }),
    );
  }

  console.error(
    `[proxy] ${ticker}: ${out.length} proxy filings (DEF 14A family)`,
  );
  return out;
}

// ─── Historical backfill mode ───────────────────────────────────────────────

/**
 * Historical backfill: enumerate EVERY DEF-14A-family filing from the
 * authoritative EDGAR quarterly full-index (`master.idx`) across
 * [startYear, endYear] and emit ProxyFiling rows.
 *
 * Why this exists: the per-ticker path only sees a company's most-recent
 * ~1000 filings (submissions `recent`), and the live-feed uses FTS (capped).
 * Neither gives broad historical depth — pre-backfill, only Apple (an early
 * per-CIK smoke test) had full history, while most large-caps returned 0.
 * The full-index is the COMPLETE census — the same source the reconciliation
 * sweep used to make the sibling SEC feeds (8-K, Form 144, Form 3, 13D/G)
 * whole. This makes proxy coverage whole the same way.
 *
 * Scale-safe (follow-up #0): builds + flushes rows in slices via `onBatch`;
 * never accumulates a second full array of ProxyFilings. The enumerated
 * index list (~150-190K small records for 2016-2026, ~tens of MB) is held
 * once. Run locally (no Cloud Function memory cap).
 *
 * Limitations (documented, v1A posture):
 *  - period_of_report is left empty: the full-index carries no reportDate.
 *    Filter/sort by filing_date (the tool already steers agents there).
 *  - primary_document_url points at the filing's archive directory (the
 *    index has no per-doc filename); the directory lists the proxy docs.
 *  - ticker resolves via the CURRENT company_tickers.json; delisted/merged
 *    issuers get "" (honest — they no longer trade). Query by company_cik
 *    or company_name for those.
 */
export async function scrapeProxyHistorical(opts: {
  startYear: number;
  endYear: number;
  onBatch?: (rows: ProxyFiling[]) => Promise<void>;
  batchSize?: number;
}): Promise<{ enumerated: number; emitted: number }> {
  await loadCaches();

  const filings = await fetchEdgarFilingsByForm({
    forms: [...PROXY_FORMS],
    startYear: opts.startYear,
    endYear: opts.endYear,
    onProgress: (m) => console.error(`[proxy hist]   ${m}`),
  });
  console.error(
    `[proxy hist] enumerated ${filings.length} proxy-family filings ` +
      `${opts.startYear}-${opts.endYear}`,
  );

  const batchSize = opts.batchSize ?? 2000;
  let emitted = 0;
  let batch: ProxyFiling[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (opts.onBatch) await opts.onBatch(batch);
    emitted += batch.length;
    batch = [];
  };

  for (const f of filings) {
    const normalized = normalizeProxyForm(f.formType);
    if (!normalized) continue;
    const cikPadded = f.cik.replace(/^0+/, "").padStart(10, "0");
    const cikRaw = cikPadded.replace(/^0+/, "");
    const ticker = cikToTicker![cikPadded] ?? "";
    const companyName = f.company || cikToName![cikPadded] || null;

    batch.push(
      buildProxyFiling({
        accession: f.accession,
        cikPadded,
        cikRaw,
        ticker,
        companyName,
        filingType: normalized,
        filingDate: f.dateFiled,
        periodOfReport: "",
        primaryDocument: "",
      }),
    );
    if (batch.length >= batchSize) await flush();
  }
  await flush();

  console.error(`[proxy hist] emitted ${emitted} ProxyFiling rows`);
  return { enumerated: filings.length, emitted };
}

// ─── Live-feed mode ────────────────────────────────────────────────────────

interface FtsHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    file_type?: string;
    display_names?: string[];
    /** EDGAR FTS calls this `period_ending`; we expose it as
     *  `period_of_report` on the output. Same field-name typo as
     *  form8k.ts surfaced 2026-05-23 — fixed defensively here too. */
    period_ending?: string;
    period_of_report?: string;
    form?: string;
  };
}

/**
 * Live-feed mode: scan EDGAR full-text search for proxy filings filed in
 * the last N days, iterating each of the four form codes (FTS doesn't
 * have a wildcard match; we hit it once per form type). Dedupe by accession.
 */
export async function scrapeProxyLiveFeed(
  lookbackDays = 1,
  maxFilings = 200,
): Promise<ProxyFiling[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  const seenAccessions = new Set<string>();
  const out: ProxyFiling[] = [];

  for (const formCode of PROXY_FORMS) {
    if (out.length >= maxFilings) break;
    // URL-encode the space in "DEF 14A" as %20 (works), "+" also works on FTS.
    const encodedForm = encodeURIComponent(formCode);
    const url = `${CONFIG.SEARCH_URL}?q=&forms=${encodedForm}&dateRange=custom&startdt=${startStr}&enddt=${endStr}`;

    let data: { hits?: { hits?: FtsHit[] } };
    try {
      data = (await fetchJson(url)) as { hits?: { hits?: FtsHit[] } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proxy live]   FTS ${formCode} failed: ${msg}`);
      continue;
    }
    const hits = data.hits?.hits ?? [];
    console.error(`[proxy live]   forms=${formCode}: ${hits.length} hits`);

    for (const hit of hits) {
      if (out.length >= maxFilings) break;
      const src = hit._source;
      if (!src) continue;

      const accession = src.adsh ?? "";
      if (!accession || seenAccessions.has(accession)) continue;

      const filename = (hit._id ?? "").split(":")[1] ?? "";
      if (!filename) continue;

      const fileType = (src.file_type ?? "").toUpperCase();
      // FTS's file_type is the most reliable form-type signal on the hit;
      // fall back to the form code we queried with if missing.
      const normalized = normalizeProxyForm(fileType) ?? normalizeProxyForm(formCode);
      if (!normalized) continue;

      const cikPaddedFromHit = (src.ciks?.[0] ?? "").padStart(10, "0");
      if (!cikPaddedFromHit) continue;
      const cikRaw = cikPaddedFromHit.replace(/^0+/, "");

      const filedAt = src.file_date ?? "";
      // FTS field is `period_ending`, not `period_of_report` — same
      // bug as form8k.ts caught 2026-05-23. Fall back to legacy
      // name defensively.
      const periodOfReport = src.period_ending ?? src.period_of_report ?? "";

      const ticker = await getTickerFromCik(cikPaddedFromHit);
      const companyName =
        (await getNameFromCik(cikPaddedFromHit)) ??
        src.display_names?.[0]?.split(" (")[0] ??
        null;

      seenAccessions.add(accession);
      out.push(
        buildProxyFiling({
          accession,
          cikPadded: cikPaddedFromHit,
          cikRaw,
          ticker,
          companyName,
          filingType: normalized,
          filingDate: filedAt,
          periodOfReport,
          primaryDocument: filename,
        }),
      );
    }
  }

  console.error(
    `[proxy live] TOTAL: ${out.length} unique proxy filings ` +
      `(${out.filter((p) => p.is_merger_related).length} merger-related, ` +
      `${out.filter((p) => p.is_amendment).length} revised)`,
  );
  return out;
}
