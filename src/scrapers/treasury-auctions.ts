/**
 * Treasury Auctions scraper — debt auction announcements + results.
 *
 * Source: api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/
 *         accounting/od/auctions_query
 *
 * No auth required. Clean REST + JSON. Covers Bills (≤1yr), Notes (2-10yr),
 * Bonds (20-30yr), TIPS (inflation-protected), and FRN (floating-rate).
 *
 * Records have a two-stage lifecycle:
 *   1. Announcement (pre-auction): record exists with offering_amt + auction
 *      schedule fields populated, results fields null.
 *   2. Results (post-auction): same record gets bid_to_cover_ratio, yields,
 *      bidder breakdowns populated.
 *
 * Idempotent doc-ID = `{cusip}-{auction_date}`. Re-running after results
 * publish correctly overwrites the announcement-only record with full data.
 *
 * Key demand signal agents care about: bid_to_cover_ratio.
 *   > 2.5 = strong demand
 *   < 2.0 = weak / cautious demand
 *
 * SOMA (System Open Market Account) holdings show the Fed's direct
 * allocation — a real-time measure of QE/QT activity on each issuance.
 */
import type { TreasuryAuction } from "../types.js";

const CONFIG = {
  BASE_URL:
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query",
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  PAGE_SIZE: 200,
  RATE_LIMIT_MS: 250,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Coerce a Treasury API field to number. Their API serializes EVERYTHING as
 * strings — "null", "0", "2.345" — so we normalize once here. Sentinel
 * value "null" (literal string) means missing; map to JS null.
 */
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  if (v === "" || v === "null" || v.toLowerCase() === "n/a") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return v === "Yes" || v.toLowerCase() === "true";
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v === "null" ? "" : v;
  return String(v);
}

/**
 * Raw shape of one auction record from the API. Treasury's JSON ships
 * everything as string-typed; we type the relevant subset and normalize
 * inside `normalize()`.
 */
interface RawAuction {
  cusip?: string;
  security_type?: string;
  security_term?: string;
  auction_date?: string;
  issue_date?: string;
  maturity_date?: string;
  announcemt_date?: string;
  offering_amt?: string;
  total_tendered?: string;
  total_accepted?: string;
  bid_to_cover_ratio?: string;
  high_yield?: string;
  low_yield?: string;
  avg_med_yield?: string;
  high_discnt_rate?: string;
  low_discnt_rate?: string;
  avg_med_discnt_rate?: string;
  high_investment_rate?: string;
  low_investment_rate?: string;
  avg_med_investment_rate?: string;
  high_price?: string;
  low_price?: string;
  avg_med_price?: string;
  comp_tendered?: string;
  comp_accepted?: string;
  noncomp_accepted?: string;
  primary_dealer_tendered?: string;
  primary_dealer_accepted?: string;
  direct_bidder_tendered?: string;
  direct_bidder_accepted?: string;
  indirect_bidder_tendered?: string;
  indirect_bidder_accepted?: string;
  soma_tendered?: string;
  soma_accepted?: string;
  soma_holdings?: string;
  soma_included?: string;
  fima_included?: string;
  treas_retail_accepted?: string;
  reopening?: string;
  callable?: string;
  inflation_index_security?: string;
  auction_format?: string;
  int_rate?: string;
  pdf_filenm_announcemt?: string;
  pdf_filenm_comp_results?: string;
  pdf_filenm_noncomp_results?: string;
}

function pdfUrl(filename: string | undefined): string | null {
  if (!filename || filename === "null") return null;
  // Treasury hosts press-release PDFs at /press/preanre/YYYY/<filename>
  // where YYYY is derived from the filename's date prefix (A_YYYYMMDD_*.pdf).
  const match = filename.match(/^[ACR]_(\d{4})\d{4}_/);
  const year = match ? match[1] : new Date().getFullYear().toString();
  return `https://www.treasurydirect.gov/instit/annceresult/press/preanre/${year}/${filename}`;
}

