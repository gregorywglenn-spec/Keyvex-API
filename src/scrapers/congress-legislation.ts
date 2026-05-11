/**
 * Congress.gov scrapers — bills + roll-call votes.
 *
 * api.congress.gov is the Library of Congress's free public REST API. Same
 * api.data.gov gateway as FEC — one key works for both. JSON in/out.
 * Endpoints used:
 *   GET /v3/bill/{congress}/{billType}?limit=250&offset=N
 *     → paginated list of bills in a given Congress + type
 *   GET /v3/house-vote/{congress}/{session}?limit=250&offset=N
 *     → paginated list of House roll-call votes
 *   GET /v3/senate-vote/{congress}/{session}?limit=250&offset=N
 *     → paginated list of Senate roll-call votes
 *
 * Pagination: `pagination.next` URL (cursor-style) + `pagination.count`
 * (total). Max limit per page is 250.
 *
 * v1A scope: list-level metadata only. Per-bill detail (sponsors, full
 * action history, related bills, text) and per-vote member positions are
 * v1.1 — agents follow the api_url / source_data_url for those.
 *
 * Killer cross-source use case unlocked when paired with FEC + bioguide:
 *   trader buys LMT stock (congressional_trades) →
 *   member's committee assignments (member_profile) →
 *   members' votes on defense bills (roll_call_votes) →
 *   PAC donations from defense contractors (fec_candidate_profile)
 *   = full political-alpha picture.
 */

import type { Bill, RollCallVote } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.CONGRESS_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.congress.gov/v3",
  /** 250ms = 4 req/sec sustained; api.data.gov gateway permits 1000/hr on a
   *  personal key, so this leaves significant headroom. */
  RATE_LIMIT_MS: 250,
  PAGE_SIZE: 250, // congress.gov max
  /** All standard bill types we ingest. Concurrent resolutions (HCONRES,
   *  SCONRES) and joint resolutions (HJRES, SJRES) included alongside
   *  regular bills (HR, S) and simple resolutions (HRES, SRES). */
  BILL_TYPES: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"],
};

