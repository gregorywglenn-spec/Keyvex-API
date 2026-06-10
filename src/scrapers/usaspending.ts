/**
 * USAspending federal contract award scraper — first non-SEC source.
 *
 * api.usaspending.gov is a free public REST API maintained by Treasury.
 * No auth, no scraping, JSON in/out. The killer political-alpha cross-source
 * query: join `congressional_trades` (by ticker + member + date) to
 * `federal_contracts` (by recipient name + date) — "Senator buys LMT on
 * Mar 15, defense contract awarded to Lockheed Martin on Mar 17."
 *
 * Endpoint: /api/v2/search/spending_by_award/ (POST)
 *   - filters.time_period: array of { start_date, end_date } windows
 *   - filters.award_type_codes: ['A','B','C','D'] for contracts
 *     (skip grants/loans/direct payments for v1)
 *   - filters.recipient_search_text: array of recipient name substrings
 *   - fields: array of column names to return
 *   - page / limit (max 100): pagination
 *   - sort / order: server-side sort
 *
 * Pagination: page_metadata.hasNext + last_record_unique_id (for cursor mode).
 * For v1 we just bump page number until hasNext=false or we hit a max-pages
 * cap (default 10 = 1000 records per scrape run).
 *
 * Award type codes (full set; v1 captures contracts only):
 *   A = BPA Call
 *   B = Purchase Order
 *   C = Delivery Order
 *   D = Definitive Contract
 *   IDV_A/B/C/D/E = Indefinite Delivery Vehicle subtypes
 *   02/03/04/05 = Grant subtypes
 *   06/10 = Direct payment subtypes
 *   07/08 = Loan subtypes
 *   09/11 = Insurance / Other
 */

import type { FederalContractAward } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.usaspending.gov",
  AWARD_URL_BASE: "https://www.usaspending.gov/award",
  RATE_LIMIT_MS: 200, // generous — USAspending is unrate-limited but be a good citizen
  CONTRACT_AWARD_TYPES: ["A", "B", "C", "D"] as const,
  PAGE_SIZE: 100,
  DEFAULT_MAX_PAGES: 10, // 1000 records max per scrape run
};

