/**
 * Phase 2b — unit tests for the read-time source-metadata shim.
 *
 * Design spec: docs/phase-2b-read-time-shim-design.md (commit c95364c).
 * Implementation: src/source-metadata.ts.
 *
 * Test framework: Node's built-in `node:test` runner via `tsx --test`
 * (established convention in this project — see also
 * tests/firestore-owner-name-substring.test.ts from Axis-7 Issue A).
 *
 * Run with:
 *   npx tsx --test tests/source-metadata.test.ts
 *
 * What this file covers (per spec step 4, with corrected boundaries against
 * the STATIC thresholds resolved in Q3 — the spec's outline draft language
 * about "dynamic threshold" was a residual from the rejected dynamic
 * approach; corrected here to the static values 2027-01-01 / 1990-01-01
 * / 2050-01-01 + the sentinel-precedence behavior):
 *
 *   - Sentinel detected on exercise_date / expiration_date — assertive flag.
 *   - Sentinel-precedence: a row with exercise_date=2050-12-31 gets
 *     `sec_perpetual_sentinel`, NOT `anomalous_year_likely_filer_entry`,
 *     even though Step 2's >2050-01-01 threshold would otherwise catch it.
 *   - 2050-but-not-sentinel-string (e.g., 2050-06-15) falls through to
 *     Step 2 and gets the calibrated anomalous-year flag.
 *   - 00XX year on transaction_date — anomalous-year detected.
 *   - 00XX year on exercise/expiration — anomalous-year detected (NOT
 *     sentinel; the 00XX year is in the ancient range, not the sentinel).
 *   - 203X year on transaction_date (e.g., 2031 for a 2026 filing) — flagged.
 *   - Clean row → NO source_metadata field at all (Q5: presence is signal).
 *   - Multi-field corrupt row → source_metadata contains multiple field
 *     keys, each with the appropriate flag.
 *   - Boundary cases at the static thresholds:
 *       transaction_date == 2027-01-01  → NO flag (boundary inclusive)
 *       transaction_date == 2027-01-02  → flag fires
 *       transaction_date == 2026-12-31  → NO flag
 *       transaction_date == 1990-01-01  → NO flag (ancient boundary inclusive)
 *       transaction_date == 1989-12-31  → flag fires
 *       exercise_date == 2050-01-01     → NO flag
 *       exercise_date == 2050-12-31     → SENTINEL flag (Step 1 fires)
 *       exercise_date == 2050-06-15     → ANOMALOUS-YEAR flag (Step 2)
 *   - Missing / null / empty-string field values → skipped (no flag).
 *   - Legacy row (only transaction_date present, no exercise/expiration)
 *     → still works correctly.
 *   - Input rows' existing fields are NEVER mutated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotateRowsSourceMetadata,
  type SourceMetadataFlags,
} from "../src/source-metadata.js";

// ─── Fixture helpers ───────────────────────────────────────────────────────

/**
 * Minimal row shape — just the fields the shim reads. The shim is generic
 * over any object with the three date fields optional/nullable, so the
 * tests don't need full InsiderTransaction or InsiderTransactionV2Compat
 * fixtures. (Verified against the real types via type witnesses in
 * src/source-metadata.ts — those compile-time checks confirm the real
 * row types satisfy the AnnotableRow constraint.)
 */
interface TestRow {
  ticker?: string;
  transaction_date?: string | null;
  exercise_date?: string | null;
  expiration_date?: string | null;
  period_of_report?: string | null;
  // Any extra fields just pass through unchanged
  [k: string]: unknown;
}

function row(overrides: Partial<TestRow>): TestRow {
  return { ticker: "TEST", ...overrides };
}

// Helper: assert source_metadata is absent (the field, not just empty)
function assertNoSourceMetadata(annotated: unknown, message?: string): void {
  const obj = annotated as Record<string, unknown>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(obj, "source_metadata"),
    false,
    message ?? "source_metadata field must be absent on clean rows (Q5: presence is signal)",
  );
}

// Helper: get the source_metadata object, asserting it's present
function getSourceMetadata(annotated: unknown): SourceMetadataFlags {
  const obj = annotated as { source_metadata?: SourceMetadataFlags };
  assert.ok(
    obj.source_metadata !== undefined,
    "source_metadata must be present on flagged rows",
  );
  return obj.source_metadata;
}

// ─── Step 1 — Sentinel detection ───────────────────────────────────────────

test("sentinel: exercise_date=2050-12-31 → sec_perpetual_sentinel flag", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ exercise_date: "2050-12-31", transaction_date: "2006-01-04" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(
    meta.exercise_date,
    ["sec_perpetual_sentinel"],
    "exact-string match on 2050-12-31 must produce the assertive sentinel flag",
  );
  // transaction_date is in-range, no flag
  assert.equal(meta.transaction_date, undefined);
});

