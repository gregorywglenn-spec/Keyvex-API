/**
 * USAspending federal GRANTS scraper.
 *
 * Sibling to usaspending.ts (federal CONTRACTS). Same api.usaspending.gov
 * endpoint /api/v2/search/spending_by_award/ — different award_type_codes:
 *   02 = Block Grant
 *   03 = Formula Grant
 *   04 = Project Grant
 *   05 = Cooperative Agreement
 *
 * Grant rows have a distinct shape from contracts:
 *   - "Award Type" field instead of "Contract Award Type"
 *   - CFDA Number (Catalog of Federal Domestic Assistance) — grant-specific
 *     identifier for the program (e.g., "89.003" = NHPRC discretionary grants).
 *   - No NAICS / PSC codes (those are contract-only).
 *
 * Cross-source value: federal grants flow to universities, nonprofits, state
 * and local government agencies — totally different recipient universe than
 * the defense / tech contractors that dominate the contracts collection.
 * Closes the "where does federal money go" loop with both directions of
 * spending visible to agents.
 */

import type { FederalGrant } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.usaspending.gov",
  AWARD_URL_BASE: "https://www.usaspending.gov/award",
  RATE_LIMIT_MS: 200,
  GRANT_AWARD_TYPES: ["02", "03", "04", "05"] as const,
  PAGE_SIZE: 100,
  DEFAULT_MAX_PAGES: 10,
};

const FIELDS_TO_REQUEST = [
  "Award ID",
  "Recipient Name",
  "recipient_id",
  "Recipient UEI",
  "Award Amount",
  "Total Outlays",
  "Description",
  "Award Type",
  "Awarding Agency",
  "Awarding Sub Agency",
  "CFDA Number",
  "def_codes",
  "Start Date",
  "End Date",
  "Last Modified Date",
  "Place of Performance State Code",
  "generated_internal_id",
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RawGrantResult {
  generated_internal_id?: string;
  "Award ID"?: string;
  "Recipient Name"?: string;
  recipient_id?: string;
  "Recipient UEI"?: string;
  "Award Amount"?: number;
  "Total Outlays"?: number;
  Description?: string;
  "Award Type"?: string;
  "Awarding Agency"?: string;
  "Awarding Sub Agency"?: string;
  "CFDA Number"?: string;
  def_codes?: string[];
  "Start Date"?: string;
  "End Date"?: string;
  "Last Modified Date"?: string;
  "Place of Performance State Code"?: string;
}

interface SearchResponse {
  results?: RawGrantResult[];
  page_metadata?: {
    page?: number;
    hasNext?: boolean;
  };
}

interface SearchFilters {
  time_period?: Array<{
    start_date: string;
    end_date: string;
    /** "last_modified_date" verified working 2026-06-10. */
    date_type?: string;
  }>;
  award_type_codes?: readonly string[];
  recipient_search_text?: string[];
  agencies?: Array<{ type: string; tier: string; name: string }>;
  /** Verified server-side 2026-06-10. */
  award_amounts?: Array<{ lower_bound?: number; upper_bound?: number }>;
  /** CFDA filter — matches the award's full Assistance LISTINGS array, not
   *  just the primary CFDA (an award can carry several; verified 2026-06-10
   *  by inspecting Assistance Listings on matched rows). */
  program_numbers?: string[];
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
      `USAspending grants ${res.status} ${res.statusText} on page ${page}`,
    );
  }
  return (await res.json()) as SearchResponse;
}

function toIsoTimestamp(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(" ", "T");
}

function normalizeGrant(raw: RawGrantResult): FederalGrant | null {
  const id = raw.generated_internal_id ?? "";
  if (!id) return null;
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
    award_type: raw["Award Type"] ?? "",
    awarding_agency: raw["Awarding Agency"] ?? "",
    awarding_subagency: raw["Awarding Sub Agency"] ?? "",
    cfda_number: raw["CFDA Number"] ?? "",
    def_codes: Array.isArray(raw.def_codes) ? raw.def_codes : [],
    start_date: raw["Start Date"] ?? "",
    end_date: raw["End Date"] ?? "",
    last_modified_date: toIsoTimestamp(raw["Last Modified Date"]),
    place_of_performance_state: raw["Place of Performance State Code"] ?? "",
    award_url: `${CONFIG.AWARD_URL_BASE}/${id}/`,
    source_url: `${CONFIG.AWARD_URL_BASE}/${id}/`,
    data_source: "USASPENDING",
  };
}

// ─── Public scrapers ────────────────────────────────────────────────────────

