/**
 * FINRA OTC Transparency scraper — weekly off-exchange (ATS / OTC) volume.
 *
 * api.finra.org/data/group/otcMarket/name/weeklySummary is FINRA's free
 * public Data API. No auth required. POST + JSON body with compareFilters,
 * sortFields, limit, offset. Response is JSON; pagination via headers
 * (record-total, record-max-limit: 5000, record-offset).
 *
 * What this dataset is: every week, FINRA publishes how much of every
 * NMS stock and OTC equity was traded through Alternative Trading Systems
 * (ATS, the formal term for "dark pools") and OTC firms (FINRA-registered
 * dealers reporting their over-the-counter activity). The result is the
 * canonical dark-pool transparency feed — same data Quiver Quantitative
 * and Unusual Whales surface.
 *
 * v1A scope: ingest ATS_W_SMBL_FIRM (issue × venue weekly granularity) for
 * a single week per run. ~250K records per fully-published week. Schedule
 * a weekly Cloud Function (Sunday or Monday) to append next week. Composite
 * doc IDs preserve full history.
 *
 * Partition keys (FINRA-imposed): weekStartDate + tierIdentifier MUST be
 * specified with EQUAL filters before sortFields is honored. We don't sort,
 * we just paginate by offset.
 *
 * Volume note: per-week record-total varies by tier:
 *   - T1 (S&P 500, Russell 1000 + ETPs): ~50-70K rows/week
 *   - T2 (other NMS): ~180-200K rows/week
 *   - OTCE (pink sheets): ~30-50K rows/week
 *   Total fully-published week: ~250-280K rows.
 */

import type { OtcMarketWeekly } from "../types.js";