test("sentinel: expiration_date=2050-12-31 also detected", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ expiration_date: "2050-12-31", transaction_date: "2006-01-04" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.expiration_date, ["sec_perpetual_sentinel"]);
});

test("sentinel: expiration_date=2050-08-31 also detected (second known sentinel)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ expiration_date: "2050-08-31", transaction_date: "2007-11-21" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.expiration_date, ["sec_perpetual_sentinel"]);
});

test("sentinel-precedence: 2050-12-31 gets SENTINEL flag, NOT anomalous-year, even though >2050-01-01", () => {
  // Step 2's >2050-01-01 threshold would also fire on 2050-12-31. The
  // sentinel-precedence rule prevents the calibrated flag from also firing.
  const [annotated] = annotateRowsSourceMetadata([
    row({ exercise_date: "2050-12-31" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(
    meta.exercise_date,
    ["sec_perpetual_sentinel"],
    "must be ONLY sentinel, not [sentinel, anomalous_year] — Step 2 is skipped after Step 1 fires",
  );
});

test("sentinel: transaction_date=2050-12-31 does NOT get sentinel flag (transaction_date is not a sentinel field)", () => {
  // SEC's 2050 sentinel is for "no calendar expiration" on derivatives.
  // Transaction dates always have a real calendar date. A transaction_date
  // of 2050-12-31 is just a way-too-future date → anomalous-year via Step 2.
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "2050-12-31" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(
    meta.transaction_date,
    ["anomalous_year_likely_filer_entry"],
    "transaction_date is not a sentinel field; 2050-12-31 on transaction_date is just way-too-future",
  );
});

test("2050-but-not-sentinel-string (2050-06-15) on exercise_date falls through to Step 2", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ exercise_date: "2050-06-15" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(
    meta.exercise_date,
    ["anomalous_year_likely_filer_entry"],
    "a 2050 date that's NOT in the sentinel string list must fall through to Step 2's anomalous-year flag — exact-string match keeps false-positives at zero",
  );
});

// ─── Step 2 — Anomalous-year detection ─────────────────────────────────────

test("anomalous-year: transaction_date=0012-02-17 (00XX face — 2-digit year typo)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "0012-02-17" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.transaction_date, ["anomalous_year_likely_filer_entry"]);
});

test("anomalous-year: exercise_date=0012-11-21 (00XX on forward field — below ancient floor)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ exercise_date: "0012-11-21" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(
    meta.exercise_date,
    ["anomalous_year_likely_filer_entry"],
    "00XX year on exercise_date is below ancient floor (1990) → anomalous-year, NOT sentinel (the sentinel is only the listed 2050-* strings)",
  );
});

test("anomalous-year: transaction_date=2031-01-29 (203X face — single-digit transposition)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "2031-01-29" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.transaction_date, ["anomalous_year_likely_filer_entry"]);
});

// ─── Q5 — Clean rows get NO source_metadata field ──────────────────────────

test("clean row: no source_metadata field at all (Q5)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({
      transaction_date: "2024-06-04",
      exercise_date: "2030-01-01",
      expiration_date: "2034-01-01",
    }),
  ]);
  assertNoSourceMetadata(annotated);
});

test("clean row: returned BY REFERENCE — same object, no copy", () => {
  // Q5 + read-time-only: clean rows aren't shallow-copied; the original
  // input row is returned. This is an optimization-cum-correctness check —
  // it confirms the shim doesn't allocate on the happy path.
  const inputRow = row({ transaction_date: "2024-06-04" });
  const [annotated] = annotateRowsSourceMetadata([inputRow]);
  assert.strictEqual(
    annotated,
    inputRow,
    "clean rows must be returned by reference (no allocation when no flags fire)",
  );
});

test("clean row: empty / null / undefined date fields are skipped (no flag)", () => {
  const [annotatedEmpty] = annotateRowsSourceMetadata([
    row({ transaction_date: "" }),
  ]);
  assertNoSourceMetadata(annotatedEmpty);

  const [annotatedNull] = annotateRowsSourceMetadata([
    row({ transaction_date: null }),
  ]);
  assertNoSourceMetadata(annotatedNull);

  const [annotatedMissing] = annotateRowsSourceMetadata([row({})]);
  assertNoSourceMetadata(annotatedMissing);
});

// ─── Multi-field corruption ────────────────────────────────────────────────