const FIELDS_TO_REQUEST = [
  "Award ID",
  "Recipient Name",
  "recipient_id",
  "Recipient UEI",
  "Award Amount",
  "Total Outlays",
  "Description",
  "Contract Award Type",
  "Awarding Agency",
  "Awarding Sub Agency",
  "NAICS",
  "PSC",
  "def_codes",
  "Start Date",
  "End Date",
  "Last Modified Date",
  "Place of Performance State Code",
  "generated_internal_id",
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RawAwardResult {
  internal_id?: number;
  generated_internal_id?: string;
  "Award ID"?: string;
  "Recipient Name"?: string;
  recipient_id?: string;
  "Recipient UEI"?: string;
  "Award Amount"?: number;
  "Total Outlays"?: number;
  Description?: string;
  "Contract Award Type"?: string;
  "Awarding Agency"?: string;
  "Awarding Sub Agency"?: string;
  NAICS?: { code?: string; description?: string };
  PSC?: { code?: string; description?: string };
  def_codes?: string[];
  "Start Date"?: string;
  "End Date"?: string;
  "Last Modified Date"?: string;
  "Place of Performance State Code"?: string;
}

interface SearchResponse {
  results?: RawAwardResult[];
  page_metadata?: {
    page?: number;
    hasNext?: boolean;
    last_record_unique_id?: number;
    last_record_sort_value?: string;
  };
}

interface SearchFilters {
  time_period?: Array<{
    start_date: string;
    end_date: string;
    /** "action_date" (default) | "date_signed" | "last_modified_date" —
     *  last_modified_date verified working 2026-06-10. */
    date_type?: string;
  }>;
  award_type_codes?: readonly string[];
  recipient_search_text?: string[];
  agencies?: Array<{ type: string; tier: string; name: string }>;
  /** Verified server-side 2026-06-10. */
  naics_codes?: string[];
  psc_codes?: string[];
  award_amounts?: Array<{ lower_bound?: number; upper_bound?: number }>;
}

async function postSearch(
  filters: SearchFilters,
  page: number,
  sort = "Last Modified Date",
  order: "desc" | "asc" = "desc",
): Promise<SearchResponse> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(
    `${CONFIG.BASE_URL}/api/v2/search/spending_by_award/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CONFIG.USER_AGENT,
      },
      body: JSON.stringify({
        filters,
        fields: FIELDS_TO_REQUEST,
        page,
        limit: CONFIG.PAGE_SIZE,
        sort,
        order,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `USAspending ${res.status} ${res.statusText} on page ${page}`,
    );
  }
  return (await res.json()) as SearchResponse;
}

/**
 * Convert USAspending's "Last Modified Date" timestamp ("2026-04-28 10:50:00")
 * to ISO 8601 ("2026-04-28T10:50:00"). Trivial but consistent with the rest
 * of the system using ISO dates everywhere.
 */
function toIsoTimestamp(raw: string | undefined): string {
  if (!raw) return "";
  // USAspending uses "YYYY-MM-DD HH:MM:SS"; replace the space with T.
  return raw.replace(" ", "T");
}

/**
 * Map a raw USAspending result row to our FederalContractAward shape.
 * Defensive: every field has a fallback in case USAspending omits it for
 * a particular row.
 */
function normalizeAward(raw: RawAwardResult): FederalContractAward | null {
  const id = raw.generated_internal_id ?? "";
  if (!id) return null; // can't dedup without it; skip
  return {
    id,
    award_id: raw["Award ID"] ?? "",
    recipient_name: raw["Recipient Name"] ?? "",
    recipient_uei: raw["Recipient UEI"] ?? "",
    recipient_id: raw.recipient_id ?? "",
    award_amount: typeof raw["Award Amount"] === "number" ? raw["Award Amount"] : 0,
    total_outlays:
      typeof raw["Total Outlays"] === "number" ? raw["Total Outlays"] : 0,
    description: raw.Description ?? "",
    contract_award_type: raw["Contract Award Type"] ?? "",
    awarding_agency: raw["Awarding Agency"] ?? "",
    awarding_subagency: raw["Awarding Sub Agency"] ?? "",
    naics_code: raw.NAICS?.code ?? "",
    naics_description: raw.NAICS?.description ?? "",
    psc_code: raw.PSC?.code ?? "",
    psc_description: raw.PSC?.description ?? "",
    def_codes: Array.isArray(raw.def_codes) ? raw.def_codes : [],
    start_date: raw["Start Date"] ?? "",
    end_date: raw["End Date"] ?? "",
    last_modified_date: toIsoTimestamp(raw["Last Modified Date"]),
    place_of_performance_state: raw["Place of Performance State Code"] ?? "",
    award_url: `${CONFIG.AWARD_URL_BASE}/${id}/`,
    data_source: "USASPENDING",
  };
}

// ─── Public scrapers ────────────────────────────────────────────────────────

/**
 * Pull federal contract awards modified in the last N days, sorted by
 * Last Modified Date desc. Captures both new awards and modifications to
 * existing awards (USAspending doesn't distinguish at the API level).
 *
 * Caps at maxPages × 100 records. For a typical 7-day window across all
 * federal contracts, the default 10-page cap (1000 records) is the right
 * size — bigger windows would need bumping or a date-walking strategy.
 */
export async function scrapeContractsLiveFeed(
  lookbackDays = 7,
  maxPages = CONFIG.DEFAULT_MAX_PAGES,
): Promise<FederalContractAward[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0]!;
  const endStr = end.toISOString().split("T")[0]!;

  console.error(
    `[usaspending live] Window ${startStr} → ${endStr}, max ${maxPages} pages of ${CONFIG.PAGE_SIZE}`,
  );

  const filters: SearchFilters = {
    time_period: [{ start_date: startStr, end_date: endStr }],
    award_type_codes: CONFIG.CONTRACT_AWARD_TYPES,
  };

  const all: FederalContractAward[] = [];
  let page = 1;
  while (page <= maxPages) {
    let resp: SearchResponse;
    try {
      resp = await postSearch(filters, page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[usaspending live]   page ${page}: SKIP — ${msg}`);
      break;
    }
    const rows = (resp.results ?? []).map(normalizeAward).filter(
      (r): r is FederalContractAward => r !== null,
    );
    all.push(...rows);
    console.error(
      `[usaspending live]   page ${page}: ${rows.length} awards (running total ${all.length})`,
    );
    if (!resp.page_metadata?.hasNext) break;
    page++;
  }

  console.error(
    `[usaspending live] TOTAL: ${all.length} contract awards in last ${lookbackDays}d`,
  );
  return all;
}

/**
 * Pull federal contract awards for a specific recipient name (substring
 * matched). Useful for "what contracts did Lockheed Martin get this year"
 * queries. Recipient name in USAspending is filed as the legal entity
 * name, often ALL CAPS, sometimes with subsidiary suffixes ("LOCKHEED
 * MARTIN MISSILES AND FIRE CONTROL", "LOCKHEED MARTIN CORPORATION", etc.)
 * — pass the parent name as substring to catch all variants.
 */