const CONFIG = {
  USER_AGENT: process.env.FINRA_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.finra.org",
  ENDPOINT: "/data/group/otcMarket/name/weeklySummary",
  /** FINRA's max page size, per response header `record-max-limit`. */
  PAGE_SIZE: 5000,
  /** Be a good citizen on a free public API. */
  RATE_LIMIT_MS: 200,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Raw FINRA response shape ──────────────────────────────────────────────

interface RawOtcRow {
  weekStartDate?: string;
  summaryStartDate?: string;
  MPID?: string;
  marketParticipantName?: string;
  issueSymbolIdentifier?: string;
  issueName?: string;
  tierIdentifier?: string;
  tierDescription?: string;
  summaryTypeCode?: string;
  totalWeeklyTradeCount?: number;
  totalWeeklyShareQuantity?: number;
  totalNotionalSum?: number;
  firmCRDNumber?: string | null;
  productTypeCode?: string | null;
  initialPublishedDate?: string;
  lastUpdateDate?: string;
  lastReportedDate?: string;
}

// ─── Doc-id + normalization helpers ────────────────────────────────────────

/** Strip any character illegal in a Firestore doc ID. Same defense-in-depth
 *  pattern as the SEC scrapers — we never trust upstream IDs to be Firestore-safe. */
function sanitizeForDocId(s: string): string {
  return s
    .replace(/[/\\#?\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(raw: RawOtcRow, scrapedAt: string): OtcMarketWeekly | null {
  const week = raw.weekStartDate ?? raw.summaryStartDate ?? "";
  const mpid = raw.MPID ?? "";
  const symbol = raw.issueSymbolIdentifier ?? "";
  const summaryType = raw.summaryTypeCode ?? "";
  // ATS_W_VOL_STATS rows have empty symbol (firm-level rollup). Use a sentinel.
  const symbolForId = symbol || "_FIRM_TOTAL";
  if (!week || !mpid) return null;
  const weeklyId = sanitizeForDocId(`${week}-${symbolForId}-${mpid}-${summaryType}`);
  return {
    weekly_id: weeklyId,
    week_start_date: week,
    mpid,
    market_participant_name: raw.marketParticipantName ?? "",
    issue_symbol: symbol,
    issue_name: raw.issueName ?? "",
    tier_identifier: raw.tierIdentifier ?? "",
    tier_description: raw.tierDescription ?? "",
    summary_type_code: summaryType,
    total_weekly_trade_count:
      typeof raw.totalWeeklyTradeCount === "number"
        ? raw.totalWeeklyTradeCount
        : 0,
    total_weekly_share_quantity:
      typeof raw.totalWeeklyShareQuantity === "number"
        ? raw.totalWeeklyShareQuantity
        : 0,
    total_notional_sum:
      typeof raw.totalNotionalSum === "number" ? raw.totalNotionalSum : 0,
    firm_crd_number: raw.firmCRDNumber ?? "",
    product_type_code: raw.productTypeCode ?? "",
    initial_published_date: raw.initialPublishedDate ?? "",
    last_update_date: raw.lastUpdateDate ?? "",
    last_reported_date: raw.lastReportedDate ?? "",
    // FINRA's OTC Transparency portal exposes per-issue rollup pages
    // at otctransparency.finra.org. The per-row weekly summary doesn't
    // have a permalink, but the issue-level page shows the same data.
    // For ATS_W_VOL_STATS rows (no symbol), point at the firm-level page.
    finra_source_url: symbol
      ? `https://otctransparency.finra.org/otctransparency/AtsIssueData?issueSymbol=${encodeURIComponent(symbol)}`
      : `https://otctransparency.finra.org/otctransparency/AtsData?mpid=${encodeURIComponent(mpid)}`,
    scraped_at: scrapedAt,
  };
}

// ─── Paginated fetcher with retry ──────────────────────────────────────────

interface CompareFilter {
  fieldName: string;
  fieldValue: string;
  compareType: "EQUAL" | "GREATER_THAN" | "LESS_THAN";
}

interface FetchOptions {
  filters: CompareFilter[];
  maxPages?: number;
}

async function fetchAllRows(
  options: FetchOptions,
): Promise<RawOtcRow[]> {
  const maxPages = options.maxPages ?? 1000;
  const all: RawOtcRow[] = [];
  let offset = 0;
  let recordTotal = 0;
  let page = 0;

  while (page < maxPages) {
    const body = {
      limit: CONFIG.PAGE_SIZE,
      offset,
      compareFilters: options.filters,
    };

    await sleep(CONFIG.RATE_LIMIT_MS);

    // Retry on 5xx + network errors. FINRA's API is reliable but Cloudflare
    // sometimes injects transient errors during heavy pulls.
    let res: Response | null = null;
    let attempt = 0;
    const MAX_RETRIES = 5;
    while (attempt <= MAX_RETRIES) {
      try {
        res = await fetch(`${CONFIG.BASE_URL}${CONFIG.ENDPOINT}`, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": CONFIG.USER_AGENT,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt);
          console.error(
            `[finra]   offset=${offset}: network error (${msg}), retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}s`,
          );
          await sleep(backoff * 1000);
          attempt++;
          continue;
        }
        throw err;
      }
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
        console.error(
          `[finra]   offset=${offset}: 429 rate-limited, waiting ${retryAfter}s...`,
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt);
          console.error(
            `[finra]   offset=${offset}: HTTP ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}s`,
          );
          await sleep(backoff * 1000);
          attempt++;
          continue;
        }
        throw new Error(
          `FINRA OTC HTTP ${res.status} at offset ${offset} after ${MAX_RETRIES} retries`,
        );
      }
      break;
    }
    if (!res || !res.ok) {
      throw new Error(
        `FINRA OTC HTTP ${res?.status ?? "(no response)"} ${res?.statusText ?? ""} at offset ${offset}`,
      );
    }

    if (page === 0) {
      recordTotal = parseInt(res.headers.get("record-total") ?? "0", 10);
      console.error(
        `[finra]   record-total: ${recordTotal} rows for this filter`,
      );
      // FINRA returns an EMPTY BODY (not "[]") when record-total is 0, which
      // makes res.json() throw "Unexpected end of JSON input". Bail before the
      // parse. This is the common case for recent weeks where FINRA hasn't
      // published yet — a normal "no data", not an error.
      if (recordTotal === 0) {
        console.error(`[finra]   no rows published for this filter; skipping`);
        break;
      }
    }

    // Defensive parse: even with record-total > 0, a short/empty body
    // shouldn't crash the whole weekly run. Treat an unparseable/empty
    // response as end-of-data rather than throwing.
    const responseText = await res.text();
    if (responseText.trim() === "") {
      console.error(`[finra]   empty body at offset=${offset}; ending pagination`);
      break;
    }
    let rows: RawOtcRow[];
    try {
      rows = JSON.parse(responseText) as RawOtcRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[finra]   JSON parse failed at offset=${offset} (${msg}); ending pagination`,
      );
      break;
    }
    all.push(...rows);
    page++;
    console.error(
      `[finra]   page ${page} offset=${offset}: ${rows.length} rows (running ${all.length}/${recordTotal})`,
    );

    if (rows.length === 0) break;
    offset += rows.length;
    if (offset >= recordTotal) break;
  }

  if (page >= maxPages && recordTotal > all.length) {
    console.error(
      `[finra]   WARNING: hit maxPages=${maxPages}; pulled ${all.length}/${recordTotal}`,
    );
  }
  return all;
}

// ─── Public scraper ────────────────────────────────────────────────────────

export interface ScrapeOtcOptions {
  /** ISO week-start date (Monday). Required (FINRA partition key). */
  weekStartDate: string;
  /** Tier to scrape. FINRA requires tier as a partition filter, so we must
   *  iterate the tiers explicitly. Default: all three (T1 + T2 + OTCE). */
  tiers?: string[];
  /** Filter to a single summary type code. Default: ATS_W_SMBL_FIRM only
   *  (the granular row-per-venue dark-pool detail; the most agent-useful slice). */
  summaryTypeCode?: string;
  maxPages?: number;
}

/** All FINRA-published tier codes. Required to be iterated because tier is a
 *  partition key on the FINRA API. */
const ALL_TIERS = ["T1", "T2", "OTCE"];

/**
 * Pull one FINRA OTC week of summary data, iterating tiers and deduping by
 * composite weekly_id. Default: ATS_W_SMBL_FIRM only (the dark-pool detail).
 *
 * Returns one row per (week × ticker × venue × summary type). Saving via
 * saveOtcMarketWeekly is idempotent — re-running upserts cleanly.
 */
export async function scrapeFinraOtcWeek(
  options: ScrapeOtcOptions,
): Promise<OtcMarketWeekly[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.weekStartDate)) {
    throw new Error(
      `weekStartDate must be ISO YYYY-MM-DD; got ${options.weekStartDate}`,
    );
  }
  const summaryTypeCode = options.summaryTypeCode ?? "ATS_W_SMBL_FIRM";
  const tiers = options.tiers ?? ALL_TIERS;
  const scrapedAt = new Date().toISOString();
  console.error(
    `[finra otc] Week ${options.weekStartDate} | tiers: ${tiers.join(", ")} | summaryType: ${summaryTypeCode}`,
  );

  const seen = new Map<string, OtcMarketWeekly>();
  for (const tier of tiers) {
    console.error(`[finra otc]   tier=${tier}`);
    const filters: CompareFilter[] = [
      {
        fieldName: "weekStartDate",
        fieldValue: options.weekStartDate,
        compareType: "EQUAL",
      },
      {
        fieldName: "tierIdentifier",
        fieldValue: tier,
        compareType: "EQUAL",
      },
      {
        fieldName: "summaryTypeCode",
        fieldValue: summaryTypeCode,
        compareType: "EQUAL",
      },
    ];
    const raws = await fetchAllRows({ filters, ...(options.maxPages !== undefined && { maxPages: options.maxPages }) });
    for (const raw of raws) {
      const norm = normalize(raw, scrapedAt);
      if (norm) seen.set(norm.weekly_id, norm);
    }
  }
  const rows = Array.from(seen.values());
  console.error(`[finra otc] TOTAL: ${rows.length} unique rows for ${options.weekStartDate}`);
  return rows;
}
