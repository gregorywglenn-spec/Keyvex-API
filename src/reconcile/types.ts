/**
 * KeyVex Reconciliation System — shared types.
 *
 * Implements the framework described in docs/KEYVEX-RECONCILIATION-SYSTEM.md.
 * One generic Reconciler runs ANY dataset; each dataset supplies a small
 * Source Adapter (the ONLY per-dataset code). The Reconciler diffs the
 * authoritative source-id set against what KeyVex holds and produces the
 * three gauges (G1 coverage, G2 correctness, G3 continuous).
 *
 * This file is the contract between the two. Keep adapters thin — everything
 * generic (the Firestore snapshot, the diff, the per-type tally, the missing
 * classification loop) lives in reconciler.ts so it is written once and shared.
 */

/**
 * One unit of the authoritative denominator — a single thing the source says
 * SHOULD exist (e.g. one House PTR filing, one EDGAR accession). `url` is the
 * clickable government link Greg opens to verify; the builder never asserts
 * coverage, Greg confirms it by clicking.
 */
export interface SourceItem {
  /** authoritative id, as it appears in KeyVex's `keyvexIdField` */
  id: string;
  /** clickable government source link for this exact filing */
  url: string;
  /** human label for the report row (member name, issuer, etc.) */
  label?: string;
  /** free-form context used for grouping in the report (e.g. { year }) */
  meta?: Record<string, unknown>;
}

/**
 * Why a source item is absent from KeyVex. The whole point of classification
 * is to drive `unexplained-missing` to zero: every gap is either something we
 * can recover, or a documented reason we legitimately don't have it.
 */
export type MissingClass =
  | "recoverable" // the source doc has real data we failed to ingest — a true gap
  | "nil" // the source doc reports nothing (e.g. "no transactions") — nothing to have
  | "unreadable" // the source doc exists but is corrupt / unparseable
  | "gone" // the source link 404s — the source itself lost it
  | "unclassified"; // not yet fetched/classified (classification is opt-in & costly)

/**
 * Optional Firestore scoping filter so one collection can host multiple
 * adapters (congressional_trades holds both House and Senate; the House
 * adapter scopes to chamber == "house").
 */
export interface KeyvexFilter {
  field: string;
  op: FirebaseFirestore.WhereFilterOp;
  value: unknown;
}

/**
 * The ONLY per-dataset code (target: ~30–50 lines). Supplies the five things
 * the Reconciler needs and nothing else.
 */
export interface SourceAdapter {
  /** machine name, used on the CLI and as the report filename, e.g. "congress-house" */
  name: string;
  /** human title for the report heading */
  title: string;
  /** Firestore collection KeyVex stores this dataset in */
  collection: string;
  /** the field on each KeyVex doc holding the authoritative id (the join key) */
  keyvexIdField: string;
  /** the field holding the transaction/record type (for the per-type census) */
  typeField?: string;
  /**
   * Categories that MUST be present, so a whole class can never silently read
   * zero (the dropped-exchanges failure mode). Reported even when count is 0.
   */
  expectedTypes?: string[];
  /** optional scoping filter when one collection hosts multiple adapters */
  keyvexFilter?: KeyvexFilter;
  /**
   * The authoritative set of ids that SHOULD exist — the denominator.
   * Tolerate per-slice failures by calling `ctx.warn(...)` rather than
   * throwing, so a single bad year doesn't blank the whole census (and the
   * gap is surfaced, never silent).
   */
  sourceIds(ctx: ReconContext): Promise<SourceItem[]>;
  /** clickable government link for one item (fallback when SourceItem.url is empty) */
  sourceUrl(item: SourceItem): string;
  /**
   * Optionally classify ONE missing item by fetching the source doc. Opt-in
   * because it costs a network round-trip per item; when absent, missing items
   * stay "unclassified" and the report says so honestly.
   */
  classifyMissing?(item: SourceItem): Promise<MissingClass>;
}

/** Per-run context handed to the adapter — scope + a warning sink. */
export interface ReconContext {
  /** years to scan (adapters that are year-partitioned use this) */
  years?: number[];
  /** surface a non-fatal problem (e.g. one year's index 404'd) */
  warn(message: string): void;
}

/** Per-type census line for the report. */
export interface TypeCount {
  type: string;
  count: number;
  present: boolean;
  /** true if this type was on the adapter's expectedTypes list */
  expected: boolean;
}

/** The full reconciliation result — what the report renders. */
export interface ReconResult {
  adapter: string;
  title: string;
  collection: string;
  generatedAt: string;
  years?: number[];
  warnings: string[];

  /** denominator */
  sourceTotal: number;
  /** source items grouped by meta.year (or "—") → count, for the by-year table */
  sourceByYear: Record<string, number>;

  /** KeyVex side */
  keyvexIdsPresent: number; // distinct ids that intersect the source set
  keyvexTotalRecords: number; // total docs in the (scoped) collection
  keyvexDistinctIds: number; // distinct ids in KeyVex (may exceed present if some aren't in source)

  /** G1 coverage = (source ∩ keyvex) / source */
  coveragePct: number;

  /** the exact missing list — every source id KeyVex lacks, with links */
  missing: SourceItem[];
  missingByYear: Record<string, number>;

  /** ids KeyVex has that the source set doesn't (informational; may be other years) */
  extraInKeyvexCount: number;
  extraInKeyvexSample: string[];

  /** per-type census (the "no category reads zero" guard) */
  typeCounts: TypeCount[];

  /** present only when classification was run */
  classification?: Record<MissingClass, number>;
  classifiedCount?: number;
  /** missing − (nil + unreadable + gone); target 0. undefined if not fully classified */
  unexplainedMissing?: number;
}
