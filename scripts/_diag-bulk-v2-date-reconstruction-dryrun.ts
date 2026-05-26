/**
 * P0 DATE-CORRUPTION RECONSTRUCTION — DRY-RUN (READ-ONLY)
 *
 * ──────────────────────────────────────────────────────────────────────
 * POSTERITY NOTE (added 2026-05-26)
 * ──────────────────────────────────────────────────────────────────────
 * The reconstruction premise this script was built on has been REFUTED.
 * A subsequent source-TSV grep + EDGAR primary-filing spot-check (logfile
 * .tmp/edgar-spotcheck-20260526-150902.log; 22/22 field-matches, 0
 * bulk-vs-primary discrepancies across all four corruption faces) showed
 * the bulk_v2 dates are byte-faithful to SEC's authoritative source. The
 * parser (src/scrapers/form345-bulk.ts:68-77, parseSecDate) introduces no
 * mutation; the "corruption" is a mix of SEC-side sentinels (2050 =
 * perpetual-instrument) and filer-side data-entry errors (2-digit-year
 * typos, single-digit transpositions) preserved verbatim from SEC's
 * primary filings.
 *
 * This script is PRESERVED as evidence of the gate working — it sized
 * what a backfill writer would have written (~14,541 "clean-reconstruct"
 * proposals, of which the diagnostic measured 27,639 forward-field
 * reconstructions as 99.96% systematically wrong) and the dry-run output
 * is what stopped that catastrophic fabrication-against-source before it
 * shipped.
 *
 * DO NOT REPURPOSE THIS SCRIPT INTO A WRITER. The reconstruction logic
 * here, by the spot-check verdict, would write data that diverges from
 * SEC's authoritative record — a direct violation of KeyVex's pure-
 * publisher posture. Reconstruction-backfill is permanently CLOSED. The
 * forward path is read-time interpretation, never silent overwrite.
 *
 * See docs/handoff-phase-a-v4-count-check-arc-2026-05-25.md, Amendment 2,
 * for the full investigation record and reframe.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Reports what a Phase-2 backfill writer WOULD change. Writes nothing.
 *
 * ──────────────────────────────────────────────────────────────────────
 * NO-WRITE ATTESTATION
 * ──────────────────────────────────────────────────────────────────────
 * This script's Firestore surface is strictly read:
 *   - .where().select().get()    (corrupt-doc discovery)
 *   - .collection().doc().get()  (per-doc evaluation)
 *
 * The following methods are NEVER called from this file. Grep to confirm:
 *   .set(  .update(  .delete(  .add(  .create(  .batch(
 *   FieldValue.delete  FieldValue.increment  FieldValue.arrayUnion
 *   firestore().writeBulk  firestore().bulkWriter  WriteBatch
 *
 * Backfill is a separate, gated, later step that requires explicit
 * authorization. This file's purpose is only to surface what that
 * step WOULD do, so the gate decision is informed.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Bug characterization (from earlier recon + 2026-05-25 recount):
 *   - Year-digit corruption on date fields in bulk_v2 ingestion path
 *     (and 6 known live-feed rows). Month/day intact per characterization.
 *   - Confirmed faces: 20XX -> 00XX (low end) and 20XX -> 204X (high end).
 *   - filing_date is universally clean (0 corrupt across 10M+ rows).
 *     IT IS THE ANCHOR for reconstruction.
 *   - period_of_report has 142 corrupt v2 rows. It MAY corroborate
 *     consensus but MUST NEVER be the sole source.
 *
 * Reconstruction rule (per Greg's 2026-05-26 directive):
 *   1. Identify corrupt fields by field-aware thresholds:
 *        transaction_date:  > 2027-01-01 OR < 1990-01-01
 *        exercise_date:     > 2050-01-01 OR < 1990-01-01
 *        expiration_date:   > 2050-01-01 OR < 1990-01-01
 *   2. For each corrupt field on the row, extract MM-DD from the corrupt
 *      value (year-digit-only-corruption assumption; verified per-row).
 *   3. Evaluate sibling date fields:
 *        filing_date, period_of_report, date_of_orig_sub,
 *        deemed_execution_date
 *      Treat a sibling as "clean" if its year is in [1990, 2027].
 *   4. Auto-reconstruct iff:
 *        - >= 2 clean siblings agree on a single candidate year, AND
 *        - filing_date is one of the agreeing siblings.
 *      Otherwise -> FLAG FOR MANUAL REVIEW (no auto-fix proposed).
 *   5. When a row has any corrupt date field, evaluate and report
 *      proposed reconstruction for EVERY corrupt date field on it,
 *      not just the triggering one.
 *   6. Recompute reporting_lag_days from corrected transaction_date
 *      and filing_date when both are available post-fix.
 *
 * Output:
 *   - Per-row detail (bounded sample): collection, doc id, sibling values,
 *     each corrupt field's corrupt-value -> reconstructed-value, siblings
 *     used, consistency verdict, reporting_lag_days delta, AND the
 *     last-two-digit consistency check — corrupt-year's last 2 digits
 *     vs proposed-year's last 2 digits, reported as MATCH/MISMATCH.
 *     DIAGNOSTIC ONLY at this stage; NOT a rule change. Mismatch on a
 *     forward field (exercise/expiration) is the signal that the
 *     corruption is "deeper" than century-prefix and may not be
 *     recoverable from sibling consensus alone.
 *   - Per-collection summary: counts (clean / partial / ambiguous /
 *     month-day-invalid) and sibling-agreement-count distribution, plus
 *     a FIELD-CLASS BREAKDOWN segregating transaction_date (close-
 *     semantics, sibling-year-equals-truth-year is expected) from
 *     exercise_date + expiration_date (forward-semantics, the open
 *     question), with per-class last-two-digit match rates.
 *   - Spot-check sample (~12 rows): low-end 00XX faces, high-end 204X
 *     faces, derivative-date cases (exercise/expiration), ambiguous
 *     rows, AND forward-field last-two-digit MISMATCH cases — the
 *     latter being the most evidentiary set for the committee review
 *     of the forward-field reconstruction regime.
 *
 * NO PRODUCTION WRITE. NO BACKFILL. This is design + dry-run only.
 */