test("multi-field: transaction + exercise + expiration all corrupt → source_metadata has all 3 keys", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({
      transaction_date: "0012-11-21",
      exercise_date: "0012-11-21",
      expiration_date: "0017-11-21",
    }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta, {
    transaction_date: ["anomalous_year_likely_filer_entry"],
    exercise_date: ["anomalous_year_likely_filer_entry"],
    expiration_date: ["anomalous_year_likely_filer_entry"],
  });
});

test("multi-field: sentinel on exercise/expiration, in-range transaction_date → only the 2 sentinel keys", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({
      transaction_date: "2006-01-04",
      exercise_date: "2050-12-31",
      expiration_date: "2050-12-31",
    }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta, {
    exercise_date: ["sec_perpetual_sentinel"],
    expiration_date: ["sec_perpetual_sentinel"],
  });
  // No transaction_date key — it's in-range, gets no flag, and Q5 implies
  // absent keys for unflagged fields (the parallel of "absent field for
  // unflagged rows" at the row level).
  assert.equal(meta.transaction_date, undefined);
});

// ─── Boundary cases at the STATIC thresholds (per Q3 resolution) ───────────

test("boundary: transaction_date == 2027-01-01 → NO flag (threshold inclusive)", () => {
  // The check is `value > "2027-01-01"`, strict-greater-than. Equal-to is
  // in-range. This is the boundary the periodic-review cadence guards.
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "2027-01-01" }),
  ]);
  assertNoSourceMetadata(annotated);
});

test("boundary: transaction_date == 2027-01-02 → flag fires", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "2027-01-02" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.transaction_date, ["anomalous_year_likely_filer_entry"]);
});

test("boundary: transaction_date == 2026-12-31 → NO flag (below threshold)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "2026-12-31" }),
  ]);
  assertNoSourceMetadata(annotated);
});

test("boundary: transaction_date == 1990-01-01 → NO flag (ancient floor inclusive)", () => {
  // The check is `value < "1990-01-01"`, strict-less-than.
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "1990-01-01" }),
  ]);
  assertNoSourceMetadata(annotated);
});

test("boundary: transaction_date == 1989-12-31 → flag fires", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "1989-12-31" }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.transaction_date, ["anomalous_year_likely_filer_entry"]);
});

test("boundary: exercise_date == 2050-01-01 → NO flag (threshold inclusive)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ exercise_date: "2050-01-01" }),
  ]);
  assertNoSourceMetadata(annotated);
});

// ─── No mutation of input rows ─────────────────────────────────────────────

test("input row's existing fields are NEVER mutated", () => {
  const inputRow: TestRow = {
    ticker: "TEST",
    transaction_date: "0012-11-21",
    exercise_date: "2050-12-31",
    expiration_date: "0017-11-21",
  };
  // Snapshot original values before annotation
  const originalSnapshot = JSON.stringify(inputRow);

  annotateRowsSourceMetadata([inputRow]);

  assert.equal(
    JSON.stringify(inputRow),
    originalSnapshot,
    "annotateRowsSourceMetadata must NEVER modify the input row — pure-publisher guarantee enforced in code",
  );
});

test("flagged row is a NEW object (not the input), so callers can't accidentally observe sentinel-merged state", () => {
  // For flagged rows, annotateRow uses `{ ...row, source_metadata }` —
  // returns a new shallow copy. The original input row stays without
  // source_metadata. Confirms the spec's "additive, optional, never
  // replaces" guarantee even at the object-identity level.
  const inputRow = row({ exercise_date: "2050-12-31" });
  const [annotated] = annotateRowsSourceMetadata([inputRow]);

  assert.notStrictEqual(
    annotated,
    inputRow,
    "flagged rows must be a NEW object, not the input row (additive shallow-copy)",
  );
  assertNoSourceMetadata(
    inputRow,
    "the INPUT row must remain unannotated — only the returned object carries source_metadata",
  );
});

// ─── Batch annotation ──────────────────────────────────────────────────────

test("batch: mixed clean + flagged rows — only the flagged ones carry source_metadata", () => {
  const cleanInput = row({ transaction_date: "2024-06-04" });
  const flaggedInput = row({ exercise_date: "2050-12-31" });
  const [annotatedClean, annotatedFlagged] = annotateRowsSourceMetadata([
    cleanInput,
    flaggedInput,
  ]);
  assertNoSourceMetadata(annotatedClean);
  assert.ok((annotatedFlagged as { source_metadata?: unknown }).source_metadata);
  // Original input rows unchanged
  assertNoSourceMetadata(cleanInput);
  assertNoSourceMetadata(flaggedInput);
});

test("batch: empty array returns empty array", () => {
  const result = annotateRowsSourceMetadata([]);
  assert.equal(result.length, 0);
});