export async function scrapeContractsByRecipient(
  recipientName: string,
  lookbackDays = 365,
  maxPages = CONFIG.DEFAULT_MAX_PAGES,
): Promise<FederalContractAward[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0]!;
  const endStr = end.toISOString().split("T")[0]!;

  console.error(
    `[usaspending] Recipient "${recipientName}", window ${startStr} → ${endStr}, max ${maxPages} pages`,
  );

  const filters: SearchFilters = {
    time_period: [{ start_date: startStr, end_date: endStr }],
    award_type_codes: CONFIG.CONTRACT_AWARD_TYPES,
    recipient_search_text: [recipientName],
  };

  const all: FederalContractAward[] = [];
  let page = 1;
  while (page <= maxPages) {
    let resp: SearchResponse;
    try {
      // Sort by Award Amount desc for by-recipient pulls — agents asking
      // "what contracts did this recipient get" usually want the biggest first.
      resp = await postSearch(filters, page, "Award Amount", "desc");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[usaspending]   page ${page}: SKIP — ${msg}`);
      break;
    }
    const rows = (resp.results ?? []).map(normalizeAward).filter(
      (r): r is FederalContractAward => r !== null,
    );
    all.push(...rows);
    console.error(
      `[usaspending]   page ${page}: ${rows.length} awards (running total ${all.length})`,
    );
    if (!resp.page_metadata?.hasNext) break;
    page++;
  }

  console.error(
    `[usaspending] TOTAL: ${all.length} awards for recipient matching "${recipientName}"`,
  );
  return all;
}

// ─── Live-search path (MCP passthrough) ────────────────────────────────────

export interface AwardsLiveQuery {
  /** Pushed server-side as recipient_search_text (name keyword match). */
  recipientName?: string;
  naicsCode?: string;
  pscCode?: string;
  minAmount?: number;
  /** last_modified_date bounds — pushed via time_period date_type
   *  "last_modified_date" (verified 2026-06-10). */
  lastModifiedSince?: string;
  lastModifiedUntil?: string;
  /** API sort field name ("Last Modified Date" / "Start Date" /
   *  "Award Amount" / "Total Outlays" — all verified 2026-06-10). */
  sort: string;
  order: "asc" | "desc";
  /** Pages of 100 to fetch. */
  maxPages: number;
  /** Also POST spending_by_award_count for the authoritative total. */
  wantTotal: boolean;
}

function buildContractFilters(q: AwardsLiveQuery): SearchFilters {
  const filters: SearchFilters = {
    award_type_codes: CONFIG.CONTRACT_AWARD_TYPES,
  };
  if (q.recipientName) filters.recipient_search_text = [q.recipientName];
  if (q.naicsCode) filters.naics_codes = [q.naicsCode];
  if (q.pscCode) filters.psc_codes = [q.pscCode];
  if (q.minAmount !== undefined) {
    filters.award_amounts = [{ lower_bound: q.minAmount }];
  }
  if (q.lastModifiedSince || q.lastModifiedUntil) {
    filters.time_period = [
      {
        // USAspending searches floor at 2007-10-01 (API-reported).
        start_date: q.lastModifiedSince ?? "2007-10-01",
        end_date: q.lastModifiedUntil ?? new Date().toISOString().slice(0, 10),
        date_type: "last_modified_date",
      },
    ];
  }
  return filters;
}

/** POST spending_by_award_count with the same filters; returns the bucket
 *  for the requested award family. Throws on non-OK (callers treat the
 *  total as best-effort). */
export async function fetchAwardCount(
  filters: SearchFilters,
  bucket: "contracts" | "grants",
): Promise<number> {
  const res = await fetch(
    `${CONFIG.BASE_URL}/api/v2/search/spending_by_award_count/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CONFIG.USER_AGENT,
      },
      body: JSON.stringify({ filters }),
    },
  );
  if (!res.ok) {
    throw new Error(`USAspending count ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    results?: Record<string, number | undefined>;
  };
  return json.results?.[bucket] ?? 0;
}

export interface ContractsLiveResult {
  awards: FederalContractAward[];
  /** spending_by_award_count "contracts" bucket for exactly these filters —
   *  authoritative volume over the full USAspending dataset. Undefined when
   *  not requested or the count call failed (best-effort). */
  totalCount?: number;
}

/** One live query for the MCP passthrough: server-side filters + sort,
 *  paged, with the count fetched IN PARALLEL with the first page (the count
 *  aggregation is the slow half; serializing it blew the 8s liveFirst
 *  budget on unbounded recipient queries). Throws on a failed search — the
 *  caller's liveFirst wrapper handles cache fallback. */
export async function searchContractsLive(
  q: AwardsLiveQuery,
): Promise<ContractsLiveResult> {
  const filters = buildContractFilters(q);

  const countPromise: Promise<number | undefined> = q.wantTotal
    ? fetchAwardCount(filters, "contracts").catch((err: unknown) => {
        console.error(
          `[usaspending live] count call failed (${(err as Error).message}) — omitting total`,
        );
        return undefined;
      })
    : Promise.resolve(undefined);

  const awards: FederalContractAward[] = [];
  for (let page = 1; page <= q.maxPages; page++) {
    const resp = await postSearch(filters, page, q.sort, q.order);
    const rows = (resp.results ?? [])
      .map(normalizeAward)
      .filter((r): r is FederalContractAward => r !== null);
    awards.push(...rows);
    if (!resp.page_metadata?.hasNext) break;
  }

  return { awards, totalCount: await countPromise };
}
