/**
 * One-time cleanup for the two anomalies the DB-wide scan found:
 *  1. activist_ownership.event_date — a few rows in M/D/YYYY → normalize to ISO
 *     (format only; same date, our system standard — not a value change).
 *  2. insider transaction_date filer year-typos (e.g. 2047) in
 *     insider_transactions_v2 (corroborate vs filing_date) and insider_trades
 *     (vs disclosure_date) — expose the true year, preserve source, flag.
 *
 *   npx tsx scripts/fix-date-anomalies.ts --dry   # preview
 *   npx tsx scripts/fix-date-anomalies.ts         # apply
 */
import "../src/load-secrets.js";
import { getLiveDb } from "../src/firestore.js";
import { correctFutureDate, yearOf } from "../src/fec-date-correct.js";

const DRY = process.argv.includes("--dry");
const db = await getLiveDb();

function toIso(raw: string): string {
  if (!raw) return raw;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : raw;
}

// 1) activist_ownership.event_date — normalize M/D/YYYY → ISO
{
  const snap = await db.collection("activist_ownership").get();
  let fixed = 0;
  for (const doc of snap.docs) {
    const ev = doc.get("event_date") as string;
    const iso = toIso(ev);
    if (iso !== ev) {
      console.log(`  activist_ownership.event_date  ${ev} -> ${iso}`);
      if (!DRY) await doc.ref.set({ event_date: iso }, { merge: true });
      fixed++;
    }
  }
  console.log(`activist_ownership.event_date normalized: ${fixed}\n`);
}

// 2) insider transaction_date future-typos (both collections)
for (const [coll, corrField] of [
  ["insider_transactions_v2", "filing_date"],
  ["insider_trades", "disclosure_date"],
] as const) {
  const snap = await db.collection(coll).where("transaction_date", ">", "2027-12-31").get();
  let fixed = 0;
  for (const doc of snap.docs) {
    const x = doc.data() as any;
    const corr = correctFutureDate(x.transaction_date, [yearOf(x[corrField])], corrField);
    if (!corr.corrected) {
      console.log(`  SKIP ${coll} txn=${x.transaction_date} (${corrField}=${x[corrField]})`);
      continue;
    }
    console.log(`  ${coll} ${x.transaction_date} -> ${corr.value} (${corrField}=${x[corrField]})`);
    if (!DRY)
      await doc.ref.set(
        {
          transaction_date: corr.value,
          transaction_date_source: corr.source,
          date_corrected: true,
          date_correction_basis: corr.basis,
        },
        { merge: true },
      );
    fixed++;
  }
  console.log(`${coll}.transaction_date corrected: ${fixed}\n`);
}
console.log(DRY ? "(dry run — no writes)" : "done");
process.exit(0);
