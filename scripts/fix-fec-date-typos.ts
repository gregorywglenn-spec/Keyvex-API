/**
 * One-time cleanup: apply the FEC date-typo correction to records already in
 * Firestore (the going-forward fix lives in the schedule-a/e normalizers).
 * Idempotent — once corrected, a record's date is no longer future-dated, so a
 * re-run won't re-find it. Dedup-safe (merge by sub_id).
 *
 *   npx tsx scripts/fix-fec-date-typos.ts --dry   # preview, no writes
 *   npx tsx scripts/fix-fec-date-typos.ts         # apply
 */
import "../src/load-secrets.js";
import { getLiveDb } from "../src/firestore.js";
import { correctFutureDate, yearOf } from "../src/fec-date-correct.js";

const DRY = process.argv.includes("--dry");
const TODAY = "2026-06-06";
const db = await getLiveDb();

async function fix(
  coll: string,
  dateField: string,
  candidates: (x: any) => Array<number | null | undefined>,
  basis: (x: any) => string,
) {
  const snap = await db.collection(coll).where(dateField, ">", TODAY).get();
  console.log(`\n=== ${coll}: ${snap.size} future-dated ===`);
  let fixed = 0;
  for (const doc of snap.docs) {
    const x = doc.data() as any;
    const corr = correctFutureDate(x[dateField], candidates(x), basis(x));
    if (!corr.corrected) {
      console.log(`  SKIP no corroborator: ${dateField}=${x[dateField]} sub_id=${x.sub_id}`);
      continue;
    }
    console.log(`  ${x[dateField]} -> ${corr.value} (basis=${corr.basis}) sub_id=${x.sub_id}`);
    if (!DRY) {
      await doc.ref.set(
        {
          [dateField]: corr.value,
          [`${dateField}_source`]: corr.source,
          date_corrected: true,
          date_correction_basis: corr.basis,
        },
        { merge: true },
      );
    }
    fixed++;
  }
  console.log(`  ${DRY ? "would fix" : "FIXED"}: ${fixed}`);
}

await fix(
  "fec_independent_expenditures",
  "expenditure_date",
  (x) => [yearOf(x.dissemination_date), x.report_year, x.two_year_transaction_period],
  (x) =>
    yearOf(x.dissemination_date) != null
      ? "dissemination_date"
      : x.report_year != null
        ? "report_year"
        : "two_year_transaction_period",
);
await fix(
  "fec_contributions",
  "contribution_receipt_date",
  (x) => [x.report_year, x.two_year_transaction_period],
  (x) => (x.report_year != null ? "report_year" : "two_year_transaction_period"),
);
console.log(`\n${DRY ? "(dry run — no writes)" : "done"}`);
process.exit(0);