function getApiKey(): string {
  // congress.gov shares the api.data.gov gateway with FEC, so the same
  // FEC_API_KEY works. We also check CONGRESS_API_KEY first for users who
  // want to keep keys separate.
  const key = process.env.CONGRESS_API_KEY ?? process.env.FEC_API_KEY;
  if (!key) {
    console.error(
      "[congress] WARNING: no API key set (CONGRESS_API_KEY or FEC_API_KEY); " +
        "falling back to DEMO_KEY (~40 req/hr). Sign up at https://api.data.gov/signup/.",
    );
    return "DEMO_KEY";
  }
  return key;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Raw congress.gov response shapes ──────────────────────────────────────

interface CongressPagination {
  count?: number;
  next?: string;
}

interface RawBill {
  congress?: number;
  type?: string;
  number?: string;
  title?: string;
  originChamber?: string;
  originChamberCode?: string;
  latestAction?: {
    actionDate?: string;
    text?: string;
  };
  updateDate?: string;
  updateDateIncludingText?: string;
  url?: string;
}

interface BillListResponse {
  bills?: RawBill[];
  pagination?: CongressPagination;
}

interface RawHouseVote {
  congress?: number;
  identifier?: number;
  legislationNumber?: string;
  legislationType?: string;
  legislationUrl?: string;
  result?: string;
  rollCallNumber?: number;
  sessionNumber?: number;
  sourceDataURL?: string;
  startDate?: string;
  updateDate?: string;
  url?: string;
  voteType?: string;
}

interface HouseVoteListResponse {
  houseRollCallVotes?: RawHouseVote[];
  pagination?: CongressPagination;
}

// NOTE: Senate vote types are kept here for v1.1 reference when we add the
// senate.gov XML scraper. The Senate rolled-call vote endpoint does NOT
// exist on api.congress.gov v3 (verified Day 8); the canonical source is
// https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml
// which returns a different schema (per-vote XML rather than a paginated
// JSON list). When that scraper lands, swap these placeholders for real
// fetched-shape types.
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface _RawSenateVote_v1_1_placeholder {
  congress?: number;
  identifier?: string;
  legislationNumber?: string;
  legislationType?: string;
  result?: string;
  rollCallNumber?: number;
  sessionNumber?: number;
  sourceDataURL?: string;
  startDate?: string;
  updateDate?: string;
  url?: string;
  voteType?: string;
  voteQuestion?: string;
}

// ─── Paginated fetcher with retry-on-5xx ───────────────────────────────────

interface PaginationOptions {
  maxPages?: number;
}

async function fetchAllPages<TResp, TRow>(
  endpoint: string,
  params: Record<string, string | number>,
  extractRows: (resp: TResp) => TRow[],
  extractPagination: (resp: TResp) => CongressPagination | undefined,
  options: PaginationOptions = {},
): Promise<TRow[]> {
  const apiKey = getApiKey();
  const maxPages = options.maxPages ?? 1000;
  const allRows: TRow[] = [];

  let offset = 0;
  let totalCount = 0;
  let page = 0;
  while (page < maxPages) {
    const url = new URL(`${CONFIG.BASE_URL}${endpoint}`);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(CONFIG.PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    await sleep(CONFIG.RATE_LIMIT_MS);

    // Same retry-with-exponential-backoff pattern as the FEC scraper.
    // api.data.gov's gateway returns 5xx + 429 occasionally during heavy
    // pulls; rather than crash, back off and retry up to 5 times.
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
            `[congress]   offset=${offset}: network error (${msg}), retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
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
          `[congress]   offset=${offset}: 429 rate-limited, waiting ${retryAfter}s...`,
        );
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        if (attempt < MAX_RETRIES) {
          const backoffSec = Math.pow(2, attempt);
          console.error(
            `[congress]   offset=${offset}: HTTP ${res.status} ${res.statusText}, retry ${attempt + 1}/${MAX_RETRIES} in ${backoffSec}s`,
          );
          await sleep(backoffSec * 1000);
          attempt++;
          continue;
        }
        throw new Error(
          `congress.gov ${endpoint} HTTP ${res.status} at offset ${offset} after ${MAX_RETRIES} retries`,
        );
      }
      break;
    }

    if (!res || !res.ok) {
      throw new Error(
        `congress.gov ${endpoint} HTTP ${res?.status ?? "(no response)"} ${res?.statusText ?? ""} at offset ${offset}`,
      );
    }

    const json = (await res.json()) as TResp;
    const rows = extractRows(json);
    const pagination = extractPagination(json);

    allRows.push(...rows);

    if (page === 0) {
      totalCount = pagination?.count ?? rows.length;
      console.error(
        `[congress]   ${endpoint} reports ${totalCount} total rows`,
      );
    }
    page++;
    console.error(
      `[congress]   offset=${offset}: ${rows.length} rows (running ${allRows.length}/${totalCount})`,
    );

    if (rows.length === 0) break;
    // Use the API's `next` cursor if provided; otherwise advance by page size.
    if (pagination?.next) {
      // congress.gov's `next` is a full URL; we extract just the new offset.
      const nextUrl = new URL(pagination.next);
      const nextOffset = nextUrl.searchParams.get("offset");
      if (!nextOffset) break;
      offset = parseInt(nextOffset, 10);
    } else {
      offset += rows.length;
    }
    if (offset >= totalCount) break;
  }

  if (page >= maxPages && totalCount > allRows.length) {
    console.error(
      `[congress]   WARNING: hit maxPages=${maxPages}; pulled ${allRows.length}/${totalCount}`,
    );
  }
  return allRows;
}

// ─── Normalizers ────────────────────────────────────────────────────────────

function normalizeBill(raw: RawBill, scrapedAt: string): Bill | null {
  if (!raw.congress || !raw.type || !raw.number) return null;
  const billType = raw.type.toUpperCase();
  const congress = raw.congress;
  const number = raw.number;
  const billId = `${congress}-${billType}-${number}`;
  return {
    bill_id: billId,
    congress,
    bill_type: billType,
    number,
    title: raw.title ?? "",
    origin_chamber: raw.originChamber ?? "",
    origin_chamber_code: raw.originChamberCode ?? "",
    latest_action_date: raw.latestAction?.actionDate ?? "",
    latest_action_text: raw.latestAction?.text ?? "",
    update_date: raw.updateDateIncludingText ?? raw.updateDate ?? "",
    congress_gov_url: `https://www.congress.gov/bill/${congress}/${billType.toLowerCase()}/${number}`,
    api_url: raw.url ?? "",
    scraped_at: scrapedAt,
  };
}

function normalizeHouseVote(
  raw: RawHouseVote,
  scrapedAt: string,
): RollCallVote | null {
  if (
    raw.congress === undefined ||
    raw.sessionNumber === undefined ||
    raw.rollCallNumber === undefined
  ) {
    return null;
  }
  const congress = raw.congress;
  const session = raw.sessionNumber;
  const rcNum = raw.rollCallNumber;
  const legType = (raw.legislationType ?? "").toUpperCase();
  const legNum = raw.legislationNumber ?? "";
  return {
    vote_id: `house-${congress}-${session}-${rcNum}`,
    congress,
    session_number: session,
    chamber: "house",
    roll_call_number: rcNum,
    vote_type: raw.voteType ?? "",
    result: raw.result ?? "",
    legislation_type: legType,
    legislation_number: legNum,
    bill_id: legType && legNum ? `${congress}-${legType}-${legNum}` : "",
    start_date: raw.startDate ?? "",
    update_date: raw.updateDate ?? "",
    source_data_url: raw.sourceDataURL ?? "",
    congress_gov_url: raw.legislationUrl ?? "",
    api_url: raw.url ?? "",
    scraped_at: scrapedAt,
  };
}

// normalizeSenateVote is intentionally absent for v1A; senate.gov XML scraper
// (v1.1) will produce its own normalizer because the upstream schema differs.

// ─── Public scrapers ────────────────────────────────────────────────────────

export interface ScrapeBillsOptions {
  congress: number;
  billTypes?: string[]; // defaults to all 8 types
  maxPages?: number;
}

/**
 * Scrape all bills (and resolutions) for a given Congress. Iterates each
 * bill type (HR / S / HRES / SRES / HJRES / SJRES / HCONRES / SCONRES)
 * and dedups by composite bill_id ({congress}-{type}-{number}).
 */
export async function scrapeBills(
  options: ScrapeBillsOptions,
): Promise<Bill[]> {
  const scrapedAt = new Date().toISOString();
  const billTypes = options.billTypes ?? CONFIG.BILL_TYPES;
  console.error(
    `[bills] Scraping Congress ${options.congress}, types: ${billTypes.join(", ")}`,
  );

  const seen = new Map<string, Bill>();
  for (const billType of billTypes) {
    console.error(`[bills]   type=${billType.toUpperCase()}`);
    const raws = await fetchAllPages<BillListResponse, RawBill>(
      `/bill/${options.congress}/${billType}`,
      {},
      (r) => r.bills ?? [],
      (r) => r.pagination,
      { maxPages: options.maxPages },
    );
    for (const raw of raws) {
      const b = normalizeBill(raw, scrapedAt);
      if (b) seen.set(b.bill_id, b);
    }
  }
  const bills = Array.from(seen.values());
  console.error(`[bills] TOTAL: ${bills.length} unique bills`);
  return bills;
}

export interface ScrapeVotesOptions {
  congress: number;
  /** When set, scrape only one session; otherwise both sessions (1 & 2). */
  session?: number;
  /** When set to "house" or "senate", scrape only that chamber. */
  chamber?: "house" | "senate";
  maxPages?: number;
}

/**
 * Scrape roll-call votes for a Congress (both chambers, both sessions by
 * default). Dedups by composite vote_id ({chamber}-{congress}-{session}-{rcNum}).
 */
export async function scrapeRollCallVotes(
  options: ScrapeVotesOptions,
): Promise<RollCallVote[]> {
  const scrapedAt = new Date().toISOString();
  const sessions = options.session ? [options.session] : [1, 2];
  // v1A is HOUSE ONLY. api.congress.gov v3 only exposes /house-vote; Senate
  // roll-call votes live on senate.gov directly as XML at
  // senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml
  // and require a separate scraper. Tagged for v1.1.
  if (options.chamber === "senate") {
    throw new Error(
      "Senate roll-call votes are v1.1 — not available via api.congress.gov. " +
        "Live source: senate.gov/legislative/LIS/roll_call_lists/. " +
        "Use chamber=house for now, or skip --chamber to default to house.",
    );
  }
  console.error(
    `[votes] Scraping House votes for Congress ${options.congress}, sessions: ${sessions.join(",")} (Senate is v1.1)`,
  );

  const seen = new Map<string, RollCallVote>();
  for (const session of sessions) {
    console.error(`[votes]   house session=${session}`);
    const raws = await fetchAllPages<HouseVoteListResponse, RawHouseVote>(
      `/house-vote/${options.congress}/${session}`,
      {},
      (r) => r.houseRollCallVotes ?? [],
      (r) => r.pagination,
      { maxPages: options.maxPages },
    );
    for (const raw of raws) {
      const v = normalizeHouseVote(raw, scrapedAt);
      if (v) seen.set(v.vote_id, v);
    }
  }
  const votes = Array.from(seen.values());
  console.error(`[votes] TOTAL: ${votes.length} unique roll-call votes`);
  return votes;
}