// ─── Legacy row shape (only transaction_date, no exercise/expiration) ──────

test("legacy row shape (only transaction_date present): works correctly", () => {
  // The legacy InsiderTransaction interface has no exercise_date or
  // expiration_date fields. The shim must handle this gracefully.
  const legacyShape: TestRow = {
    ticker: "AAPL",
    transaction_date: "0023-11-14",
    // No exercise_date, no expiration_date
  };
  const [annotated] = annotateRowsSourceMetadata([legacyShape]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta, {
    transaction_date: ["anomalous_year_likely_filer_entry"],
  });
});

// ─── Phase 2b extension — period_of_report coverage ─────────────────────────
// Seven tests pinning the new field's behavior. Same flat test() convention
// as the parent set above; each test names the property it pins.
//
// Population characterization for these representatives is in
// docs/phase-2b-extension-period-of-report-design.md and in the diagnostic
// outputs at .tmp/sample-parked-rows.ts, .tmp/epoch-subpopulation.ts, and
// .tmp/singleton-enum.ts. The values used below are representative of the
// three cause-classes plus the one future-side outlier; per-class row
// counts are deliberately not encoded in the test names.

test("Phase 2b extension: ancient-side period_of_report → anomalous_year_likely_filer_entry flag", () => {
  // 00XX-XX-XX face, representative of Class 2 (filer-side keying typos).
  const [annotated] = annotateRowsSourceMetadata([
    row({
      ticker: "FICO",
      transaction_date: "2019-08-30",
      period_of_report: "0019-08-30",
    }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.period_of_report, ["anomalous_year_likely_filer_entry"]);
});

test("Phase 2b extension: future-side period_of_report (AETRIUM outlier, +20-year transposition)", () => {
  // The one future-side row in the 142-population. Validates that the
  // period_of_report future threshold catches what it should.
  const [annotated] = annotateRowsSourceMetadata([
    row({
      ticker: "ATRM",
      transaction_date: "2010-08-26",
      period_of_report: "2030-08-26",
    }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.period_of_report, ["anomalous_year_likely_filer_entry"]);
});

test("Phase 2b extension: SEC filing-agent default-epoch period_of_report → same calibrated flag", () => {
  // Representative of Class 1 (the architectural finding — single
  // upstream filing-agent toolchain substituting 0001-01-01 across a
  // decade-plus of filings, CIK prefix 0001225208-). Pins that the
  // calibrated flag covers all three cause-classes under one banner by
  // design — the flag's "filer_entry" shorthand encompasses filing-
  // pipeline data quality issues across the upstream-actor stack.
  const [annotated] = annotateRowsSourceMetadata([
    row({
      ticker: "UPS",
      transaction_date: "2014-12-23",
      period_of_report: "0001-01-01",
    }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta.period_of_report, ["anomalous_year_likely_filer_entry"]);
});

test("Phase 2b extension boundary: period_of_report == '1990-01-01' → NO flag (ancient floor strict-less-than)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "1990-01-01", period_of_report: "1990-01-01" }),
  ]);
  assertNoSourceMetadata(annotated);
});

test("Phase 2b extension boundary: period_of_report == '2027-01-01' → NO flag (future threshold strict-greater-than)", () => {
  const [annotated] = annotateRowsSourceMetadata([
    row({ transaction_date: "2026-12-31", period_of_report: "2027-01-01" }),
  ]);
  assertNoSourceMetadata(annotated);
});

test("Phase 2b extension Q5: clean row with period_of_report present → NO source_metadata, returned by reference", () => {
  // Preserves the omit-on-clean rule AND the no-allocation path with the
  // new field present.
  const inputRow = row({
    transaction_date: "2024-03-15",
    period_of_report: "2024-03-15",
  });
  const [annotated] = annotateRowsSourceMetadata([inputRow]);
  assertNoSourceMetadata(annotated);
  assert.strictEqual(annotated, inputRow);
});

test("Phase 2b extension per-field isolation: period_of_report anomalous, transaction_date clean", () => {
  // Pins that the new field is independently detected, not implicitly
  // tied to transaction_date — source_metadata is keyed solely on
  // period_of_report when only period_of_report carries the anomaly.
  const [annotated] = annotateRowsSourceMetadata([
    row({
      transaction_date: "2024-03-15",
      period_of_report: "0024-03-15",
    }),
  ]);
  const meta = getSourceMetadata(annotated);
  assert.deepEqual(meta, {
    period_of_report: ["anomalous_year_likely_filer_entry"],
  });
  assert.equal(meta.transaction_date, undefined);
});
