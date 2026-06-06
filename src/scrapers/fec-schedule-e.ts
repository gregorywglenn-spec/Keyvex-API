/**
 * FEC Schedule E scraper — INDEPENDENT EXPENDITURES.
 *
 * Schedule E captures uncoordinated ad spending by super PACs and other
 * IE-only committees FOR or AGAINST federal candidates. This is the
 * hallmark vehicle for political ad warfare since Citizens United (2010).
 *
 * Distinct from Schedule A (contributions INTO a committee) — Schedule E
 * is money spent BY a committee on independent ads / mailers / phone
 * banks / digital media. The `support_oppose_indicator` field is the
 * critical signal: "S" = support, "O" = oppose. Same candidate can have
 * dozens of S and O entries from different super PACs.
 *
 * Cross-source joins:
 *   - candidate_id → fec_candidates → bioguide via name → trade /
 *     vote history of the targeted member
 *   - committee_id → fec_committees (filer_type "I" = IE-only PAC)
 *   - payee_name (substring) → ad-agency / media-vendor networks
 *
 * v1A scope: default $1,000+ rolling 7-day window, cursor-paginated.
 * Same pattern as Schedule A. F24 (24-hour notice within 20 days of
 * election) and F5 (quarterly) filings both flow through this endpoint.
 */

import type { FecIndependentExpenditure } from "../types.js";
import { correctFutureDate, yearOf } from "../fec-date-correct.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.FEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.open.fec.gov/v1",
  RATE_LIMIT_MS: 250,
  PAGE_SIZE: 100,
  DEFAULT_MIN_AMOUNT: 1000,
  MAX_PAGE_PAGINATION: 100,
};

