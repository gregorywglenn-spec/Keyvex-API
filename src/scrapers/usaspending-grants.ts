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
  time_period?: Array<{ start_date: string; end_date: string }>;
  award_type_codes?: readonly string[];
  recipient_search_text?: string[];
  agencies?: Array<{ type: string; tier: string; name: string }>;
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
