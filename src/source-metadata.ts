/**
 * Phase 2b — Read-Time Source-Metadata Shim
 *
 * Annotates response rows with `source_metadata` flags identifying known
 * SEC-source data quirks (the 2050 perpetual-instrument sentinel and the
 * anomalous-year filer-entry pattern) so agents reading raw values can
 * interpret them correctly.
 *
 * Design spec (LOCKED in version control): docs/phase-2b-read-time-shim-design.md
 * (commit c95364c). The spec is the source of truth for design decisions;
 * this file is its rendering into code.
 *
 * Pairs with Phase 2a (commit c4c1192) which documented the same SEC
 * conventions in human-readable tool description text. Phase 2a explains;
 * Phase 2b makes the same interpretation machine-readable.
 *
 * Principle enforced in code: KeyVex mirrors SEC's bytes exactly; the
 * interpretation lives at the response boundary as labeled metadata;
 * a customer auditing KeyVex against EDGAR finds a byte-for-byte match.
 * NEVER REPLACE, ALWAYS ANNOTATE.
 *
 * ──────────────────────────────────────────────────────────────────────
 * NO-WRITE ATTESTATION
 * ──────────────────────────────────────────────────────────────────────
 * This file is a pure-function read-time annotator. Strictly:
 *
 *   - No imports from src/firestore.ts, firebase-admin, getLiveDb, or any
 *     Firestore-bearing module. Verified by mechanical grep at commit time.
 *   - No network calls. No file I/O. No shared mutable state.
 *   - No mutation of input rows' existing fields. transaction_date,
 *     exercise_date, expiration_date, period_of_report, filing_date, and
 *     every other field on the input row are NEVER modified, replaced,
 *     normalized, or null-substituted. The shim emits a NEW object via
 *     spread (`{ ...row, source_metadata: ... }`) only when at least one
 *     detection rule fires on the row; otherwise returns the input row
 *     unchanged by reference.
 *   - No precomputed metadata stored in Firestore. Detection runs at read
 *     time, every time, on the in-memory result set.
 *
 * The following methods are NEVER called from this file. Grep to confirm:
 *   .set(  .update(  .delete(  .create(  .batch(
 *   FieldValue.delete  FieldValue.increment  FieldValue.arrayUnion
 *   firestore().writeBulk  firestore().bulkWriter  WriteBatch
 * ──────────────────────────────────────────────────────────────────────
 *
 * Three small reconciliations from the spec drafting, captured here as
 * a note rather than spec-revised (per Greg's "honesty over polish"
 * recommendation; spec stays as it was committed):
 *
 *   A. The spec's Q4 type union listed `anomalous_year_likely_filer_entry`
 *      twice (once for active fields, once for the parked period_of_report
 *      case). Doc-side typo only — TypeScript would dedupe. Rendered here
 *      as three distinct strings with field-coverage documented per flag.
 *
 *   B. The spec's implementation-outline step 4 referenced "dynamic
 *      threshold" boundary tests, which was draft phrasing from the
 *      rejected dynamic-threshold approach. Q3 was revised to STATIC
 *      thresholds; the test file (tests/source-metadata.test.ts) targets
 *      the static values (2027-01-01, 1990-01-01, 2050 sentinels).
 *
 *   C. Step 7 (the tool-description follow-on edit in
 *      src/tools/insider-transactions.ts) ships in the SAME COMMIT as
 *      this shim — not a separate follow-up — so 2a never promised
 *      behavior that didn't exist, and the deploy moment is coherent.
 */

import type { InsiderTransactionV2 } from "./types.js";
import type { InsiderTransactionV2Compat } from "./tools/insider-transactions-v2-shim.js";
import type { InsiderTransaction } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One flag, labeling KeyVex's interpretation of a SEC-source quirk on a
 * specific field of a row. The flag value carries the confidence register
 * in its identifier — assertive strings (e.g. `sec_perpetual_sentinel`)
 * encode a fact about SEC's schema; calibrated strings (e.g.
 * `anomalous_year_likely_filer_entry`) carry "likely" so an agent reading
 * the flag knows the cause is inferred from a pattern, not certified.
 */
