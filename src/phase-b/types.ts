/**
 * Phase B — Sync Queue + Heal Worker types.
 *
 * Authoritative shapes for the `/sync_queue/{entry_id}` Firestore collection
 * and the heal-worker command surface. Mirrors the spec in
 * `docs/architecture-phase-b-sync-queue.md` — drift between this file and
 * that doc is a bug.
 *
 * Phase B is INERT as of 2026-05-25. No code in this file writes to
 * Firestore or fetches from SEC EDGAR. The types exist so the Index Pass
 * can speak the same vocabulary as the (later, separately-authorized)
 * heal worker.
 */

// ─── Healable categories ────────────────────────────────────────────────────

/**
 * Why a queue entry exists. Drives which heal handler runs.
 *
 * - `13F_COUNT_CHECK_FAILED`: institutional_holdings rows where
 *   `verification_status === "INSUFFICIENT_DATA"`. Heal = re-fetch
 *   `primary_doc.xml` + info table, re-parse, recompare, flip VERIFIED
 *   when counts agree.
 * - `13F_POSITION_CHANGE_UNRESOLVED`: institutional_holdings rows where
 *   `position_change === "INSUFFICIENT_DATA"`. Heal = fetch the prior
 *   quarter's 13F for the same fund_cik (ingest if missing), then
 *   recompute deltas for the current quarter.
 * - `INSIDER_FOOTNOTE_UNRESOLVED`: insider_trades AND insider_transactions_v2
 *   rows where `verification_status === "INSUFFICIENT_DATA"`. Heal =
 *   re-fetch the source Form 4/5 XML + FOOTNOTES table, re-resolve
 *   footnote refs, write resolved text back.
 */
export type HealReason =
  | "13F_COUNT_CHECK_FAILED"
  | "13F_POSITION_CHANGE_UNRESOLVED"
  | "INSIDER_FOOTNOTE_UNRESOLVED";

export type HealTargetCollection =
  | "institutional_holdings"
  | "insider_trades"
  | "insider_transactions_v2";

/**
 * State machine for one queue entry.
 *
 * - `PENDING`: enqueued, no worker has claimed it yet.
 * - `IN_PROGRESS`: a worker has claimed it (atomic claim via
 *   compare-and-swap on `status` + `last_attempted_at`).
 * - `VERIFIED`: heal succeeded; source-collection rows updated; entry can
 *   be archived. NEVER flipped while source rows still carry an
 *   INSUFFICIENT_DATA label — atomicity rule from the architecture doc.
 * - `FAILED_PERMANENT`: hit `max_attempts` (= 3). Surfaces in a daily
 *   summary log. Not retried automatically; a human (or a follow-up
 *   command) decides whether to re-enqueue.
 */
export type HealStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "VERIFIED"
  | "FAILED_PERMANENT";

// ─── Queue entry shape ──────────────────────────────────────────────────────

export interface SyncQueueEntry {
  entry_id: string;

  target_collection: HealTargetCollection;
  heal_reason: HealReason;

  /** Set for filing-level heals (count-check, footnote re-resolve). */
  accession_number?: string;

  /** Set for fund-quarter-level heals (position_change recompute). */
  fund_cik?: string;
  quarter?: string;

  status: HealStatus;

  attempt_count: number;
  max_attempts: number;
  last_attempted_at?: string; // ISO-8601
  last_error?: string;
  backoff_until?: string; // ISO-8601

  created_at: string; // ISO-8601
  resolved_at?: string; // ISO-8601

  /** How many rows in target_collection this entry will heal (informational). */
  affected_row_count: number;
}

// ─── Heal-worker command surface ────────────────────────────────────────────

/**
 * Two distinct, independently-gated commands. Per the Phase B doctrine,
 * MEASURE is implicit-authorized (read-only, zero risk); HEAL requires
 * explicit operator invocation AFTER measurement output is reviewed.
 */
export type HealCommand = "measure" | "heal";

/**
 * Compile-time check: the kill switch the heal worker reads before doing
 * anything that touches the network or Firestore. See
 * `src/phase-b/heal-worker.ts` — runtime enforcement lives there.
 */
export interface HealAuthorization {
  command: HealCommand;
  /** Must equal "true" (string) at the env-var level. Any other value
   *  causes the worker to throw before any side effect. */
  HEAL_AUTHORIZED: "true" | undefined;
}

// ─── Measurement output shape (Index Pass) ─────────────────────────────────

/**
 * What the Index Pass prints/returns. Held in memory + printed to chat;
 * NOT written to Firestore on this pass. (Optional JSON-artifact dump
 * planned for the heal pass once authorized.)
 */
export interface IndexPassReport {
  measured_at: string; // ISO-8601

  /** The two hard numbers per Greg's brief. */
  total_records_requiring_heal: number;
  unique_sec_filings_mapped: number;

  /** Row-to-filing compression: total_records / unique_filings. */
  row_to_filing_compression_ratio: number;

  /** Per-category break-down (healable). */
  by_category: Array<{
    heal_reason: HealReason;
    records_in_category: number;
    unique_filings_in_category: number;
    unique_fund_quarters_in_category?: number;
  }>;

  /** NOT heal-fetchable, reported separately for honesty. */
  not_heal_fetchable: {
    insider_transaction_nature_insufficient_data: number;
    note: string;
  };

  /** ETA arithmetic. */
  eta: {
    operational_rate_req_per_sec: number; // = 5 (matches existing 13f.ts guardrail)
    ceiling_rate_req_per_sec: number; // = 10 (SEC fair-access ceiling)
    eta_at_operational_rate_seconds: number;
    eta_at_ceiling_rate_seconds: number;
    eta_at_operational_rate_human: string; // e.g., "1h 22m"
    eta_at_ceiling_rate_human: string;
    rate_choice_rationale: string;
  };

  /** Likely-unhealable break-out, if estimable. */
  likely_unhealable_estimate?: {
    count_estimate: number;
    confidence: "high" | "medium" | "low";
    reasoning: string;
  };
}
