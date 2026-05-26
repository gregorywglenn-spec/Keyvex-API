/**
 * Firestore client wrapper with two modes:
 *
 *   1. STUB MODE — secrets/service-account.json doesn't exist. Tool handlers
 *      return realistic mock data so the server is testable end-to-end without
 *      live credentials.
 *
 *   2. LIVE MODE — secrets/service-account.json exists. Real Firestore queries
 *      go to the MCP project's own Firestore database (sibling project, dual-
 *      scrape architecture — see DATA_REQUIREMENTS_FOR_DASHBOARD.md and the
 *      handoff doc for why we don't share a database with Capital Edge).
 *
 * Mode is auto-detected at module load. Drop a service-account.json into
 * secrets/ and restart to switch modes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActivistOwnership,
  ActivistOwnershipQuery,
  Bill,
  BillsQuery,
  CongressionalTrade,
  CongressionalTradesQuery,
  EnforcementAction,
  EnforcementActionsQuery,
  FecCandidate,
  FecCandidateQuery,
  FecCommittee,
  FecCommitteeQuery,
  FecContribution,
  FecContributionQuery,
  FecIndependentExpenditure,
  FecIndependentExpenditureQuery,
  FederalContractAward,
  FederalContractAwardsQuery,
  FederalGrant,
  FederalGrantsQuery,
  CftcCotReport,
  CftcCotReportQuery,
  SecFailToDeliver,
  SecFailsToDeliverQuery,
  FederalRegisterDocument,
  FederalRegisterDocumentsQuery,
  Form144Filing,
  Form144FilingsQuery,
  Form278Filing,
  Form278FilingsQuery,
  Form3Holding,
  Form3HoldingsQuery,
  InsiderTransaction,
  InsiderTransactionsQuery,
  InstitutionalHolding,
  InstitutionalHoldingsQuery,
  Legislator,
  LegislatorHistorical,
  LegislatorQuery,
  LobbyingFiling,
  LobbyingFilingsQuery,
  MaterialEvent,
  MaterialEventsQuery,
  NportFiling,
  NportFilingsQuery,
  NportHolding,
  NportHoldingsQuery,
  ProductRecall,
  ProductRecallsQuery,
  GovDocument,
  GovDocumentsQuery,
  ForeignAgent,
  ForeignAgentsQuery,
  ScreeningListEntry,
  ScreeningListQuery,
  OfacSdnEntry,
  OfacSdnQuery,
  OtcMarketWeekly,
  OtcMarketWeeklyQuery,
  PrivatePlacement,
  PrivatePlacementsQuery,
  ConsumerComplaint,
  ConsumerComplaintsQuery,
  EconomicIndicator,
  EconomicIndicatorsQuery,
  OigExclusion,
  OigExclusionsQuery,
  ProxyFiling,
  ProxyFilingsQuery,
  TreasuryAuction,
  TreasuryAuctionsQuery,
  XbrlFundamental,
  XbrlFundamentalsQuery,
  RegistrationStatement,
  RegistrationStatementsQuery,
  RollCallVote,
  RollCallVotesQuery,
  TenderOffer,
  TenderOffersQuery,
} from "./types.js";

// Resolve service-account.json relative to the project root, not cwd. This
// matters when the server is launched by an MCP client (Claude Desktop, etc.)
// whose working directory is not necessarily our project folder.
//
// In dev (tsx running src/firestore.ts), this module lives at <root>/src.
// In prod (node running dist/firestore.js), it lives at <root>/dist.
// Either way, project root is one level up.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "..");
const SERVICE_ACCOUNT_PATH = resolve(
  PROJECT_ROOT,
  "secrets/service-account.json",
);

// ─── Mode detection ─────────────────────────────────────────────────────────

/**
 * True when running on Cloud Functions / Cloud Run / any GCP runtime that
 * provides Application Default Credentials. Detected via runtime env vars
 * Google sets automatically. When this is true we use ADC for Firestore
 * auth instead of a local service-account file.
 */
function isCloudRuntime(): boolean {
  return (
    process.env.K_SERVICE !== undefined ||
    process.env.FUNCTION_TARGET !== undefined ||
    process.env.FUNCTION_NAME !== undefined
  );
}

export function isStubMode(): boolean {
  // On Cloud Functions, ADC handles auth — never stub even without a local file.
  if (isCloudRuntime()) return false;
  return !existsSync(SERVICE_ACCOUNT_PATH);
}

// ─── Live-mode client (lazy init) ───────────────────────────────────────────

// Type-only imports — keep firebase-admin out of cold-start unless we
// actually use it. Important when running in stub mode (no SDK touched).
type FirestoreInstance = import("firebase-admin/firestore").Firestore;
type FirestoreQuery = import("firebase-admin/firestore").Query;

let liveDb: FirestoreInstance | null = null;

/**
 * Get the live Firestore instance, initializing the SDK on first call.
 * Throws if called in stub mode (no service account).
 *
 * Exported so other modules (scrapers, etc.) can pass the db handle into
 * helpers that take an optional Firestore. Use `getDbIfLive()` if you want
 * a null-or-db result without throwing.
 */
export async function getLiveDb(): Promise<FirestoreInstance> {
  if (liveDb) return liveDb;

  const { applicationDefault, cert, initializeApp, getApps } = await import(
    "firebase-admin/app"
  );
  const { getFirestore } = await import("firebase-admin/firestore");

  // On Cloud Functions / Cloud Run: use Application Default Credentials.
  // The runtime service account already has Firestore access (Firebase
  // configures this automatically). No service-account.json file needed.
  //
  // On local dev: load credentials from secrets/service-account.json.
  const credential = isCloudRuntime()
    ? applicationDefault()
    : cert(JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, "utf8")));

  // initializeApp is idempotent if an app already exists with this name
  const app =
    getApps().find((a) => a.name === "[DEFAULT]") ??
    initializeApp({ credential });

  liveDb = getFirestore(app);
  return liveDb;
}

/**
 * Returns the live Firestore instance, or null in stub mode.
 * Convenient for code paths that work with-or-without live data.
 */
export async function getDbIfLive(): Promise<FirestoreInstance | null> {
  if (isStubMode()) return null;
  return getLiveDb();
}

// ─── Cross-project health-check telemetry ──────────────────────────────────

/**
 * Telemetry write for cross-project health-check monitoring. Called at
 * the end of each scheduled scraper to record that the cron fired and
 * finished successfully. Derek's project (`capital-edge-d5038`) uses the
 * same `/meta/{jobName}` convention; both projects' `scheduledHealthCheck`
 * functions read these docs to alert on stale crons via a shared Slack
 * webhook.
 *
 * Field name `lastSyncedAt` is REQUIRED and load-bearing — Derek's
 * health-check looks for that exact name first, with fallbacks for
 * `lastRunAt`, `lastFinishedAt`, `completedAt`, `lastChecked`. We canonical
 * on `lastSyncedAt`.
 *
 * Wrapped in try/catch — a Firestore hiccup on the meta write should not
 * propagate up and poison an otherwise-successful sync. Only call this
 * AFTER the actual save completes; a failed scrape should NOT write the
 * meta doc, otherwise the health-check sees a phantom "successful" run.
 *
 * In stub mode (no Firestore credentials), no-op silently — local CLI
 * scrapers run without telemetry.
 */
export async function writeJobMeta(
  jobName: string,
  options: {
    started: number;
    docsWritten?: number;
    errors?: number;
    stats?: Record<string, unknown>;
  },
): Promise<void> {
  if (isStubMode()) return;
  try {
    const db = await getLiveDb();
    const payload: Record<string, unknown> = {
      lastSyncedAt: new Date(),
      durationMs: Date.now() - options.started,
    };
    if (options.docsWritten !== undefined) payload.docsWritten = options.docsWritten;
    if (options.errors !== undefined) payload.errors = options.errors;
    if (options.stats !== undefined) payload.stats = options.stats;
    await db.collection("meta").doc(jobName).set(payload, { merge: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[meta] write to /meta/${jobName} failed: ${msg}`);
  }
}

// ─── Public query API ───────────────────────────────────────────────────────

export interface QueryResult<T> {
  results: T[];
  has_more: boolean;
  /**
   * Bug #6 fix (2026-05-22): when a query returns 0 results AND the caller
   * passed a since/until date filter, populate this field with a friendly
   * message explaining that KeyVex's data depth varies by collection. This
   * prevents the silent-empty-equals-no-data misinterpretation that bit
   * Claude.ai's Wells Fargo CFPB query (collection only had 8 days of data
   * but query asked for 90; the empty response felt definitive). The
   * "transparency-as-differentiator" fix.
   */
  coverage_warning?: string;
}

/**
 * Helper for Bug #6 — generate a coverage-warning string when a query
 * returned zero results while a date filter was active. Returns undefined
 * when the warning is not applicable (results were returned, or no date
 * filter was set).
 *
 * The text is intentionally generic across collections — agents can read it
 * and decide whether to widen the window. The contact@keyvex.com pointer
 * gives a real escape hatch for users who need exact coverage info per
 * collection (we'll formalize that into a /coverage endpoint in v1.1).
 */
/**
 * Per-collection map of the canonical "date field" used to define coverage.
 * Used by withCoverageWarning() v2 to look up the actual min/max date the
 * collection holds when building a coverage notice.
 *
 * For most collections this is the same as the default sort_by date. For
 * collections with multiple date dimensions (e.g., bills has latest_action_date
 * + update_date + introduction_date) the value is the field that most agents
 * mean when they say "the date" for that data — usually the one that drives
 * the daily-cron ingestion window.
 */
const COLLECTION_DATE_FIELD: Record<string, string> = {
  insider_trades: "disclosure_date",
  congressional_trades: "disclosure_date",
  planned_insider_sales: "filing_date",
  initial_ownership_baselines: "filing_date",
  activist_ownership: "filing_date",
  federal_contracts: "last_modified_date",
  federal_grants: "last_modified_date",
  cftc_cot_reports: "report_date",
  sec_fails_to_deliver: "settlement_date",
  lobbying_filings: "dt_posted",
  material_events: "filing_date",
  proxy_filings: "filing_date",
  xbrl_fundamentals: "period_end",
  consumer_complaints: "date_received",
  oig_exclusions: "exclusion_date",
  economic_indicators: "period",
  treasury_auctions: "auction_date",
  annual_financial_disclosures: "filing_date",
  federal_register_documents: "publication_date",
  registration_statements: "filing_date",
  nport_filings: "file_date",
  nport_holdings: "period_ending",
  product_recalls: "recall_initiation_date",
  gov_documents: "date_issued",
  foreign_agents: "registration_date",
  screening_list: "scraped_at",
  enforcement_actions: "file_date",
  private_placements: "filing_date",
  otc_market_weekly: "week_start_date",
  bills: "latest_action_date",
  roll_call_votes: "start_date",
  tender_offers: "filing_date",
  fec_candidates: "last_file_date",
  fec_committees: "last_file_date",
  fec_contributions: "contribution_receipt_date",
  fec_independent_expenditures: "expenditure_date",
  insider_transactions_v2: "transaction_date",
  insider_holdings_v2: "period_of_report",
  insider_filings_v2: "filing_date",
};

/**
 * Per-collection map of the QUERY param names that trigger date filtering.
 * Default for any collection not listed: ["since", "until"]. Collections with
 * extra date filter pairs (currently just bills with introduced_since/
 * introduced_until) override here so the coverage warning fires when those
 * are passed too.
 */
const COLLECTION_DATE_FILTER_FIELDS: Record<string, string[]> = {
  bills: ["since", "until", "introduced_since", "introduced_until"],
};

/**
 * Per-collection cache of min/max date strings. Computed lazily on first use,
 * refreshed when cache entry is older than CACHE_TTL_MS. Per-Cloud-Function-
 * instance — restart drops the cache, no big deal because the cache is just a
 * cheap freshness gate, not source of truth.
 */
interface CoverageMeta {
  min_date: string;
  max_date: string;
  fetched_at: number;
}
const COVERAGE_CACHE = new Map<string, CoverageMeta>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCollectionCoverage(
  collection: string,
  dateField: string,
): Promise<{ min_date: string; max_date: string }> {
  const cached = COVERAGE_CACHE.get(collection);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
    return { min_date: cached.min_date, max_date: cached.max_date };
  }
  const db = await getLiveDb();
  const ref = db.collection(collection);
  const [minSnap, maxSnap] = await Promise.all([
    ref.orderBy(dateField, "asc").limit(1).get(),
    ref.orderBy(dateField, "desc").limit(1).get(),
  ]);
  const min_date =
    (minSnap.docs[0]?.data() as Record<string, unknown> | undefined)?.[
      dateField
    ] as string | undefined ?? "";
  const max_date =
    (maxSnap.docs[0]?.data() as Record<string, unknown> | undefined)?.[
      dateField
    ] as string | undefined ?? "";
  const fresh: CoverageMeta = {
    min_date,
    max_date,
    fetched_at: Date.now(),
  };
  COVERAGE_CACHE.set(collection, fresh);
  return { min_date, max_date };
}

/**
 * v2 (2026-05-22 post-bug-hunt): attaches `coverage_warning` to a query
 * result whenever the requested date range is outside or partially outside
 * the collection's actual coverage window. Fires in two cases:
 *
 *   1. ZERO RESULTS + date filter set → "requested X; collection holds Y to Z;
 *      no records in the requested window."
 *   2. TRUNCATED RESULTS + date filter set + requested window EXTENDS BEYOND
 *      the collection coverage → "requested X but collection only holds Y to
 *      Z; some results returned but the older / newer slice of your window
 *      isn't in the collection yet."
 *
 * Skipped when:
 *   - No date filter was set on the query.
 *   - Results came back AND the requested window is entirely within coverage.
 *   - The collection name is unknown to the COLLECTION_DATE_FIELD map (defensive
 *     fallback — better to emit no warning than crash on an unmapped collection).
 *
 * Async because it fetches min/max from Firestore (cached 5min per instance).
 *
 * Called as the final return wrapper in every query function:
 *   return await withCoverageWarning({ results, has_more }, query, "<COLLECTION>");
 */
async function withCoverageWarning<T>(
  base: { results: T[]; has_more: boolean },
  query: Record<string, unknown> | unknown,
  collection: string,
): Promise<QueryResult<T>> {
  const q = query as Record<string, unknown>;

  // ── Case 2: KNOWN-UNSUPPORTED filter value (Greg's 4-case spec) ────────
  // Fires regardless of result count, regardless of date filter. Static
  // notice — no Firestore round-trip. This intentionally REPLACES any
  // downstream coverage_warning that would have been emitted for the
  // same query, because the gap notice is the more informative message
  // (tells the agent exactly which version supports the path).
  const gapNotice = checkKnownGap(collection, q);
  if (gapNotice) {
    return { ...base, coverage_warning: gapNotice };
  }

  // ── Case 5: SHALLOW-COVERAGE collection (Greg's 2026-05-22 federal_contracts diagnosis) ──
  // Fires on EVERY query against a known-shallow collection (empty or
  // non-empty), because the agent's "completeness" assumption is wrong
  // regardless of how many rows came back. The rolling-window scrapers
  // simply do not see historical non-recently-modified records. Higher
  // priority than the empty/coverage messaging below — the shallow
  // notice is the single most useful piece of context for the agent.
  // INVALID_QUERY and KNOWN_GAP still take precedence (those represent
  // structural query mistakes; this represents a data-coverage caveat).
  const shallowNotice = SHALLOW_COVERAGE_NOTICES[collection];
  if (shallowNotice) {
    return { ...base, coverage_warning: shallowNotice };
  }

  const dateFilterFields = COLLECTION_DATE_FILTER_FIELDS[collection] ?? [
    "since",
    "until",
  ];
  // Find the active since/until pair (any date filter that's set).
  const setFilters: Array<[string, string]> = [];
  for (const f of dateFilterFields) {
    const v = q[f];
    if (typeof v === "string" && v.length > 0) setFilters.push([f, v]);
  }

  // ── Case 3.b: VALID + empty WITHOUT a date filter ─────────────────────
  // The agent's filter values matched 0 records but they didn't ask about
  // a date window. Surface the collection's actual coverage so the agent
  // knows whether to suspect "filter combination matches nothing" vs
  // "data hasn't been ingested yet for this entity." Skip when the
  // collection isn't mapped in COLLECTION_DATE_FIELD (no coverage to
  // report) or when results are non-empty.
  if (setFilters.length === 0) {
    if (base.results.length === 0) {
      const df = COLLECTION_DATE_FIELD[collection];
      if (df) {
        try {
          const cov = await getCollectionCoverage(collection, df);
          if (cov.min_date && cov.max_date) {
            return {
              ...base,
              coverage_warning: `Returned 0 results for this query. The collection currently holds records spanning ${cov.min_date} to ${cov.max_date}; the filter values you supplied match no records. Either no entity matches those values, or the relevant data hasn't been ingested yet. Try removing filters one at a time. Email contact@keyvex.com for exact coverage info.`,
            };
          }
        } catch {
          // Coverage fetch failed — fall through to bare base; better
          // silence than an alarmist message we can't substantiate.
        }
      }
    }
    return base; // no date filter, non-empty results → no warning needed
  }

  const dateField = COLLECTION_DATE_FIELD[collection];
  if (!dateField) return base; // unmapped collection → silently skip

  // Resolve the "requested window" from the set filters. Treat anything ending
  // in "since" as a lower bound and "until" as an upper bound.
  let reqSince: string | undefined;
  let reqUntil: string | undefined;
  for (const [name, value] of setFilters) {
    if (name.endsWith("since") || name === "since") {
      reqSince = !reqSince || value < reqSince ? value : reqSince;
    } else if (name.endsWith("until") || name === "until") {
      reqUntil = !reqUntil || value > reqUntil ? value : reqUntil;
    }
  }

  const userLimit =
    typeof q.limit === "number" && q.limit > 0 ? q.limit : 50;
  const isEmpty = base.results.length === 0;
  const isTruncated = base.has_more || base.results.length === userLimit;

  // Fetch collection coverage (cached).
  let coverage: { min_date: string; max_date: string };
  try {
    coverage = await getCollectionCoverage(collection, dateField);
  } catch {
    // Coverage fetch failed (Firestore hiccup, missing index, etc.) — fall back
    // to a generic warning rather than blocking the response.
    if (!isEmpty) return base;
    return {
      ...base,
      coverage_warning: `Returned 0 results in the requested date range. KeyVex's coverage check could not run for this collection right now; widen the date range or contact contact@keyvex.com if this persists.`,
    };
  }

  const { min_date, max_date } = coverage;
  if (!min_date || !max_date) {
    // Empty collection (no docs at all) — only meaningful when caller asked
    // for something and got nothing.
    if (!isEmpty) return base;
    return {
      ...base,
      coverage_warning: `Returned 0 results. This collection currently holds 0 records — its scraper may not have run yet, or the collection name has changed. Email contact@keyvex.com to investigate.`,
    };
  }

  // Determine if the requested window is outside or extends beyond coverage.
  const beforeCoverage = reqSince && reqSince < min_date;
  const afterCoverage = reqUntil && reqUntil > max_date;
  const completelyOutside =
    (reqUntil && reqUntil < min_date) || (reqSince && reqSince > max_date);

  // Build a window-description string for the message.
  const windowText =
    reqSince && reqUntil
      ? `${reqSince} to ${reqUntil}`
      : reqSince
        ? `since ${reqSince}`
        : `until ${reqUntil}`;
  const coverageText = `${min_date} to ${max_date}`;

  if (isEmpty) {
    let msg = `Returned 0 results in the requested range (${windowText}); this collection currently holds ${coverageText}.`;
    if (completelyOutside) {
      msg += ` The requested window is entirely outside available coverage.`;
    } else if (beforeCoverage || afterCoverage) {
      msg += ` The requested window extends beyond the collection's coverage on the ${beforeCoverage ? "older" : "newer"} side.`;
    }
    msg += ` Widen the range, omit the date filter, or email contact@keyvex.com for exact coverage info.`;
    return { ...base, coverage_warning: msg };
  }

  if (isTruncated && (beforeCoverage || afterCoverage)) {
    const side = beforeCoverage ? "older" : "newer";
    const sideDetail = beforeCoverage
      ? `${reqSince} predates collection start of ${min_date}`
      : `${reqUntil} is past collection end of ${max_date}`;
    return {
      ...base,
      coverage_warning: `Partial coverage: returned ${base.results.length} results from the available window, but the requested range (${windowText}) extends beyond this collection's coverage (${coverageText}) on the ${side} side (${sideDetail}). Records outside the coverage window are not stored. Email contact@keyvex.com for exact coverage info.`,
    };
  }

  return base;
}

/**
 * Fields known to be NUMERIC across this codebase's collections. When one of
 * these is used as `sort_by` AND the caller also passes `since` / `until`,
 * the prior code applied the date filter to the numeric field — Firestore
 * would compare the date STRING against the numeric value and silently
 * return zero results. That silent-wrong-answer bug bit a real Claude.ai
 * test on 2026-05-22 (planned_insider_sales sorted by aggregate_market_value
 * with a since filter returned empty).
 *
 * `rejectNumericSortWithDateFilter()` throws a clear, actionable error
 * before issuing the bad query, so an agent gets useful feedback instead
 * of misleading empty results.
 *
 * Trade-off documented intentionally: this rejects the "find largest by
 * value within a date window" pattern. Callers must either drop the date
 * filter or post-filter on the date field client-side after fetching by
 * value sort. v1.1 polish can introduce an in-memory hybrid (pull a wider
 * Firestore window sorted by the numeric field, then filter dates in
 * memory) to preserve that use case without composite indexes.
 */