function normalize(raw: RawAuction, scrapedAt: string): TreasuryAuction | null {
  const cusip = toStr(raw.cusip);
  const auctionDate = toStr(raw.auction_date);
  if (!cusip || !auctionDate) return null;

  return {
    id: `${cusip}-${auctionDate}`,
    cusip,
    security_type: toStr(raw.security_type),
    security_term: toStr(raw.security_term),
    auction_date: auctionDate,
    issue_date: toStr(raw.issue_date),
    maturity_date: toStr(raw.maturity_date),
    announcement_date: toStr(raw.announcemt_date),
    offering_amount: toNum(raw.offering_amt) ?? 0,
    total_tendered: toNum(raw.total_tendered),
    total_accepted: toNum(raw.total_accepted),
    bid_to_cover_ratio: toNum(raw.bid_to_cover_ratio),
    high_yield: toNum(raw.high_yield),
    low_yield: toNum(raw.low_yield),
    average_yield: toNum(raw.avg_med_yield),
    high_discount_rate: toNum(raw.high_discnt_rate),
    low_discount_rate: toNum(raw.low_discnt_rate),
    average_discount_rate: toNum(raw.avg_med_discnt_rate),
    high_investment_rate: toNum(raw.high_investment_rate),
    low_investment_rate: toNum(raw.low_investment_rate),
    average_investment_rate: toNum(raw.avg_med_investment_rate),
    high_price: toNum(raw.high_price),
    low_price: toNum(raw.low_price),
    average_price: toNum(raw.avg_med_price),
    competitive_tendered: toNum(raw.comp_tendered),
    competitive_accepted: toNum(raw.comp_accepted),
    noncompetitive_accepted: toNum(raw.noncomp_accepted),
    primary_dealer_tendered: toNum(raw.primary_dealer_tendered),
    primary_dealer_accepted: toNum(raw.primary_dealer_accepted),
    direct_bidder_tendered: toNum(raw.direct_bidder_tendered),
    direct_bidder_accepted: toNum(raw.direct_bidder_accepted),
    indirect_bidder_tendered: toNum(raw.indirect_bidder_tendered),
    indirect_bidder_accepted: toNum(raw.indirect_bidder_accepted),
    soma_tendered: toNum(raw.soma_tendered),
    soma_accepted: toNum(raw.soma_accepted),
    soma_holdings: toNum(raw.soma_holdings),
    soma_included: toBool(raw.soma_included),
    fima_included: toBool(raw.fima_included),
    treas_retail_accepted: toNum(raw.treas_retail_accepted),
    reopening: toBool(raw.reopening),
    callable: toBool(raw.callable),
    inflation_indexed: toBool(raw.inflation_index_security),
    auction_format: toStr(raw.auction_format),
    interest_rate: toNum(raw.int_rate),
    pdf_announcement_url: pdfUrl(raw.pdf_filenm_announcemt),
    pdf_competitive_results_url: pdfUrl(raw.pdf_filenm_comp_results),
    pdf_noncompetitive_results_url: pdfUrl(raw.pdf_filenm_noncomp_results),
    // Treasury exposes per-CUSIP detail pages keyed by CUSIP
    treasury_source_url: `https://www.treasurydirect.gov/auctions/auction-query/?cusip=${encodeURIComponent(cusip)}`,
    scraped_at: scrapedAt,
  };
}

interface ApiResponse {
  data?: RawAuction[];
  meta?: { "total-count"?: number };
  links?: { next?: string };
}

/**
 * Pull Treasury auction records filtered by date range. The API paginates
 * with page[number] and page[size]; we iterate until we run out of pages
 * or hit maxRecords.
 */
export async function scrapeTreasuryAuctions(
  options: {
    sinceDate?: string;
    untilDate?: string;
    maxRecords?: number;
  } = {},
): Promise<TreasuryAuction[]> {
  const sinceDate = options.sinceDate ?? "";
  const untilDate = options.untilDate ?? "";
  const maxRecords = options.maxRecords ?? 1000;
  const scrapedAt = new Date().toISOString();

  const params = new URLSearchParams();
  params.set("page[size]", String(CONFIG.PAGE_SIZE));
  params.set("sort", "-auction_date");
  if (sinceDate || untilDate) {
    const filters: string[] = [];
    if (sinceDate) filters.push(`auction_date:gte:${sinceDate}`);
    if (untilDate) filters.push(`auction_date:lte:${untilDate}`);
    params.set("filter", filters.join(","));
  }

  const out: TreasuryAuction[] = [];
  let pageNum = 1;
  let totalCount: number | null = null;

  while (out.length < maxRecords) {
    params.set("page[number]", String(pageNum));
    const url = `${CONFIG.BASE_URL}?${params.toString()}`;
    await sleep(CONFIG.RATE_LIMIT_MS);

    const res = await fetch(url, {
      headers: { "User-Agent": CONFIG.USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Treasury auctions HTTP ${res.status} ${res.statusText} — ${url}`,
      );
    }
    const data = (await res.json()) as ApiResponse;
    if (totalCount === null) {
      totalCount = data.meta?.["total-count"] ?? 0;
      console.error(
        `[treasury-auctions]   page 1: total=${totalCount}, range=${sinceDate}→${untilDate || "(open)"}`,
      );
    }
    const rows = data.data ?? [];
    if (rows.length === 0) break;

    for (const raw of rows) {
      const norm = normalize(raw, scrapedAt);
      if (norm) out.push(norm);
      if (out.length >= maxRecords) break;
    }

    console.error(
      `[treasury-auctions]   page ${pageNum}: ${rows.length} rows (running ${out.length}/${totalCount ?? "?"})`,
    );

    if (rows.length < CONFIG.PAGE_SIZE) break;
    pageNum++;
  }

  console.error(
    `[treasury-auctions] TOTAL: ${out.length} normalized auction records`,
  );
  return out;
}
