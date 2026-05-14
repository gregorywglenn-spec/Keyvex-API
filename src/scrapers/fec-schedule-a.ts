/**
 * FEC Schedule A scraper — individual & committee CONTRIBUTIONS.
 *
 * Closes the political-alpha loop:
 *   donor → candidate → bills/votes → trades → contracts
 *
 * Schedule A is the FEC's full record of money flowing INTO a committee.
 * Itemized rows are required for any contribution ≥ $200 from an individual
 * (PACs also report all PAC-to-PAC and CCM transfers). The Open FEC API at
 * api.open.fec.gov/v1/schedules/schedule_a/ exposes every row indexed.
 *
 * Scale consideration: a single cycle has ≈ 130M contribution rows. We
 * cannot store all of it. v1A scope is deliberately tight:
 *   - min_amount $1,000+ by default (filters payroll-deduction memo noise;
 *     real signal lives in larger donations anyway)
 *   - rolling 7-day cron window (weekly catch-up)
 *   - cursor-based pagination available for deep pulls (committee-id or
 *     candidate-id filtered backfills)
 *
 * v1.1 follow-ups (deliberately deferred):
 *   - sub_id-based pagination loop for unbounded backfills
 *   - donor-name normalization for cross-cycle aggregation
 *   - bipartite link to `legislators` via candidate-name → bioguide_id matcher
 *
 * Key gotcha: contribution_receipt_date can be null on memo rows
 * (payroll-deduction subtotals etc). The FEC API still returns them in
 * date-sorted queries — they pile at the end. We tolerate nulls in
 * normalization (preserve as empty string), but recommend agents use
 * since/until filters with not-null semantics for serious analysis.
 */

import type { FecContribution } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.FEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.open.fec.gov/v1",
  /** 250ms = 4 req/sec sustained, well under 1000 req/hr key limit */
  RATE_LIMIT_MS: 250,
  PAGE_SIZE: 100,
  /** Default minimum contribution amount in dollars. Filters out
   *  payroll-deduction memos and sub-$1K rows that drown signal. */
  DEFAULT_MIN_AMOUNT: 1000,
  /** Hard cap on pages to fetch per cycle. FEC's `page` paging tops out
   *  at page 100 (10K rows) before requiring cursor-based pagination —
   *  we stop at 100 and log if there's more. */
  MAX_PAGE_PAGINATION: 100,
};

