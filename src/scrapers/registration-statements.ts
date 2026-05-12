/**
 * SEC registration-statement scraper — Form S-1 (IPO + first-time
 * registration) and Form S-3 (shelf registration), plus amendments.
 *
 * v1A scope: metadata only via EDGAR full-text search. The primary
 * document is typically HTML prospectus content — agents follow the URL
 * for offering size, share counts, use of proceeds, etc.
 *
 * Same SEC-FTS template as NPORT scraper — seventh use after Form 4 /
 * 144 / 3 / 13D-G / D / NPORT.
 *
 * Filter quirk: EDGAR FTS surfaces all attachments alongside the primary
 * (sequence=1) document. We filter to file_type that exactly matches
 * the canonical filing types (S-1, S-1/A, S-3, S-3/A) to drop EX-10
 * supplemental agreements, EX-FILING FEES, opinion letters, etc.
 */

import type { RegistrationStatement } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
  FTS_HITS_PER_PAGE: 100,
  FORM_CODES: ["S-1", "S-1/A", "S-3", "S-3/A"],
};

/** Canonical filing types we keep — must exactly match. */
const KEEP_FILE_TYPES = new Set(["S-1", "S-1/A", "S-3", "S-3/A"]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatAccession = (a: string): string => a.replace(/-/g, "");

interface EdgarHitSource {
  ciks?: string[];
  display_names?: string[];
  form?: string;
  file_type?: string;
  file_date?: string;
  period_ending?: string;
  file_num?: string[];
  adsh?: string;
  biz_states?: string[];
  inc_states?: string[];
  sics?: string[];
}

interface EdgarHit {
  _id?: string;
  _source?: EdgarHitSource;
}

interface EdgarSearchResponse {
  hits?: {
    total?: { value?: number };
    hits?: EdgarHit[];
  };
}

async function fetchJson(url: string): Promise<EdgarSearchResponse> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`EDGAR FTS ${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as EdgarSearchResponse;
}

/** Display name format from EDGAR FTS:
 *   "Karyopharm Therapeutics Inc.  (KPTI)  (CIK 0001503802)"
 *   "Kraneshares Crypto Trust  (CIK 0002073505)"
 * Extract the plain entity name and optional ticker. */
interface ParsedDisplayName {
  name: string;
  ticker: string;
}

function parseDisplayName(raw: string): ParsedDisplayName {
  const withoutCik = raw.replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
  // Optional "(TICKER)" suffix — 1-5 uppercase letters / digits with dots.
  const tickerMatch = withoutCik.match(/\(([A-Z][A-Z0-9.]{0,4})\)\s*$/);
  if (tickerMatch) {
    return {
      name: withoutCik.replace(/\([A-Z][A-Z0-9.]{0,4}\)\s*$/, "").trim(),
      ticker: tickerMatch[1] ?? "",
    };
  }
  return { name: withoutCik, ticker: "" };
}

function normalizeHit(
  hit: EdgarHit,
  scrapedAt: string,
): RegistrationStatement | null {
  const src = hit._source;
  if (!src) return null;
  const accession = src.adsh ?? "";
  if (!accession) return null;
  const fileType = src.file_type ?? "";
  // Drop exhibits / opinion letters / fee tables. Keep only canonical S-1 / S-3 forms.
  if (!KEEP_FILE_TYPES.has(fileType)) return null;

  const ciks = src.ciks ?? [];
  const archiveCik = (ciks[0] ?? "").replace(/^0+/, "");
  const filerCik = (ciks[0] ?? "").padStart(10, "0");
  const display = parseDisplayName(src.display_names?.[0] ?? "");
  const idParts = (hit._id ?? "").split(":");
  const primaryDoc = idParts[1] ?? "";
  if (!archiveCik || !primaryDoc) return null;

  const accNoDash = formatAccession(accession);
  return {
    filing_id: accession,
    filing_type: fileType,
    is_amendment: fileType.endsWith("/A"),
    file_date: src.file_date ?? "",
    filer_name: display.name,
    filer_cik: filerCik,
    filer_ticker: display.ticker,
    sec_file_number: src.file_num?.[0] ?? "",
    filer_state: src.biz_states?.[0] ?? "",
    inc_state: src.inc_states?.[0] ?? "",
    sic_codes: src.sics ?? [],
    primary_document_url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${primaryDoc}`,
    filing_url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${accession}-index.htm`,
    scraped_at: scrapedAt,
  };
}

export interface ScrapeRegStatementsOptions {
  lookbackDays?: number;
  maxFilingsPerForm?: number;
}

export async function scrapeRegistrationStatementsLiveFeed(
  options: ScrapeRegStatementsOptions = {},
): Promise<RegistrationStatement[]> {
  const scrapedAt = new Date().toISOString();
  const lookbackDays = options.lookbackDays ?? 2;
  const maxFilingsPerForm = options.maxFilingsPerForm ?? 2000;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  console.error(
    `[reg-stmt] Window ${startStr} → ${endStr}, forms: ${CONFIG.FORM_CODES.join(", ")}`,
  );

  const byAccession = new Map<string, RegistrationStatement>();
  for (const form of CONFIG.FORM_CODES) {
    const formEncoded = encodeURIComponent(form);
    let from = 0;
    let pulled = 0;
    while (pulled < maxFilingsPerForm) {
      const url =
        `${CONFIG.SEARCH_URL}?q=%22%22&forms=${formEncoded}` +
        `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
        `&hits=${CONFIG.FTS_HITS_PER_PAGE}&from=${from}`;
      let data: EdgarSearchResponse;
      try {
        data = await fetchJson(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[reg-stmt] ${form} from=${from}: SKIP — ${msg}`);
        break;
      }
      const hits = data.hits?.hits ?? [];
      const total = data.hits?.total?.value ?? hits.length;
      if (from === 0) {
        console.error(
          `[reg-stmt]   ${form}: ${total} total in window`,
        );
      }
      for (const hit of hits) {
        const filing = normalizeHit(hit, scrapedAt);
        if (filing) byAccession.set(filing.filing_id, filing);
      }
      pulled += hits.length;
      console.error(
        `[reg-stmt]   ${form} from=${from}: +${hits.length} (running ${byAccession.size} unique)`,
      );
      if (hits.length < CONFIG.FTS_HITS_PER_PAGE) break;
      from += CONFIG.FTS_HITS_PER_PAGE;
    }
  }

  const out = Array.from(byAccession.values());
  console.error(`[reg-stmt] TOTAL: ${out.length} unique registration statements`);
  return out;
}