const NUMERIC_SORT_FIELDS = new Set<string>([
  // Form 144 / planned insider sales
  "aggregate_market_value",
  "shares_to_be_sold",
  // Form 4 / insider transactions
  "total_value",
  "shares",
  // 13D/G / activist ownership
  "percent_of_class",
  "shares_owned",
  // USAspending federal contracts + grants
  "award_amount",
  "total_outlays",
  // Lobbying disclosure + Annual financial disclosures (both have filing_year:number)
  "income",
  "filing_year",
  // XBRL fundamentals + Economic indicators (BLS/FRED) — both have a "value" field
  "value",
  // Economic indicators — `year` is an integer YYYY
  "year",
  // OFAC SDN
  "ent_num",
  // 13F institutional holdings (sort_by: market_value | shares_held | shares_change_pct)
  "market_value",
  "shares_held",
  "shares_change_pct",
  // N-PORT holdings
  "value_usd",
  "pct_of_portfolio",
  // FEC Schedule A — itemized contributions
  "contribution_receipt_amount",
  // FEC Schedule E — independent expenditures
  "expenditure_amount",
  // FEC candidate profile — `active_through` is a year integer
  "active_through",
  // CFTC Commitments of Traders
  "open_interest",
  "noncomm_net",
  "comm_net",
  // FINRA OTC market weekly (dark-pool activity)
  "total_weekly_share_quantity",
  "total_notional_sum",
  "total_weekly_trade_count",
  // SEC Form D — private placements
  "total_amount_sold",
  // SEC Fails-to-Deliver
  "quantity_fails",
  "fail_value",
  // US Treasury auctions (the field that triggered this audit on 2026-05-22)
  "offering_amount",
  "bid_to_cover_ratio",
  // Generic
  "amount",
  "amount_min",
  "amount_max",
]);

function rejectNumericSortWithDateFilter(
  sortField: string,
  since: string | undefined,
  until: string | undefined,
): void {
  if (!since && !until) return;
  if (!NUMERIC_SORT_FIELDS.has(sortField)) return;
  throw new Error(
    `INVALID_QUERY: since/until cannot be combined with sort_by="${sortField}" because that field is numeric, not a date. A date-string filter on a numeric field would silently return zero results. Two ways to fix: (1) drop the since/until filter, OR (2) keep the date filter and use a date sort_by (each tool's default sort_by is a date — omit sort_by to use it). To find the largest by ${sortField} within a date window, fetch with sort_by="${sortField}" and no date filter, then post-filter on the date field client-side.`,
  );
}

/**
 * KNOWN-UNSUPPORTED filter values per Greg's 4-case empty-result spec
 * (2026-05-22):
 *
 *   1. INVALID_QUERY   — handled by rejectNumericSortWithDateFilter above.
 *   2. KNOWN-UNSUPPORTED filter value — handled here. Static notice, no
 *      coverage computation, no Firestore round-trip. Replaces the bare-
 *      empty response when an agent passes a documented gap value.
 *   3. VALID + empty   — handled by withCoverageWarning's date-window
 *      logic + the new empty-without-date-filter notice.
 *   4. VALID + results — passes through unchanged.
 *
 * Each gap entry is a (collection, filterField, matchFn, notice) tuple.
 * Add new ones as documented gaps surface — keep notices honest and
 * action-oriented (tell the agent what version DOES support it, or
 * what alternative path covers the question).
 */
type KnownGap = {
  collection: string;
  filterField: string;
  matches: (value: unknown) => boolean;
  notice: string;
};

const KNOWN_GAPS: KnownGap[] = [
  {
    collection: "annual_financial_disclosures",
    filterField: "chamber",
    matches: (v) => v === "house",
    notice:
      "House Form 278 filings are not yet available — v1A covers Senate eFD filings only. House Clerk Form 278 coverage lands in v1.1. This is a documented gap, not a missing-data condition. Use chamber='senate' or omit the chamber filter for Senate-only results.",
  },
];

function checkKnownGap(
  collection: string,
  query: Record<string, unknown>,
): string | undefined {
  for (const gap of KNOWN_GAPS) {
    if (gap.collection !== collection) continue;
    const v = query[gap.filterField];
    if (v === undefined) continue;
    if (gap.matches(v)) return gap.notice;
  }
  return undefined;
}

/**
 * Collections that hold a recency-limited / shallow slice of a deeper
 * external dataset. The agent might assume completeness on an entity
 * query ("show me Lockheed's federal contracts") but the underlying
 * scraper only ingests a rolling window — so any result count, even
 * non-zero, can be a small sliver of the true upstream universe.
 *
 * For these collections, attach a notice to EVERY response (empty or
 * non-empty). The notice tells the agent what the scraper actually
 * covers + where to go for full history.
 *
 * Surfaced by Greg's 2026-05-22 federal_contracts diagnosis: querying
 * by indexed recipient_uei returned only 3 records max $42M for
 * Lockheed Martin — a "completeness" answer that's structurally wrong
 * because LMT's billions in historical defense contracts simply
 * aren't in the rolling 7-day action window the scraper pulls.
 *
 * Today's registry covers only collections where the limitation has
 * been confirmed and the source-of-truth fallback is clear. Add new
 * entries conservatively — over-warning is also dishonest (an
 * informative-deep collection getting a "shallow!" notice is wrong).
 */
const SHALLOW_COVERAGE_NOTICES: Record<string, string> = {
  federal_contracts:
    "Coverage note: federal_contracts holds a rolling slice of recently-modified contract actions (scraper runs daily on a 7-day action_date window via USAspending API). Historical multi-year mega-contracts that haven't had a recent modification will NOT be in this collection regardless of recipient size — e.g. a Lockheed Martin F-35 contract signed in 2018 won't appear unless a recent obligation/modification was filed against it. Top results by award_amount in this collection are the largest among recently-modified actions, not the largest overall. For full historical coverage of a recipient or program, use the USAspending advanced search at https://www.usaspending.gov/search. v1.1 will add a recipient-backfill mode.",
  federal_grants:
    "Coverage note: federal_grants holds a rolling slice of recently-modified grant actions (scraper runs daily on a 7-day action_date window via USAspending API). Historical multi-year awards that haven't been modified recently will NOT be in this collection. For full historical coverage of a recipient or CFDA program, use https://www.usaspending.gov/search. v1.1 will add a recipient-backfill mode.",
};

/**
 * Substring match with word-boundary protection for short queries.
 *
 * Greg's 2026-05-22 finding: naive .includes() on short query tokens
 * produces mostly false positives.
 *
 *   "AI" matches inside maintaining, Chairman, training, Air, aiding,
 *   against, remain, claiming, etc.
 *   "EV" matches inside event, level, sever, every, eleven, behavioral.
 *   "ML" matches inside HTML, Hamilton, simulated, formally.
 *
 * For short needles (≤3 chars) — including 2-3-char acronyms like AI,
 * ML, EV, CEO, USA, API, EPA — require a WORD-BOUNDARY match: the
 * needle must appear as a whole token, with non-word characters
 * (whitespace, punctuation, hyphens, string boundaries) on both sides.
 * This catches "AI-powered" (✓), "AI." (✓), "AI's" (✓), drops "Air"
 * (✗), "Chairman" (✗), "RoboticAI" (✗ — accepted trade-off: false
 * negatives on glued compounds are better than the current 90%+ false-
 * positive rate on short queries).
 *
 * For longer needles (≥4 chars), substring matching is reliable
 * enough — collision risk is low (e.g. "trump" inside another word is
 * essentially never coincidental). Keeps the current behavior to avoid
 * regressing accepted matches.
 *
 * Empty / undefined inputs return false (never match).
 *
 * INTERIM FIX. The proper solution is tokenized full-text search —
 * Typesense/Algolia/Meili/Elastic OR pre-computed keyword arrays on
 * each document at ingestion (matched server-side via array-contains).
 * The build-vs-buy call is Greg's; tracked in REVIEW_QUEUE.md.
 */
export function matchesSubstringSafe(
  haystack: string | null | undefined,
  needle: string | null | undefined,
): boolean {
  if (!haystack || !needle) return false;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n.length === 0) return false;
  if (n.length <= 3) {
    // Regex escape every special char in the needle, then \b-anchor.
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    return re.test(h);
  }
  return h.includes(n);
}

/**
 * Axis-7 Issue A helper — broadens reporting-owner-name substring matching
 * to traverse the `reporting_owners[]` array in addition to the denormalized
 * primary `reporting_owner_name` field.
 *
 * Why this exists: `insider_transactions_v2` rows carry both
 * `reporting_owner_name: string` (the PRIMARY filer, denormalized for indexed
 * queries) AND `reporting_owners: BulkReportingOwner[]` (the full list of
 * all reporting persons on the filing — for joint disclosures by funds,
 * 10%-holders, etc.). The substring filter at the v2 query sites used to
 * check only the primary field, silently missing rows where the searched
 * name appeared only as a co-filer in the array (e.g., joint 13D-style or
 * multi-owner Form 4 filings where the primary is the fund and the
 * person-name lives in reporting_owners[1].name).
 *
 * Factored as a single source of truth so PATH A (no postFilter, single
 * fetch) and PATH B (postFilter set, paginated loop) in
 * queryInsiderTransactionsV2 both call exactly the same matching logic.
 * The previous shape — substring check inlined at both call sites — was
 * the trap that created Issue A: when a future change broadens coverage,
 * inlining risks fixing one path and leaving the other broken.
 *
 * Additive: any row that matched today still matches. The OR-arm only
 * adds candidates; it never excludes a match the primary-field check
 * would have returned. Backward-compatible by construction.
 */
export function matchesOwnerNameSubstring(
  row: import("./types.js").InsiderTransactionV2,
  needle: string,
): boolean {
  if (matchesSubstringSafe(row.reporting_owner_name, needle)) return true;
  return (row.reporting_owners ?? []).some((o) =>
    matchesSubstringSafe(o.name, needle),
  );
}

/**
 * Apply orderBy(sortField, sortOrder) ONLY when at least one is true:
 *   - the caller explicitly requested a sort (hasExplicitSort=true), OR
 *   - the query already includes an inequality where clause that forces
 *     Firestore to orderBy that field (hasInequalityFilter=true), OR
 *   - no equality filter is in play — pure scan; the single-field auto-
 *     index on sortField handles it (hasEqualityFilter=false).
 *
 * Otherwise return the query unchanged. The "equality-only + no explicit
 * sort" case is served by Firestore's automatic single-field equality
 * index — no composite needed. Without this guard, a default orderBy on
 * top of an equality filter requires a (equality_field, sort_field)
 * composite index, and any agent query against an unprovisioned combo
 * returns FAILED_PRECONDITION / INDEX_MISSING.
 *
 * The trade-off: equality-only queries now return rows in INSERTION
 * ORDER rather than sorted-by-default. Agents who want sorted output
 * pass `sort_by` explicitly, which DOES require a provisioned composite
 * for that (filter, sort) combo. The error message Firestore returns in
 * that case is the same FAILED_PRECONDITION the agent saw before, but
 * now it only fires when the agent EXPLICITLY asked for ordering — not
 * as an invisible default-sort side effect.
 */
function applyOrderByConditionally<T>(
  q: FirebaseFirestore.Query<T>,
  opts: {
    sortField: string;
    sortOrder: "asc" | "desc";
    hasExplicitSort: boolean;
    hasInequalityFilter: boolean;
    hasEqualityFilter: boolean;
  },
): FirebaseFirestore.Query<T> {
  if (
    opts.hasExplicitSort ||
    opts.hasInequalityFilter ||
    !opts.hasEqualityFilter
  ) {
    return q.orderBy(opts.sortField, opts.sortOrder);
  }
  return q;
}

export async function queryInsiderTransactions(
  query: InsiderTransactionsQuery,
): Promise<QueryResult<InsiderTransaction>> {
  if (isStubMode()) {
    return queryInsiderTransactionsStub(query);
  }
  return queryInsiderTransactionsLive(query);
}

// ─── Live mode implementation ───────────────────────────────────────────────

