/**
 * FEC (Federal Election Commission) scraper — campaign finance data.
 *
 * api.open.fec.gov is a free public REST API maintained by the FEC + GSA.
 * No auth scraping needed; just an API key from api.data.gov (1000 req/hr)
 * or DEMO_KEY (30 req/hr, fine for dev). JSON in/out, well-documented.
 *
 * Endpoints used:
 *   GET /v1/candidates/?cycle=YYYY&candidate_status=C&per_page=100&page=N
 *     → registered candidates (House / Senate / President), one per row
 *   GET /v1/committees/?cycle=YYYY&per_page=100&page=N
 *     → committees (campaign, PAC, Super PAC, party committee)
 *
 * Pagination: standard `page` + `per_page` (max 100); FEC returns
 * `pagination.pages` so we know the total page count upfront.
 *
 * Killer use case unlocked: the "follow the money" loop. Given a member's
 * `bioguide_id` (from `legislators`), find their FEC candidate_id (by name
 * match, since FEC IDs and bioguide IDs are independent), then find their
 * principal campaign committee (committee.candidate_ids → matching ID,
 * designation = "P"). That committee's Schedule A receipts (v1.1) are the
 * full donor history.
 *
 * v1.0 scope: candidates + committees lookup tables. Contributions
 * (Schedule A) come in v1.1 via bulk downloads — see CLAUDE.md backfill plan.
 */

import type { FecCandidate, FecCommittee } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.FEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.open.fec.gov/v1",
  RATE_LIMIT_MS: 250, // 4 req/sec sustained, leaves headroom under 1000/hr key
  PAGE_SIZE: 100,
  /** Cycles to backfill by default. Most queries care about recent cycles.
   *  Older cycles can be backfilled explicitly via --cycle=YYYY. */
  DEFAULT_CYCLES: [2022, 2024, 2026],
};

