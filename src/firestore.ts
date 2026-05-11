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
  FecCandidate,
  FecCandidateQuery,
  FecCommittee,
  FecCommitteeQuery,
  FederalContractAward,
  FederalContractAwardsQuery,
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
  if (query.min_value !== undefined) {
    q = q.where("total_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "disclosure_date";
  const sortOrder = query.sort_order ?? "desc";

  // Date-range filters apply to the active sort field
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
      (t.officer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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

  if (query.ticker) q = q.where("ticker", "==", query.ticker);
  if (query.cusip) q = q.where("cusip", "==", query.cusip);
  if (query.fund_cik) q = q.where("fund_cik", "==", query.fund_cik);
  if (query.quarter) q = q.where("quarter", "==", query.quarter);
  if (query.position_change) {
    q = q.where("position_change", "==", query.position_change);
  }
  if (query.min_value !== undefined) {
    q = q.where("market_value", ">=", query.min_value);
  }

  const sortField = query.sort_by ?? "market_value";
  const sortOrder = query.sort_order ?? "desc";
  q = q.orderBy(sortField, sortOrder);

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
      (h.fund_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
      (t.member_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
      (f.filer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
      (f.filer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
      (f.filer_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
  if (query.min_amount !== undefined) {
    q = q.where("award_amount", ">=", query.min_amount);
  }

  const sortField = query.sort_by ?? "last_modified_date";
  const sortOrder = query.sort_order ?? "desc";

  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Same substring-filter consideration as the other collections: when
  // recipient_name (substring) is set, pull a much larger Firestore window
  // so the client-side filter sees the full universe.
  const fetchLimit = query.recipient_name ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as FederalContractAward);

  if (query.recipient_name) {
    const needle = query.recipient_name.toLowerCase();
    docs = docs.filter((c) =>
      (c.recipient_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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

  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;

  // Substring filters (registrant_name, client_name, government_entity) need
  // a wider Firestore window so the post-fetch filter sees the full universe.
  // 5000 ceiling matches other collections.
  const needsClientSideFilter =
    query.registrant_name || query.client_name || query.government_entity;
  const fetchLimit = needsClientSideFilter ? 5000 : userLimit + 1;
  q = q.limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs.map((d) => d.data() as LobbyingFiling);

  if (query.registrant_name) {
    const needle = query.registrant_name.toLowerCase();
    docs = docs.filter((f) =>
      (f.registrant_name ?? "").toLowerCase().includes(needle),
    );
  }
  if (query.client_name) {
    const needle = query.client_name.toLowerCase();
    docs = docs.filter((f) =>
      (f.client_name ?? "").toLowerCase().includes(needle),
    );
  }
  if (query.government_entity) {
    const needle = query.government_entity.toLowerCase();
    docs = docs.filter((f) =>
      (f.government_entities ?? []).some((g) =>
        g.toLowerCase().includes(needle),
      ),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
  const updates: Array<{ docId: string; bioguide_id: string }> = [];

  for (const doc of tradesSnap.docs) {
    const x = doc.data() as {
      member_first?: string;
      member_last?: string;
      state?: string;
      chamber?: string;
      bioguide_id?: string;
      transaction_date?: string;
      disclosure_date?: string;
    };
    if (x.bioguide_id) {
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
  let written = 0;
  if (!dryRun && updates.length > 0) {
    const collection = db.collection("congressional_trades");
    const BATCH_SIZE = 400;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = updates.slice(i, i + BATCH_SIZE);
      for (const u of chunk) {
        batch.update(collection.doc(u.docId), { bioguide_id: u.bioguide_id });
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

  if (query.since) q = q.where(sortField, ">=", query.since);
  if (query.until) q = q.where(sortField, "<=", query.until);

  q = q.orderBy(sortField, sortOrder);

  const userLimit = query.limit ?? 50;
  q = q.limit(userLimit + 1);

  const snap = await q.get();
  const docs = snap.docs.map((d) => d.data() as MaterialEvent);

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
    docs = docs.filter((l) => (l.full_name ?? "").toLowerCase().includes(needle));
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
  return { results, has_more };
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
      (f.member_name ?? "").toLowerCase().includes(needle),
    );
  }

  const has_more = docs.length > userLimit;
  const results = docs.slice(0, userLimit);
  return { results, has_more };
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
    docs = docs.filter((b) => (b.title ?? "").toLowerCase().includes(needle));
  }
  if (query.since) {
    docs = docs.filter((b) => b.latest_action_date >= query.since!);
  }
  if (query.until) {
    docs = docs.filter((b) => b.latest_action_date <= query.until!);
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
  return { results, has_more };
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
    docs = docs.filter((v) => (v.result ?? "").toLowerCase().includes(needle));
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
  return { results, has_more };
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
      (o.target_name ?? "").toLowerCase().includes(needle),
    );
  }
  if (query.bidder_name) {
    const needle = query.bidder_name.toLowerCase();
    docs = docs.filter((o) =>
      (o.bidder_name ?? "").toLowerCase().includes(needle),
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
  return { results, has_more };
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
    docs = docs.filter((c) => (c.name ?? "").toLowerCase().includes(needle));
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
  return { results, has_more };
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
    docs = docs.filter((c) => (c.name ?? "").toLowerCase().includes(needle));
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
  return { results, has_more };
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
  },
];