function getApiKey(): string {
  const key = process.env.FEC_API_KEY;
  if (!key) {
    console.error(
      "[fec-sa] WARNING: FEC_API_KEY not set; falling back to DEMO_KEY (30 req/hr limit). " +
        "Sign up at https://api.data.gov/signup/ for a free 1000 req/hr key.",
    );
    return "DEMO_KEY";
  }
  return key;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Raw FEC Schedule A response shape ──────────────────────────────────────

interface FecPagination {
  count?: number;
  is_count_exact?: boolean;
  page?: number;
  pages?: number;
  per_page?: number;
  last_indexes?: {
    last_index?: string | number | null;
    last_contribution_receipt_date?: string | null;
    sort_null_only?: boolean | null;
  } | null;
}

interface FecListResponse<T> {
  api_version?: string;
  pagination?: FecPagination;
  results?: T[];
}

interface RawFecScheduleARow {
  contribution_receipt_amount?: number | null;
  contribution_receipt_date?: string | null;
  contributor_id?: string | null;
  contributor_name?: string | null;
  contributor_first_name?: string | null;
  contributor_last_name?: string | null;
  contributor_employer?: string | null;
  contributor_occupation?: string | null;
  contributor_city?: string | null;
  contributor_state?: string | null;
  contributor_zip?: string | null;
  entity_type?: string | null;
  entity_type_desc?: string | null;
  committee_id?: string | null;
  committee_name?: string | null;
  committee?: {
    committee_id?: string | null;
    name?: string | null;
    committee_type?: string | null;
    committee_type_full?: string | null;
    organization_type?: string | null;
    organization_type_full?: string | null;
    designation?: string | null;
    designation_full?: string | null;
    party?: string | null;
    state?: string | null;
  } | null;
  candidate_id?: string | null;
  candidate_name?: string | null;
  candidate_first_name?: string | null;
  candidate_last_name?: string | null;
  candidate_office?: string | null;
  candidate_office_full?: string | null;
  candidate_office_state?: string | null;
  candidate_office_district?: string | null;
  recipient_committee_designation?: string | null;
  recipient_committee_org_type?: string | null;
  recipient_committee_type?: string | null;
  two_year_transaction_period?: number | null;
  election_type?: string | null;
  election_type_full?: string | null;
  receipt_type?: string | null;
  receipt_type_desc?: string | null;
  receipt_type_full?: string | null;
  report_type?: string | null;
  report_year?: number | null;
  file_number?: number | null;
  transaction_id?: string | null;
  link_id?: number | string | null;
  sub_id?: number | string | null;
  image_number?: string | null;
  pdf_url?: string | null;
  memo_text?: string | null;
  memo_code?: string | null;
  memoed_subtotal?: boolean | null;
  is_individual?: boolean | null;
  contributor_aggregate_ytd?: number | null;
  load_date?: string | null;
  amendment_indicator?: string | null;
  filing_form?: string | null;
}

// ─── Normalizer ─────────────────────────────────────────────────────────────

function normalizeContribution(
  raw: RawFecScheduleARow,
  scrapedAt: string,
): FecContribution | null {
  // sub_id / link_id is the FEC's globally unique row identifier. Without
  // it we cannot dedup or write idempotently — skip the row.
  const subId = raw.sub_id ?? raw.link_id;
  if (subId === null || subId === undefined || subId === "") return null;
  const subIdStr = String(subId);

  const committee = raw.committee ?? {};
  const committeeId = raw.committee_id ?? committee.committee_id ?? "";
  if (!committeeId) return null;

  const amount =
    typeof raw.contribution_receipt_amount === "number"
      ? raw.contribution_receipt_amount
      : 0;

  return {
    sub_id: subIdStr,
    contribution_receipt_amount: amount,
    contribution_receipt_date: raw.contribution_receipt_date ?? "",
    contributor_id: raw.contributor_id ?? "",
    contributor_name: raw.contributor_name ?? "",
    contributor_first_name: raw.contributor_first_name ?? "",
    contributor_last_name: raw.contributor_last_name ?? "",
    contributor_employer: raw.contributor_employer ?? "",
    contributor_occupation: raw.contributor_occupation ?? "",
    contributor_city: raw.contributor_city ?? "",
    contributor_state: raw.contributor_state ?? "",
    contributor_zip: raw.contributor_zip ?? "",
    entity_type: raw.entity_type ?? "",
    entity_type_desc: raw.entity_type_desc ?? "",
    recipient_committee_id: committeeId,
    recipient_committee_name: raw.committee_name ?? committee.name ?? "",
    recipient_committee_type: raw.recipient_committee_type ?? committee.committee_type ?? "",
    recipient_committee_org_type: raw.recipient_committee_org_type ?? committee.organization_type ?? "",
    recipient_committee_designation: raw.recipient_committee_designation ?? committee.designation ?? "",
    candidate_id: raw.candidate_id ?? "",
    candidate_name: raw.candidate_name ?? "",
    candidate_office: raw.candidate_office ?? "",
    candidate_office_state: raw.candidate_office_state ?? "",
    candidate_office_district: raw.candidate_office_district ?? "",
    two_year_transaction_period:
      typeof raw.two_year_transaction_period === "number"
        ? raw.two_year_transaction_period
        : null,
    election_type: raw.election_type ?? "",
    receipt_type: raw.receipt_type ?? "",
    receipt_type_desc: raw.receipt_type_desc ?? "",
    report_type: raw.report_type ?? "",
    report_year:
      typeof raw.report_year === "number" ? raw.report_year : null,
    file_number:
      typeof raw.file_number === "number" ? raw.file_number : null,
    transaction_id: raw.transaction_id ?? "",
    image_number: raw.image_number ?? "",
    pdf_url: raw.pdf_url ?? "",
    memo_text: raw.memo_text ?? "",
    memo_code: raw.memo_code ?? "",
    memoed_subtotal: raw.memoed_subtotal === true,
    is_individual: raw.is_individual === true,
    contributor_aggregate_ytd:
      typeof raw.contributor_aggregate_ytd === "number"
        ? raw.contributor_aggregate_ytd
        : null,
    load_date: raw.load_date ?? "",
    amendment_indicator: raw.amendment_indicator ?? "",
    filing_form: raw.filing_form ?? "",
    source_url: `https://www.fec.gov/data/receipts/?committee_id=${committeeId}&data_type=processed`,
    scraped_at: scrapedAt,
  };
}

// ─── Paginated fetcher with retry (cursor-based) ────────────────────────────

/**
 * Schedule A's `/schedules/schedule_a/` endpoint silently IGNORES the `page`
 * parameter — it requires cursor-based pagination via `last_index` +
 * `last_<sort_field>` query params. The first request omits those; subsequent
 * requests pass back the `pagination.last_indexes.*` values from the prior
 * response. The loop terminates when results[] is empty.
 *
 * Sort field convention: when sorting by `-contribution_receipt_date`, the
 * companion cursor param is `last_contribution_receipt_date`. When sorting
 * by amount, it's `last_contribution_receipt_amount`. We sort by date by
 * default (most-recent-first for cron freshness).
 */
async function fetchScheduleA(
  params: Record<string, string | number | boolean>,
  options: { maxPages?: number } = {},
): Promise<RawFecScheduleARow[]> {
  const apiKey = getApiKey();
  const maxPages = options.maxPages ?? CONFIG.MAX_PAGE_PAGINATION;
  const allResults: RawFecScheduleARow[] = [];

  let lastIndex: string | number | null = null;
  let lastContributionReceiptDate: string | null = null;
  let pageNum = 1;
  let totalCountReported: number | null = null;

  while (pageNum <= maxPages) {
    const url = new URL(`${CONFIG.BASE_URL}/schedules/schedule_a/`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("per_page", String(CONFIG.PAGE_SIZE));
    url.searchParams.set("sort", "-contribution_receipt_date");
    // Hint to count the result set on the first call only; saves cycles
    // on subsequent calls (FEC respects this when the param is omitted).
    if (pageNum === 1) url.searchParams.set("sort_hide_null", "true");
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    if (lastIndex !== null) {
      url.searchParams.set("last_index", String(lastIndex));
    }
    if (lastContributionReceiptDate !== null) {
      url.searchParams.set(
        "last_contribution_receipt_date",
        lastContributionReceiptDate,
      );
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
            `[fec-sa]   page ${pageNum}: network error (${msg}), retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
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
          `[fec-sa]   page ${pageNum}: 429 rate-limited, waiting ${retryAfter}s...`,
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < MAX_RETRIES) {
          const backoffSec = Math.pow(2, attempt);
          console.error(
            `[fec-sa]   page ${pageNum}: HTTP ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
          );
          await sleep(backoffSec * 1000);
          attempt++;
          continue;
        }
        throw new Error(
          `FEC Schedule A HTTP ${res.status} on page ${pageNum} after ${MAX_RETRIES} retries`,
        );
      }
      break;
    }

    if (!res || !res.ok) {
      throw new Error(
        `FEC Schedule A HTTP ${res?.status ?? "(no response)"} on page ${pageNum}`,
      );
    }

    const json = (await res.json()) as FecListResponse<RawFecScheduleARow>;
    const rows = json.results ?? [];
    allResults.push(...rows);

    if (pageNum === 1) {
      totalCountReported = json.pagination?.count ?? null;
      const isExact = json.pagination?.is_count_exact ?? false;
      console.error(
        `[fec-sa]   ${totalCountReported ?? "?"}${isExact ? "" : "+"} total rows (cursor-paginated, page cap=${maxPages})`,
      );
    }
    console.error(
      `[fec-sa]   page ${pageNum}: ${rows.length} rows (running ${allResults.length})`,
    );

    if (rows.length === 0) break;

    // Advance cursor.
    const last = json.pagination?.last_indexes;
    if (
      !last ||
      last.last_index === null ||
      last.last_index === undefined ||
      String(last.last_index) === ""
    ) {
      // No further cursor — we've reached the end of the result set.
      break;
    }
    lastIndex = last.last_index ?? null;
    lastContributionReceiptDate = last.last_contribution_receipt_date ?? null;
    pageNum++;
  }

  if (
    totalCountReported !== null &&
    allResults.length < totalCountReported &&
    pageNum > maxPages
  ) {
    console.error(
      `[fec-sa]   WARNING: hit maxPages=${maxPages} but ${totalCountReported - allResults.length}+ rows remain. ` +
        `Tighten filters (min_amount, committee_id, candidate_id, date range) ` +
        `or raise --max-pages to capture more.`,
    );
  }
  return allResults;
}