export type SourceMetadataFlag =
  /**
   * Assertive — exact-string match on a known SEC perpetual-instrument
   * sentinel. The value (e.g. 2050-12-31) is SEC's documented convention
   * for "no calendar expiration" on perpetual derivatives (DSUs, certain
   * NQ Stock Options, Units of Limited Partnership Interest, similar
   * condition-vested instruments). Applies to: exercise_date, expiration_date.
   */
  | "sec_perpetual_sentinel"
  /**
   * Calibrated — date year is outside the plausible range. Spot-check
   * verified these are filer data-entry typos (2-digit years entered into
   * a 4-digit field; single-digit transpositions) preserved verbatim from
   * SEC's authoritative primary filings (22/22 byte-match on stratified
   * sample; see Amendment 2 of docs/handoff-phase-a-v4-count-check-arc-
   * 2026-05-25.md). Applies to: transaction_date, exercise_date,
   * expiration_date (Phase 2b initial); period_of_report (Phase 2b
   * extension, designed-for, not active in initial ship).
   */
  | "anomalous_year_likely_filer_entry"
  /**
   * Calibrated — a required field is missing where the schema expects it.
   * Designed-for-not-built in Phase 2b initial; covers the 6 insider_trades
   * rows with no filing_date as the first use case. NOT active in the
   * initial 2b ship — the rule's first activation is a small Phase 2b.1
   * follow-on commit.
   */
  | "missing_required_field";

/**
 * One row's source_metadata block. Keyed by field name, with an array of
 * flag strings per field. Arrays (not singletons) so a field can carry
 * multiple flags simultaneously if a future pattern adds that case.
 *
 * Q5 from the spec: a row with NO flags on any field receives NO
 * `source_metadata` field at all — presence is the signal. Absence of
 * `source_metadata` means "no SEC source quirks detected," NOT "certified
 * clean by audit" — agents weigh the difference.
 */
export type SourceMetadataFlags = Record<string, SourceMetadataFlag[]>;

// ─── Detection rules ────────────────────────────────────────────────────────

/**
 * Step 1 — SEC perpetual-instrument sentinel strings (exact-string match,
 * assertive). Applies to exercise_date and expiration_date only.
 *
 * Extensible: if other SEC perpetual-instrument sentinel strings surface
 * in ongoing operation (other "no expiration" date-shapes), add them here.
 * NOT a year-range match: a 2050-but-not-listed-string date (e.g.,
 * "2050-06-15") falls through to Step 2 and gets the calibrated
 * anomalous-year flag instead of being mis-labeled as a sentinel.
 */
const SENTINEL_STRINGS = new Set<string>([
  "2050-12-31", // most common — "no expiration" on DSUs, perpetual derivatives
  "2050-08-31", // observed on certain NQ Stock Options
]);

/**
 * Step 2 — Ancient floor. Older than this = filer data-entry typo
 * (pre-EDGAR-electronic era; SEC's electronic filing predates 1990 only
 * marginally). Universal across all date fields; not time-relative,
 * never drifts.
 */
const ANCIENT_FLOOR = "1990-01-01";

/**
 * Step 2 — Field-aware future thresholds. STATIC (not dynamic) per Q3's
 * resolution. The static threshold matches the recount-validated values
 * exactly. Reviewed annually per the spec's "Periodic review cadence"
 * note (Q3, lines 124 of c95364c) — bumped when the current year
 * approaches threshold − 2, with the new value at least 3 years forward.
 *
 * Why static, not dynamic (`currentYear + 2`): a dynamic threshold makes
 * the shim's flagging behavior change silently with wall-clock time —
 * response shape mutates non-deterministically across time, audit traces
 * diverge, unit tests pinned at one date fail later for non-bug reasons.
 * Static + periodic-review keeps the shim deterministic; the cost (a
 * legitimate near-future transaction_date getting the "likely filer
 * entry" flag) is bounded soft-miss, calibrated by the flag's identifier.
 */
const FUTURE_THRESHOLDS: Readonly<Record<string, string>> = {
  transaction_date: "2027-01-01",
  exercise_date: "2050-01-01",
  expiration_date: "2050-01-01",
};

/**
 * Fields the shim checks on each row. The intersection of "date fields
 * that can carry SEC-source quirks" and "fields populated on the row
 * types returned to clients."
 *
 * NOT included in Phase 2b initial:
 *   - period_of_report (Phase 2b extension — same anomalous-year rule,
 *     just applied to a different field; namespace already accommodates).
 *   - filing_date missing (Phase 2b extension — missing_required_field
 *     flag for the 6 insider_trades rows; namespace already accommodates).
 */
const DETECT_FIELDS = [
  "transaction_date",
  "exercise_date",
  "expiration_date",
] as const;

/**
 * Fields that participate in Step 1 (sentinel-precedence). transaction_date
 * is NOT in this set — SEC's 2050-12-31 sentinel is for "no calendar
 * expiration" on derivatives, not for transactions (which always have a
 * real calendar date when filed).
 */
const SENTINEL_FIELDS = new Set<string>(["exercise_date", "expiration_date"]);