import { getLiveDb } from "../src/firestore.js";

// ─── Constants ──────────────────────────────────────────────────────────

const COLLECTIONS = ["insider_trades", "insider_transactions_v2"] as const;

// Per-field corruption thresholds — see types.ts:1128 finding for
// forward-looking-field tolerances (long-dated options legitimately
// reach ~24yr out, so 2050 cap for exercise / expiration).
const FIELD_THRESHOLDS: Record<string, { future: string; ancient: string }> = {
  transaction_date: { future: "2027-01-01", ancient: "1990-01-01" },
  exercise_date:    { future: "2050-01-01", ancient: "1990-01-01" },
  expiration_date:  { future: "2050-01-01", ancient: "1990-01-01" },
};

const PROBE_FIELDS = Object.keys(FIELD_THRESHOLDS);

// Sibling fields evaluated for consensus.
const SIBLING_FIELDS = [
  "filing_date",
  "period_of_report",
  "date_of_orig_sub",
  "deemed_execution_date",
] as const;

// filing_date is the universal anchor. It MUST be one of the agreeing
// siblings for any auto-reconstruction (period_of_report is itself
// corrupt on 142 v2 rows and cannot be a sole source of truth).
const ANCHOR_FIELD = "filing_date";

// Generic clean-window for sibling fields (backward-looking dates;
// filing / period / orig-sub / deemed-execution are all retrospective).
const SIBLING_CLEAN_MIN = "1990-01-01";
const SIBLING_CLEAN_MAX = "2027-01-01";

// Output bounding.
const BOUNDED_DETAIL_SAMPLE = 200;
const SPOTCHECK_TARGET = 12;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ─── Helpers ────────────────────────────────────────────────────────────

type Verdict =
  | "clean-reconstruct"
  | "ambiguous-flagged"
  | "month-day-invalid"
  | "anchor-compromised";

interface FieldEvaluation {
  field: string;
  corruptValue: string;
  corruptYear: number | null;
  monthDay: string | null; // "MM-DD"
  monthDayValid: boolean;
  candidateYear: number | null;
  agreeingSiblings: string[];
  filingDateInAgreers: boolean;
  verdict: Verdict;
  reconstructedValue: string | null;
  // Last-two-digit consistency check (diagnostic, not a rule input).
  // Populated only for verdict === "clean-reconstruct"; null otherwise.
  // last2DigitsCorrupt:  corruptYear % 100 (or null if corruptYear is null)
  // last2DigitsProposed: candidateYear % 100 (or null if candidateYear is null)
  // last2DigitsMatch:    true iff both above defined AND equal
  last2DigitsCorrupt: number | null;
  last2DigitsProposed: number | null;
  last2DigitsMatch: boolean | null;
}

