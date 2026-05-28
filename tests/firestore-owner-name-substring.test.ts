/**
 * Axis-7 Issue A — unit test for owner-name substring matching.
 *
 * The bug being fixed: `queryInsiderTransactionsV2` substring-filtered on
 * `reporting_owner_name` only (the denormalized primary field), silently
 * missing rows where the searched name appeared as a co-filer in the
 * `reporting_owners[]` array on the same row. Common shape: joint Form 4
 * filings where the primary is a fund entity and the named insider is the
 * second/third owner. Pre-fix: `?reporting_owner_name=Halbower` against a
 * row stored as `{ reporting_owner_name: "Pentwater Capital Management LP",
 * reporting_owners: [{name: "Pentwater..."}, {name: "Halbower Matthew"}] }`
 * returned the row from Firestore (no server-side filter on the name) but
 * then dropped it in the client-side substring filter.
 *
 * This file is the first test in the project repo — the "no tests" gap
 * flagged in the Axis-7 scoping report (no regression baseline anywhere
 * in the serving layer). Test framework: Node's built-in `node:test`
 * runner via `tsx --test` (zero new dev deps; tsx is already a project
 * devDependency, Node 22 is the engine requirement). Run with:
 *
 *   npx tsx --test tests/firestore-owner-name-substring.test.ts
 *
 * Test discipline: the "demonstration mandate" requires this test to
 * fail BEFORE the array-traversal fix and pass AFTER. The toggle is
 * a single line in `matchesOwnerNameSubstring` in src/firestore.ts.
 * Both runs are captured in the stage-and-show.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchesSubstringSafe,
  matchesOwnerNameSubstring,
} from "../src/firestore.js";
import type {
  BulkReportingOwner,
  InsiderTransactionV2,
} from "../src/types.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────
//
// Synthetic InsiderTransactionV2 rows mirroring real production shapes
// (per types.ts:3590-3599 BulkReportingOwner + the InsiderTransactionV2
// interface). Only the fields the substring helper reads are populated
// faithfully; the rest are filled with type-correct placeholders so the
// fixtures compile under strict TS without polluting the test surface.

function ownerStub(overrides: Partial<BulkReportingOwner>): BulkReportingOwner {
  return {
    cik: "0000000000",
    name: "",
    is_director: false,
    is_officer: false,
    is_ten_percent_owner: false,
    is_other: false,
    officer_title: null,
    other_relationship_text: null,
    ...overrides,
  };
}

function rowStub(
  reporting_owner_name: string,
  reporting_owners: BulkReportingOwner[],
): InsiderTransactionV2 {
  return {
    // ─── Identity / provenance ─────
    id: "test-row",
    source: "sec_bulk",
    source_zip: "2024q2_form345.zip",
    schema_era: "2023_plus",
    bulk_loaded_at: "2026-05-26T00:00:00.000Z",
    source_url: "https://www.sec.gov/test",
    // ─── Filing envelope ─────
    accession_number: "0000000000-00-000000",
    filing_date: "2024-06-07",
    period_of_report: "2024-06-07",
    date_of_orig_sub: null,
    document_type: "4",
    is_amendment: false,
    company_cik: "0000000000",
    company_name: "Test Co",
    ticker: "TEST",
    remarks: null,
    no_securities_owned: false,
    not_subject_sec16: false,
    form3_holdings_reported: false,
    form4_trans_reported: true,
    aff10b5one: "0",
    // ─── Reporting-owner block (primary, denormalized) ─────
    reporting_owner_cik: "0000000000",
    reporting_owner_name,
    is_director: false,
    is_officer: false,
    is_ten_percent_owner: false,
    is_other: false,
    officer_title: null,
    other_relationship_text: null,
    reporting_owners,
    // ─── Transaction row ─────
    transaction_type: "nonderiv",
    sk: 1,
    security_title: "Common Stock",
    transaction_date: "2024-06-04",
    deemed_execution_date: null,
    trans_form_type: "4",
    trans_code: "S",
    equity_swap_involved: false,
    trans_timeliness: null,
    trans_shares: 100,
    trans_price_per_share: 10,
    trans_total_value: null,
    trans_acquired_disp_cd: "D",
    direct_indirect_ownership: "D",
    nature_of_ownership: null,
    shrs_owned_following_trans: 0,
    valu_owned_following_trans: null,
    conv_exercise_price: null,
    exercise_date: null,
    expiration_date: null,
    underlying_security_title: null,
    underlying_security_shares: null,
    underlying_security_value: null,
    footnote_refs: [],
  };
}

// Fixture A — primary name carries the searched substring.
// Pre-fix AND post-fix both match. No regression target.
const primaryMatchRow = rowStub(
  "Halbower Matthew",
  [ownerStub({ name: "Halbower Matthew", cik: "0001234567" })],
);

// Fixture B — primary name is a fund entity; the searched person is a
// CO-FILER in reporting_owners[1].name only.  THIS IS THE BUG.
// Pre-fix: missed (substring check on primary returns false).
// Post-fix: matched (array traversal finds the co-filer).
const coFilerOnlyRow = rowStub(
  "Pentwater Capital Management LP",
  [
    ownerStub({ name: "Pentwater Capital Management LP", cik: "0001100000" }),
    ownerStub({ name: "Halbower Matthew", cik: "0001234567" }),
  ],
);

// Fixture C — neither primary nor any co-filer carries the substring.
// Both pre-fix AND post-fix correctly exclude. No false-positive broadening.
const noMatchRow = rowStub(
  "Berkshire Hathaway Inc",
  [
    ownerStub({ name: "Berkshire Hathaway Inc", cik: "0001067983" }),
    ownerStub({ name: "Buffett Warren E", cik: "0000315090" }),
  ],
);

// Fixture D — empty / missing reporting_owners (edge case: rows pre-dating
// the array population). Helper must not throw on null/undefined arrays.
const emptyOwnersRow = rowStub("Halbower Matthew", []);

// ─── Tests ─────────────────────────────────────────────────────────────────

test("baseline: matchesSubstringSafe alone misses co-filers in array (the bug)", () => {
  // Run the OLD direct check — what the pre-fix code did inline at the v2
  // call sites — against the co-filer-only fixture. Asserting FALSE here
  // documents that the bug existed: searching for "halbower" on a row where
  // Halbower lives only in reporting_owners[1].name returns false from the
  // primary-field-only matcher.
  const oldBehavior = matchesSubstringSafe(
    coFilerOnlyRow.reporting_owner_name,
    "halbower",
  );
  assert.equal(
    oldBehavior,
    false,
    "Sanity: the old single-field matcher correctly returns false on the co-filer-only fixture, confirming the bug shape Issue A fixes.",
  );
});

test("fix: matchesOwnerNameSubstring matches co-filer in reporting_owners[]", () => {
  // This is THE assertion that was RED pre-fix and is GREEN post-fix.
  // If the helper's array-traversal line is commented out / missing, this
  // test fails (the array-only co-filer goes unfound). With the traversal
  // in place, it passes.
  assert.equal(
    matchesOwnerNameSubstring(coFilerOnlyRow, "halbower"),
    true,
    "Helper must find the co-filer 'Halbower Matthew' in reporting_owners[1] even though the primary reporting_owner_name is 'Pentwater Capital Management LP'.",
  );
});

test("no regression: primary-name match still returns true", () => {
  // Ensure the fix doesn't break the case that already worked.
  assert.equal(
    matchesOwnerNameSubstring(primaryMatchRow, "halbower"),
    true,
    "A row whose PRIMARY name matches the needle must still match — additive broadening only.",
  );
});

test("no false broadening: needle not present in any name returns false", () => {
  // Ensure the array traversal doesn't accidentally match unrelated rows.
  assert.equal(
    matchesOwnerNameSubstring(noMatchRow, "halbower"),
    false,
    "A row where neither the primary nor any reporting_owners[].name contains the needle must NOT match.",
  );
});

test("edge case: empty reporting_owners[] does not throw", () => {
  // Ensure the (row.reporting_owners ?? []) guard handles the case where
  // the array is empty without crashing the filter.
  assert.equal(
    matchesOwnerNameSubstring(emptyOwnersRow, "halbower"),
    true,
    "Row with primary match and empty reporting_owners[] should still match via the primary check.",
  );
});

test("edge case: primary-only match with empty array returns true", () => {
  // Verify the helper short-circuits on a primary match without needing
  // the array (the primary check runs first).
  const sparseRow = rowStub("Halbower Matthew", []);
  assert.equal(
    matchesOwnerNameSubstring(sparseRow, "halbower"),
    true,
  );
});

test("edge case: case-insensitive substring on co-filer", () => {
  // Confirm the helper inherits matchesSubstringSafe's case-insensitive
  // behavior across the array branch (uppercase needle against lowercase
  // co-filer name, or vice versa).
  const mixedCaseRow = rowStub(
    "Some Fund Name",
    [
      ownerStub({ name: "Some Fund Name" }),
      ownerStub({ name: "HALBOWER MATTHEW" }),
    ],
  );
  assert.equal(
    matchesOwnerNameSubstring(mixedCaseRow, "halbower"),
    true,
    "Case-insensitive substring match must work on the array branch (test fixture has uppercase co-filer name, lowercase needle).",
  );
});