// ─── Annotation (the pure function) ─────────────────────────────────────────

/**
 * Internal: detect flags on a single date-field value. Returns an array of
 * flags (zero, one, or — designed-for-future — more). Pure function.
 */
function detectFieldFlags(
  field: string,
  value: string,
): SourceMetadataFlag[] {
  // Step 1 — sentinel-precedence. If a known sentinel string fires, stop;
  // Step 2 does NOT also flag this field. (A row with exercise_date =
  // "2050-12-31" gets `sec_perpetual_sentinel`, not the calibrated
  // anomalous-year flag — the assertive reading is correct here.)
  if (SENTINEL_FIELDS.has(field) && SENTINEL_STRINGS.has(value)) {
    return ["sec_perpetual_sentinel"];
  }

  // Step 2 — anomalous-year fallthrough (static thresholds, calibrated).
  // The boundary is strict-less-than the ancient floor (value < "1990-01-01")
  // and strict-greater-than the future threshold (value > "2027-01-01"
  // for transaction_date; > "2050-01-01" for exercise_date/expiration_date).
  // Boundary values exactly at the threshold are IN-BOUNDS, not flagged.
  const futureThreshold = FUTURE_THRESHOLDS[field];
  if (value < ANCIENT_FLOOR) {
    return ["anomalous_year_likely_filer_entry"];
  }
  if (futureThreshold && value > futureThreshold) {
    return ["anomalous_year_likely_filer_entry"];
  }
  return [];
}

/**
 * Row-types this shim accepts. The structural shape is "any object whose
 * detected-fields are string or null/undefined" — covers InsiderTransaction
 * (legacy), InsiderTransactionV2 (raw bulk), and InsiderTransactionV2Compat
 * (the post-backward-compat-shim shape both handlers return).
 */
type AnnotableRow = {
  transaction_date?: string | null;
  exercise_date?: string | null;
  expiration_date?: string | null;
};

/**
 * Annotate a single row. Returns the input row by reference if no flags
 * fire (Q5: no source_metadata field on clean rows). Otherwise returns
 * a NEW object via spread, with the input row's existing fields untouched
 * and a `source_metadata` field added.
 */
function annotateRow<T extends AnnotableRow>(
  row: T,
): T | (T & { source_metadata: SourceMetadataFlags }) {
  const flags: SourceMetadataFlags = {};
  for (const field of DETECT_FIELDS) {
    const value = row[field];
    if (typeof value !== "string" || value === "") continue;
    const fieldFlags = detectFieldFlags(field, value);
    if (fieldFlags.length > 0) {
      flags[field] = fieldFlags;
    }
  }
  // Q5: omit source_metadata field entirely on clean rows. Presence is
  // the signal; an agent's `if (row.source_metadata)` works directly.
  if (Object.keys(flags).length === 0) return row;
  return { ...row, source_metadata: flags };
}

/**
 * Public entry point. Annotate every row in an array. Read-time only,
 * no Firestore I/O, no input-row mutation. Returns a NEW array via .map();
 * each element is either the original row (clean) or a new shallow-copy
 * with source_metadata added (flagged).
 *
 * Called from the response-assembly point in both branch handlers of
 * `get_insider_transactions` (handleV2 + handleLegacy) — single source
 * of truth so a future detection-rule revision lands in one place, not
 * across two parallel inline implementations (the same lesson Axis-7
 * Issue A taught for the substring filter).
 */
export function annotateRowsSourceMetadata<T extends AnnotableRow>(
  rows: T[],
): Array<T | (T & { source_metadata: SourceMetadataFlags })> {
  return rows.map((row) => annotateRow(row));
}

// ─── Type-safety witnesses for the call-site contracts ─────────────────────
// The shim accepts any AnnotableRow. The concrete row types from the v2
// and legacy paths satisfy the constraint — these type-only references
// document that contract without adding runtime cost. If a row interface
// changes such that the detect-fields no longer match, TypeScript will
// catch it here.
type _LegacySatisfies = InsiderTransaction extends AnnotableRow ? true : false;
type _V2RawSatisfies = InsiderTransactionV2 extends AnnotableRow ? true : false;
type _V2CompatSatisfies = InsiderTransactionV2Compat extends AnnotableRow
  ? true
  : false;
// Stub variables to keep the unused-type warnings quiet; these compile out.
const _typecheck: {
  legacy: _LegacySatisfies;
  v2Raw: _V2RawSatisfies;
  v2Compat: _V2CompatSatisfies;
} = { legacy: true, v2Raw: true, v2Compat: true };
void _typecheck;