// ─── Public scraper ─────────────────────────────────────────────────────────

export interface ScrapeFecScheduleAOptions {
  /** Minimum contribution amount (server-side filter). Default $1,000. */
  minAmount?: number;
  /** Maximum contribution amount (server-side filter). */
  maxAmount?: number;
  /** Rolling window in days. Mutually exclusive with minDate/maxDate. */
  lookbackDays?: number;
  /** Explicit start date (YYYY-MM-DD). */
  minDate?: string;
  /** Explicit end date (YYYY-MM-DD). */
  maxDate?: string;
  /** Two-year transaction period (cycle year, e.g. 2026). Default 2026. */
  cycle?: number;
  /** Filter to one recipient committee. */
  committeeId?: string;
  /** Filter to one candidate. */
  candidateId?: string;
  /** Filter to one contributor state. */
  contributorState?: string;
  /** Filter to one contributor employer (substring at FEC). */
  contributorEmployer?: string;
  /** Hard cap on pages (each page = 100 rows). Default 100. */
  maxPages?: number;
}

/**
 * Scrape Schedule A contributions for the given filters. Defaults pulling
 * the last 7 days of contributions ≥ $1,000 for the 2026 cycle — a
 * weekly cron-shaped pull that fits easily in the 10K-row page-paging cap.
 */