interface RowEvaluation {
  collection: string;
  docId: string;
  filingDate: string | null;
  filingDateClean: boolean;
  siblingValues: Record<string, string | null>;
  siblingsClean: Record<string, boolean>;
  corruptFields: FieldEvaluation[];
  overallVerdict:
    | "clean-reconstruct"
    | "partial-reconstruct"
    | "ambiguous-flagged"
    | "anchor-compromised";
  reportingLagDaysOld: number | null;
  reportingLagDaysNew: number | null;
}

function extractMonthDay(value: string): { md: string | null; valid: boolean } {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return { md: null, valid: false };
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31;
  return { md: `${m[2]}-${m[3]}`, valid };
}

function extractYear(value: string): number | null {
  const m = ISO_DATE_RE.exec(value);
  return m ? parseInt(m[1], 10) : null;
}

function isFieldCorrupt(field: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const t = FIELD_THRESHOLDS[field];
  if (!t) return false;
  return value > t.future || value < t.ancient;
}

function isSiblingClean(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ISO_DATE_RE.test(value)) return false;
  return value >= SIBLING_CLEAN_MIN && value <= SIBLING_CLEAN_MAX;
}

function evaluateField(
  field: string,
  corruptValue: string,
  cleanSiblings: Record<string, string>,
): FieldEvaluation {
  const corruptYear = extractYear(corruptValue);
  const { md, valid } = extractMonthDay(corruptValue);

  if (!valid || !md) {
    return {
      field,
      corruptValue,
      corruptYear,
      monthDay: md,
      monthDayValid: false,
      candidateYear: null,
      agreeingSiblings: [],
      filingDateInAgreers: false,
      verdict: "month-day-invalid",
      reconstructedValue: null,
      last2DigitsCorrupt: null,
      last2DigitsProposed: null,
      last2DigitsMatch: null,
    };
  }

  // Each clean sibling proposes its year as the row's context year.
  // We take consensus iff >= 2 siblings agree AND filing_date is one of them.
  const proposalsByYear: Record<number, string[]> = {};
  for (const [siblingName, siblingValue] of Object.entries(cleanSiblings)) {
    const y = extractYear(siblingValue);
    if (y === null) continue;
    if (!proposalsByYear[y]) proposalsByYear[y] = [];
    proposalsByYear[y].push(siblingName);
  }

  const consensusYears = Object.entries(proposalsByYear)
    .filter(([, supporters]) =>
      supporters.length >= 2 && supporters.includes(ANCHOR_FIELD),
    )
    .map(([y, supporters]) => ({
      year: parseInt(y, 10),
      supporters: supporters.slice(),
    }));

  if (consensusYears.length === 0 || consensusYears.length > 1) {
    return {
      field,
      corruptValue,
      corruptYear,
      monthDay: md,
      monthDayValid: true,
      candidateYear: null,
      agreeingSiblings: [],
      filingDateInAgreers: false,
      verdict: "ambiguous-flagged",
      reconstructedValue: null,
      last2DigitsCorrupt: null,
      last2DigitsProposed: null,
      last2DigitsMatch: null,
    };
  }

  const { year, supporters } = consensusYears[0];
  // Diagnostic only — does the corrupt-year's last 2 digits match the
  // proposed year's last 2 digits? On a "century-prefix-only" corruption
  // (20XX -> 00XX), these would MATCH (XX is preserved). On a "deeper"
  // corruption (digit other than the leading 2 mangled), these can
  // DIVERGE. This DOES NOT affect the reconstruction rule at this stage;
  // it's measured + reported so the committee review can judge whether
  // forward-field reconstructions are trustworthy.
  const last2DigitsCorrupt =
    corruptYear !== null ? ((corruptYear % 100) + 100) % 100 : null;
  const last2DigitsProposed = ((year % 100) + 100) % 100;
  const last2DigitsMatch =
    last2DigitsCorrupt !== null && last2DigitsCorrupt === last2DigitsProposed;

  return {
    field,
    corruptValue,
    corruptYear,
    monthDay: md,
    monthDayValid: true,
    candidateYear: year,
    agreeingSiblings: supporters,
    filingDateInAgreers: true,
    verdict: "clean-reconstruct",
    reconstructedValue: `${year}-${md}`,
    last2DigitsCorrupt,
    last2DigitsProposed,
    last2DigitsMatch,
  };
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (isNaN(ta) || isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

// ─── Firestore I/O (read-only) ──────────────────────────────────────────

type FirestoreDb = Awaited<ReturnType<typeof getLiveDb>>;

async function findCorruptDocIds(
  db: FirestoreDb,
  collection: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const field of PROBE_FIELDS) {
    const t = FIELD_THRESHOLDS[field];
    const probes: Array<{ op: ">" | "<"; threshold: string }> = [
      { op: ">", threshold: t.future },
      { op: "<", threshold: t.ancient },
    ];
    for (const { op, threshold } of probes) {
      try {
        const snap = await db
          .collection(collection)
          .where(field, op, threshold)
          .select(field)
          .get();
        for (const doc of snap.docs) ids.add(doc.id);
        console.log(
          `  ${collection}.${field} ${op} ${threshold}: ${snap.docs.length} hits  (cumulative unique: ${ids.size})`,
        );
      } catch (e) {
        console.log(
          `  ${collection}.${field} ${op} ${threshold}: ERROR ${(e as Error).message.slice(0, 120)}`,
        );
      }
    }
  }
  return ids;
}

async function evaluateDoc(
  db: FirestoreDb,
  collection: string,
  docId: string,
): Promise<RowEvaluation | null> {
  const docSnap = await db.collection(collection).doc(docId).get();
  if (!docSnap.exists) return null;
  const data = docSnap.data() as Record<string, unknown>;

  // Collect raw + clean sibling values.
  const siblingValues: Record<string, string | null> = {};
  const siblingsClean: Record<string, boolean> = {};
  const cleanSiblings: Record<string, string> = {};
  for (const s of SIBLING_FIELDS) {
    const v = data[s];
    if (typeof v === "string" && ISO_DATE_RE.test(v)) {
      siblingValues[s] = v;
      if (isSiblingClean(v)) {
        siblingsClean[s] = true;
        cleanSiblings[s] = v;
      } else {
        siblingsClean[s] = false;
      }
    } else {
      siblingValues[s] = null;
      siblingsClean[s] = false;
    }
  }

  const filingDate = siblingValues[ANCHOR_FIELD];
  const filingDateClean = siblingsClean[ANCHOR_FIELD];

  // Identify all corrupt date fields on this doc.
  const corruptFieldEvals: FieldEvaluation[] = [];
  for (const field of PROBE_FIELDS) {
    if (isFieldCorrupt(field, data[field])) {
      // Defensive: if filing_date is itself compromised on THIS row,
      // refuse to auto-reconstruct any field — anchor is gone.
      if (!filingDateClean) {
        corruptFieldEvals.push({
          field,
          corruptValue: data[field] as string,
          corruptYear: extractYear(data[field] as string),
          monthDay: extractMonthDay(data[field] as string).md,
          monthDayValid: extractMonthDay(data[field] as string).valid,
          candidateYear: null,
          agreeingSiblings: [],
          filingDateInAgreers: false,
          verdict: "anchor-compromised",
          reconstructedValue: null,
          last2DigitsCorrupt: null,
          last2DigitsProposed: null,
          last2DigitsMatch: null,
        });
      } else {
        corruptFieldEvals.push(
          evaluateField(field, data[field] as string, cleanSiblings),
        );
      }
    }
  }

  if (corruptFieldEvals.length === 0) return null;

  // Overall verdict.
  const verdicts = new Set(corruptFieldEvals.map((f) => f.verdict));
  let overallVerdict: RowEvaluation["overallVerdict"];
  if (verdicts.has("anchor-compromised")) {
    overallVerdict = "anchor-compromised";
  } else if (verdicts.size === 1 && verdicts.has("clean-reconstruct")) {
    overallVerdict = "clean-reconstruct";
  } else if (verdicts.has("clean-reconstruct")) {
    overallVerdict = "partial-reconstruct";
  } else {
    overallVerdict = "ambiguous-flagged";
  }

  // reporting_lag_days delta (only when transaction_date is involved
  // and filing_date is clean).
  let oldLag: number | null = null;
  let newLag: number | null = null;
  const txnEval = corruptFieldEvals.find((f) => f.field === "transaction_date");
  if (filingDate && filingDateClean) {
    const txnRaw = data["transaction_date"];
    if (typeof txnRaw === "string") oldLag = daysBetween(txnRaw, filingDate);
    if (txnEval?.reconstructedValue) {
      newLag = daysBetween(txnEval.reconstructedValue, filingDate);
    } else if (!txnEval && typeof txnRaw === "string") {
      // transaction_date wasn't corrupt; lag unchanged
      newLag = oldLag;
    }
  }

  return {
    collection,
    docId,
    filingDate,
    filingDateClean,
    siblingValues,
    siblingsClean,
    corruptFields: corruptFieldEvals,
    overallVerdict,
    reportingLagDaysOld: oldLag,
    reportingLagDaysNew: newLag,
  };
}

// ─── Reporting ──────────────────────────────────────────────────────────

function printRowDetail(row: RowEvaluation, indent = "  "): void {
  console.log(`${indent}${row.collection} / ${row.docId}`);
  console.log(
    `${indent}  filing_date (anchor): ${row.filingDate ?? "(absent)"}` +
      (row.filingDate ? `  [${row.filingDateClean ? "CLEAN" : "COMPROMISED"}]` : ""),
  );
  console.log(`${indent}  siblings:`);
  for (const s of SIBLING_FIELDS) {
    if (s === ANCHOR_FIELD) continue;
    const v = row.siblingValues[s];
    const tag = v === null ? "(absent)" : row.siblingsClean[s] ? "[clean]" : "[unclean]";
    console.log(`${indent}    ${s.padEnd(24)}: ${v ?? "—"}  ${tag}`);
  }
  console.log(`${indent}  corrupt fields:`);
  for (const f of row.corruptFields) {
    console.log(`${indent}    ${f.field}:`);
    console.log(`${indent}      corrupt value:    ${f.corruptValue}  (year ${f.corruptYear ?? "?"})`);
    console.log(`${indent}      month-day:        ${f.monthDay ?? "(invalid)"}  (valid: ${f.monthDayValid})`);
    if (f.verdict === "clean-reconstruct") {
      console.log(`${indent}      reconstructed:    ${f.reconstructedValue}  (year ${f.candidateYear})`);
      console.log(`${indent}      siblings used:    ${f.agreeingSiblings.join(", ")}`);
      // Last-2-digit diagnostic — flag MISMATCH on forward fields with !!
      if (
        f.last2DigitsCorrupt !== null &&
        f.last2DigitsProposed !== null
      ) {
        const c2 = String(f.last2DigitsCorrupt).padStart(2, "0");
        const p2 = String(f.last2DigitsProposed).padStart(2, "0");
        const tag = f.last2DigitsMatch ? "MATCH" : "MISMATCH";
        const isForward = f.field === "exercise_date" || f.field === "expiration_date";
        const flag = !f.last2DigitsMatch && isForward ? "  !! forward-field" : "";
        console.log(`${indent}      last-2-digit:     ${c2} (corrupt) vs ${p2} (proposed) -> ${tag}${flag}`);
      }
    } else {
      console.log(`${indent}      verdict:          ${f.verdict}`);
    }
  }
  console.log(`${indent}  overall: ${row.overallVerdict}`);
  if (
    row.reportingLagDaysOld !== row.reportingLagDaysNew &&
    (row.reportingLagDaysOld !== null || row.reportingLagDaysNew !== null)
  ) {
    console.log(
      `${indent}  reporting_lag_days: ${row.reportingLagDaysOld} -> ${row.reportingLagDaysNew}`,
    );
  }
  console.log("");
}

interface CollectionSummary {
  collection: string;
  total: number;
  cleanReconstruct: number;
  partialReconstruct: number;
  ambiguousFlagged: number;
  anchorCompromised: number;
  monthDayInvalidRows: number;
  siblingAgreementCounts: Record<number, number>;
  perFieldCorruptCount: Record<string, number>;
  perFieldCleanReconstructCount: Record<string, number>;
  // Field-class breakdown: "close" = transaction_date, "forward" =
  // exercise_date + expiration_date. Counts are at field-event level
  // (one row with multiple corrupt fields contributes per field).
  closeFieldCorrupt: number;
  closeFieldCleanReconstruct: number;
  closeFieldLast2Match: number;
  closeFieldLast2Mismatch: number;
  forwardFieldCorrupt: number;
  forwardFieldCleanReconstruct: number;
  forwardFieldLast2Match: number;
  forwardFieldLast2Mismatch: number;
}

function isForwardField(field: string): boolean {
  return field === "exercise_date" || field === "expiration_date";
}

function pickSpotcheckSamples(rows: RowEvaluation[]): RowEvaluation[] {
  // Buckets:
  //   - low-end (corrupt year <1000) ~ "00XX" face
  //   - high-end (corrupt year >2030) ~ "204X" face
  //   - derivative-field cases (exercise/expiration), any verdict
  //   - ambiguous / anchor-compromised rows
  //   - forward-field MISMATCH cases (the evidentiary set for the
  //     committee review of the forward-field reconstruction regime)
  const lowEnd: RowEvaluation[] = [];
  const highEnd: RowEvaluation[] = [];
  const derivCases: RowEvaluation[] = [];
  const ambiguous: RowEvaluation[] = [];
  const fwdMismatch: RowEvaluation[] = [];

  for (const row of rows) {
    for (const f of row.corruptFields) {
      const y = f.corruptYear ?? -1;
      if (y >= 0 && y < 1000 && lowEnd.length < 3) {
        lowEnd.push(row);
        break;
      }
      if (y > 2030 && highEnd.length < 3) {
        highEnd.push(row);
        break;
      }
    }
    for (const f of row.corruptFields) {
      if (
        (f.field === "exercise_date" || f.field === "expiration_date") &&
        derivCases.length < 3
      ) {
        derivCases.push(row);
        break;
      }
    }
    if (
      (row.overallVerdict === "ambiguous-flagged" ||
        row.overallVerdict === "anchor-compromised") &&
      ambiguous.length < 2
    ) {
      ambiguous.push(row);
    }
    // Forward-field MISMATCH — prioritized for committee review
    for (const f of row.corruptFields) {
      if (
        (f.field === "exercise_date" || f.field === "expiration_date") &&
        f.verdict === "clean-reconstruct" &&
        f.last2DigitsMatch === false &&
        fwdMismatch.length < 4
      ) {
        fwdMismatch.push(row);
        break;
      }
    }
  }

  const seen = new Set<string>();
  const out: RowEvaluation[] = [];
  // Order: forward-field MISMATCH first (highest evidentiary value),
  // then the other buckets in original order.
  for (const r of [...fwdMismatch, ...lowEnd, ...highEnd, ...derivCases, ...ambiguous]) {
    const k = `${r.collection}/${r.docId}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
      if (out.length >= SPOTCHECK_TARGET) break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log("############################################################");
  console.log("P0 DATE-CORRUPTION RECONSTRUCTION — DRY-RUN  (READ-ONLY)");
  console.log("No writes. No updates. No deletes. No backfill.");
  console.log("Backfill writer is a SEPARATE, gated step. NOT authorized.");
  console.log("############################################################");
  console.log("");
  console.log("Field-aware thresholds (corruption ranges):");
  for (const [field, t] of Object.entries(FIELD_THRESHOLDS)) {
    console.log(`  ${field.padEnd(20)}: corrupt if value > ${t.future} OR < ${t.ancient}`);
  }
  console.log("");
  console.log(`Sibling clean-window: [${SIBLING_CLEAN_MIN}, ${SIBLING_CLEAN_MAX}]`);
  console.log(`Anchor (must be in agreeing-sibling set): ${ANCHOR_FIELD}`);
  console.log("");

  const db = await getLiveDb();

  const allByCollection: Record<string, RowEvaluation[]> = {};
  const summaries: CollectionSummary[] = [];

  for (const collection of COLLECTIONS) {
    console.log("============================================================");
    console.log(collection);
    console.log("============================================================");
    console.log("");
    console.log("Discovery — corrupt-doc-ID collection (per field/direction):");
    const ids = await findCorruptDocIds(db, collection);
    console.log(`  total unique corrupt docs: ${ids.size}`);
    console.log("");

    if (ids.size === 0) {
      console.log("  No corrupt docs found in this collection — skipping evaluation.");
      console.log("");
      summaries.push({
        collection,
        total: 0,
        cleanReconstruct: 0,
        partialReconstruct: 0,
        ambiguousFlagged: 0,
        anchorCompromised: 0,
        monthDayInvalidRows: 0,
        siblingAgreementCounts: {},
        perFieldCorruptCount: {},
        perFieldCleanReconstructCount: {},
        closeFieldCorrupt: 0,
        closeFieldCleanReconstruct: 0,
        closeFieldLast2Match: 0,
        closeFieldLast2Mismatch: 0,
        forwardFieldCorrupt: 0,
        forwardFieldCleanReconstruct: 0,
        forwardFieldLast2Match: 0,
        forwardFieldLast2Mismatch: 0,
      });
      continue;
    }

    console.log("Per-doc evaluation:");
    const rows: RowEvaluation[] = [];
    const idArray = Array.from(ids);
    let processed = 0;
    for (const id of idArray) {
      const result = await evaluateDoc(db, collection, id);
      if (result) rows.push(result);
      processed++;
      if (processed % 1000 === 0) {
        console.log(`  ...progress: ${processed}/${idArray.length} evaluated`);
      }
    }
    console.log(
      `  ${rows.length} docs evaluated  (${idArray.length - rows.length} skipped: not-found or no-longer-corrupt at fetch time)`,
    );
    console.log("");

    allByCollection[collection] = rows;

    const summary: CollectionSummary = {
      collection,
      total: rows.length,
      cleanReconstruct: 0,
      partialReconstruct: 0,
      ambiguousFlagged: 0,
      anchorCompromised: 0,
      monthDayInvalidRows: 0,
      siblingAgreementCounts: {},
      perFieldCorruptCount: {},
      perFieldCleanReconstructCount: {},
      closeFieldCorrupt: 0,
      closeFieldCleanReconstruct: 0,
      closeFieldLast2Match: 0,
      closeFieldLast2Mismatch: 0,
      forwardFieldCorrupt: 0,
      forwardFieldCleanReconstruct: 0,
      forwardFieldLast2Match: 0,
      forwardFieldLast2Mismatch: 0,
    };
    for (const r of rows) {
      switch (r.overallVerdict) {
        case "clean-reconstruct":
          summary.cleanReconstruct++;
          break;
        case "partial-reconstruct":
          summary.partialReconstruct++;
          break;
        case "ambiguous-flagged":
          summary.ambiguousFlagged++;
          break;
        case "anchor-compromised":
          summary.anchorCompromised++;
          break;
      }
      let hasInvalidMd = false;
      for (const f of r.corruptFields) {
        summary.perFieldCorruptCount[f.field] =
          (summary.perFieldCorruptCount[f.field] ?? 0) + 1;
        if (!f.monthDayValid) hasInvalidMd = true;

        // Field-class breakdown (at field-event level)
        const forward = isForwardField(f.field);
        if (forward) summary.forwardFieldCorrupt++;
        else summary.closeFieldCorrupt++;

        if (f.verdict === "clean-reconstruct") {
          summary.perFieldCleanReconstructCount[f.field] =
            (summary.perFieldCleanReconstructCount[f.field] ?? 0) + 1;
          const c = f.agreeingSiblings.length;
          summary.siblingAgreementCounts[c] =
            (summary.siblingAgreementCounts[c] ?? 0) + 1;

          if (forward) {
            summary.forwardFieldCleanReconstruct++;
            if (f.last2DigitsMatch === true) summary.forwardFieldLast2Match++;
            else if (f.last2DigitsMatch === false) summary.forwardFieldLast2Mismatch++;
          } else {
            summary.closeFieldCleanReconstruct++;
            if (f.last2DigitsMatch === true) summary.closeFieldLast2Match++;
            else if (f.last2DigitsMatch === false) summary.closeFieldLast2Mismatch++;
          }
        }
      }
      if (hasInvalidMd) summary.monthDayInvalidRows++;
    }
    summaries.push(summary);

    console.log(`Per-row detail (first ${Math.min(BOUNDED_DETAIL_SAMPLE, rows.length)}):`);
    console.log("");
    for (const r of rows.slice(0, BOUNDED_DETAIL_SAMPLE)) {
      printRowDetail(r);
    }
    if (rows.length > BOUNDED_DETAIL_SAMPLE) {
      console.log(`  ... ${rows.length - BOUNDED_DETAIL_SAMPLE} more rows omitted from per-row detail print.`);
      console.log("");
    }
  }

  // ── Summary ──
  console.log("############################################################");
  console.log("SUMMARY");
  console.log("############################################################");
  console.log("");
  for (const s of summaries) {
    console.log(`${s.collection}:`);
    console.log(`  total corrupt rows:           ${s.total.toLocaleString()}`);
    if (s.total === 0) {
      console.log("");
      continue;
    }
    const pct = (n: number) => `(${((100 * n) / s.total).toFixed(1)}%)`;
    console.log(`  clean-reconstruct:            ${s.cleanReconstruct.toLocaleString()}  ${pct(s.cleanReconstruct)}`);
    console.log(`  partial-reconstruct:          ${s.partialReconstruct.toLocaleString()}  ${pct(s.partialReconstruct)}`);
    console.log(`  ambiguous-flagged:            ${s.ambiguousFlagged.toLocaleString()}  ${pct(s.ambiguousFlagged)}`);
    console.log(`  anchor-compromised:           ${s.anchorCompromised.toLocaleString()}  ${pct(s.anchorCompromised)}`);
    console.log(`  rows with invalid MM-DD:      ${s.monthDayInvalidRows.toLocaleString()}  ${pct(s.monthDayInvalidRows)}`);
    console.log("");
    console.log("  per-field corruption (rows that have a corrupt value on this field):");
    for (const f of PROBE_FIELDS) {
      const corrupt = s.perFieldCorruptCount[f] ?? 0;
      const reconstructable = s.perFieldCleanReconstructCount[f] ?? 0;
      const cpct = corrupt > 0 ? ((100 * reconstructable) / corrupt).toFixed(1) : "—";
      console.log(`    ${f.padEnd(20)}: ${corrupt.toLocaleString().padStart(8)} corrupt   ${reconstructable.toLocaleString().padStart(8)} clean-reconstruct  (${cpct}%)`);
    }
    console.log("");
    console.log("  sibling-agreement distribution (clean-reconstruct field-events only):");
    const entries = Object.entries(s.siblingAgreementCounts)
      .map(([k, v]) => [parseInt(k, 10), v] as const)
      .sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) {
      console.log("    (none)");
    } else {
      for (const [c, n] of entries) {
        console.log(`    ${c} siblings agreed: ${n.toLocaleString()}`);
      }
    }
    console.log("");

    // ── FIELD-CLASS BREAKDOWN ──
    console.log("  FIELD-CLASS BREAKDOWN (close = transaction_date; forward = exercise_date + expiration_date):");
    const cpct = (n: number, d: number) => (d > 0 ? `(${((100 * n) / d).toFixed(1)}%)` : "(—)");
    console.log("    close-semantics (transaction_date):");
    console.log(`      corrupt field-events:           ${s.closeFieldCorrupt.toLocaleString()}`);
    console.log(`      clean-reconstruct:              ${s.closeFieldCleanReconstruct.toLocaleString()}  ${cpct(s.closeFieldCleanReconstruct, s.closeFieldCorrupt)}`);
    console.log(`      last-2-digit MATCH:             ${s.closeFieldLast2Match.toLocaleString()}  ${cpct(s.closeFieldLast2Match, s.closeFieldCleanReconstruct)}`);
    console.log(`      last-2-digit MISMATCH:          ${s.closeFieldLast2Mismatch.toLocaleString()}  ${cpct(s.closeFieldLast2Mismatch, s.closeFieldCleanReconstruct)}`);
    console.log("    forward-semantics (exercise_date + expiration_date):");
    console.log(`      corrupt field-events:           ${s.forwardFieldCorrupt.toLocaleString()}`);
    console.log(`      clean-reconstruct:              ${s.forwardFieldCleanReconstruct.toLocaleString()}  ${cpct(s.forwardFieldCleanReconstruct, s.forwardFieldCorrupt)}`);
    console.log(`      last-2-digit MATCH:             ${s.forwardFieldLast2Match.toLocaleString()}  ${cpct(s.forwardFieldLast2Match, s.forwardFieldCleanReconstruct)}`);
    console.log(`      last-2-digit MISMATCH:          ${s.forwardFieldLast2Mismatch.toLocaleString()}  ${cpct(s.forwardFieldLast2Mismatch, s.forwardFieldCleanReconstruct)}`);
    console.log("");
    console.log("  Interpretation note:");
    console.log("    MATCH on a forward-field clean-reconstruct = century-prefix-only");
    console.log("      corruption (XX preserved) → consensus rule is likely safe.");
    console.log("    MISMATCH on a forward-field clean-reconstruct = corruption is");
    console.log("      deeper than century-prefix; the consensus rule may be");
    console.log("      proposing the filing year for a genuinely-future option.");
    console.log("      This is the open committee-review question.");
    console.log("");
  }

  // ── Spot-check sample ──
  console.log("############################################################");
  console.log("SPOT-CHECK SAMPLE (human-eyeball verification set)");
  console.log("Buckets: low-end (00XX), high-end (204X), derivative-date, ambiguous");
  console.log("############################################################");
  console.log("");
  for (const collection of Object.keys(allByCollection)) {
    const samples = pickSpotcheckSamples(allByCollection[collection]);
    if (samples.length === 0) continue;
    console.log(`── ${collection}  (${samples.length} sample(s)) ──`);
    console.log("");
    for (const s of samples) printRowDetail(s);
  }

  console.log("############################################################");
  console.log("DRY-RUN COMPLETE.");
  console.log("NO PRODUCTION WRITE OCCURRED.");
  console.log("Backfill writer is a SEPARATE step requiring explicit");
  console.log("authorization from Greg. Phase B / heal-worker.ts LOCKED.");
  console.log("############################################################");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