function getApiKey(): string {
  const key = process.env.FEC_API_KEY;
  if (!key) {
    console.error(
      "[fec-se] WARNING: FEC_API_KEY not set; falling back to DEMO_KEY (30 req/hr limit).",
    );
    return "DEMO_KEY";
  }
  return key;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Raw FEC Schedule E response shape ──────────────────────────────────────

interface FecPagination {
  count?: number;
  is_count_exact?: boolean;
  last_indexes?: {
    last_index?: string | number | null;
    last_expenditure_date?: string | null;
  } | null;
}

interface FecListResponse<T> {
  api_version?: string;
  pagination?: FecPagination;
  results?: T[];
}

interface RawFecScheduleERow {
  committee_id?: string | null;
  committee_name?: string | null;
  committee?: {
    committee_id?: string | null;
    name?: string | null;
    committee_type?: string | null;
    designation?: string | null;
    party?: string | null;
    state?: string | null;
  } | null;
  candidate_id?: string | null;
  candidate_name?: string | null;
  candidate_first_name?: string | null;
  candidate_last_name?: string | null;
  candidate_office?: string | null;
  candidate_office_state?: string | null;
  candidate_office_district?: string | null;
  candidate_party?: string | null;
  support_oppose_indicator?: string | null;
  expenditure_amount?: number | null;
  expenditure_date?: string | null;
  dissemination_date?: string | null;
  disbursement_description?: string | null;
  category_code?: string | null;
  category_code_full?: string | null;
  payee_name?: string | null;
  payee_first_name?: string | null;
  payee_last_name?: string | null;
  payee_city?: string | null;
  payee_state?: string | null;
  payee_zip?: string | null;
  election_type?: string | null;
  election_type_full?: string | null;
  report_type?: string | null;
  report_year?: number | null;
  file_number?: number | null;
  transaction_id?: string | null;
  sub_id?: number | string | null;
  link_id?: number | string | null;
  image_number?: string | null;
  filing_form?: string | null;
  memo_text?: string | null;
  memo_code?: string | null;
  memoed_subtotal?: boolean | null;
  amendment_indicator?: string | null;
  two_year_transaction_period?: number | null;
}

// ─── Normalizer ─────────────────────────────────────────────────────────────

function normalizeIE(
  raw: RawFecScheduleERow,
  scrapedAt: string,
): FecIndependentExpenditure | null {
  const subId = raw.sub_id ?? raw.link_id;
  if (subId === null || subId === undefined || subId === "") return null;
  const subIdStr = String(subId);

  const committee = raw.committee ?? {};
  const committeeId = raw.committee_id ?? committee.committee_id ?? "";
  if (!committeeId) return null;

  // Correct filer year-typos in expenditure_date (e.g. 2104→2014) using the
  // dissemination_date / report_year / cycle as corroborator; source preserved.
  const dy = yearOf(raw.dissemination_date);
  const ry = typeof raw.report_year === "number" ? raw.report_year : null;
  const cy =
    typeof raw.two_year_transaction_period === "number"
      ? raw.two_year_transaction_period
      : null;
  const expCorr = correctFutureDate(
    raw.expenditure_date,
    [dy, ry, cy],
    dy != null ? "dissemination_date" : ry != null ? "report_year" : "two_year_transaction_period",
  );

  return {
    sub_id: subIdStr,
    committee_id: committeeId,
    committee_name: raw.committee_name ?? committee.name ?? "",
    committee_type: committee.committee_type ?? "",
    committee_designation: committee.designation ?? "",
    candidate_id: raw.candidate_id ?? "",
    candidate_name: raw.candidate_name ?? "",
    candidate_office: raw.candidate_office ?? "",
    candidate_office_state: raw.candidate_office_state ?? "",
    candidate_office_district: raw.candidate_office_district ?? "",
    candidate_party: raw.candidate_party ?? "",
    support_oppose_indicator: raw.support_oppose_indicator ?? "",
    expenditure_amount:
      typeof raw.expenditure_amount === "number" ? raw.expenditure_amount : 0,
    expenditure_date: expCorr.value,
    expenditure_date_source: expCorr.source,
    date_corrected: expCorr.corrected,
    date_correction_basis: expCorr.basis,
    dissemination_date: raw.dissemination_date ?? "",
    disbursement_description: raw.disbursement_description ?? "",
    category_code: raw.category_code ?? "",
    category_code_full: raw.category_code_full ?? "",
    payee_name: raw.payee_name ?? "",
    payee_city: raw.payee_city ?? "",
    payee_state: raw.payee_state ?? "",
    payee_zip: raw.payee_zip ?? "",
    election_type: raw.election_type ?? "",
    report_type: raw.report_type ?? "",
    report_year:
      typeof raw.report_year === "number" ? raw.report_year : null,
    file_number:
      typeof raw.file_number === "number" ? raw.file_number : null,
    transaction_id: raw.transaction_id ?? "",
    image_number: raw.image_number ?? "",
    filing_form: raw.filing_form ?? "",
    memoed_subtotal: raw.memoed_subtotal === true,
    amendment_indicator: raw.amendment_indicator ?? "",
    two_year_transaction_period:
      typeof raw.two_year_transaction_period === "number"
        ? raw.two_year_transaction_period
        : null,
    source_url: `https://www.fec.gov/data/independent-expenditures/?committee_id=${committeeId}`,
    scraped_at: scrapedAt,
  };
}

// ─── Cursor-paginated fetcher ───────────────────────────────────────────────

async function fetchScheduleE(
  params: Record<string, string | number | boolean>,
  options: { maxPages?: number } = {},
): Promise<RawFecScheduleERow[]> {
  const apiKey = getApiKey();
  const maxPages = options.maxPages ?? CONFIG.MAX_PAGE_PAGINATION;
  const allResults: RawFecScheduleERow[] = [];

  let lastIndex: string | number | null = null;
  let lastExpenditureDate: string | null = null;
  let pageNum = 1;
  let totalCountReported: number | null = null;

  while (pageNum <= maxPages) {
    const url = new URL(`${CONFIG.BASE_URL}/schedules/schedule_e/`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("per_page", String(CONFIG.PAGE_SIZE));
    url.searchParams.set("sort", "-expenditure_date");
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    if (lastIndex !== null) {
      url.searchParams.set("last_index", String(lastIndex));
    }
    if (lastExpenditureDate !== null) {
      url.searchParams.set("last_expenditure_date", lastExpenditureDate);
    }

    await sleep(CONFIG.RATE_LIMIT_MS);

    let res: Response | null = null;
    let attempt = 0;
    const MAX_RETRIES = 5;
    while (attempt <= MAX_RETRIES) {
      try {
        res = await fetch(url.toString(), {
          headers: {
            "User-Agent": CONFIG.USER_AGENT,
            Accept: "application/json",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          const backoffSec = Math.pow(2, attempt);
          console.error(
            `[fec-se]   page ${pageNum}: network error (${msg}), retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
          );
          await sleep(backoffSec * 1000);
          attempt++;
          continue;
        }
        throw err;
      }
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
        console.error(
          `[fec-se]   page ${pageNum}: 429 rate-limited, waiting ${retryAfter}s...`,
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < MAX_RETRIES) {
          const backoffSec = Math.pow(2, attempt);
          console.error(
            `[fec-se]   page ${pageNum}: HTTP ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
          );
          await sleep(backoffSec * 1000);
          attempt++;
          continue;
        }
        throw new Error(
          `FEC Schedule E HTTP ${res.status} on page ${pageNum} after ${MAX_RETRIES} retries`,
        );
      }
      break;
    }
    if (!res || !res.ok) {
      throw new Error(
        `FEC Schedule E HTTP ${res?.status ?? "(no response)"} on page ${pageNum}`,
      );
    }

    const json = (await res.json()) as FecListResponse<RawFecScheduleERow>;
    const rows = json.results ?? [];
    allResults.push(...rows);

    if (pageNum === 1) {
      totalCountReported = json.pagination?.count ?? null;
      console.error(
        `[fec-se]   ${totalCountReported ?? "?"} total rows (cursor-paginated, page cap=${maxPages})`,
      );
    }
    console.error(
      `[fec-se]   page ${pageNum}: ${rows.length} rows (running ${allResults.length})`,
    );

    if (rows.length === 0) break;

    const last = json.pagination?.last_indexes;
    if (
      !last ||
      last.last_index === null ||
      last.last_index === undefined ||
      String(last.last_index) === ""
    ) {
      break;
    }
    lastIndex = last.last_index ?? null;
    lastExpenditureDate = last.last_expenditure_date ?? null;
    pageNum++;
  }

  return allResults;
}

// ─── Public scraper ─────────────────────────────────────────────────────────

export interface ScrapeFecScheduleEOptions {
  minAmount?: number;
  maxAmount?: number;
  lookbackDays?: number;
  minDate?: string;
  maxDate?: string;
  cycle?: number;
  committeeId?: string;
  candidateId?: string;
  /** "S" = support only, "O" = oppose only. */
  supportOppose?: "S" | "O";
  maxPages?: number;
}

/**
 * Scrape Schedule E independent expenditures. Defaults: rolling 7-day
 * window, $1,000+, cycle 2026.
 */
export async function scrapeFecScheduleE(
  options: ScrapeFecScheduleEOptions = {},
): Promise<FecIndependentExpenditure[]> {
  const scrapedAt = new Date().toISOString();
  const minAmount = options.minAmount ?? CONFIG.DEFAULT_MIN_AMOUNT;
  const cycle = options.cycle ?? 2026;

  let minDate = options.minDate;
  const maxDate = options.maxDate;
  if (!minDate && options.lookbackDays !== undefined) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - options.lookbackDays);
    minDate = d.toISOString().slice(0, 10);
  }
  if (!minDate && !maxDate && !options.committeeId && !options.candidateId) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    minDate = d.toISOString().slice(0, 10);
  }

  const params: Record<string, string | number | boolean> = {
    min_amount: minAmount,
    two_year_transaction_period: cycle,
  };
  if (options.maxAmount !== undefined) params.max_amount = options.maxAmount;
  if (minDate) params.min_date = minDate;
  if (maxDate) params.max_date = maxDate;
  if (options.committeeId) params.committee_id = options.committeeId;
  if (options.candidateId) params.candidate_id = options.candidateId;
  if (options.supportOppose) params.support_oppose_indicator = options.supportOppose;

  console.error(
    `[fec-se] Scraping cycle=${cycle} min_amount=$${minAmount}${
      minDate ? ` min_date=${minDate}` : ""
    }${maxDate ? ` max_date=${maxDate}` : ""}${
      options.committeeId ? ` committee=${options.committeeId}` : ""
    }${options.candidateId ? ` candidate=${options.candidateId}` : ""}${
      options.supportOppose ? ` ${options.supportOppose === "S" ? "support" : "oppose"}` : ""
    }`,
  );

  const raws = await fetchScheduleE(params, {
    ...(options.maxPages !== undefined && { maxPages: options.maxPages }),
  });

  const seen = new Map<string, FecIndependentExpenditure>();
  for (const raw of raws) {
    const ie = normalizeIE(raw, scrapedAt);
    if (ie) seen.set(ie.sub_id, ie);
  }
  const ies = Array.from(seen.values());
  console.error(
    `[fec-se] TOTAL: ${ies.length} unique independent expenditures`,
  );
  return ies;
}