export async function scrapeFecScheduleA(
  options: ScrapeFecScheduleAOptions = {},
): Promise<FecContribution[]> {
  const scrapedAt = new Date().toISOString();
  const minAmount = options.minAmount ?? CONFIG.DEFAULT_MIN_AMOUNT;
  const cycle = options.cycle ?? 2026;

  // Resolve date window
  let minDate = options.minDate;
  let maxDate = options.maxDate;
  if (!minDate && options.lookbackDays !== undefined) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - options.lookbackDays);
    minDate = d.toISOString().slice(0, 10);
  }
  if (!minDate && !maxDate && !options.committeeId && !options.candidateId) {
    // Safety default: 7-day window so unfiltered runs don't blow up
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
  if (options.contributorState)
    params.contributor_state = options.contributorState.toUpperCase();
  if (options.contributorEmployer)
    params.contributor_employer = options.contributorEmployer;

  console.error(
    `[fec-sa] Scraping cycle=${cycle} min_amount=$${minAmount}${
      minDate ? ` min_date=${minDate}` : ""
    }${maxDate ? ` max_date=${maxDate}` : ""}${
      options.committeeId ? ` committee=${options.committeeId}` : ""
    }${options.candidateId ? ` candidate=${options.candidateId}` : ""}`,
  );

  const raws = await fetchScheduleA(params, {
    ...(options.maxPages !== undefined && { maxPages: options.maxPages }),
  });

  // Dedup by sub_id (FEC returns amendment chains; the same sub_id can
  // appear once-each from the original + amended filing; later wins).
  const seen = new Map<string, FecContribution>();
  for (const raw of raws) {
    const c = normalizeContribution(raw, scrapedAt);
    if (c) seen.set(c.sub_id, c);
  }
  const contributions = Array.from(seen.values());
  console.error(
    `[fec-sa] TOTAL: ${contributions.length} unique contributions (raw rows: ${raws.length})`,
  );
  return contributions;
}