function getApiKey(): string {
  const key = process.env.FEC_API_KEY;
  if (!key) {
    console.error(
      "[fec] WARNING: FEC_API_KEY not set; falling back to DEMO_KEY (30 req/hr limit). " +
        "Sign up at https://api.data.gov/signup/ for a free 1000 req/hr key.",
    );
    return "DEMO_KEY";
  }
  return key;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Raw FEC response shapes ────────────────────────────────────────────────

interface FecPagination {
  count?: number;
  page?: number;
  pages?: number;
  per_page?: number;
}

interface FecListResponse<T> {
  api_version?: string;
  pagination?: FecPagination;
  results?: T[];
}

interface RawFecCandidate {
  candidate_id?: string;
  name?: string | null;
  party?: string | null;
  party_full?: string | null;
  office?: string | null;
  office_full?: string | null;
  state?: string | null;
  district?: string | null;
  district_number?: number | null;
  incumbent_challenge?: string | null;
  incumbent_challenge_full?: string | null;
  candidate_status?: string | null;
  candidate_inactive?: boolean | null;
  cycles?: number[] | null;
  election_years?: number[] | null;
  active_through?: number | null;
  first_file_date?: string | null;
  last_file_date?: string | null;
  load_date?: string | null;
}

interface RawFecCommittee {
  committee_id?: string;
  name?: string | null;
  treasurer_name?: string | null;
  committee_type?: string | null;
  committee_type_full?: string | null;
  designation?: string | null;
  designation_full?: string | null;
  organization_type?: string | null;
  organization_type_full?: string | null;
  party?: string | null;
  party_full?: string | null;
  state?: string | null;
  filing_frequency?: string | null;
  candidate_ids?: string[] | null;
  sponsor_candidate_ids?: string[] | null;
  cycles?: number[] | null;
  first_file_date?: string | null;
  last_file_date?: string | null;
}

// ─── Normalizers ────────────────────────────────────────────────────────────

function normalizeCandidate(
  raw: RawFecCandidate,
  scrapedAt: string,
): FecCandidate | null {
  if (!raw.candidate_id) return null;
  return {
    candidate_id: raw.candidate_id,
    name: raw.name ?? "",
    party: raw.party ?? "",
    party_full: raw.party_full ?? "",
    office: raw.office ?? "",
    office_full: raw.office_full ?? "",
    state: raw.state ?? "",
    district: raw.district ?? "",
    district_number:
      typeof raw.district_number === "number" ? raw.district_number : null,
    incumbent_challenge: raw.incumbent_challenge ?? "",
    candidate_status: raw.candidate_status ?? "",
    candidate_inactive: raw.candidate_inactive === true,
    cycles: Array.isArray(raw.cycles) ? raw.cycles : [],
    election_years: Array.isArray(raw.election_years) ? raw.election_years : [],
    active_through:
      typeof raw.active_through === "number" ? raw.active_through : null,
    first_file_date: raw.first_file_date ?? "",
    last_file_date: raw.last_file_date ?? "",
    load_date: raw.load_date ?? "",
    scraped_at: scrapedAt,
  };
}

function normalizeCommittee(
  raw: RawFecCommittee,
  scrapedAt: string,
): FecCommittee | null {
  if (!raw.committee_id) return null;
  return {
    committee_id: raw.committee_id,
    name: raw.name ?? "",
    treasurer_name: raw.treasurer_name ?? "",
    committee_type: raw.committee_type ?? "",
    committee_type_full: raw.committee_type_full ?? "",
    designation: raw.designation ?? "",
    designation_full: raw.designation_full ?? "",
    organization_type: raw.organization_type ?? "",
    organization_type_full: raw.organization_type_full ?? "",
    party: raw.party ?? "",
    party_full: raw.party_full ?? "",
    state: raw.state ?? "",
    filing_frequency: raw.filing_frequency ?? "",
    candidate_ids: Array.isArray(raw.candidate_ids) ? raw.candidate_ids : [],
    sponsor_candidate_ids: Array.isArray(raw.sponsor_candidate_ids)
      ? raw.sponsor_candidate_ids
      : [],
    cycles: Array.isArray(raw.cycles) ? raw.cycles : [],
    first_file_date: raw.first_file_date ?? "",
    last_file_date: raw.last_file_date ?? "",
    scraped_at: scrapedAt,
  };
}

// ─── Paginated fetcher ──────────────────────────────────────────────────────

interface PaginationOptions {
  /** Hard cap on pages to fetch. Safety net. */
  maxPages?: number;
}

/**
 * Generic paginated GET against an OpenFEC list endpoint. Drives the
 * pagination loop, accumulates results, and respects RATE_LIMIT_MS.
 *
 * params should NOT include `api_key`, `page`, or `per_page` — those are
 * added by this helper.
 */
async function fetchAllPages<TRaw>(
  endpoint: string,
  params: Record<string, string | number | boolean>,
  options: PaginationOptions = {},
): Promise<TRaw[]> {
  const apiKey = getApiKey();
  const maxPages = options.maxPages ?? 1000;
  const allResults: TRaw[] = [];

  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= maxPages) {
    const url = new URL(`${CONFIG.BASE_URL}${endpoint}`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("per_page", String(CONFIG.PAGE_SIZE));
    url.searchParams.set("page", String(page));
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    await sleep(CONFIG.RATE_LIMIT_MS);

    // Retry loop for transient errors. FEC's gateway returns 502/503/504
    // a few times an hour during a backfill — they're transient, not
    // permanent. Plus standard 429 handling. Exponential backoff capped
    // at 5 retries; on the final failure we surface the error.
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
        // Network-level failure (DNS, socket reset, etc.). Retry like a 5xx.
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          const backoffSec = Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s
          console.error(
            `[fec]   page ${page}: network error (${msg}), retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
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
          `[fec]   page ${page}: 429 rate-limited, waiting ${retryAfter}s...`,
        );
        await sleep(retryAfter * 1000);
        // 429 doesn't count against attempt budget; we keep going.
        continue;
      }
      // 5xx: transient gateway / server error. Backoff and retry.
      if (res.status >= 500 && res.status < 600) {
        if (attempt < MAX_RETRIES) {
          const backoffSec = Math.pow(2, attempt);
          console.error(
            `[fec]   page ${page}: HTTP ${res.status} ${res.statusText}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
          );
          await sleep(backoffSec * 1000);
          attempt++;
          continue;
        }
        // Out of retries — surface a clear error.
        throw new Error(
          `FEC ${endpoint} HTTP ${res.status} on page ${page} after ${MAX_RETRIES} retries`,
        );
      }
      // Any other status (incl. 200) breaks out of the retry loop.
      break;
    }

    if (!res || !res.ok) {
      throw new Error(
        `FEC ${endpoint} HTTP ${res?.status ?? "(no response)"} ${res?.statusText ?? ""} on page ${page}`,
      );
    }

    const json = (await res.json()) as FecListResponse<TRaw>;
    const rows = json.results ?? [];
    allResults.push(...rows);

    if (page === 1) {
      totalPages = json.pagination?.pages ?? 1;
      const totalCount = json.pagination?.count ?? 0;
      console.error(
        `[fec]   ${endpoint} returned ${totalCount} total rows across ${totalPages} pages`,
      );
    }
    console.error(
      `[fec]   page ${page}/${totalPages}: ${rows.length} rows (running ${allResults.length})`,
    );

    if (rows.length === 0) break;
    page++;
  }

  if (page > maxPages && totalPages > maxPages) {
    console.error(
      `[fec]   WARNING: hit maxPages=${maxPages} of ${totalPages} total. ` +
        `Tighten filters or raise maxPages to capture the rest.`,
    );
  }
  return allResults;
}