export async function scrapeGrantsLiveFeed(
  lookbackDays = 7,
  maxPages = CONFIG.DEFAULT_MAX_PAGES,
): Promise<FederalGrant[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0]!;
  const endStr = end.toISOString().split("T")[0]!;

  console.error(
    `[usaspending grants] Window ${startStr} → ${endStr}, max ${maxPages} pages`,
  );

  const filters: SearchFilters = {
    time_period: [{ start_date: startStr, end_date: endStr }],
    award_type_codes: CONFIG.GRANT_AWARD_TYPES,
  };

  const all: FederalGrant[] = [];
  let page = 1;
  while (page <= maxPages) {
    let resp: SearchResponse;
    try {
      resp = await postSearch(filters, page);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[usaspending grants]   page ${page}: SKIP — ${msg}`);
      break;
    }
    const rows = (resp.results ?? [])
      .map(normalizeGrant)
      .filter((r): r is FederalGrant => r !== null);
    all.push(...rows);
    console.error(
      `[usaspending grants]   page ${page}: ${rows.length} grants (running ${all.length})`,
    );
    if (!resp.page_metadata?.hasNext) break;
    page++;
  }

  console.error(
    `[usaspending grants] TOTAL: ${all.length} grants in last ${lookbackDays}d`,
  );
  return all;
}

export async function scrapeGrantsByRecipient(
  recipientName: string,
  lookbackDays = 365,
  maxPages = CONFIG.DEFAULT_MAX_PAGES,
): Promise<FederalGrant[]> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().split("T")[0]!;
  const endStr = end.toISOString().split("T")[0]!;

  console.error(
    `[usaspending grants] Recipient "${recipientName}", window ${startStr} → ${endStr}`,
  );

  const filters: SearchFilters = {
    time_period: [{ start_date: startStr, end_date: endStr }],
    award_type_codes: CONFIG.GRANT_AWARD_TYPES,
    recipient_search_text: [recipientName],
  };

  const all: FederalGrant[] = [];
  let page = 1;
  while (page <= maxPages) {
    let resp: SearchResponse;
    try {
      resp = await postSearch(filters, page, "Award Amount", "desc");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[usaspending grants]   page ${page}: SKIP — ${msg}`);
      break;
    }
    const rows = (resp.results ?? [])
      .map(normalizeGrant)
      .filter((r): r is FederalGrant => r !== null);
    all.push(...rows);
    console.error(
      `[usaspending grants]   page ${page}: ${rows.length} grants (running ${all.length})`,
    );
    if (!resp.page_metadata?.hasNext) break;
    page++;
  }

  console.error(
    `[usaspending grants] TOTAL: ${all.length} grants for "${recipientName}"`,
  );
  return all;
}

// ─── Live-search path (MCP passthrough) ────────────────────────────────────

export interface GrantsLiveQuery {
  /** Pushed server-side as recipient_search_text (name keyword match). */
  recipientName?: string;
  /** Pushed server-side as program_numbers — matches the award's full
   *  assistance-listings array (an award can carry several CFDAs). */
  cfdaNumber?: string;
  minAmount?: number;
  /** last_modified_date bounds — pushed via time_period date_type. */
  lastModifiedSince?: string;
  lastModifiedUntil?: string;
  /** API sort field name. */
  sort: string;
  order: "asc" | "desc";
  maxPages: number;
  /** Also POST spending_by_award_count for the authoritative total. */
  wantTotal: boolean;
}

export interface GrantsLiveResult {
  grants: FederalGrant[];
  /** spending_by_award_count "grants" bucket — authoritative volume over the
   *  full USAspending dataset for exactly these filters. Undefined when not
   *  requested or the count call failed (best-effort). */
  totalCount?: number;
}

/** One live query for the MCP passthrough. Count fetched IN PARALLEL with
 *  the page loop (serializing blew the liveFirst budget on unbounded
 *  queries). Throws on a failed search — the caller's liveFirst wrapper
 *  handles cache fallback. */
export async function searchGrantsLive(
  q: GrantsLiveQuery,
): Promise<GrantsLiveResult> {
  const filters: SearchFilters = {
    award_type_codes: CONFIG.GRANT_AWARD_TYPES,
  };
  if (q.recipientName) filters.recipient_search_text = [q.recipientName];
  if (q.cfdaNumber) filters.program_numbers = [q.cfdaNumber];
  if (q.minAmount !== undefined) {
    filters.award_amounts = [{ lower_bound: q.minAmount }];
  }
  if (q.lastModifiedSince || q.lastModifiedUntil) {
    filters.time_period = [
      {
        start_date: q.lastModifiedSince ?? "2007-10-01",
        end_date: q.lastModifiedUntil ?? new Date().toISOString().slice(0, 10),
        date_type: "last_modified_date",
      },
    ];
  }

  const countPromise: Promise<number | undefined> = q.wantTotal
    ? (async (): Promise<number | undefined> => {
        try {
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
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as {
            results?: Record<string, number | undefined>;
          };
          return json.results?.grants ?? 0;
        } catch (err) {
          console.error(
            `[usaspending grants live] count failed (${(err as Error).message}) — omitting total`,
          );
          return undefined;
        }
      })()
    : Promise.resolve(undefined);

  const grants: FederalGrant[] = [];
  for (let page = 1; page <= q.maxPages; page++) {
    const resp = await postSearch(filters, page, q.sort, q.order);
    const rows = (resp.results ?? [])
      .map(normalizeGrant)
      .filter((r): r is FederalGrant => r !== null);
    grants.push(...rows);
    if (!resp.page_metadata?.hasNext) break;
  }

  return { grants, totalCount: await countPromise };
}