async function queryInsiderTransactionsLive(
  query: InsiderTransactionsQuery,
): Promise<QueryResult<InsiderTransaction>> {
  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("insider_trades");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.transaction_type) {
    q = q.where("transaction_type", "==", query.transaction_type);
  }
  if (query.is_derivative !== undefined) {
    q = q.where("is_derivative", "==", query.is_derivative);
  }
  if (query.transaction_codes && query.transaction_codes.length > 0) {
    q = q.where("transaction_code", "in", query.transaction_codes);
  }
  if (query.min_value !== undefined) {
    q = q.where("total_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";

  // Date-range filters apply to the active sort field
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // When a client-side substring filter is active (officer_name), we must
  // pull a much larger Firestore window — otherwise the global-top-N
  // truncation happens BEFORE the substring filter, and we silently miss
  // valid matches that didn't rank in the first N rows. The 5000 ceiling
  // is enough for v1's data volume (~hundreds of insider records) and
  // protects against runaway memory on later growth. See v1.1 polish item
  // for moving substring search to Firestore-side via tokenized indexes.
  const fetchLimit = query.officer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as InsiderTransaction);

  if (query.officer_name) {
    const needle = query.officer_name.toLowerCase();
    docs = docs.filter((t) =>
      matchesSubstringSafe(t.officer_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "insider_trades");
}

/**
 * Save scraped insider transactions to Firestore.
 *
 * Each record uses its `id` as the document key, so re-running a scraper for
 * the same filings is idempotent — the same trades land at the same doc IDs
 * with `merge: true` semantics, no duplicates.
 *
 * Firestore caps batch size at 500 writes; we use 400 for headroom.
 *
 * Throws if called in stub mode (no service account) — the scrape CLI catches
 * this and prints a friendly message.
 */
export async function saveInsiderTransactions(
  trades: InsiderTransaction[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "insider_trades";
  if (trades.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < trades.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = trades.slice(i, i + BATCH_SIZE);
    for (const trade of chunk) {
      batch.set(collection.doc(trade.id), trade, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── SEC Bulk Insider Dataset v2 — write paths ────────────────────────────
//
// Three sibling collections, parallel save shape to saveInsiderTransactions
// above. Idempotent merge (Firestore set merge:true) — re-runs of the same
// quarter hit the same doc IDs and overwrite-in-place. NEVER duplicates.
//
// Per Greg's Gate 2/4 approval: tagged source: "sec_bulk", era-aware via
// schema_era field; pre-2023 records carry aff10b5one: "NOT_TRACKED" sentinel.
//
// 2026-05-24 perf: switched from single-threaded await loop (~70 min per
// 400K-doc quarter from a residential connection) to an N-way concurrent
// semaphore.
//
// First attempt at N=50 hit gRPC DEADLINE_EXCEEDED after 60s — 50 batches
// × ~800KB each = 40MB queued for upload, draining over 16-32s on
// residential bandwidth, plus Firestore commit/ack pushed last-in-queue
// batches past the 60s default deadline. The Firebase Admin SDK retries
// were burning their full budget before firstError fired.
//
// Reset to N=10: 10 × 800KB = 8MB queued, drains in 5-10s, leaves
// plenty of margin under 60s. Still 3-4x faster than single-threaded
// (~287 docs/sec at N=50 before fault → projected ~250 docs/sec sustained
// at N=10). RETRY logic stays for transient throttling / blips so the
// loader self-recovers without halting.

const BULK_BATCH_SIZE = 400;
const BULK_PARALLEL_BATCHES = 10;
const BULK_MAX_RETRIES = 5;

/**
 * Save a batch of docs using a semaphore-bounded parallel-commit pool.
 * - Up to BULK_PARALLEL_BATCHES Firestore batch commits in flight at once.
 * - Each batch carries up to BULK_BATCH_SIZE docs.
 * - Transient throttling (429 / RESOURCE_EXHAUSTED / UNAVAILABLE) is
 *   retried with exponential backoff per batch (BULK_MAX_RETRIES attempts).
 * - Other errors fail the whole save (orchestrator catches and marks the
 *   quarter "in_progress"; resume re-runs idempotently).
 */
async function commitBatchesParallel<T extends { id: string }>(
  db: FirestoreInstance,
  collectionName: string,
  docs: T[],
): Promise<number> {
  if (docs.length === 0) return 0;
  const collection = db.collection(collectionName);

  // Slice docs into batch-sized chunks up front
  const chunks: T[][] = [];
  for (let i = 0; i < docs.length; i += BULK_BATCH_SIZE) {
    chunks.push(docs.slice(i, i + BULK_BATCH_SIZE));
  }

  let nextIdx = 0;
  let saved = 0;
  let firstError: Error | null = null;

  async function worker(): Promise<void> {
    while (true) {
      if (firstError) return; // short-circuit if a peer worker hit a non-retryable failure
      const myIdx = nextIdx++;
      if (myIdx >= chunks.length) return;
      const chunk = chunks[myIdx]!;

      let attempt = 0;
      while (true) {
        try {
          const batch = db.batch();
          for (const doc of chunk) {
            batch.set(collection.doc(doc.id), doc, { merge: true });
          }
          await batch.commit();
          saved += chunk.length;
          break;
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const isRetryable =
            /429|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/i.test(msg);
          attempt += 1;
          if (!isRetryable || attempt >= BULK_MAX_RETRIES) {
            firstError = e as Error;
            return;
          }
          // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s
          const baseMs = 1000 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 500);
          await new Promise((r) => setTimeout(r, baseMs + jitter));
        }
      }
    }
  }

  const workerCount = Math.min(BULK_PARALLEL_BATCHES, chunks.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  if (firstError) throw firstError;
  return saved;
}

export async function saveInsiderTransactionsV2(
  docs: import("./types.js").InsiderTransactionV2[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "insider_transactions_v2";
  if (docs.length === 0) return { saved: 0, collection: COLLECTION };
  const db = await getLiveDb();
  const saved = await commitBatchesParallel(db, COLLECTION, docs);
  return { saved, collection: COLLECTION };
}

export async function saveInsiderHoldingsV2(
  docs: import("./types.js").InsiderHoldingV2[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "insider_holdings_v2";
  if (docs.length === 0) return { saved: 0, collection: COLLECTION };
  const db = await getLiveDb();
  const saved = await commitBatchesParallel(db, COLLECTION, docs);
  return { saved, collection: COLLECTION };
}

export async function saveInsiderFilingsV2(
  docs: import("./types.js").InsiderFilingV2[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "insider_filings_v2";
  if (docs.length === 0) return { saved: 0, collection: COLLECTION };
  const db = await getLiveDb();
  const saved = await commitBatchesParallel(db, COLLECTION, docs);
  return { saved, collection: COLLECTION };
}

// ─── SEC Bulk Insider Dataset v2 — read path ──────────────────────────────
//
// Parallel to queryInsiderTransactions but reads from insider_transactions_v2
// and returns the full v2 doc shape (including footnote_refs[] and
// aff10b5one). Branched into by get_insider_transactions when the tool is
// called with data_source="bulk_v2".
//
// Greg's Item 3 acceptance test (Gate 5 follow-up, 2026-05-23): "Query that
// row through the live MCP and show the 10b5-1 footnote text coming back in
// the response." This is the read path that makes that possible.
//
// NOTE: the v2 schema's `transaction_type` field is nonderiv|deriv (NOT
// buy|sell as in legacy). Caller-facing parameter is named `row_type` in
// InsiderTransactionsV2Query to avoid the naming collision.
//
// POSTFILTER OPTION (2026-05-24): the handler can pass a post-fetch filter
// callback. Used by the buy/sell input-filter fix — v2 doesn't STORE
// buy/sell (it's derived from trans_code + trans_acquired_disp_cd at
// response time via the shim), so a buy/sell filter has to run AFTER
// Firestore returns rows. When postFilter is set, this function pages
// through Firestore until userLimit+1 matches accumulate (or the dataset
// is exhausted or the safety cap is hit), and has_more reflects post-
// filter reality — NOT the pre-filter row count. Critical for honest
// pagination semantics.

export interface QueryInsiderTransactionsV2Options {
  /**
   * Optional callback applied to each row AFTER it's fetched from Firestore.
   * Return true to include the row, false to drop it. When set, the function
   * pages through Firestore (BULK_POSTFILTER_PAGE_SIZE rows per page, up to
   * BULK_POSTFILTER_MAX_PAGES pages) until userLimit+1 matches accumulate
   * or Firestore is exhausted. has_more reflects post-filter matches.
   */
  postFilter?: (row: import("./types.js").InsiderTransactionV2) => boolean;
}

// Per-page fetch size when paging through Firestore with a postFilter.
// Larger = fewer round trips but more bandwidth; 500 is a reasonable
// balance for the typical buy/sell mix (~60/40) — should fill a 50-row
// userLimit in a single page in almost all cases.
const BULK_POSTFILTER_PAGE_SIZE = 500;
// Safety cap on total Firestore fetches per query. 10 pages × 500 = 5000
// rows scanned. If we still don't have userLimit+1 matches at that point,
// we return what we have with has_more=true (conservative — caller can
// page further by narrowing filters). Prevents runaway latency on
// pathological skews (e.g., ticker with only buys when caller asks for sells).
const BULK_POSTFILTER_MAX_PAGES = 10;

export async function queryInsiderTransactionsV2(
  query: import("./types.js").InsiderTransactionsV2Query,
  options: QueryInsiderTransactionsV2Options = {},
): Promise<QueryResult<import("./types.js").InsiderTransactionV2>> {
  if (isStubMode()) {
    // No stub data for v2 — returns empty in stub mode. Tool description
    // makes it clear data only exists once the bulk loader has run.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("insider_transactions_v2");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) q = q.where("company_cik", "==", query.company_cik);
  if (query.reporting_owner_cik) {
    q = q.where("reporting_owner_cik", "==", query.reporting_owner_cik);
  }
  if (query.row_type) {
    q = q.where("transaction_type", "==", query.row_type);
  }
  if (query.trans_codes && query.trans_codes.length > 0) {
    q = q.where("trans_code", "in", query.trans_codes);
  }
  if (query.aff10b5one !== undefined) {
    q = q.where("aff10b5one", "==", query.aff10b5one);
  }
  if (query.schema_era) {
    q = q.where("schema_era", "==", query.schema_era);
  }

  const sortField = query.sort_by ?? "transaction_date";
  const sortOrder = query.sort_order ?? "desc";

  // Date-range filters apply to the active sort field. The v2 collection's
  // sortable date fields are both ISO YYYY-MM-DD strings so this is safe to
  // use without numeric-sort guarding.
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  // INDEX HYGIENE: only add orderBy when the caller actually needs ordered
  // results — i.e. they passed since/until or an explicit sort_by. A plain
  // equality query without orderBy doesn't require a composite index, so
  // ticker-only / company_cik-only / reporting_owner-only queries work
  // immediately on a fresh deploy (before composite indexes propagate).
  // When the caller IS using date-range or sort, the composite index from
  // firestore.indexes.json is required.
  //
  // EXTRA: when postFilter is set, we paginate via .startAfter(lastDoc),
  // which requires a stable orderBy. Force ordering on the sortField in
  // that case (composite indexes are deployed for the common shapes).
  const needsOrderBy =
    query.sort_by !== undefined ||
    query.since !== undefined ||
    query.until !== undefined ||
    options.postFilter !== undefined;
  if (needsOrderBy) {
    q = q.orderBy(sortField, sortOrder);
  }

  const userLimit = query.limit ?? 50;

  // ─── PATH A: no postFilter — original single-fetch behavior ──────────────
  if (!options.postFilter) {
    const fetchLimit = query.reporting_owner_name ? 5000 : userLimit + 1;
    const snap = await q.limit(fetchLimit).get();
    let docs = snap.docs.map(
      (d) => d.data() as import("./types.js").InsiderTransactionV2,
    );

    if (query.reporting_owner_name) {
      const needle = query.reporting_owner_name.toLowerCase();
      // Axis-7 Issue A fix: traverse reporting_owners[].name in addition
      // to the primary reporting_owner_name (see matchesOwnerNameSubstring
      // docstring). Single source of truth shared with PATH B below.
      docs = docs.filter((t) => matchesOwnerNameSubstring(t, needle));
    }

    const has_more = docs.length > userLimit;
    const results = docs.slice(0, userLimit);
    return await withCoverageWarning(
      { results, has_more },
      query,
      "insider_transactions_v2",
    );
  }

  // ─── PATH B: postFilter set — page through Firestore until we have ───────
  //           userLimit+1 matches OR Firestore exhausted OR safety cap hit.
  const substringNeedle = query.reporting_owner_name
    ? query.reporting_owner_name.toLowerCase()
    : null;
  const matched: import("./types.js").InsiderTransactionV2[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let firestoreExhausted = false;
  let pagesScanned = 0;

  // Loop until we have enough matches OR Firestore is exhausted OR we hit
  // the safety cap. Fetch BULK_POSTFILTER_PAGE_SIZE+1 per page to detect
  // whether more rows exist beyond the page.
  while (
    matched.length <= userLimit &&
    !firestoreExhausted &&
    pagesScanned < BULK_POSTFILTER_MAX_PAGES
  ) {
    let pageQ = q.limit(BULK_POSTFILTER_PAGE_SIZE + 1);
    if (cursor) pageQ = pageQ.startAfter(cursor);
    const pageSnap = await pageQ.get();

    if (pageSnap.empty) {
      firestoreExhausted = true;
      break;
    }

    // If we got fewer than PAGE_SIZE+1 rows, this is the last page.
    firestoreExhausted = pageSnap.size <= BULK_POSTFILTER_PAGE_SIZE;
    const pageDocs = firestoreExhausted
      ? pageSnap.docs
      : pageSnap.docs.slice(0, BULK_POSTFILTER_PAGE_SIZE);

    for (const docSnap of pageDocs) {
      const row = docSnap.data() as import("./types.js").InsiderTransactionV2;

      // Apply substring filter (if set) FIRST — cheaper than the postFilter
      // for rows that don't match the owner-name substring.
      // Axis-7 Issue A fix: same helper as PATH A above — traverses
      // reporting_owners[].name in addition to primary reporting_owner_name.
      if (substringNeedle !== null) {
        if (!matchesOwnerNameSubstring(row, substringNeedle)) {
          continue;
        }
      }

      if (options.postFilter(row)) {
        matched.push(row);
        if (matched.length > userLimit) break; // hot exit
      }
    }

    cursor = pageDocs[pageDocs.length - 1];
    pagesScanned += 1;
  }

  // has_more semantics for postFilter path:
  //   - matched.length > userLimit → we found more matches than the limit → has_more = true
  //   - matched.length <= userLimit AND firestoreExhausted → we saw everything → has_more = false
  //   - matched.length <= userLimit AND hit safety cap → unknown; conservative true
  const has_more =
    matched.length > userLimit ||
    (!firestoreExhausted && pagesScanned >= BULK_POSTFILTER_MAX_PAGES);
  const results = matched.slice(0, userLimit);
  return await withCoverageWarning(
    { results, has_more },
    query,
    "insider_transactions_v2",
  );
}

// ─── Institutional holdings (13F) query ─────────────────────────────────────

export async function queryInstitutionalHoldings(
  query: InstitutionalHoldingsQuery,
): Promise<QueryResult<InstitutionalHolding>> {
  if (isStubMode()) {
    // No stub data for 13F yet — returns empty in stub mode. Tool descriptions
    // make it clear the data only exists once a 13f scrape has been run.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("institutional_holdings");

  // Track filter shape so we can decide whether to apply a default orderBy
  // below. The default sort is market_value (numeric) — Firestore needs a
  // composite index on (equality_field, market_value) when both are
  // present. We avoid that requirement on equality-only queries by
  // skipping the default orderBy entirely; the caller can opt-in to a
  // sorted result by passing sort_by explicitly (which DOES need the
  // composite, and surfaces a clean error if it's missing).
  let hasEqualityFilter = false;
  let hasInequalityFilter = false;

  if (query.ticker) {
    q = q.where("ticker", "==", query.ticker);
    hasEqualityFilter = true;
  }
  if (query.cusip) {
    q = q.where("cusip", "==", query.cusip);
    hasEqualityFilter = true;
  }
  if (query.fund_cik) {
    q = q.where("fund_cik", "==", query.fund_cik);
    hasEqualityFilter = true;
  }
  if (query.quarter) {
    q = q.where("quarter", "==", query.quarter);
    hasEqualityFilter = true;
  }
  if (query.position_change) {
    q = q.where("position_change", "==", query.position_change);
    hasEqualityFilter = true;
  }
  if (query.min_value !== undefined) {
    q = q.where("market_value", ">=", query.min_value);
    hasInequalityFilter = true;
  }

  const sortField = query.sort_by ?? "market_value";
  const sortOrder = query.sort_order ?? "desc";
  q = applyOrderByConditionally(q, {
    sortField,
    sortOrder,
    hasExplicitSort: query.sort_by !== undefined,
    hasInequalityFilter,
    hasEqualityFilter,
  });

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as queryInsiderTransactionsLive:
  // when fund_name is set, we must pull a much larger Firestore window so
  // the client-side substring filter sees the full universe. Without this,
  // a query for "Berkshire" returns only the top-N global positions that
  // happen to be Berkshire's — Berkshire's smaller positions silently miss.
  // 5000 ceiling protects memory; sufficient for v1's ~thousands of records.
  const fetchLimit = query.fund_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as InstitutionalHolding);

  if (query.fund_name) {
    const needle = query.fund_name.toLowerCase();
    docs = docs.filter((h) =>
      matchesSubstringSafe(h.fund_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "institutional_holdings");
}

/**
 * Save scraped institutional holdings to Firestore.
 *
 * Each record uses its `id` as the document key (`13f-{fundCik}-{cusip}-
 * {quarter}`), so re-running a scrape for the same filing is idempotent.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveInstitutionalHoldings(
  holdings: InstitutionalHolding[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "institutional_holdings";
  if (holdings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < holdings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = holdings.slice(i, i + BATCH_SIZE);
    for (const holding of chunk) {
      batch.set(collection.doc(holding.id), holding, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Congressional trades query ─────────────────────────────────────────────

export async function queryCongressionalTrades(
  query: CongressionalTradesQuery,
): Promise<QueryResult<CongressionalTrade>> {
  if (isStubMode()) {
    // No stub data for congressional trades — returns empty in stub mode.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("congressional_trades");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.bioguide_id) q = q.where("bioguide_id", "==", query.bioguide_id);
  if (query.chamber) q = q.where("chamber", "==", query.chamber);
  if (query.transaction_type) {
    q = q.where("transaction_type", "==", query.transaction_type);
  }
  if (query.owner) q = q.where("owner", "==", query.owner);
  if (query.min_amount !== undefined) {
    q = q.where("amount_min", ">=", query.min_amount);
  }

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as queryInsiderTransactionsLive: when
  // member_name (substring filter) is set, pull a much larger Firestore window
  // so the client-side filter sees the full universe.
  const fetchLimit = query.member_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as CongressionalTrade);

  if (query.member_name) {
    const needle = query.member_name.toLowerCase();
    docs = docs.filter((t) =>
      matchesSubstringSafe(t.member_name, needle),
    );
  }

  // Interim guard (Greg's 2026-05-23 finding): a handful of House PTRs
  // have transaction_date corruption from pdf-parse digit garbling
  // ("04/30/2021" extracted as "04/30/3031"). Until those rows are
  // cleaned up via re-scrape, exclude impossible future-dated trades
  // from transaction_date-sorted results so the "most recent trades"
  // headline query doesn't return year-3031 rows at the top.
  //
  // Threshold: any transaction_date year > current_year+1 is
  // structurally impossible (no PTR is filed for a trade more than ~1
  // year in the future). Keep ancient-year rows (< 2012) in the
  // result set since they're legitimate historical PTRs.
  if (sortField === "transaction_date") {
    const cutoffYear = new Date().getUTCFullYear() + 1;
    docs = docs.filter((t) => {
      const td = t.transaction_date ?? "";
      if (!td) return true; // empty stays (sorts to bottom naturally)
      const yr = parseInt(td.slice(0, 4), 10);
      return Number.isNaN(yr) || yr <= cutoffYear;
    });
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "congressional_trades");
}

/**
 * Save scraped congressional trades to Firestore. Idempotent — re-running
 * the scraper on the same PTRs writes the same doc IDs (`senate-{ptrId}-{i}`
 * or `house-{docId}-{i}`) with merge:true semantics.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveCongressionalTrades(
  trades: CongressionalTrade[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "congressional_trades";
  if (trades.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  // Enrich bioguide_id + party + state from the legislators catalog
  // BEFORE writing. Greg's 2026-05-22 finding: 99.6% of existing rows had
  // bioguide_id="" because the scheduled scrapers never ran the resolver.
  // Now every save (scheduled cron OR manual CLI) gets ingestion-time
  // enrichment. Lookups are cached 10 min per process so the 13K-record
  // catalog load only happens once per cold function start.
  //
  // Best-effort: if the catalog load fails, log + save the raw trades
  // rather than blocking the write. The standalone `backfill-bioguide`
  // CLI can clean up any rows that slipped through.
  let toWrite = trades;
  try {
    toWrite = await enrichTradesWithBioguide(trades);
    const filled = toWrite.filter(
      (t, i) => !trades[i]?.bioguide_id && t.bioguide_id,
    ).length;
    if (filled > 0) {
      console.error(
        `[saveCongressionalTrades] bioguide enrichment: ${filled}/${trades.length} resolved`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[saveCongressionalTrades] bioguide enrichment FAILED — saving raw rows. ${msg}`,
    );
  }

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = toWrite.slice(i, i + BATCH_SIZE);
    for (const trade of chunk) {
      batch.set(collection.doc(trade.id), trade, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Bioguide enrichment (ingestion-time + cached) ────────────────────────
//
// Greg's 2026-05-22 finding: the Senate + House scrapers wrote bioguide_id=""
// + party="" + state="" on every new record, relying on a manual back-fill
// CLI to fill them in later. The back-fill was a one-time pass — so every
// nightly cron run accumulated more unenriched rows. By 2026-05-22 the
// collection was 99.6% empty on bioguide_id (56,970 of 57,211 rows).
//
// Fix: extract the resolver from backfillBioguideIds() into a reusable
// in-memory enricher + wire it into saveCongressionalTrades() so EVERY
// write (scheduled cron, manual CLI, future paths) populates bioguide_id
// + party + state at ingestion time. The standalone back-fill CLI still
// exists for one-time cleanup of pre-existing rows.

type SenatorByLast = {
  bioguide: string;
  state: string;
  first: string;
  nickname: string;
};
type ByLastWord = {
  bioguide: string;
  chamber: string;
  state: string;
  fullLast: string;
};
type HistoricalCandidate = {
  bioguide: string;
  terms: Array<{ start: string; end: string }>;
};
type BioguideInfo = { party: string; state: string };

type BioguideLookups = {
  primaryLookup: Record<string, string>;
  senateByLast: Record<string, SenatorByLast[]>;
  byLastWord: Record<string, ByLastWord[]>;
  historicalByKey: Record<string, HistoricalCandidate[]>;
  bioguideToInfo: Record<string, BioguideInfo>;
};

let cachedLookups: BioguideLookups | null = null;
let cachedLookupsExpiry = 0;
const LOOKUPS_TTL_MS = 10 * 60 * 1000; // 10 min — agents won't notice; cron cold-starts rebuild fresh

/**
 * Strip ", Jr.", ", Sr.", ", III", ", IV" etc. — trailing comma-suffixes
 * the Senate scraper bakes into the last_name field. Used both here and
 * in backfillBioguideIds (kept duplicated to avoid coupling).
 */
function stripSuffixForBioguide(last: string): string {
  return last.replace(/,\s*(jr|sr|ii|iii|iv|v)\.?\s*$/i, "").trim();
}

/**
 * Build the four lookup tables from the legislators + legislators_historical
 * collections. Cached at module scope for 10 minutes — cheap enough for
 * cold cron starts (one 13K-record load on first call, no-op after).
 */
async function buildBioguideLookups(): Promise<BioguideLookups> {
  if (cachedLookups && Date.now() < cachedLookupsExpiry) {
    return cachedLookups;
  }
  const db = await getLiveDb();

  const lookups: BioguideLookups = {
    primaryLookup: {},
    senateByLast: {},
    byLastWord: {},
    historicalByKey: {},
    bioguideToInfo: {},
  };

  // Current legislators
  const legSnap = await db.collection("legislators").get();
  for (const doc of legSnap.docs) {
    const x = doc.data() as {
      bioguide_id?: string;
      chamber?: string;
      state?: string;
      party?: string;
      last_name?: string;
      first_name?: string;
      nickname?: string;
    };
    if (!x.bioguide_id || !x.chamber || !x.state || !x.last_name) continue;
    const lastLower = x.last_name.toLowerCase();
    const stateUpper = x.state.toUpperCase();
    lookups.primaryLookup[`${x.chamber}|${stateUpper}|${lastLower}`] = x.bioguide_id;
    lookups.bioguideToInfo[x.bioguide_id] = {
      party: x.party ?? "",
      state: stateUpper,
    };
    if (x.chamber === "senate") {
      if (!lookups.senateByLast[lastLower]) lookups.senateByLast[lastLower] = [];
      lookups.senateByLast[lastLower].push({
        bioguide: x.bioguide_id,
        state: stateUpper,
        first: (x.first_name || "").toLowerCase(),
        nickname: (x.nickname || "").toLowerCase(),
      });
    }
    const lastWord = lastLower.split(/\s+/).pop() ?? "";
    if (lastWord && lastWord !== lastLower) {
      if (!lookups.byLastWord[lastWord]) lookups.byLastWord[lastWord] = [];
      lookups.byLastWord[lastWord].push({
        bioguide: x.bioguide_id,
        chamber: x.chamber,
        state: stateUpper,
        fullLast: lastLower,
      });
    }
  }

  // Historical legislators (best-effort — skip cleanly if collection empty)
  try {
    const histSnap = await db.collection("legislators_historical").get();
    for (const doc of histSnap.docs) {
      const x = doc.data() as {
        bioguide_id?: string;
        last_name?: string;
        terms?: Array<{
          chamber?: string;
          state?: string;
          start?: string;
          end?: string;
          party?: string;
        }>;
      };
      if (!x.bioguide_id || !x.last_name || !x.terms) continue;
      const lastLower = x.last_name.toLowerCase();
      const termsByKey: Record<string, Array<{ start: string; end: string }>> = {};
      for (const t of x.terms) {
        if (!t.chamber || !t.state || !t.start || !t.end) continue;
        const key = `${t.chamber}|${t.state.toUpperCase()}|${lastLower}`;
        if (!termsByKey[key]) termsByKey[key] = [];
        termsByKey[key].push({ start: t.start, end: t.end });
        // Record info from the most-recent term (last in chronological list).
        if (!lookups.bioguideToInfo[x.bioguide_id]) {
          lookups.bioguideToInfo[x.bioguide_id] = {
            party: t.party ?? "",
            state: t.state.toUpperCase(),
          };
        }
      }
      for (const [key, terms] of Object.entries(termsByKey)) {
        if (!lookups.historicalByKey[key]) lookups.historicalByKey[key] = [];
        lookups.historicalByKey[key].push({ bioguide: x.bioguide_id, terms });
      }
    }
  } catch {
    // Historical collection unreadable — skip cleanly, Tier-4 will return nothing.
  }

  cachedLookups = lookups;
  cachedLookupsExpiry = Date.now() + LOOKUPS_TTL_MS;
  return lookups;
}

/**
 * Resolve one trade's bioguide_id via the 4-tier matcher. Returns null on
 * no match. Pure function over the prebuilt lookups — safe to call in a tight
 * loop without I/O.
 */
function resolveTradeBioguide(
  trade: CongressionalTrade,
  lookups: BioguideLookups,
): string | null {
  const chamber = trade.chamber || "";
  const stateUpper = (trade.state || "").toUpperCase();
  const lastClean = stripSuffixForBioguide(
    (trade.member_last || "").toLowerCase(),
  );
  const tradeDate = trade.transaction_date || trade.disclosure_date || "";

  // Tier 1: primary
  if (stateUpper && lastClean) {
    const hit = lookups.primaryLookup[`${chamber}|${stateUpper}|${lastClean}`];
    if (hit) return hit;
  }

  // Tier 2: senate-no-state
  if (chamber === "senate" && lastClean) {
    const senators = lookups.senateByLast[lastClean] ?? [];
    if (senators.length === 1 && senators[0]) {
      return senators[0].bioguide;
    } else if (senators.length > 1) {
      const tradeFirstWord =
        (trade.member_first || "").toLowerCase().trim().split(/\s+/)[0] || "";
      if (tradeFirstWord) {
        const matches = senators.filter(
          (s) => s.first === tradeFirstWord || s.nickname === tradeFirstWord,
        );
        if (matches.length === 1 && matches[0]) return matches[0].bioguide;
      }
    }
  }

  // Tier 3: last-word match
  if (lastClean) {
    const candidates = (lookups.byLastWord[lastClean] ?? []).filter(
      (c) => c.chamber === chamber && (!stateUpper || c.state === stateUpper),
    );
    if (candidates.length === 1 && candidates[0]) return candidates[0].bioguide;
  }

  // Tier 4: historical (date-window filtered)
  if (lastClean && tradeDate) {
    let candidates: HistoricalCandidate[] = [];
    if (stateUpper) {
      candidates = lookups.historicalByKey[`${chamber}|${stateUpper}|${lastClean}`] ?? [];
    } else if (chamber === "senate") {
      for (const [key, arr] of Object.entries(lookups.historicalByKey)) {
        if (key.startsWith("senate|") && key.endsWith(`|${lastClean}`)) {
          candidates = candidates.concat(arr);
        }
      }
    }
    const inOffice = candidates.filter((c) =>
      c.terms.some((t) => t.start <= tradeDate && tradeDate <= t.end),
    );
    if (inOffice.length === 1 && inOffice[0]) return inOffice[0].bioguide;
  }

  return null;
}

/**
 * Enrich an array of CongressionalTrade rows in memory: for any row with
 * empty bioguide_id, run the 4-tier resolver against the cached lookups
 * and populate bioguide_id + party + state from the legislators catalog.
 *
 * Idempotent on bioguide_id (already-set rows pass through unchanged).
 * party + state are filled only if currently empty — never overwrites
 * scraper-provided values when present.
 *
 * Used by saveCongressionalTrades(). Exposed (non-`export`) so the same
 * helper is reachable from tests / smoketests via module import.
 */
async function enrichTradesWithBioguide(
  trades: CongressionalTrade[],
): Promise<CongressionalTrade[]> {
  if (trades.length === 0) return trades;
  const lookups = await buildBioguideLookups();
  return trades.map((t) => {
    if (t.bioguide_id) return t;
    const bg = resolveTradeBioguide(t, lookups);
    if (!bg) return t;
    const info = lookups.bioguideToInfo[bg];
    return {
      ...t,
      bioguide_id: bg,
      party: t.party || info?.party || "",
      state: t.state || info?.state || "",
    };
  });
}

// Export the enricher under a clear name for smoketests + future call sites.
export const __enrichTradesWithBioguide = enrichTradesWithBioguide;

// ─── Planned insider sales (Form 144) query ────────────────────────────────

export async function queryForm144Filings(
  query: Form144FilingsQuery,
): Promise<QueryResult<Form144Filing>> {
  if (isStubMode()) {
    // No stub data for Form 144 yet — returns empty in stub mode.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("planned_insider_sales");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.min_value !== undefined) {
    q = q.where("aggregate_market_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as the other collections: when
  // filer_name is set, pull a much larger Firestore window so the client-side
  // filter sees the full universe.
  const fetchLimit = query.filer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Form144Filing);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.filer_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "planned_insider_sales");
}

/**
 * Save scraped Form 144 filings to Firestore. Idempotent — re-running the
 * scraper for the same accession writes the same doc IDs (`{accession}-
 * {ticker}-{lineNumber}`) with merge:true semantics, no duplicates.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveForm144Filings(
  filings: Form144Filing[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "planned_insider_sales";
  if (filings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Initial ownership baselines (Form 3) query ────────────────────────────

export async function queryForm3Holdings(
  query: Form3HoldingsQuery,
): Promise<QueryResult<Form3Holding>> {
  if (isStubMode()) {
    // No stub data for Form 3 yet — returns empty in stub mode.
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("initial_ownership_baselines");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.filer_cik) q = q.where("filer_cik", "==", query.filer_cik);
  if (query.is_derivative !== undefined) {
    q = q.where("is_derivative", "==", query.is_derivative);
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as the other collections: when
  // filer_name is set, pull a much larger Firestore window so the client-side
  // filter sees the full universe.
  const fetchLimit = query.filer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Form3Holding);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.filer_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "initial_ownership_baselines");
}

/**
 * Save scraped Form 3 holdings to Firestore. Idempotent — re-running the
 * scraper for the same accession writes the same doc IDs (`{accession}-
 * {ticker}-ND-{lineNumber}` for non-derivative or `-D-{lineNumber}` for
 * derivative) with merge:true semantics, no duplicates.
 *
 * Throws if called in stub mode (no service account).
 */
export async function saveForm3Holdings(
  holdings: Form3Holding[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "initial_ownership_baselines";
  if (holdings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < holdings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = holdings.slice(i, i + BATCH_SIZE);
    for (const holding of chunk) {
      batch.set(collection.doc(holding.id), holding, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Activist / 5%+ ownership (Schedule 13D/G) query ──────────────────────

export async function queryActivistOwnership(
  query: ActivistOwnershipQuery,
): Promise<QueryResult<ActivistOwnership>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("activist_ownership");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.cusip) q = q.where("cusip", "==", query.cusip);
  if (query.filer_cik) q = q.where("filer_cik", "==", query.filer_cik);
  if (query.is_activist !== undefined) {
    q = q.where("is_activist", "==", query.is_activist);
  }
  if (query.filing_type) {
    q = q.where("filing_type", "==", query.filing_type);
  }
  if (query.min_percent_of_class !== undefined) {
    q = q.where("percent_of_class", ">=", query.min_percent_of_class);
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as the other collections: when
  // filer_name is set, pull a much larger Firestore window so the client-side
  // filter sees the full universe.
  const fetchLimit = query.filer_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as ActivistOwnership);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.filer_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "activist_ownership");
}

/**
 * Save scraped activist / passive 5%+ ownership rows to Firestore.
 * Idempotent — re-running emits the same doc IDs (`{accession}-{ticker}-{lineNo}`)
 * with merge:true semantics.
 */
export async function saveActivistOwnership(
  rows: ActivistOwnership[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "activist_ownership";
  if (rows.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = rows.slice(i, i + BATCH_SIZE);
    for (const row of chunk) {
      batch.set(collection.doc(row.id), row, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Federal contract awards (USAspending) query ──────────────────────────

export async function queryFederalContractAwards(
  query: FederalContractAwardsQuery,
): Promise<QueryResult<FederalContractAward>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("federal_contracts");

  if (query.recipient_uei) {
    q = q.where("recipient_uei", "==", query.recipient_uei);
  }
  if (query.awarding_agency) {
    q = q.where("awarding_agency", "==", query.awarding_agency);
  }
  if (query.naics_code) q = q.where("naics_code", "==", query.naics_code);
  if (query.psc_code) q = q.where("psc_code", "==", query.psc_code);

  const sortField = query.sort_by ?? "last_modified_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Substring + range-on-other-field consideration: when recipient_name
  // (substring) or min_amount (range on a different field than the
  // orderBy) is set, pull a wider Firestore window so client-side
  // filtering sees the universe. min_amount is intentionally NOT
  // pushed down to Firestore because combining range filters on
  // amount + a date-based orderBy triggers a composite-index requirement
  // (Firestore docs: "queries with range and inequality filters on
  // multiple fields require an index"). Client-side handles it cleanly.
  const fetchLimit =
    query.recipient_name || query.min_amount !== undefined
      ? 5000
      : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FederalContractAward);

  if (query.recipient_name) {
    const needle = query.recipient_name.toLowerCase();
    docs = docs.filter((c) =>
      matchesSubstringSafe(c.recipient_name, needle),
    );
  }
  if (query.min_amount !== undefined) {
    docs = docs.filter((c) => c.award_amount >= query.min_amount!);
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "federal_contracts");
}

/**
 * Save scraped federal contract awards to Firestore. Idempotent — re-running
 * the scraper writes the same doc IDs (USAspending's generated_internal_id)
 * with merge:true semantics, so contract modifications correctly overwrite
 * the prior snapshot.
 */
export async function saveFederalContractAwards(
  awards: FederalContractAward[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "federal_contracts";
  if (awards.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < awards.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = awards.slice(i, i + BATCH_SIZE);
    for (const award of chunk) {
      batch.set(collection.doc(award.id), award, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Federal grants (USAspending assistance awards) query + save ─────────

export async function queryFederalGrants(
  query: FederalGrantsQuery,
): Promise<QueryResult<FederalGrant>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }
  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("federal_grants");

  if (query.recipient_uei) {
    q = q.where("recipient_uei", "==", query.recipient_uei);
  } else if (query.awarding_agency) {
    q = q.where("awarding_agency", "==", query.awarding_agency);
  } else if (query.cfda_number) {
    q = q.where("cfda_number", "==", query.cfda_number);
  }

  const sortField = query.sort_by ?? "last_modified_date";
  const sortOrder = query.sort_order ?? "desc";

  const userLimit = query.limit ?? 50;
  const needsSubstring = !!query.recipient_name;
  const fetchLimit = needsSubstring ? 5000 : Math.max(userLimit * 4, 500);

  try {
    q = q.orderBy(sortField, sortOrder).limit(fetchLimit);
  } catch {
    q = q.limit(fetchLimit);
  }

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FederalGrant);

  if (query.recipient_name) {
    const needle = query.recipient_name.toLowerCase();
    docs = docs.filter((g) =>
      matchesSubstringSafe(g.recipient_name, needle),
    );
  }
  if (query.min_amount !== undefined) {
    docs = docs.filter((g) => g.award_amount >= (query.min_amount ?? 0));
  }
  if (query.since) {
    docs = docs.filter(
      (g) => (g.last_modified_date ?? "") >= (query.since ?? ""),
    );
  }
  if (query.until) {
    docs = docs.filter(
      (g) => (g.last_modified_date ?? "") <= (query.until ?? "9999"),
    );
  }

  docs.sort((a, b) => {
    const av =
      sortField === "last_modified_date"
        ? a.last_modified_date
        : sortField === "start_date"
        ? a.start_date
        : sortField === "award_amount"
        ? a.award_amount
        : a.total_outlays;
    const bv =
      sortField === "last_modified_date"
        ? b.last_modified_date
        : sortField === "start_date"
        ? b.start_date
        : sortField === "award_amount"
        ? b.award_amount
        : b.total_outlays;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "federal_grants");
}

export async function saveFederalGrants(
  grants: FederalGrant[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "federal_grants";
  if (grants.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < grants.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = grants.slice(i, i + BATCH_SIZE);
    for (const g of chunk) {
      batch.set(collection.doc(g.id), g, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── CFTC COT reports query + save ────────────────────────────────────────

export async function queryCftcCotReports(
  query: CftcCotReportQuery,
): Promise<QueryResult<CftcCotReport>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }
  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("cftc_cot_reports");

  if (query.id) {
    const docSnap = await db
      .collection("cftc_cot_reports")
      .doc(query.id)
      .get();
    if (!docSnap.exists) return { results: [], has_more: false };
    return { results: [docSnap.data() as CftcCotReport], has_more: false };
  }

  if (query.cftc_contract_market_code) {
    q = q.where(
      "cftc_contract_market_code",
      "==",
      query.cftc_contract_market_code,
    );
  } else if (query.commodity_name) {
    q = q.where("commodity_name", "==", query.commodity_name);
  }

  const sortField = query.sort_by ?? "report_date";
  const sortOrder = query.sort_order ?? "desc";

  // Type-mismatch guard: cftc_cot sort fields open_interest / noncomm_net /
  // comm_net are numeric. Combining a date-string since/until with a numeric
  // sort_by produces silently-truncated client-side filtering — agent gets
  // partial/empty results with no signal that the combination is invalid.
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);

  const userLimit = query.limit ?? 50;
  const needsSubstring = !!query.contract_market_name;
  const fetchLimit = needsSubstring ? 5000 : Math.max(userLimit * 4, 500);

  try {
    q = q.orderBy(sortField, sortOrder).limit(fetchLimit);
  } catch {
    q = q.limit(fetchLimit);
  }

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as CftcCotReport);

  if (query.contract_market_name) {
    const needle = query.contract_market_name.toLowerCase();
    docs = docs.filter((c) =>
      matchesSubstringSafe(c.contract_market_name, needle),
    );
  }
  if (query.since) {
    docs = docs.filter((c) => (c.report_date ?? "") >= (query.since ?? ""));
  }
  if (query.until) {
    docs = docs.filter(
      (c) => (c.report_date ?? "") <= (query.until ?? "9999"),
    );
  }

  if (query.latest_only) {
    const seen = new Map<string, CftcCotReport>();
    for (const d of docs) {
      const existing = seen.get(d.cftc_contract_market_code);
      if (!existing || existing.report_date < d.report_date) {
        seen.set(d.cftc_contract_market_code, d);
      }
    }
    docs = Array.from(seen.values());
  }

  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, number | string | undefined>)[
      sortField
    ] ?? "";
    const bv = (b as unknown as Record<string, number | string | undefined>)[
      sortField
    ] ?? "";
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "cftc_cot_reports");
}

export async function saveCftcCotReports(
  reports: CftcCotReport[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "cftc_cot_reports";
  if (reports.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < reports.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = reports.slice(i, i + BATCH_SIZE);
    for (const r of chunk) {
      batch.set(collection.doc(r.id), r, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── SEC FTD (Fails-to-Deliver) query + save ──────────────────────────────

export async function querySecFailsToDeliver(
  query: SecFailsToDeliverQuery,
): Promise<QueryResult<SecFailToDeliver>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }
  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("sec_fails_to_deliver");

  if (query.id) {
    const docSnap = await db
      .collection("sec_fails_to_deliver")
      .doc(query.id)
      .get();
    if (!docSnap.exists) return { results: [], has_more: false };
    return { results: [docSnap.data() as SecFailToDeliver], has_more: false };
  }

  if (query.ticker) {
    q = q.where("ticker", "==", query.ticker.toUpperCase());
  } else if (query.cusip) {
    q = q.where("cusip", "==", query.cusip);
  }

  const sortField = query.sort_by ?? "settlement_date";
  const sortOrder = query.sort_order ?? "desc";

  // Type-mismatch guard: sec_ftd sort fields quantity_fails / fail_value are
  // numeric. Same client-side filter pattern as cftc_cot — combining numeric
  // sort with since/until silently truncates without agent feedback.
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);

  const userLimit = query.limit ?? 50;
  const fetchLimit = Math.max(userLimit * 4, 500);

  try {
    q = q.orderBy(sortField, sortOrder).limit(fetchLimit);
  } catch {
    q = q.limit(fetchLimit);
  }

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as SecFailToDeliver);

  if (query.since) {
    docs = docs.filter(
      (f) => (f.settlement_date ?? "") >= (query.since ?? ""),
    );
  }
  if (query.until) {
    docs = docs.filter(
      (f) => (f.settlement_date ?? "") <= (query.until ?? "9999"),
    );
  }
  if (query.min_quantity !== undefined) {
    docs = docs.filter(
      (f) => f.quantity_fails >= (query.min_quantity ?? 0),
    );
  }
  if (query.min_value !== undefined) {
    docs = docs.filter((f) => f.fail_value >= (query.min_value ?? 0));
  }

  docs.sort((a, b) => {
    const av =
      sortField === "settlement_date"
        ? a.settlement_date
        : sortField === "quantity_fails"
        ? a.quantity_fails
        : a.fail_value;
    const bv =
      sortField === "settlement_date"
        ? b.settlement_date
        : sortField === "quantity_fails"
        ? b.quantity_fails
        : b.fail_value;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "sec_fails_to_deliver");
}

export async function saveSecFailsToDeliver(
  rows: SecFailToDeliver[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "sec_fails_to_deliver";
  if (rows.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = rows.slice(i, i + BATCH_SIZE);
    for (const r of chunk) {
      batch.set(collection.doc(r.id), r, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── Lobbying filings (LDA) query ─────────────────────────────────────────

export async function queryLobbyingFilings(
  query: LobbyingFilingsQuery,
): Promise<QueryResult<LobbyingFiling>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("lobbying_filings");

  if (query.filing_year !== undefined) {
    q = q.where("filing_year", "==", query.filing_year);
  }
  if (query.filing_period) {
    q = q.where("filing_period", "==", query.filing_period);
  }
  if (query.min_income !== undefined) {
    q = q.where("income", ">=", query.min_income);
  }
  // OR-semantic match across general_issue_codes (max 30 codes per Firestore).
  if (query.general_issue_codes && query.general_issue_codes.length > 0) {
    q = q.where(
      "general_issue_codes",
      "array-contains-any",
      query.general_issue_codes.slice(0, 30),
    );
  }

  const sortField = query.sort_by ?? "dt_posted";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Substring filters (registrant_name, client_name, government_entity)
  // need a wide Firestore window because the lobbying collection is huge
  // (~50K records spanning multiple years). 5000 was too small — verified
  // empirically: "pfizer" substring missed Pfizer's filings because their
  // most-recent record was Dec 2024 but the 5000 most-recent records
  // cover only June 2025 → May 2026.
  //
  // 20000 records covers ~2 years of dt_posted at current pace and catches
  // virtually all real-world substring queries. Trade-off: each query that
  // triggers this fetches ~40MB. Combine substring filter with a since/until
  // date range to scope down when possible.
  //
  // v1.1 polish: add a normalized-name field at ingest + array-contains
  // index for sub-second exact-substring matching at any window size.
  const needsClientSideFilter =
    query.registrant_name || query.client_name || query.government_entity;
  const fetchLimit = needsClientSideFilter ? 20000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as LobbyingFiling);

  if (query.registrant_name) {
    const needle = query.registrant_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.registrant_name, needle),
    );
  }
  if (query.client_name) {
    const needle = query.client_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.client_name, needle),
    );
  }
  if (query.government_entity) {
    const needle = query.government_entity.toLowerCase();
    docs = docs.filter((f) =>
      (f.government_entities ?? []).some((g) =>
        matchesSubstringSafe(g, needle),
      ),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "lobbying_filings");
}

/**
 * Save scraped LDA filings to Firestore. Idempotent — re-running uses the
 * same doc IDs (filing_uuid) with merge:true semantics.
 */
export async function saveLobbyingFilings(
  filings: LobbyingFiling[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "lobbying_filings";
  if (filings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }
  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── Historical legislators (legislators-historical.yaml) save ────────────

/**
 * Save the full historical legislators catalog (~12K entries) to the
 * `legislators_historical` collection. Doc IDs are bioguide_id; idempotent
 * re-runs simply overwrite via merge:true.
 *
 * Used by the back-fill matcher's Tier-4 fallback to resolve former
 * members (e.g., Markwayne Mullin trades after he resigned the Senate).
 */
export async function saveLegislatorsHistorical(
  legislators: LegislatorHistorical[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "legislators_historical";
  if (legislators.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }
  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < legislators.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = legislators.slice(i, i + BATCH_SIZE);
    for (const legislator of chunk) {
      batch.set(collection.doc(legislator.bioguide_id), legislator, {
        merge: true,
      });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── Cross-source enrichment: bioguide_id back-fill ───────────────────────

/**
 * Walk every congressional_trades record and write the matching bioguide_id
 * back into the row, joining against the legislators collection plus
 * (optionally) the legislators_historical collection.
 *
 * Four-tier matcher to handle messy upstream data:
 *   1. Primary: (chamber, state.upper, last_name.lower) — the clean key.
 *   2. Senate-only fallback: (senate, last_name) when state is empty.
 *      The Senate scraper sometimes drops state; this rescues those rows.
 *      Single match wins outright; multi-match disambiguates on first name.
 *   3. Multi-word last-name fallback: when a trade's surname is the LAST
 *      WORD of a legislator's full last_name (e.g., trade "Delaney" vs
 *      YAML "McClain Delaney"). Same uniqueness guard.
 *   4. Historical fallback: same (chamber, state, last_name) lookup against
 *      the legislators_historical collection (~12K entries, all of US
 *      history), filtered to candidates whose service window includes the
 *      trade's transaction_date (or disclosure_date as fallback). Required
 *      to resolve trades by former members no longer in current-members
 *      catalog (e.g., Markwayne Mullin's pre-resignation trades). Skipped
 *      cleanly when the legislators_historical collection is empty.
 *
 * Trade-side last_name is also stripped of trailing comma-suffixes
 * ("King, Jr." → "King", "Hagerty, IV" → "Hagerty") before lookup.
 *
 * One-shot enrichment script. Safe to re-run. dryRun=true counts what
 * would change without writing.
 */
export async function backfillBioguideIds(
  options: { dryRun?: boolean } = {},
): Promise<{
  total_trades: number;
  matched: number;
  matched_primary: number;
  matched_senate_no_state: number;
  matched_suffix: number;
  matched_historical: number;
  unmatched: number;
  already_set: number;
  written: number;
  unmatched_keys: string[];
}> {
  if (isStubMode()) {
    throw new Error(
      "backfillBioguideIds requires LIVE mode (no service account at secrets/service-account.json)",
    );
  }
  const dryRun = options.dryRun ?? false;
  const db = await getLiveDb();

  // Step 1: Load every legislator into memory and build three lookup tables.
  const legSnap = await db.collection("legislators").get();
  const primaryLookup: Record<string, string> = {};
  // For Senate-only fallback: last_name → array of {bioguide, state, first, nickname}.
  // When there's exactly one senator with that last name we use them outright;
  // when there are multiple (e.g., Tim Scott + Rick Scott in the 119th Congress)
  // we disambiguate by matching the trade's first name against `first` OR `nickname`.
  const senateByLast: Record<
    string,
    Array<{ bioguide: string; state: string; first: string; nickname: string }>
  > = {};
  // For multi-word last-name fallback: last word of last_name → array of
  // {bioguide, chamber, state, fullLast}. Used when no primary hit AND
  // exactly one legislator's last word matches.
  const byLastWord: Record<
    string,
    Array<{ bioguide: string; chamber: string; state: string; fullLast: string }>
  > = {};

  for (const doc of legSnap.docs) {
    const x = doc.data() as {
      bioguide_id?: string;
      chamber?: string;
      state?: string;
      last_name?: string;
      first_name?: string;
      nickname?: string;
    };
    if (!x.bioguide_id || !x.chamber || !x.state || !x.last_name) continue;
    const lastLower = x.last_name.toLowerCase();
    const stateUpper = x.state.toUpperCase();
    primaryLookup[`${x.chamber}|${stateUpper}|${lastLower}`] = x.bioguide_id;
    if (x.chamber === "senate") {
      if (!senateByLast[lastLower]) senateByLast[lastLower] = [];
      senateByLast[lastLower].push({
        bioguide: x.bioguide_id,
        state: stateUpper,
        first: (x.first_name || "").toLowerCase(),
        nickname: (x.nickname || "").toLowerCase(),
      });
    }
    const lastWord = lastLower.split(/\s+/).pop() ?? "";
    if (lastWord && lastWord !== lastLower) {
      if (!byLastWord[lastWord]) byLastWord[lastWord] = [];
      byLastWord[lastWord].push({
        bioguide: x.bioguide_id,
        chamber: x.chamber,
        state: stateUpper,
        fullLast: lastLower,
      });
    }
  }
  console.error(
    `[backfill] Loaded ${legSnap.size} legislators, ${Object.keys(primaryLookup).length} primary keys`,
  );

  // Step 1b: Historical lookup. Same key shape as primary but each key
  // maps to an array of candidates (multiple senators named "Smith" over
  // 230 years). Each candidate carries its term windows so the per-trade
  // loop can date-filter to one in-office at a given trade date. Skipped
  // cleanly if the legislators_historical collection is missing/empty.
  const historicalByKey: Record<
    string,
    Array<{ bioguide: string; terms: Array<{ start: string; end: string }> }>
  > = {};
  let historicalCount = 0;
  try {
    const histSnap = await db.collection("legislators_historical").get();
    historicalCount = histSnap.size;
    for (const doc of histSnap.docs) {
      const x = doc.data() as {
        bioguide_id?: string;
        last_name?: string;
        terms?: Array<{ chamber?: string; state?: string; start?: string; end?: string }>;
      };
      if (!x.bioguide_id || !x.last_name || !x.terms) continue;
      const lastLower = x.last_name.toLowerCase();
      // Group this person's terms by (chamber, state) so one bioguide can
      // appear under multiple keys (e.g., served as House rep then senator).
      const termsByKey: Record<string, Array<{ start: string; end: string }>> =
        {};
      for (const t of x.terms) {
        if (!t.chamber || !t.state || !t.start || !t.end) continue;
        const key = `${t.chamber}|${t.state.toUpperCase()}|${lastLower}`;
        if (!termsByKey[key]) termsByKey[key] = [];
        termsByKey[key].push({ start: t.start, end: t.end });
      }
      for (const [key, terms] of Object.entries(termsByKey)) {
        if (!historicalByKey[key]) historicalByKey[key] = [];
        historicalByKey[key].push({ bioguide: x.bioguide_id, terms });
      }
    }
    console.error(
      `[backfill] Loaded ${historicalCount} historical legislators, ${Object.keys(historicalByKey).length} historical join keys`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[backfill] legislators_historical collection unreadable — Tier-4 fallback disabled. (${msg})`,
    );
  }

  // Strip ", Jr.", ", Sr.", ", III", ", IV" etc. — trailing comma-suffixes
  // that the Senate scraper bakes into the last_name field.
  function stripSuffix(last: string): string {
    return last.replace(/,\s*(jr|sr|ii|iii|iv|v)\.?\s*$/i, "").trim();
  }

  // Step 2: Walk every trade. Try primary, then senate-no-state, then
  // suffix, then historical (with date-window filter).
  const tradesSnap = await db.collection("congressional_trades").get();
  const total = tradesSnap.size;
  let matchedPrimary = 0;
  let matchedSenateNoState = 0;
  let matchedSuffix = 0;
  let matchedHistorical = 0;
  let unmatched = 0;
  let alreadySet = 0;
  const unmatchedKeys = new Set<string>();
  const updates: Array<{
    docId: string;
    bioguide_id: string;
    party?: string;
    state?: string;
  }> = [];

  // Build a bioguide → {party, state} lookup so backfill can ALSO write
  // party + state alongside bioguide_id. Greg's 2026-05-22 finding: the
  // earlier backfill only wrote bioguide_id, leaving party empty across
  // every backfilled row even when the catalog had the answer. Now both
  // current and historical legislators contribute info to this map; the
  // primary catalog wins on conflict (most recent term info).
  const bioguideToInfo: Record<string, { party: string; state: string }> = {};
  for (const doc of legSnap.docs) {
    const x = doc.data() as {
      bioguide_id?: string;
      party?: string;
      state?: string;
    };
    if (x.bioguide_id) {
      bioguideToInfo[x.bioguide_id] = {
        party: x.party ?? "",
        state: (x.state ?? "").toUpperCase(),
      };
    }
  }
  // Historical fallback for legislators not in the current catalog.
  try {
    const histSnap = await db.collection("legislators_historical").get();
    for (const doc of histSnap.docs) {
      const x = doc.data() as {
        bioguide_id?: string;
        terms?: Array<{ party?: string; state?: string }>;
      };
      if (!x.bioguide_id || bioguideToInfo[x.bioguide_id]) continue;
      const lastTerm = x.terms?.[x.terms.length - 1];
      if (lastTerm) {
        bioguideToInfo[x.bioguide_id] = {
          party: lastTerm.party ?? "",
          state: (lastTerm.state ?? "").toUpperCase(),
        };
      }
    }
  } catch {
    // Historical missing — current catalog is sufficient for ~98% of cases
  }

  for (const doc of tradesSnap.docs) {
    const x = doc.data() as {
      member_first?: string;
      member_last?: string;
      state?: string;
      chamber?: string;
      bioguide_id?: string;
      party?: string;
      transaction_date?: string;
      disclosure_date?: string;
    };
    if (x.bioguide_id) {
      // bioguide is already set — but check whether party still needs
      // back-filling (an earlier backfill run only wrote bioguide_id).
      // If so, push an update with just the missing party/state and
      // continue. Otherwise count as fully-set and skip.
      const info = bioguideToInfo[x.bioguide_id];
      const needsParty = !x.party && info?.party;
      const needsState = !x.state && info?.state;
      if (needsParty || needsState) {
        updates.push({ docId: doc.id, bioguide_id: x.bioguide_id });
      }
      alreadySet++;
      continue;
    }
    const chamber = x.chamber || "";
    const stateUpper = (x.state || "").toUpperCase();
    const lastClean = stripSuffix((x.member_last || "").toLowerCase());
    // ISO date strings sort lexicographically, so straight `<=` works.
    // Prefer transaction_date (more accurate); fall back to disclosure_date.
    const tradeDate = x.transaction_date || x.disclosure_date || "";

    // Tier 1 — primary key.
    let bioguide: string | undefined;
    if (stateUpper && lastClean) {
      bioguide = primaryLookup[`${chamber}|${stateUpper}|${lastClean}`];
      if (bioguide) {
        matchedPrimary++;
        updates.push({ docId: doc.id, bioguide_id: bioguide });
        continue;
      }
    }

    // Tier 2 — senate fallback when state is missing.
    // Single match: use it. Multi-match (e.g., Tim Scott vs Rick Scott):
    // disambiguate by first-name match against legislator first_name OR
    // nickname. Trade-side member_first is messy (e.g., "Richard Dean Dr"),
    // so we compare on the FIRST WORD only.
    if (chamber === "senate" && lastClean) {
      const senators = senateByLast[lastClean] ?? [];
      const onlyOne = senators.length === 1 ? senators[0] : undefined;
      if (onlyOne) {
        bioguide = onlyOne.bioguide;
        matchedSenateNoState++;
        updates.push({ docId: doc.id, bioguide_id: bioguide });
        continue;
      } else if (senators.length > 1) {
        const tradeFirstWord =
          (x.member_first || "").toLowerCase().trim().split(/\s+/)[0] || "";
        if (tradeFirstWord) {
          const matches = senators.filter(
            (s) => s.first === tradeFirstWord || s.nickname === tradeFirstWord,
          );
          const oneMatch = matches.length === 1 ? matches[0] : undefined;
          if (oneMatch) {
            bioguide = oneMatch.bioguide;
            matchedSenateNoState++;
            updates.push({ docId: doc.id, bioguide_id: bioguide });
            continue;
          }
        }
      }
    }

    // Tier 3 — last-word match (e.g., "Delaney" → "McClain Delaney").
    if (lastClean) {
      const candidates = (byLastWord[lastClean] ?? []).filter(
        (c) => c.chamber === chamber && (!stateUpper || c.state === stateUpper),
      );
      const oneCandidate = candidates.length === 1 ? candidates[0] : undefined;
      if (oneCandidate) {
        bioguide = oneCandidate.bioguide;
        matchedSuffix++;
        updates.push({ docId: doc.id, bioguide_id: bioguide });
        continue;
      }
    }

    // Tier 4 — historical fallback. Same (chamber, state, last_name) key,
    // but candidates are filtered to those whose service window includes
    // the trade's date. Resolves former members like Markwayne Mullin.
    // Senate-no-state historical sub-fallback handles the (senate, "", last)
    // case the same way Tier 2 handles it for current members.
    if (lastClean && tradeDate) {
      let candidates: Array<{
        bioguide: string;
        terms: Array<{ start: string; end: string }>;
      }> = [];
      if (stateUpper) {
        candidates = historicalByKey[`${chamber}|${stateUpper}|${lastClean}`] ?? [];
      } else if (chamber === "senate") {
        // Senate trade with empty state: union all senate keys ending in
        // this last name. Could match any state; date filter narrows it.
        for (const [key, arr] of Object.entries(historicalByKey)) {
          if (key.startsWith("senate|") && key.endsWith(`|${lastClean}`)) {
            candidates = candidates.concat(arr);
          }
        }
      }
      const inOffice = candidates.filter((c) =>
        c.terms.some((t) => t.start <= tradeDate && tradeDate <= t.end),
      );
      const oneHistorical = inOffice.length === 1 ? inOffice[0] : undefined;
      if (oneHistorical) {
        bioguide = oneHistorical.bioguide;
        matchedHistorical++;
        updates.push({ docId: doc.id, bioguide_id: bioguide });
        continue;
      }
    }

    unmatched++;
    unmatchedKeys.add(`${chamber}|${stateUpper}|${lastClean}`);
  }

  const matched =
    matchedPrimary + matchedSenateNoState + matchedSuffix + matchedHistorical;

  console.error(
    `[backfill] ${total} trades: ${matched} matchable (${matchedPrimary} primary, ${matchedSenateNoState} senate-no-state, ${matchedSuffix} suffix, ${matchedHistorical} historical), ${unmatched} unmatched, ${alreadySet} already set`,
  );

  // Step 3: Write the matches back. Batch updates capped at 400 per Firestore.
  // Also write party + state from bioguideToInfo (Greg's 2026-05-22 fix —
  // earlier backfill only wrote bioguide_id, leaving party empty even when
  // the catalog had the answer). Only writes party/state if non-empty so
  // existing scraper-provided values aren't clobbered (merge semantics).
  let written = 0;
  if (!dryRun && updates.length > 0) {
    const collection = db.collection("congressional_trades");
    const BATCH_SIZE = 400;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = updates.slice(i, i + BATCH_SIZE);
      for (const u of chunk) {
        const info = bioguideToInfo[u.bioguide_id];
        const payload: Record<string, string> = { bioguide_id: u.bioguide_id };
        if (info?.party) payload.party = info.party;
        if (info?.state) payload.state = info.state;
        batch.update(collection.doc(u.docId), payload);
      }
      await batch.commit();
      written += chunk.length;
      console.error(`[backfill] Wrote ${written}/${updates.length}...`);
    }
  } else if (dryRun) {
    console.error(`[backfill] DRY RUN — no Firestore writes`);
  }

  return {
    total_trades: total,
    matched,
    matched_primary: matchedPrimary,
    matched_senate_no_state: matchedSenateNoState,
    matched_suffix: matchedSuffix,
    matched_historical: matchedHistorical,
    unmatched,
    already_set: alreadySet,
    written,
    unmatched_keys: [...unmatchedKeys].sort(),
  };
}

// ─── 8-K material events query ────────────────────────────────────────────

export async function queryMaterialEvents(
  query: MaterialEventsQuery,
): Promise<QueryResult<MaterialEvent>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("material_events");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.is_amendment !== undefined) {
    q = q.where("is_amendment", "==", query.is_amendment);
  }

  // OR-semantic match across the item_codes array. Firestore's
  // `array-contains-any` is the natural primitive — caps at 30 values per
  // query, which is well above realistic 8-K item-code combinations.
  if (query.item_codes && query.item_codes.length > 0) {
    q = q.where("item_codes", "array-contains-any", query.item_codes.slice(0, 30));
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  // Greg's 2026-05-23 finding: period_of_report was empty on ~52% of
  // material_events rows (FTS field-name typo in the scraper — fixed
  // for going-forward writes, plus a backfill, but until the backfill
  // completes some rows still have blank period_of_report). When
  // sort_by=period_of_report, sorting by an empty string buries the
  // newest filings — the opposite of what the agent wants. Fall back
  // to filing_date as the order key in that case: it's the same
  // ordering for fully-populated rows, and pushes blank-period rows
  // into their natural chronological position by filing_date.
  const effectiveSortField =
    sortField === "period_of_report" ? "filing_date" : sortField;
  q = q.orderBy(effectiveSortField, sortOrder);

  const userLimit = query.limit ?? 50;
  q = q.limit(userLimit + 1);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as MaterialEvent);

  // When agent asked for period_of_report sort, re-sort client-side
  // using a COALESCE(period_of_report, filing_date) key so populated
  // rows still get their accurate event-date ordering while blanks
  // sort by filing_date.
  if (sortField === "period_of_report") {
    docs.sort((a, b) => {
      const ak = (a.period_of_report || a.filing_date || "") as string;
      const bk = (b.period_of_report || b.filing_date || "") as string;
      if (ak === bk) return 0;
      const cmp = ak < bk ? -1 : 1;
      return sortOrder === "desc" ? -cmp : cmp;
    });
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "material_events");
}

/**
 * Save 8-K filings to Firestore. Idempotent — re-running uses the same
 * doc IDs (accession numbers) with merge:true semantics. Amendments
 * (8-K/A) get their own doc IDs and don't overwrite the original.
 */
export async function saveMaterialEvents(
  events: MaterialEvent[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "material_events";
  if (events.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = events.slice(i, i + BATCH_SIZE);
    for (const event of chunk) {
      batch.set(collection.doc(event.id), event, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── DEF 14A Proxy filings query + save ────────────────────────────────────

export async function queryProxyFilings(
  query: ProxyFilingsQuery,
): Promise<QueryResult<ProxyFiling>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("proxy_filings");

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik);
  }
  if (query.filing_type) q = q.where("filing_type", "==", query.filing_type);
  if (query.is_merger_related !== undefined) {
    q = q.where("is_merger_related", "==", query.is_merger_related);
  }
  if (query.is_amendment !== undefined) {
    q = q.where("is_amendment", "==", query.is_amendment);
  }

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  q = q.limit(userLimit + 1);

  const snap = await q.get();
  const docs = snap.docs.map((d) => d.data() as ProxyFiling);

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "proxy_filings");
}

export async function saveProxyFilings(
  filings: ProxyFiling[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "proxy_filings";
  if (filings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── XBRL Fundamentals query + save ────────────────────────────────────────

export async function queryXbrlFundamentals(
  query: XbrlFundamentalsQuery,
): Promise<QueryResult<XbrlFundamental>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }
  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("xbrl_fundamentals");

  if (query.ticker) q = q.where("ticker", "==", query.ticker.toUpperCase());
  if (query.company_cik) {
    q = q.where("company_cik", "==", query.company_cik.padStart(10, "0"));
  }
  if (query.concept) q = q.where("concept", "==", query.concept);
  if (query.category) q = q.where("category", "==", query.category);
  if (query.fiscal_year !== undefined) {
    q = q.where("fiscal_year", "==", query.fiscal_year);
  }
  if (query.fiscal_period) {
    q = q.where("fiscal_period", "==", query.fiscal_period);
  }
  if (query.form) q = q.where("form", "==", query.form);

  const sortField = query.sort_by ?? "period_end";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  // latest_only is a post-fetch dedup; pull wider window when set.
  const fetchLimit = query.latest_only ? 2000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as XbrlFundamental);

  if (query.latest_only) {
    // One record per (ticker, concept). Keep the one with the latest period_end.
    const latest = new Map<string, XbrlFundamental>();
    for (const d of docs) {
      const key = `${d.ticker}|${d.concept}`;
      const existing = latest.get(key);
      if (!existing || d.period_end > existing.period_end) {
        latest.set(key, d);
      }
    }
    docs = Array.from(latest.values()).sort((a, b) =>
      b.period_end.localeCompare(a.period_end),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "xbrl_fundamentals");
}

export async function saveXbrlFundamentals(
  records: XbrlFundamental[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "xbrl_fundamentals";
  if (records.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }
  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = records.slice(i, i + BATCH_SIZE);
    for (const r of chunk) {
      batch.set(collection.doc(r.id), r, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── CFPB Consumer Complaints query + save ────────────────────────────────

export async function queryConsumerComplaints(
  query: ConsumerComplaintsQuery,
): Promise<QueryResult<ConsumerComplaint>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }
  const db = await getLiveDb();

  // Direct doc lookup when id provided.
  if (query.id) {
    const doc = await db.collection("consumer_complaints").doc(query.id).get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as ConsumerComplaint], has_more: false };
  }

  let q: FirestoreQuery = db.collection("consumer_complaints");

  if (query.product) q = q.where("product", "==", query.product);
  if (query.sub_product) q = q.where("sub_product", "==", query.sub_product);
  if (query.state) q = q.where("state", "==", query.state.toUpperCase());
  if (query.submitted_via) {
    q = q.where("submitted_via", "==", query.submitted_via);
  }
  if (query.timely_response !== undefined) {
    q = q.where("timely_response", "==", query.timely_response);
  }

  const sortField = query.sort_by ?? "date_received";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Substring filters (company, issue) need a wide window. Cap at 10K
  // to balance memory vs coverage.
  const needsClientSideFilter = query.company || query.issue;
  const fetchLimit = needsClientSideFilter ? 10000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as ConsumerComplaint);

  if (query.company) {
    const needle = query.company.toLowerCase();
    docs = docs.filter((c) => matchesSubstringSafe(c.company, needle));
  }
  if (query.issue) {
    const needle = query.issue.toLowerCase();
    docs = docs.filter((c) => matchesSubstringSafe(c.issue, needle));
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "consumer_complaints");
}

export async function saveConsumerComplaints(
  complaints: ConsumerComplaint[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "consumer_complaints";
  if (complaints.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }
  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < complaints.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = complaints.slice(i, i + BATCH_SIZE);
    for (const c of chunk) {
      batch.set(collection.doc(c.id), c, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── HHS-OIG Exclusions query + save ──────────────────────────────────────

export async function queryOigExclusions(
  query: OigExclusionsQuery,
): Promise<QueryResult<OigExclusion>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("oig_exclusions");

  if (query.state) q = q.where("state", "==", query.state.toUpperCase());
  if (query.general_category) {
    q = q.where("general_category", "==", query.general_category);
  }
  if (query.exclusion_type) {
    q = q.where("exclusion_type", "==", query.exclusion_type);
  }
  if (query.npi) q = q.where("npi", "==", query.npi);
  if (query.is_business !== undefined) {
    q = q.where("is_business", "==", query.is_business);
  }

  const sortField = query.sort_by ?? "exclusion_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Substring filters (name, business_name, city, specialty, is_reinstated)
  // need a wide window. OIG collection is ~90K records so we cap fetch at
  // 20000 to balance memory vs coverage. Combine with state filter to
  // narrow when possible.
  const needsClientSideFilter =
    query.name ||
    query.business_name ||
    query.city ||
    query.specialty ||
    query.is_reinstated !== undefined;
  const fetchLimit = needsClientSideFilter ? 20000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as OigExclusion);

  if (query.name) {
    const needle = query.name.toLowerCase();
    docs = docs.filter((e) => matchesSubstringSafe(e.full_name, needle));
  }
  if (query.business_name) {
    const needle = query.business_name.toLowerCase();
    docs = docs.filter((e) =>
      matchesSubstringSafe(e.business_name, needle),
    );
  }
  if (query.city) {
    const needle = query.city.toLowerCase();
    docs = docs.filter((e) => matchesSubstringSafe(e.city, needle));
  }
  if (query.specialty) {
    const needle = query.specialty.toLowerCase();
    docs = docs.filter((e) => matchesSubstringSafe(e.specialty, needle));
  }
  if (query.is_reinstated !== undefined) {
    docs = docs.filter((e) =>
      query.is_reinstated
        ? e.reinstatement_date !== null
        : e.reinstatement_date === null,
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "oig_exclusions");
}

export async function saveOigExclusions(
  exclusions: OigExclusion[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "oig_exclusions";
  if (exclusions.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < exclusions.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = exclusions.slice(i, i + BATCH_SIZE);
    for (const ex of chunk) {
      batch.set(collection.doc(ex.id), ex, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Economic Indicators (BLS) query + save ─────────────────────────────────

export async function queryEconomicIndicators(
  query: EconomicIndicatorsQuery,
): Promise<QueryResult<EconomicIndicator>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("economic_indicators");

  if (query.source) q = q.where("source", "==", query.source);
  if (query.series_id) q = q.where("series_id", "==", query.series_id);
  if (query.category) q = q.where("category", "==", query.category);
  if (query.period_type) q = q.where("period_type", "==", query.period_type);
  if (query.since_year !== undefined) {
    q = q.where("year", ">=", query.since_year);
  }
  if (query.until_year !== undefined) {
    q = q.where("year", "<=", query.until_year);
  }

  // sort_by default = period (composite "YYYYMxx"/"YYYYQxx"/"YYYYDxxx" sorts
  // lexicographically = chronologically since year and period code are
  // fixed-width in both BLS and FRED conventions).
  const sortField = query.sort_by ?? "period";
  const sortOrder = query.sort_order ?? "desc";
  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  // latest_only is a client-side post-filter — Firestore can't natively
  // dedup-by-series_id in a single query. Pull a wider window when set.
  // FRED daily series have ~1825 obs over 5yr so bump to 5000 for safety.
  const fetchLimit = query.latest_only ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as EconomicIndicator);

  if (query.latest_only) {
    const latestBySeries = new Map<string, EconomicIndicator>();
    for (const d of docs) {
      const existing = latestBySeries.get(d.series_id);
      if (!existing || d.period > existing.period) {
        latestBySeries.set(d.series_id, d);
      }
    }
    docs = Array.from(latestBySeries.values()).sort((a, b) =>
      a.series_name.localeCompare(b.series_name),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "economic_indicators");
}

export async function saveEconomicIndicators(
  indicators: EconomicIndicator[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "economic_indicators";
  if (indicators.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < indicators.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = indicators.slice(i, i + BATCH_SIZE);
    for (const ind of chunk) {
      batch.set(collection.doc(ind.id), ind, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Treasury Auctions query + save ────────────────────────────────────────

export async function queryTreasuryAuctions(
  query: TreasuryAuctionsQuery,
): Promise<QueryResult<TreasuryAuction>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("treasury_auctions");

  if (query.cusip) q = q.where("cusip", "==", query.cusip);
  if (query.security_type) {
    q = q.where("security_type", "==", query.security_type);
  }
  if (query.reopening !== undefined) {
    q = q.where("reopening", "==", query.reopening);
  }
  if (query.min_offering_amount !== undefined) {
    q = q.where("offering_amount", ">=", query.min_offering_amount);
  }
  if (query.min_bid_to_cover !== undefined) {
    q = q.where("bid_to_cover_ratio", ">=", query.min_bid_to_cover);
  }

  const sortField = query.sort_by ?? "auction_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  q = q.limit(userLimit + 1);

  const snap = await q.get();
  const docs = snap.docs.map((d) => d.data() as TreasuryAuction);

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "treasury_auctions");
}

export async function saveTreasuryAuctions(
  auctions: TreasuryAuction[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "treasury_auctions";
  if (auctions.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < auctions.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = auctions.slice(i, i + BATCH_SIZE);
    for (const auction of chunk) {
      batch.set(collection.doc(auction.id), auction, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Legislators (bioguide catalog) query ─────────────────────────────────

export async function queryLegislators(
  query: LegislatorQuery,
): Promise<QueryResult<Legislator>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("legislators");

  if (query.bioguide_id) {
    // Direct doc lookup is fastest path when bioguide_id is set.
    const doc = await db.collection("legislators").doc(query.bioguide_id).get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as Legislator], has_more: false };
  }

  if (query.state) q = q.where("state", "==", query.state);
  if (query.chamber) q = q.where("chamber", "==", query.chamber);
  if (query.party) q = q.where("party", "==", query.party);

  const userLimit = query.limit ?? 50;

  // member_name and committee_id both need post-filter handling — pull a
  // larger window so the substring/array-contains filter sees the full set.
  // 600 ceiling is enough for v1 (~540 current legislators).
  const needsClientFilter = query.member_name || query.committee_id;
  const fetchLimit = needsClientFilter ? 600 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Legislator);

  if (query.member_name) {
    const needle = query.member_name.toLowerCase();
    docs = docs.filter((l) => matchesSubstringSafe(l.full_name, needle));
  }

  if (query.committee_id) {
    const code = query.committee_id.toUpperCase();
    docs = docs.filter((l) =>
      (l.committee_assignments ?? []).some(
        (a) => a.committee_id.toUpperCase() === code,
      ),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "legislators");
}

/**
 * Save the bioguide catalog to Firestore. Doc IDs are bioguide_id
 * (e.g., "C001035"). Idempotent — re-running the ingestion overwrites
 * cleanly with merge:true semantics.
 */
export async function saveLegislators(
  legislators: Legislator[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "legislators";
  if (legislators.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < legislators.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = legislators.slice(i, i + BATCH_SIZE);
    for (const legislator of chunk) {
      batch.set(collection.doc(legislator.bioguide_id), legislator, {
        merge: true,
      });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

/**
 * Lightweight Firestore connection check — fetches the Firestore project ID
 * and runs a no-op read against a sentinel collection. Returns project info
 * on success; throws on auth/connectivity failures with a useful message.
 *
 * Used by the `tsx src/scrape.ts ping` CLI command to verify credentials are
 * working before spending time on a real scrape run.
 */
export async function pingFirestore(): Promise<{
  mode: "live" | "stub";
  projectId?: string;
  collectionsSeen?: number;
}> {
  if (isStubMode()) {
    return { mode: "stub" };
  }
  const db = await getLiveDb();
  // listCollections returns top-level collections — fast, free metadata read
  const collections = await db.listCollections();
  const projectId =
    (db as unknown as { projectId?: string; _projectId?: string }).projectId ??
    (db as unknown as { projectId?: string; _projectId?: string })._projectId;
  return {
    mode: "live",
    ...(projectId !== undefined ? { projectId } : {}),
    collectionsSeen: collections.length,
  };
}

// ─── Form 278 (Annual Financial Disclosure) query + save ──────────────────

export async function queryForm278Filings(
  query: Form278FilingsQuery,
): Promise<QueryResult<Form278Filing>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("annual_financial_disclosures");

  if (query.bioguide_id) q = q.where("bioguide_id", "==", query.bioguide_id);
  if (query.chamber) q = q.where("chamber", "==", query.chamber);
  if (query.state) q = q.where("state", "==", query.state);
  if (query.party) q = q.where("party", "==", query.party);
  if (query.filing_year !== undefined) {
    q = q.where("filing_year", "==", query.filing_year);
  }
  if (query.report_type) q = q.where("report_type", "==", query.report_type);

  const sortField = query.sort_by ?? "filing_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  const fetchLimit = query.member_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Form278Filing);

  if (query.member_name) {
    const needle = query.member_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.member_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "annual_financial_disclosures");
}

/**
 * Save scraped Form 278 filings to Firestore. Idempotent — re-running the
 * scraper writes the same doc IDs (`{filing_id}` already namespaces by
 * source + subtype, e.g. `senate-annual-abc-123`).
 */
export async function saveForm278Filings(
  filings: Form278Filing[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "annual_financial_disclosures";
  if (filings.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  // Same enrichment posture as saveCongressionalTrades (Greg's 2026-05-22
  // audit): Form 278 records were going in with bioguide_id="" + party=""
  // on 100% of rows (1,882 of 1,882 blank). Wire the same in-memory
  // resolver into the write path so every new save auto-resolves.
  let toWrite = filings;
  try {
    toWrite = await enrichForm278WithBioguide(filings);
    const filled = toWrite.filter(
      (f, i) => !filings[i]?.bioguide_id && f.bioguide_id,
    ).length;
    if (filled > 0) {
      console.error(
        `[saveForm278Filings] bioguide enrichment: ${filled}/${filings.length} resolved`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[saveForm278Filings] bioguide enrichment FAILED — saving raw rows. ${msg}`,
    );
  }

  for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = toWrite.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.filing_id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Form 278 bioguide enrichment (parallel to congressional_trades) ─────
//
// Form 278 filings carry the same member_first / member_last / chamber /
// state fields as congressional_trades, so the same 4-tier resolver maps
// cleanly. Reuses buildBioguideLookups() (shared cache) and a Form278-
// specific shim around resolveTradeBioguide() that adapts the record shape.
async function enrichForm278WithBioguide(
  filings: Form278Filing[],
): Promise<Form278Filing[]> {
  if (filings.length === 0) return filings;
  const lookups = await buildBioguideLookups();
  return filings.map((f) => {
    if (f.bioguide_id) return f;
    // Adapt Form278Filing shape to the trade-shape the resolver expects.
    const adapted = {
      chamber: f.chamber,
      state: f.state,
      member_first: f.member_first,
      member_last: f.member_last,
      transaction_date: f.filing_date, // filing_date is the best in-office anchor we have
      disclosure_date: f.filing_date,
    } as CongressionalTrade;
    const bg = resolveTradeBioguide(adapted, lookups);
    if (!bg) return f;
    const info = lookups.bioguideToInfo[bg];
    return {
      ...f,
      bioguide_id: bg,
      party: f.party || info?.party || "",
      state: f.state || info?.state || "",
    };
  });
}

/**
 * One-shot back-fill: walks every annual_financial_disclosures row, runs
 * the 4-tier bioguide resolver, writes bioguide_id + party + state on
 * matches. Idempotent (already-set rows skipped). Same shape as
 * backfillBioguideIds for congressional_trades.
 *
 * Invoked from CLI: `npx tsx src/scrape.ts backfill-form278-bioguide`.
 */
export async function backfillForm278Bioguide(
  options: { dryRun?: boolean } = {},
): Promise<{
  total: number;
  matched: number;
  already_set: number;
  unmatched: number;
  written: number;
}> {
  if (isStubMode()) {
    throw new Error(
      "backfillForm278Bioguide requires LIVE mode (no service account)",
    );
  }
  const dryRun = options.dryRun ?? false;
  const db = await getLiveDb();
  const lookups = await buildBioguideLookups();
  const snap = await db.collection("annual_financial_disclosures").get();

  let matched = 0;
  let alreadySet = 0;
  let unmatched = 0;
  const updates: Array<{
    docId: string;
    bioguide_id: string;
    party: string;
    state: string;
  }> = [];

  for (const doc of snap.docs) {
    const f = doc.data() as Form278Filing;
    if (f.bioguide_id) {
      alreadySet++;
      continue;
    }
    const adapted = {
      chamber: f.chamber,
      state: f.state,
      member_first: f.member_first,
      member_last: f.member_last,
      transaction_date: f.filing_date,
      disclosure_date: f.filing_date,
    } as CongressionalTrade;
    const bg = resolveTradeBioguide(adapted, lookups);
    if (!bg) {
      unmatched++;
      continue;
    }
    matched++;
    const info = lookups.bioguideToInfo[bg];
    updates.push({
      docId: doc.id,
      bioguide_id: bg,
      party: f.party || info?.party || "",
      state: f.state || info?.state || "",
    });
  }

  console.error(
    `[backfill-form278] ${snap.size} filings: ${matched} matchable, ${unmatched} unmatched, ${alreadySet} already set`,
  );

  let written = 0;
  if (!dryRun && updates.length > 0) {
    const collection = db.collection("annual_financial_disclosures");
    const BATCH_SIZE = 400;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = updates.slice(i, i + BATCH_SIZE);
      for (const u of chunk) {
        batch.update(collection.doc(u.docId), {
          bioguide_id: u.bioguide_id,
          ...(u.party ? { party: u.party } : {}),
          ...(u.state ? { state: u.state } : {}),
        });
      }
      await batch.commit();
      written += chunk.length;
      console.error(`[backfill-form278] Wrote ${written}/${updates.length}...`);
    }
  }

  return {
    total: snap.size,
    matched,
    already_set: alreadySet,
    unmatched,
    written,
  };
}

// ─── Federal Register documents query + save ─────────────────────────────

export async function queryFederalRegisterDocuments(
  query: FederalRegisterDocumentsQuery,
): Promise<QueryResult<FederalRegisterDocument>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.document_number) {
    const doc = await db
      .collection("federal_register_documents")
      .doc(query.document_number)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as FederalRegisterDocument], has_more: false };
  }

  let q: FirestoreQuery = db.collection("federal_register_documents");

  if (query.document_type) {
    q = q.where("document_type", "==", query.document_type);
  }
  if (query.agency_slug) {
    q = q.where("agency_slugs", "array-contains", query.agency_slug);
  }

  const userLimit = query.limit ?? 50;
  const needsClient = query.title || query.text || query.agency_name;
  const fetchLimit = needsClient ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FederalRegisterDocument);

  if (query.title) {
    const needle = query.title.toLowerCase();
    docs = docs.filter((d) => matchesSubstringSafe(d.title, needle));
  }
  if (query.text) {
    const needle = query.text.toLowerCase();
    docs = docs.filter(
      (d) =>
        matchesSubstringSafe(d.title, needle) ||
        matchesSubstringSafe(d.abstract, needle) ||
        matchesSubstringSafe(d.excerpts, needle),
    );
  }
  if (query.agency_name) {
    const needle = query.agency_name.toLowerCase();
    docs = docs.filter((d) =>
      (d.agency_names ?? []).some((n) => matchesSubstringSafe(n, needle)),
    );
  }
  if (query.since) {
    docs = docs.filter((d) => d.publication_date >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((d) => d.publication_date <= query.until!);
  }

  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    if (a.publication_date === b.publication_date) return 0;
    const cmp = a.publication_date < b.publication_date ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "federal_register_documents");
}

export async function saveFederalRegisterDocuments(
  documents: FederalRegisterDocument[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "federal_register_documents";
  if (documents.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = documents.slice(i, i + BATCH_SIZE);
    for (const doc of chunk) {
      batch.set(collection.doc(doc.document_number), doc, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── OFAC SDN (sanctions) query + save ───────────────────────────────────

export async function queryOfacSdn(
  query: OfacSdnQuery,
): Promise<QueryResult<OfacSdnEntry>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.ent_num) {
    const doc = await db.collection("ofac_sdn").doc(query.ent_num).get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as OfacSdnEntry], has_more: false };
  }

  let q: FirestoreQuery = db.collection("ofac_sdn");

  if (query.entity_type) {
    q = q.where("entity_type", "==", query.entity_type.toLowerCase());
  }

  const userLimit = query.limit ?? 50;
  const sortFieldForFetch = query.sort_by ?? "ent_num";
  const hasSubstringFilter = !!(query.name || query.program || query.remarks);
  // Bug #9 fix (2026-05-22): when sorting by `ent_num` (the default sort
  // field), we MUST pull the entire collection before sorting client-side.
  // Reason: doc ID = ent_num is stored as a STRING ("26503"), so Firestore's
  // default document-ID ordering is lexicographic. Without an explicit
  // orderBy clause (we can't use one because ent_num strings sort wrong
  // alphabetically), Firestore returns the first N docs in string order —
  // and our in-memory numeric sort below only sees that subset. Result was
  // a confirmed compliance-grade bug: query "highest ent_num" returned
  // 11598 while a filtered query found 26503 sitting in the same dataset.
  // Bumping fetchLimit to 30000 covers the full OFAC SDN list (~25K
  // currently) so the numeric sort sees every candidate. Long-term fix
  // (v1.1): store an `ent_num_int` numeric companion field and use a real
  // Firestore-side orderBy.
  const fetchLimit =
    hasSubstringFilter || sortFieldForFetch === "ent_num"
      ? 30000
      : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as OfacSdnEntry);

  if (query.name) {
    const needle = query.name.toLowerCase();
    docs = docs.filter((e) => matchesSubstringSafe(e.name, needle));
  }
  if (query.program) {
    const needle = query.program.toLowerCase();
    docs = docs.filter((e) =>
      matchesSubstringSafe(e.program, needle),
    );
  }
  if (query.remarks) {
    const needle = query.remarks.toLowerCase();
    docs = docs.filter((e) =>
      matchesSubstringSafe(e.remarks, needle),
    );
  }

  const sortField = query.sort_by ?? "ent_num";
  const sortOrder = query.sort_order ?? "asc";
  docs.sort((a, b) => {
    let av: string | number = (a as unknown as Record<string, string>)[sortField] ?? "";
    let bv: string | number = (b as unknown as Record<string, string>)[sortField] ?? "";
    // ent_num is a stringified number; sort numerically for sensible order.
    if (sortField === "ent_num") {
      av = parseInt(String(av), 10) || 0;
      bv = parseInt(String(bv), 10) || 0;
    }
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "ofac_sdn");
}

export async function saveOfacSdn(
  entries: OfacSdnEntry[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "ofac_sdn";
  if (entries.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = entries.slice(i, i + BATCH_SIZE);
    for (const entry of chunk) {
      batch.set(collection.doc(entry.ent_num), entry, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
    if (saved % 4000 === 0) {
      console.error(`[firestore]   ofac save progress: ${saved}/${entries.length}`);
    }
  }

  return { saved, collection: COLLECTION };
}

// ─── Registration statements (S-1, S-3) query + save ─────────────────────

export async function queryRegistrationStatements(
  query: RegistrationStatementsQuery,
): Promise<QueryResult<RegistrationStatement>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.filing_id) {
    const doc = await db
      .collection("registration_statements")
      .doc(query.filing_id)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as RegistrationStatement], has_more: false };
  }

  let q: FirestoreQuery = db.collection("registration_statements");

  if (query.filer_cik) {
    q = q.where("filer_cik", "==", query.filer_cik.padStart(10, "0"));
  }
  if (query.filer_ticker) {
    q = q.where("filer_ticker", "==", query.filer_ticker.toUpperCase());
  }
  if (query.filing_type) {
    q = q.where("filing_type", "==", query.filing_type);
  }
  if (query.sec_file_number) {
    q = q.where("sec_file_number", "==", query.sec_file_number);
  }
  // Optional family filters
  if (query.exclude_amendments) {
    q = q.where("is_amendment", "==", false);
  }

  const userLimit = query.limit ?? 50;
  const fetchLimit = query.filer_name ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as RegistrationStatement);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.filer_name, needle),
    );
  }
  // s1_only / s3_only filters are applied client-side to avoid composite index
  if (query.s1_only) {
    docs = docs.filter((r) => r.filing_type.startsWith("S-1"));
  }
  if (query.s3_only) {
    docs = docs.filter((r) => r.filing_type.startsWith("S-3"));
  }
  if (query.since) docs = docs.filter((r) => r.file_date >= query.since!);
  if (query.until) docs = docs.filter((r) => r.file_date <= query.until!);

  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    if (a.file_date === b.file_date) return 0;
    const cmp = a.file_date < b.file_date ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "registration_statements");
}

export async function saveRegistrationStatements(
  filings: RegistrationStatement[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "registration_statements";
  if (filings.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.filing_id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── N-PORT (mutual fund holdings) query + save ──────────────────────────

export async function queryNportFilings(
  query: NportFilingsQuery,
): Promise<QueryResult<NportFiling>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.filing_id) {
    const doc = await db
      .collection("nport_filings")
      .doc(query.filing_id)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as NportFiling], has_more: false };
  }

  let q: FirestoreQuery = db.collection("nport_filings");

  if (query.filer_cik) {
    q = q.where("filer_cik", "==", query.filer_cik.padStart(10, "0"));
  }
  if (query.period_ending) {
    q = q.where("period_ending", "==", query.period_ending);
  }
  if (query.sec_file_number) {
    q = q.where("sec_file_number", "==", query.sec_file_number);
  }
  if (query.is_amendment !== undefined) {
    q = q.where("is_amendment", "==", query.is_amendment);
  }

  const userLimit = query.limit ?? 50;
  const fetchLimit = query.filer_name ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as NportFiling);

  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((f) =>
      matchesSubstringSafe(f.filer_name, needle),
    );
  }
  if (query.since) docs = docs.filter((f) => f.file_date >= query.since!);
  if (query.until) docs = docs.filter((f) => f.file_date <= query.until!);

  const sortField = query.sort_by ?? "file_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string>)[sortField] ?? "";
    const bv = (b as unknown as Record<string, string>)[sortField] ?? "";
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "nport_filings");
}

export async function saveNportFilings(
  filings: NportFiling[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "nport_filings";
  if (filings.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.filing_id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── N-PORT per-holding rows query + save ─────────────────────────────────

export async function queryNportHoldings(
  query: NportHoldingsQuery,
): Promise<QueryResult<NportHolding>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  let q: FirestoreQuery = db.collection("nport_holdings");

  if (query.filing_id) {
    q = q.where("filing_id", "==", query.filing_id);
  }
  if (query.filer_cik) {
    q = q.where("filer_cik", "==", query.filer_cik.padStart(10, "0"));
  }
  if (query.period_ending) {
    q = q.where("period_ending", "==", query.period_ending);
  }
  if (query.cusip) {
    q = q.where("cusip", "==", query.cusip);
  }
  if (query.ticker) {
    q = q.where("ticker", "==", query.ticker.toUpperCase());
  }
  if (query.isin) {
    q = q.where("isin", "==", query.isin);
  }
  if (query.asset_cat) {
    q = q.where("asset_cat", "==", query.asset_cat);
  }
  if (query.is_derivative !== undefined) {
    q = q.where("is_derivative", "==", query.is_derivative);
  }
  if (query.derivative_type) {
    q = q.where("derivative_type", "==", query.derivative_type);
  }
  if (query.country) {
    q = q.where("country", "==", query.country);
  }
  if (query.payoff_profile) {
    q = q.where("payoff_profile", "==", query.payoff_profile);
  }
  if (query.min_value_usd !== undefined) {
    q = q.where("value_usd", ">=", query.min_value_usd);
  }
  if (query.min_pct_of_portfolio !== undefined) {
    q = q.where("pct_of_portfolio", ">=", query.min_pct_of_portfolio);
  }

  const userLimit = query.limit ?? 50;
  // Substring filter on name OR filer_name forces a larger fetch window.
  const usesSubstring = !!(query.name || query.filer_name);
  const fetchLimit = usesSubstring ? 5000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as NportHolding);

  if (query.name) {
    const needle = query.name.toLowerCase();
    docs = docs.filter((h) => matchesSubstringSafe(h.name, needle));
  }
  if (query.filer_name) {
    const needle = query.filer_name.toLowerCase();
    docs = docs.filter((h) =>
      matchesSubstringSafe(h.filer_name, needle),
    );
  }
  if (query.since) {
    docs = docs.filter((h) => h.period_ending >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((h) => h.period_ending <= query.until!);
  }

  const sortField = query.sort_by ?? "value_usd";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, number | string | null>)[
      sortField
    ];
    const bv = (b as unknown as Record<string, number | string | null>)[
      sortField
    ];
    // nulls last
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "nport_holdings");
}

export async function saveNportHoldings(
  holdings: NportHolding[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "nport_holdings";
  if (holdings.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < holdings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = holdings.slice(i, i + BATCH_SIZE);
    for (const h of chunk) {
      batch.set(collection.doc(h.id), h, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Product recalls (FDA + NHTSA + CPSC) query + save ───────────────────

export async function queryProductRecalls(
  query: ProductRecallsQuery,
): Promise<QueryResult<ProductRecall>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.recall_number) {
    // recall_number alone is ambiguous across sources — require source for
    // doc lookup, otherwise fall through to a where query.
    if (query.source) {
      const id = `${query.source}-${query.recall_number}`;
      const doc = await db.collection("product_recalls").doc(id).get();
      if (!doc.exists) return { results: [], has_more: false };
      return {
        results: [doc.data() as ProductRecall],
        has_more: false,
      };
    }
  }

  let q: FirestoreQuery = db.collection("product_recalls");

  if (query.source) q = q.where("source", "==", query.source);
  if (query.recall_number) {
    q = q.where("recall_number", "==", query.recall_number);
  }
  if (query.classification) {
    q = q.where("classification", "==", query.classification);
  }
  if (query.status) {
    q = q.where("status", "==", query.status);
  }
  if (query.vehicle_make) {
    q = q.where("vehicle_make", "==", query.vehicle_make.toUpperCase());
  }

  const sortField = query.sort_by ?? "recall_initiation_date";
  const sortOrder = query.sort_order ?? "desc";

  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  const usesSubstring = !!(
    query.recalling_firm ||
    query.product_description ||
    query.vehicle_model
  );
  const fetchLimit = usesSubstring ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as ProductRecall);

  if (query.recalling_firm) {
    const needle = query.recalling_firm.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.recalling_firm, needle),
    );
  }
  if (query.product_description) {
    const needle = query.product_description.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.product_description, needle),
    );
  }
  if (query.vehicle_model) {
    const needle = query.vehicle_model.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.vehicle_model, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  const base = await withCoverageWarning(
    { results, has_more },
    query,
    "product_recalls",
  );

  // Greg's 2026-05-23 honesty notice: classification is FDA-only
  // (Class I / II / III). CPSC records have classification=null by
  // design (CPSC doesn't use the FDA severity scheme). When the
  // agent filters by classification, the query STRUCTURALLY can't
  // match any CPSC row — so a 0 result without context could read as
  // "no severe recalls exist" when it really means "no FDA recalls
  // matched and CPSC was filtered out by the field choice." Append a
  // notice that augments (doesn't replace) any coverage_warning the
  // standard machinery emitted. Same posture as DEFA14A
  // period_of_report and federal_contracts coverage notes.
  if (query.classification) {
    const note =
      `Note on classification filter: 'classification' is an FDA-only field (Class I / II / III). CPSC records always have classification=null by design (CPSC doesn't use the FDA severity scheme), so this filter excludes all CPSC rows regardless of match. To see CPSC + FDA together, drop the classification filter and post-filter client-side; to focus on the highest-severity FDA recalls only, this filter is correct as-is.`;
    return {
      ...base,
      coverage_warning: base.coverage_warning
        ? `${base.coverage_warning} ${note}`
        : note,
    };
  }

  return base;
}

export async function saveProductRecalls(
  recalls: ProductRecall[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "product_recalls";
  if (recalls.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < recalls.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = recalls.slice(i, i + BATCH_SIZE);
    for (const r of chunk) {
      batch.set(collection.doc(r.id), r, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Government publications (GovInfo) query + save ──────────────────────

export async function queryGovDocuments(
  query: GovDocumentsQuery,
): Promise<QueryResult<GovDocument>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.package_id) {
    const doc = await db
      .collection("gov_documents")
      .doc(query.package_id)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as GovDocument], has_more: false };
  }

  let q: FirestoreQuery = db.collection("gov_documents");
  if (query.collection) q = q.where("collection", "==", query.collection);
  if (query.doc_class) q = q.where("doc_class", "==", query.doc_class);
  if (query.congress) q = q.where("congress", "==", query.congress);

  const sortField = query.sort_by ?? "date_issued";
  const sortOrder = query.sort_order ?? "desc";
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);
  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  const usesSubstring = !!query.title;
  const fetchLimit = usesSubstring ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as GovDocument);

  if (query.title) {
    const needle = query.title.toLowerCase();
    docs = docs.filter((d) =>
      matchesSubstringSafe(d.title, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "gov_documents");
}

export async function saveGovDocuments(
  documents: GovDocument[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "gov_documents";
  if (documents.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = documents.slice(i, i + BATCH_SIZE);
    for (const d of chunk) {
      batch.set(collection.doc(d.id), d, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── FARA — foreign agents (efile.fara.gov) query + save ──────────────────

export async function queryForeignAgents(
  query: ForeignAgentsQuery,
): Promise<QueryResult<ForeignAgent>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("foreign_agents");

  if (query.registration_number) {
    q = q.where("registration_number", "==", query.registration_number);
  }
  if (query.foreign_principal_country) {
    q = q.where(
      "foreign_principal_country",
      "==",
      query.foreign_principal_country.toUpperCase(),
    );
  }
  if (query.has_foreign_principal !== undefined) {
    q = q.where("has_foreign_principal", "==", query.has_foreign_principal);
  }

  const sortField = query.sort_by ?? "registration_date";
  const sortOrder = query.sort_order ?? "desc";
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);
  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);
  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  const usesSubstring = !!(query.registrant_name || query.foreign_principal_name);
  const fetchLimit = usesSubstring ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as ForeignAgent);

  if (query.registrant_name) {
    const needle = query.registrant_name.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.registrant_name, needle),
    );
  }
  if (query.foreign_principal_name) {
    const needle = query.foreign_principal_name.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.foreign_principal_name, needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "foreign_agents");
}

export async function saveForeignAgents(
  agents: ForeignAgent[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "foreign_agents";
  if (agents.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < agents.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = agents.slice(i, i + BATCH_SIZE);
    for (const a of chunk) {
      batch.set(collection.doc(a.id), a, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Consolidated Screening List (api.trade.gov) query + save ─────────────

export async function queryScreeningList(
  query: ScreeningListQuery,
): Promise<QueryResult<ScreeningListEntry>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("screening_list");

  if (query.source_short) {
    q = q.where("source_short", "==", query.source_short.toUpperCase());
  }
  if (query.type) {
    q = q.where("type", "==", query.type);
  }
  if (query.country) {
    q = q.where("countries", "array-contains", query.country.toUpperCase());
  }

  const userLimit = query.limit ?? 50;
  // name + program are client-side filters → pull a wide window.
  const usesClientFilter = !!(query.name || query.program);
  const fetchLimit = usesClientFilter ? 8000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as ScreeningListEntry);

  if (query.name) {
    const needle = query.name.toLowerCase();
    docs = docs.filter((e) => {
      if (matchesSubstringSafe(e.name, needle)) return true;
      return (e.alt_names ?? []).some((n) =>
        matchesSubstringSafe(n, needle),
      );
    });
  }
  if (query.program) {
    const needle = query.program.toLowerCase();
    docs = docs.filter((e) =>
      (e.programs ?? []).some((p) => matchesSubstringSafe(p, needle)),
    );
  }

  const sortOrder = query.sort_order ?? "asc";
  docs.sort((a, b) => {
    const cmp = (a.name ?? "").localeCompare(b.name ?? "");
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "screening_list");
}

export async function saveScreeningList(
  entries: ScreeningListEntry[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "screening_list";
  if (entries.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = entries.slice(i, i + BATCH_SIZE);
    for (const e of chunk) {
      batch.set(collection.doc(e.id), e, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Enforcement actions (SEC + DOJ) query + save ────────────────────────

export async function queryEnforcementActions(
  query: EnforcementActionsQuery,
): Promise<QueryResult<EnforcementAction>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.action_id) {
    const doc = await db
      .collection("enforcement_actions")
      .doc(query.action_id)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as EnforcementAction], has_more: false };
  }

  let q: FirestoreQuery = db.collection("enforcement_actions");

  if (query.source) q = q.where("source", "==", query.source);
  if (query.topic) q = q.where("topics", "array-contains", query.topic);

  const userLimit = query.limit ?? 50;
  const needsClient =
    query.title || query.text || query.agency_component;
  const fetchLimit = needsClient ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as EnforcementAction);

  if (query.title) {
    const needle = query.title.toLowerCase();
    docs = docs.filter((a) => matchesSubstringSafe(a.title, needle));
  }
  if (query.text) {
    const needle = query.text.toLowerCase();
    docs = docs.filter(
      (a) =>
        matchesSubstringSafe(a.title, needle) ||
        matchesSubstringSafe(a.teaser, needle) ||
        matchesSubstringSafe(a.description, needle),
    );
  }
  if (query.agency_component) {
    const needle = query.agency_component.toLowerCase();
    docs = docs.filter((a) =>
      matchesSubstringSafe(a.agency_component, needle),
    );
  }
  if (query.since) docs = docs.filter((a) => a.published_date >= query.since!);
  if (query.until) docs = docs.filter((a) => a.published_date <= query.until!);

  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    if (a.published_date === b.published_date) return 0;
    const cmp = a.published_date < b.published_date ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "enforcement_actions");
}

export async function saveEnforcementActions(
  actions: EnforcementAction[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "enforcement_actions";
  if (actions.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < actions.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = actions.slice(i, i + BATCH_SIZE);
    for (const action of chunk) {
      // action_id may contain hyphens but no slashes; defense-in-depth sanitize.
      const docId = action.action_id.replace(/[/\\#?]+/g, "-").slice(0, 1500);
      batch.set(collection.doc(docId), action, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Form D (private placements) query + save ────────────────────────────

export async function queryPrivatePlacements(
  query: PrivatePlacementsQuery,
): Promise<QueryResult<PrivatePlacement>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.filing_id) {
    const doc = await db
      .collection("private_placements")
      .doc(query.filing_id)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as PrivatePlacement], has_more: false };
  }

  // Type-mismatch guard: private_placements sort_by=total_amount_sold is
  // numeric. since/until apply to date_of_first_sale client-side regardless
  // of sort_by, but combining numeric sort with date filter still produces
  // confusing partial/empty results — fire the standard INVALID_QUERY error
  // so agents get clear feedback rather than a false coverage_warning.
  const sortFieldForGuard = query.sort_by ?? "file_date";
  rejectNumericSortWithDateFilter(sortFieldForGuard, query.since, query.until);

  let q: FirestoreQuery = db.collection("private_placements");

  if (query.issuer_cik) {
    q = q.where("issuer_cik", "==", query.issuer_cik.padStart(10, "0"));
  }
  if (query.issuer_state) {
    q = q.where("issuer_state", "==", query.issuer_state.toUpperCase());
  }
  if (query.is_amendment !== undefined) {
    q = q.where("is_amendment", "==", query.is_amendment);
  }
  if (query.federal_exemption) {
    q = q.where(
      "federal_exemptions",
      "array-contains",
      query.federal_exemption,
    );
  }

  // Client-side sort + substring/range filters.
  const userLimit = query.limit ?? 50;
  const needsClient =
    query.issuer_name ||
    query.industry_group_type ||
    query.investment_fund_type ||
    query.jurisdiction_of_inc;
  const fetchLimit = needsClient ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as PrivatePlacement);

  if (query.issuer_name) {
    const needle = query.issuer_name.toLowerCase();
    docs = docs.filter((p) =>
      matchesSubstringSafe(p.issuer_name, needle),
    );
  }
  if (query.industry_group_type) {
    const needle = query.industry_group_type.toLowerCase();
    docs = docs.filter((p) =>
      matchesSubstringSafe(p.industry_group_type, needle),
    );
  }
  if (query.investment_fund_type) {
    const needle = query.investment_fund_type.toLowerCase();
    docs = docs.filter((p) =>
      matchesSubstringSafe(p.investment_fund_type, needle),
    );
  }
  if (query.jurisdiction_of_inc) {
    const needle = query.jurisdiction_of_inc.toLowerCase();
    docs = docs.filter((p) =>
      matchesSubstringSafe(p.jurisdiction_of_inc, needle),
    );
  }
  if (query.min_amount_sold !== undefined) {
    docs = docs.filter((p) => p.total_amount_sold >= query.min_amount_sold!);
  }
  if (query.since) {
    docs = docs.filter((p) => p.date_of_first_sale >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((p) => p.date_of_first_sale <= query.until!);
  }

  const sortField = query.sort_by ?? "file_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string | number>)[sortField] ?? 0;
    const bv = (b as unknown as Record<string, string | number>)[sortField] ?? 0;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "private_placements");
}

export async function savePrivatePlacements(
  filings: PrivatePlacement[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "private_placements";
  if (filings.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < filings.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = filings.slice(i, i + BATCH_SIZE);
    for (const filing of chunk) {
      batch.set(collection.doc(filing.filing_id), filing, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── FINRA OTC weekly summary query + save ───────────────────────────────

export async function queryOtcMarketWeekly(
  query: OtcMarketWeeklyQuery,
): Promise<QueryResult<OtcMarketWeekly>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.weekly_id) {
    const doc = await db
      .collection("otc_market_weekly")
      .doc(query.weekly_id)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as OtcMarketWeekly], has_more: false };
  }

  // Type-mismatch guard: otc_market_weekly sort fields total_notional_sum /
  // total_weekly_share_quantity / total_weekly_trade_count are numeric.
  // Same client-side filter pattern — fire INVALID_QUERY rather than emit a
  // false coverage_warning when results truncate to empty.
  const sortFieldForGuard = query.sort_by ?? "week_start_date";
  rejectNumericSortWithDateFilter(sortFieldForGuard, query.since, query.until);

  let q: FirestoreQuery = db.collection("otc_market_weekly");

  if (query.issue_symbol) {
    q = q.where("issue_symbol", "==", query.issue_symbol.toUpperCase());
  }
  if (query.mpid) {
    q = q.where("mpid", "==", query.mpid.toUpperCase());
  }
  if (query.week_start_date) {
    q = q.where("week_start_date", "==", query.week_start_date);
  }
  if (query.tier_identifier) {
    q = q.where("tier_identifier", "==", query.tier_identifier.toUpperCase());
  }
  if (query.summary_type_code) {
    q = q.where("summary_type_code", "==", query.summary_type_code);
  }

  // Client-side sort + substring filter (same pattern as other queries).
  const userLimit = query.limit ?? 50;
  const needsClient = query.issue_name || query.market_participant_name;
  const fetchLimit = needsClient ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as OtcMarketWeekly);

  if (query.issue_name) {
    const needle = query.issue_name.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.issue_name, needle),
    );
  }
  if (query.market_participant_name) {
    const needle = query.market_participant_name.toLowerCase();
    docs = docs.filter((r) =>
      matchesSubstringSafe(r.market_participant_name, needle),
    );
  }
  if (query.since) {
    docs = docs.filter((r) => r.week_start_date >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((r) => r.week_start_date <= query.until!);
  }

  const sortField = query.sort_by ?? "week_start_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string | number>)[sortField] ?? 0;
    const bv = (b as unknown as Record<string, string | number>)[sortField] ?? 0;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "otc_market_weekly");
}

export async function saveOtcMarketWeekly(
  rows: OtcMarketWeekly[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "otc_market_weekly";
  if (rows.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = rows.slice(i, i + BATCH_SIZE);
    for (const row of chunk) {
      batch.set(collection.doc(row.weekly_id), row, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
    if (saved % 4000 === 0) {
      console.error(`[firestore]   otc save progress: ${saved}/${rows.length}`);
    }
  }

  return { saved, collection: COLLECTION };
}

// ─── Bills (congress.gov) query + save ───────────────────────────────────

export async function queryBills(
  query: BillsQuery,
): Promise<QueryResult<Bill>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  // Direct lookup by bill_id is fastest.
  if (query.bill_id) {
    const doc = await db.collection("bills").doc(query.bill_id).get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as Bill], has_more: false };
  }

  let q: FirestoreQuery = db.collection("bills");

  if (query.congress !== undefined) {
    q = q.where("congress", "==", query.congress);
  }
  if (query.bill_type) {
    q = q.where("bill_type", "==", query.bill_type.toUpperCase());
  }
  if (query.origin_chamber) {
    q = q.where("origin_chamber", "==", query.origin_chamber);
  }

  // Client-side sort + substring filter (same pattern as FEC / legislators).
  const userLimit = query.limit ?? 50;
  const fetchLimit = query.title ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as Bill);

  if (query.title) {
    const needle = query.title.toLowerCase();
    docs = docs.filter((b) => matchesSubstringSafe(b.title, needle));
  }
  // since/until ALWAYS apply to latest_action_date (the canonical "this bill
  // is currently moving" date). For "when was this bill introduced," use the
  // separate introduced_since / introduced_until filters below — those let
  // callers answer "introduced in the last N months" without conflating
  // recent floor activity with original introduction.
  if (query.since) {
    docs = docs.filter((b) => (b.latest_action_date ?? "") >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((b) => (b.latest_action_date ?? "") <= query.until!);
  }
  if (query.introduced_since) {
    docs = docs.filter(
      (b) => (b.introduction_date ?? "") >= query.introduced_since!,
    );
  }
  if (query.introduced_until) {
    docs = docs.filter(
      (b) => (b.introduction_date ?? "") <= query.introduced_until!,
    );
  }

  const sortField = query.sort_by ?? "latest_action_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string>)[sortField] ?? "";
    const bv = (b as unknown as Record<string, string>)[sortField] ?? "";
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "bills");
}

export async function saveBills(
  bills: Bill[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "bills";
  if (bills.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < bills.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = bills.slice(i, i + BATCH_SIZE);
    for (const bill of chunk) {
      batch.set(collection.doc(bill.bill_id), bill, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Roll-call votes query + save ─────────────────────────────────────────

export async function queryRollCallVotes(
  query: RollCallVotesQuery,
): Promise<QueryResult<RollCallVote>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  if (query.vote_id) {
    const doc = await db.collection("roll_call_votes").doc(query.vote_id).get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as RollCallVote], has_more: false };
  }

  let q: FirestoreQuery = db.collection("roll_call_votes");

  if (query.congress !== undefined) {
    q = q.where("congress", "==", query.congress);
  }
  if (query.session_number !== undefined) {
    q = q.where("session_number", "==", query.session_number);
  }
  if (query.chamber) {
    q = q.where("chamber", "==", query.chamber);
  }
  if (query.bill_id) {
    q = q.where("bill_id", "==", query.bill_id);
  }
  if (query.legislation_type) {
    q = q.where("legislation_type", "==", query.legislation_type.toUpperCase());
  }

  const userLimit = query.limit ?? 50;
  const fetchLimit = query.result ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as RollCallVote);

  if (query.result) {
    const needle = query.result.toLowerCase();
    docs = docs.filter((v) => matchesSubstringSafe(v.result, needle));
  }
  if (query.since) {
    docs = docs.filter((v) => v.start_date >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((v) => v.start_date <= query.until!);
  }

  const sortField = query.sort_by ?? "start_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string>)[sortField] ?? "";
    const bv = (b as unknown as Record<string, string>)[sortField] ?? "";
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "roll_call_votes");
}

export async function saveRollCallVotes(
  votes: RollCallVote[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "roll_call_votes";
  if (votes.length === 0) return { saved: 0, collection: COLLECTION };

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < votes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = votes.slice(i, i + BATCH_SIZE);
    for (const vote of chunk) {
      batch.set(collection.doc(vote.vote_id), vote, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── Tender offers (SC TO) query + save ──────────────────────────────────

export async function queryTenderOffers(
  query: TenderOffersQuery,
): Promise<QueryResult<TenderOffer>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();

  // Direct accession lookup is fastest.
  if (query.accession_number) {
    const doc = await db
      .collection("tender_offers")
      .doc(query.accession_number)
      .get();
    if (!doc.exists) return { results: [], has_more: false };
    return { results: [doc.data() as TenderOffer], has_more: false };
  }

  let q: FirestoreQuery = db.collection("tender_offers");

  if (query.target_ticker) {
    q = q.where("target_ticker", "==", query.target_ticker.toUpperCase());
  }
  if (query.target_cik) {
    q = q.where("target_cik", "==", query.target_cik.padStart(10, "0"));
  }
  if (query.bidder_cik) {
    q = q.where("bidder_cik", "==", query.bidder_cik.padStart(10, "0"));
  }
  if (query.form_type) {
    q = q.where("form_type", "==", query.form_type);
  }
  if (query.third_party_only) {
    q = q.where("is_issuer_tender", "==", false);
  } else if (query.issuer_only) {
    q = q.where("is_issuer_tender", "==", true);
  }
  if (query.exclude_amendments) {
    q = q.where("is_amendment", "==", false);
  }

  // Client-side sort + substring filter (same pattern as FEC / legislators).
  const userLimit = query.limit ?? 50;
  const needsClient = query.target_name || query.bidder_name;
  const fetchLimit = needsClient ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as TenderOffer);

  if (query.target_name) {
    const needle = query.target_name.toLowerCase();
    docs = docs.filter((o) =>
      matchesSubstringSafe(o.target_name, needle),
    );
  }
  if (query.bidder_name) {
    const needle = query.bidder_name.toLowerCase();
    docs = docs.filter((o) =>
      matchesSubstringSafe(o.bidder_name, needle),
    );
  }
  if (query.since) docs = docs.filter((o) => o.filing_date >= query.since!);
  if (query.until) docs = docs.filter((o) => o.filing_date <= query.until!);

  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    if (a.filing_date === b.filing_date) return 0;
    const cmp = a.filing_date < b.filing_date ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "tender_offers");
}

export async function saveTenderOffers(
  offers: TenderOffer[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "tender_offers";
  if (offers.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < offers.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = offers.slice(i, i + BATCH_SIZE);
    for (const offer of chunk) {
      // Accession numbers contain hyphens — Firestore doc IDs allow those,
      // but slashes (from /A amendments would be illegal). Accession itself
      // is just numeric+hyphens; safe as-is.
      batch.set(collection.doc(offer.accession_number), offer, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── FEC candidates query + save ──────────────────────────────────────────

export async function queryFecCandidates(
  query: FecCandidateQuery,
): Promise<QueryResult<FecCandidate>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("fec_candidates");

  // Direct candidate_id lookup is the fastest path.
  if (query.candidate_id) {
    const docSnap = await db
      .collection("fec_candidates")
      .doc(query.candidate_id)
      .get();
    if (!docSnap.exists) return { results: [], has_more: false };
    return { results: [docSnap.data() as FecCandidate], has_more: false };
  }

  if (query.office) q = q.where("office", "==", query.office);
  if (query.state) q = q.where("state", "==", query.state);
  if (query.district) q = q.where("district", "==", query.district);
  if (query.party) q = q.where("party", "==", query.party);
  if (query.cycle !== undefined) {
    q = q.where("cycles", "array-contains", query.cycle);
  }
  if (query.active_only) {
    q = q.where("candidate_inactive", "==", false);
  }

  // Sort and substring-filter client-side. The combinations of equality
  // filters (office × state × party × district × cycle × active_only) blow
  // up the composite-index space if we also orderBy server-side; for a
  // ~10K-row collection a client-side sort on a bounded fetch window is
  // fast and avoids the composite-index combinatorics. Same pattern as
  // queryLegislators.
  const userLimit = query.limit ?? 50;
  const fetchLimit = query.candidate_name ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FecCandidate);

  if (query.candidate_name) {
    const needle = query.candidate_name.toLowerCase();
    docs = docs.filter((c) => matchesSubstringSafe(c.name, needle));
  }

  const sortField = query.sort_by ?? "last_file_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string | number | null>)[sortField] ?? "";
    const bv = (b as unknown as Record<string, string | number | null>)[sortField] ?? "";
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "fec_candidates");
}

/**
 * Save scraped FEC candidates to Firestore. Idempotent — candidate_id is
 * the immutable FEC-assigned key, so re-runs upsert cleanly with merge:true.
 */
export async function saveFecCandidates(
  candidates: FecCandidate[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "fec_candidates";
  if (candidates.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = candidates.slice(i, i + BATCH_SIZE);
    for (const candidate of chunk) {
      batch.set(collection.doc(candidate.candidate_id), candidate, {
        merge: true,
      });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── FEC committees query + save ──────────────────────────────────────────

export async function queryFecCommittees(
  query: FecCommitteeQuery,
): Promise<QueryResult<FecCommittee>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("fec_committees");

  // Direct committee_id lookup is the fastest path.
  if (query.committee_id) {
    const docSnap = await db
      .collection("fec_committees")
      .doc(query.committee_id)
      .get();
    if (!docSnap.exists) return { results: [], has_more: false };
    return { results: [docSnap.data() as FecCommittee], has_more: false };
  }

  if (query.committee_type) {
    q = q.where("committee_type", "==", query.committee_type);
  }
  if (query.designation) q = q.where("designation", "==", query.designation);
  if (query.state) q = q.where("state", "==", query.state);
  if (query.party) q = q.where("party", "==", query.party);
  if (query.cycle !== undefined) {
    q = q.where("cycles", "array-contains", query.cycle);
  }
  if (query.candidate_id) {
    q = q.where("candidate_ids", "array-contains", query.candidate_id);
  }

  // Client-side sort + substring filter — same rationale as queryFecCandidates.
  const userLimit = query.limit ?? 50;
  const fetchLimit = query.committee_name ? 2000 : Math.max(userLimit * 4, 500);
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FecCommittee);

  if (query.committee_name) {
    const needle = query.committee_name.toLowerCase();
    docs = docs.filter((c) => matchesSubstringSafe(c.name, needle));
  }

  const sortField = query.sort_by ?? "last_file_date";
  const sortOrder = query.sort_order ?? "desc";
  docs.sort((a, b) => {
    const av = (a as unknown as Record<string, string | number | null>)[sortField] ?? "";
    const bv = (b as unknown as Record<string, string | number | null>)[sortField] ?? "";
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "fec_committees");
}

export async function saveFecCommittees(
  committees: FecCommittee[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "fec_committees";
  if (committees.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < committees.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = committees.slice(i, i + BATCH_SIZE);
    for (const committee of chunk) {
      batch.set(collection.doc(committee.committee_id), committee, {
        merge: true,
      });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── FEC contributions (Schedule A) query + save ──────────────────────────

export async function queryFecContributions(
  query: FecContributionQuery,
): Promise<QueryResult<FecContribution>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("fec_contributions");

  // Direct sub_id lookup is the fastest path.
  if (query.sub_id) {
    const docSnap = await db
      .collection("fec_contributions")
      .doc(query.sub_id)
      .get();
    if (!docSnap.exists) return { results: [], has_more: false };
    return { results: [docSnap.data() as FecContribution], has_more: false };
  }

  // Pick exactly one equality dimension to drive the server-side filter.
  // Schedule A is large; multiple equality+range combos blow up indexes.
  // Priority order: recipient_committee_id → candidate_id → entity_type → state.
  if (query.recipient_committee_id) {
    q = q.where("recipient_committee_id", "==", query.recipient_committee_id);
  } else if (query.candidate_id) {
    q = q.where("candidate_id", "==", query.candidate_id);
  } else if (query.entity_type) {
    q = q.where("entity_type", "==", query.entity_type);
  } else if (query.contributor_state) {
    q = q.where("contributor_state", "==", query.contributor_state);
  }
  if (query.cycle !== undefined) {
    q = q.where("two_year_transaction_period", "==", query.cycle);
  }

  // Server-side sort by date or amount (composite index).
  const sortField = query.sort_by ?? "contribution_receipt_date";
  const sortOrder = query.sort_order ?? "desc";

  // Type-mismatch guard: sort_by=contribution_receipt_amount is numeric;
  // combining with since/until would produce the silent-empty trap.
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);

  // Substring filters (contributor_name, contributor_employer) need a wider
  // pre-fetch window since they're applied client-side.
  const userLimit = query.limit ?? 50;
  const needsSubstring = !!(query.contributor_name || query.contributor_employer);
  const fetchLimit = needsSubstring ? 5000 : Math.max(userLimit * 4, 500);

  try {
    q = q.orderBy(sortField, sortOrder).limit(fetchLimit);
  } catch {
    // Index missing — fall through to client-side sort
    q = q.limit(fetchLimit);
  }

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FecContribution);

  // Client-side filters
  if (query.contributor_name) {
    const needle = query.contributor_name.toLowerCase();
    docs = docs.filter((c) =>
      matchesSubstringSafe(c.contributor_name, needle),
    );
  }
  if (query.contributor_employer) {
    const needle = query.contributor_employer.toLowerCase();
    docs = docs.filter((c) =>
      matchesSubstringSafe(c.contributor_employer, needle),
    );
  }
  if (query.min_amount !== undefined) {
    docs = docs.filter(
      (c) => c.contribution_receipt_amount >= (query.min_amount ?? 0),
    );
  }
  if (query.max_amount !== undefined) {
    docs = docs.filter(
      (c) =>
        c.contribution_receipt_amount <= (query.max_amount ?? Infinity),
    );
  }
  if (query.since) {
    docs = docs.filter(
      (c) => (c.contribution_receipt_date ?? "") >= (query.since ?? ""),
    );
  }
  if (query.until) {
    docs = docs.filter(
      (c) => (c.contribution_receipt_date ?? "") <= (query.until ?? "9999"),
    );
  }
  // Default-true since 2026-05-23 (Greg's "show real money movement by
  // default" call). FEC memoed_subtotal=true rows are payroll-aggregate /
  // receipt-account duplicates that double-count the same dollars across
  // multiple rows — leaving them visible by default inflates top-donor
  // queries (e.g. Doerr's $132K JF RECOUNT memo appearing alongside his
  // real $182K contribution). Power users can opt back in with
  // exclude_memos=false to see the raw memo rows.
  if (query.exclude_memos !== false) {
    docs = docs.filter((c) => c.memoed_subtotal !== true);
  }

  // Client-side resort in case server-side orderBy fell through.
  docs.sort((a, b) => {
    const av =
      sortField === "contribution_receipt_amount"
        ? a.contribution_receipt_amount
        : a.contribution_receipt_date;
    const bv =
      sortField === "contribution_receipt_amount"
        ? b.contribution_receipt_amount
        : b.contribution_receipt_date;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "fec_contributions");
}

/**
 * Save scraped Schedule A contributions to Firestore. Idempotent — sub_id is
 * the immutable FEC-assigned row ID, so re-runs upsert cleanly with merge:true.
 */
export async function saveFecContributions(
  contributions: FecContribution[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "fec_contributions";
  if (contributions.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }

  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < contributions.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = contributions.slice(i, i + BATCH_SIZE);
    for (const contrib of chunk) {
      batch.set(collection.doc(contrib.sub_id), contrib, {
        merge: true,
      });
    }
    await batch.commit();
    saved += chunk.length;
  }

  return { saved, collection: COLLECTION };
}

// ─── FEC independent expenditures (Schedule E) query + save ───────────────

export async function queryFecIndependentExpenditures(
  query: FecIndependentExpenditureQuery,
): Promise<QueryResult<FecIndependentExpenditure>> {
  if (isStubMode()) {
    return { results: [], has_more: false };
  }

  const db = await getLiveDb();
  let q: FirestoreQuery = db.collection("fec_independent_expenditures");

  if (query.sub_id) {
    const docSnap = await db
      .collection("fec_independent_expenditures")
      .doc(query.sub_id)
      .get();
    if (!docSnap.exists) return { results: [], has_more: false };
    return {
      results: [docSnap.data() as FecIndependentExpenditure],
      has_more: false,
    };
  }

  // Pick exactly one server-side equality (priority order).
  if (query.candidate_id) {
    q = q.where("candidate_id", "==", query.candidate_id);
  } else if (query.committee_id) {
    q = q.where("committee_id", "==", query.committee_id);
  } else if (query.support_oppose) {
    q = q.where("support_oppose_indicator", "==", query.support_oppose);
  } else if (query.candidate_office_state) {
    q = q.where("candidate_office_state", "==", query.candidate_office_state);
  }
  if (query.cycle !== undefined) {
    q = q.where("two_year_transaction_period", "==", query.cycle);
  }

  const sortField = query.sort_by ?? "expenditure_date";
  const sortOrder = query.sort_order ?? "desc";

  // Type-mismatch guard: sort_by=expenditure_amount is numeric; combining
  // with since/until would produce the silent-empty trap.
  rejectNumericSortWithDateFilter(sortField, query.since, query.until);

  const userLimit = query.limit ?? 50;
  const needsSubstring = !!(query.payee_name || query.description);
  const fetchLimit = needsSubstring ? 5000 : Math.max(userLimit * 4, 500);

  try {
    q = q.orderBy(sortField, sortOrder).limit(fetchLimit);
  } catch {
    q = q.limit(fetchLimit);
  }

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FecIndependentExpenditure);

  if (query.payee_name) {
    const needle = query.payee_name.toLowerCase();
    docs = docs.filter((c) =>
      matchesSubstringSafe(c.payee_name, needle),
    );
  }
  if (query.description) {
    const needle = query.description.toLowerCase();
    docs = docs.filter((c) =>
      matchesSubstringSafe(c.disbursement_description, needle),
    );
  }
  if (query.support_oppose && !["candidate_id", "committee_id"].some((k) => (query as Record<string, unknown>)[k])) {
    // already filtered server-side
  } else if (query.support_oppose) {
    // Server-side filter wasn't used because candidate_id / committee_id won the slot
    docs = docs.filter((c) => c.support_oppose_indicator === query.support_oppose);
  }
  if (query.min_amount !== undefined) {
    docs = docs.filter(
      (c) => c.expenditure_amount >= (query.min_amount ?? 0),
    );
  }
  if (query.max_amount !== undefined) {
    docs = docs.filter(
      (c) => c.expenditure_amount <= (query.max_amount ?? Infinity),
    );
  }
  if (query.since) {
    docs = docs.filter(
      (c) => (c.expenditure_date ?? "") >= (query.since ?? ""),
    );
  }
  if (query.until) {
    docs = docs.filter(
      (c) => (c.expenditure_date ?? "") <= (query.until ?? "9999"),
    );
  }
  // Default-true since 2026-05-23 (same call as fec_contributions: memo
  // rows double-count the same dollars across multiple rows; default
  // filtering keeps top-spender queries honest. Opt back in with
  // exclude_memos=false for raw memo rows.).
  if (query.exclude_memos !== false) {
    docs = docs.filter((c) => c.memoed_subtotal !== true);
  }

  docs.sort((a, b) => {
    const av =
      sortField === "expenditure_amount"
        ? a.expenditure_amount
        : a.expenditure_date;
    const bv =
      sortField === "expenditure_amount"
        ? b.expenditure_amount
        : b.expenditure_date;
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return await withCoverageWarning({ results, has_more }, query, "fec_independent_expenditures");
}

export async function saveFecIndependentExpenditures(
  ies: FecIndependentExpenditure[],
): Promise<{ saved: number; collection: string }> {
  if (isStubMode()) {
    throw new Error(
      "Cannot save to Firestore in stub mode (no service account at secrets/service-account.json)",
    );
  }
  const COLLECTION = "fec_independent_expenditures";
  if (ies.length === 0) {
    return { saved: 0, collection: COLLECTION };
  }
  const db = await getLiveDb();
  const collection = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let saved = 0;
  for (let i = 0; i < ies.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = ies.slice(i, i + BATCH_SIZE);
    for (const ie of chunk) {
      batch.set(collection.doc(ie.sub_id), ie, { merge: true });
    }
    await batch.commit();
    saved += chunk.length;
  }
  return { saved, collection: COLLECTION };
}

// ─── Stub mode implementation ───────────────────────────────────────────────

function queryInsiderTransactionsStub(
  query: InsiderTransactionsQuery,
): QueryResult<InsiderTransaction> {
  const filtered = STUB_INSIDER_TRADES.filter((t) => {
    if (query.ticker && t.ticker !== query.ticker.toUpperCase()) return false;
    if (query.company_cik && t.company_cik !== query.company_cik) return false;
    if (
      query.officer_name &&
      !t.officer_name
        .toLowerCase()
        .includes(query.officer_name.toLowerCase())
    ) {
      return false;
    }
    if (
      query.transaction_type &&
      t.transaction_type !== query.transaction_type
    ) {
      return false;
    }
    if (
      query.is_derivative !== undefined &&
      t.is_derivative !== query.is_derivative
    ) {
      return false;
    }
    if (
      query.transaction_codes &&
      query.transaction_codes.length > 0 &&
      !query.transaction_codes.includes(t.transaction_code)
    ) {
      return false;
    }
    if (query.min_value !== undefined && t.total_value < query.min_value) {
      return false;
    }
    const sortField = query.sort_by ?? "disclosure_date";
    const dateField =
      sortField === "total_value" ? "disclosure_date" : sortField;
    if (query.since && t[dateField] < query.since) return false;
    if (query.until && t[dateField] > query.until) return false;
    return true;
  });

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";
  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortField];
    const bv = b[sortField];
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortOrder === "desc" ? -cmp : cmp;
  });

  const limit = query.limit ?? 50;
  return {
    results: sorted.slice(0, limit),
    has_more: sorted.length > limit,
  };
}

// ─── Stub data ──────────────────────────────────────────────────────────────

/**
 * Realistic mock Form 4 transactions. Mirrors the schema the runner actually
 * writes to Firestore (see C:\CapitalEdge\run-scraper.js scrapeForm4) plus the
 * fields requested in DATA_REQUIREMENTS_FOR_DASHBOARD.md fix #3 — so when the
 * dashboard ports the standalone scraper's richer field set, the live data
 * matches the stub shape and no client-side parsing changes.
 *
 * Mix of buys/sells and tickers so handlers can be exercised against varied
 * filter combinations without needing live data.
 */
const STUB_INSIDER_TRADES: InsiderTransaction[] = [
  {
    id: "0000320193-26-000071-2026-04-15-S-50000",
    ticker: "AAPL",
    company_name: "Apple Inc.",
    company_cik: "0000320193",
    officer_name: "Timothy D. Cook",
    officer_title: "Chief Executive Officer",
    is_director: false,
    transaction_type: "sell",
    transaction_code: "S",
    security_title: "Common Stock",
    transaction_date: "2026-04-15",
    disclosure_date: "2026-04-17",
    reporting_lag_days: 2,
    shares: 50000,
    price_per_share: 198.42,
    total_value: 9921000,
    shares_owned_after: 3340000,
    acquired_disposed: "D",
    accession_number: "0000320193-26-000071",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000071/",
    data_source: "SEC_EDGAR_FORM4",
    is_derivative: false,
    underlying_security_title: null,
    underlying_security_shares: null,
    conversion_or_exercise_price: null,
  },
  {
    id: "0000320193-26-000068-2026-04-08-S-12500",
    ticker: "AAPL",
    company_name: "Apple Inc.",
    company_cik: "0000320193",
    officer_name: "Luca Maestri",
    officer_title: "Chief Financial Officer",
    is_director: false,
    transaction_type: "sell",
    transaction_code: "S",
    security_title: "Common Stock",
    transaction_date: "2026-04-08",
    disclosure_date: "2026-04-10",
    reporting_lag_days: 2,
    shares: 12500,
    price_per_share: 196.15,
    total_value: 2451875,
    shares_owned_after: 287000,
    acquired_disposed: "D",
    accession_number: "0000320193-26-000068",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/320193/000032019326000068/",
    data_source: "SEC_EDGAR_FORM4",
    is_derivative: false,
    underlying_security_title: null,
    underlying_security_shares: null,
    conversion_or_exercise_price: null,
  },
  {
    id: "0001045810-26-000044-2026-03-22-P-25000",
    ticker: "NVDA",
    company_name: "NVIDIA Corporation",
    company_cik: "0001045810",
    officer_name: "Jen-Hsun Huang",
    officer_title: "President and Chief Executive Officer",
    is_director: true,
    transaction_type: "buy",
    transaction_code: "P",
    security_title: "Common Stock",
    transaction_date: "2026-03-22",
    disclosure_date: "2026-03-24",
    reporting_lag_days: 2,
    shares: 25000,
    price_per_share: 142.78,
    total_value: 3569500,
    shares_owned_after: 87234500,
    acquired_disposed: "A",
    accession_number: "0001045810-26-000044",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000044/",
    data_source: "SEC_EDGAR_FORM4",
    is_derivative: false,
    underlying_security_title: null,
    underlying_security_shares: null,
    conversion_or_exercise_price: null,
  },
  {
    id: "0000789019-26-000128-2026-04-22-S-8000",
    ticker: "MSFT",
    company_name: "Microsoft Corporation",
    company_cik: "0000789019",
    officer_name: "Satya Nadella",
    officer_title: "Chief Executive Officer",
    is_director: true,
    transaction_type: "sell",
    transaction_code: "S",
    security_title: "Common Stock",
    transaction_date: "2026-04-22",
    disclosure_date: "2026-04-24",
    reporting_lag_days: 2,
    shares: 8000,
    price_per_share: 425.6,
    total_value: 3404800,
    shares_owned_after: 794200,
    acquired_disposed: "D",
    accession_number: "0000789019-26-000128",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/789019/000078901926000128/",
    data_source: "SEC_EDGAR_FORM4",
    is_derivative: false,
    underlying_security_title: null,
    underlying_security_shares: null,
    conversion_or_exercise_price: null,
  },
  {
    id: "0001045810-26-000041-2026-02-14-P-100000",
    ticker: "NVDA",
    company_name: "NVIDIA Corporation",
    company_cik: "0001045810",
    officer_name: "Mark A. Stevens",
    officer_title: "Director",
    is_director: true,
    transaction_type: "buy",
    transaction_code: "P",
    security_title: "Common Stock",
    transaction_date: "2026-02-14",
    disclosure_date: "2026-02-18",
    reporting_lag_days: 2,
    shares: 100000,
    price_per_share: 138.05,
    total_value: 13805000,
    shares_owned_after: 412000,
    acquired_disposed: "A",
    accession_number: "0001045810-26-000041",
    sec_filing_url:
      "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000041/",
    data_source: "SEC_EDGAR_FORM4",
    is_derivative: false,
    underlying_security_title: null,
    underlying_security_shares: null,
    conversion_or_exercise_price: null,
  },
];