// ─── Public scrapers ────────────────────────────────────────────────────────

export interface ScrapeCandidatesOptions {
  /** Election cycle to filter on (default: all DEFAULT_CYCLES). */
  cycle?: number;
  /** When true, restrict to candidate_status=C (currently filing). */
  activeOnly?: boolean;
  /** Office filter: H / S / P. */
  office?: string;
  /** Two-letter state code. */
  state?: string;
  /** Hard cap on pages. */
  maxPages?: number;
}

/**
 * Scrape FEC candidates for the given filters. Default: all candidates
 * active in any of the recent cycles (2022, 2024, 2026). Returns
 * one row per (candidate, cycle) combination from the FEC API — we
 * dedup by candidate_id during save (later cycles overwrite earlier).
 */
export async function scrapeFecCandidates(
  options: ScrapeCandidatesOptions = {},
): Promise<FecCandidate[]> {
  const scrapedAt = new Date().toISOString();
  const cycles = options.cycle ? [options.cycle] : CONFIG.DEFAULT_CYCLES;
  console.error(
    `[fec candidates] Scraping cycles ${cycles.join(", ")}${
      options.activeOnly ? " (active only)" : ""
    }${options.office ? ` office=${options.office}` : ""}${
      options.state ? ` state=${options.state}` : ""
    }`,
  );

  const seen = new Map<string, FecCandidate>();
  for (const cycle of cycles) {
    const params: Record<string, string | number | boolean> = { cycle };
    if (options.activeOnly) params.candidate_status = "C";
    if (options.office) params.office = options.office;
    if (options.state) params.state = options.state;

    const raws = await fetchAllPages<RawFecCandidate>("/candidates/", params, {
      maxPages: options.maxPages,
    });
    for (const raw of raws) {
      const c = normalizeCandidate(raw, scrapedAt);
      if (c) seen.set(c.candidate_id, c);
    }
  }
  const candidates = Array.from(seen.values());
  console.error(`[fec candidates] TOTAL: ${candidates.length} unique candidates`);
  return candidates;
}

export interface ScrapeCommitteesOptions {
  /** Election cycle to filter on (default: all DEFAULT_CYCLES). */
  cycle?: number;
  /** Committee type code (H/S/P/Q/N/O/etc.). */
  committeeType?: string;
  /** Designation: P (Principal) / A (Authorized) / etc. */
  designation?: string;
  /** Two-letter state code. */
  state?: string;
  /** Hard cap on pages. */
  maxPages?: number;
}

/**
 * Scrape FEC committees for the given filters. Default: all committees
 * active in any of the recent cycles. Returns one row per (committee, cycle);
 * deduped by committee_id during save.
 */
export async function scrapeFecCommittees(
  options: ScrapeCommitteesOptions = {},
): Promise<FecCommittee[]> {
  const scrapedAt = new Date().toISOString();
  const cycles = options.cycle ? [options.cycle] : CONFIG.DEFAULT_CYCLES;
  console.error(
    `[fec committees] Scraping cycles ${cycles.join(", ")}${
      options.committeeType ? ` type=${options.committeeType}` : ""
    }${options.designation ? ` designation=${options.designation}` : ""}${
      options.state ? ` state=${options.state}` : ""
    }`,
  );

  const seen = new Map<string, FecCommittee>();
  for (const cycle of cycles) {
    const params: Record<string, string | number | boolean> = { cycle };
    if (options.committeeType) params.committee_type = options.committeeType;
    if (options.designation) params.designation = options.designation;
    if (options.state) params.state = options.state;

    const raws = await fetchAllPages<RawFecCommittee>("/committees/", params, {
      maxPages: options.maxPages,
    });
    for (const raw of raws) {
      const c = normalizeCommittee(raw, scrapedAt);
      if (c) seen.set(c.committee_id, c);
    }
  }
  const committees = Array.from(seen.values());
  console.error(`[fec committees] TOTAL: ${committees.length} unique committees`);
  return committees;
}
