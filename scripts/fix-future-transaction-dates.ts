/**
 * Correct future-dated transaction dates that violate a hard invariant:
 * a transaction cannot post-date its own filing/disclosure.
 *
 *  - insider_transactions_v2.transaction_date  must be <= filing_date
 *  - congressional_trades.transaction_date     must be <= disclosure_date
 *
 * These are filer year-typos in the SOURCE (verified: Credo's Form 4 itself
 * carries transactionDate 2027-11-17 against periodOfReport/signature 2023).
 * We expose the truth — the corrected date becomes the searchable field — while
 * preserving the source value (transaction_date_source) and flagging
 * date_corrected:true with the basis, so any record audits back to EDGAR.
 *
 * Year-pick: use the corroborator's year; if that still post-dates the
 * corroborator (Dec txn filed early Jan), step back one year. Month+day verbatim.
 *
 * Run: npx tsx scripts/fix-future-transaction-dates.ts [--apply]
 * (dry-run by default; prints every proposed change)
 */
import { getLiveDb } from "../src/firestore.js";

const APPLY = process.argv.includes("--apply");
const TODAY = "2026-06-07";

interface Target {
  coll: string;
  corrField: string;
}
const TARGETS: Target[] = [
  { coll: "insider_transactions_v2", corrField: "filing_date" },
  { coll: "congressional_trades", corrField: "disclosure_date" },
];

function pickYear(rawMMDD: string, corr: string): string | null {
  const cm = /^(\d{4})-(\d{2})-(\d{2})/.exec(corr);
  if (!cm) return null;
  const corrYear = Number(cm[1]);
  // try corroborator year, then one earlier, take the latest that is <= corr
  for (const y of [corrYear, corrYear - 1]) {
    const cand = `${y}-${rawMMDD}`;
    if (cand <= corr) return cand;
  }
  return null;
}

async function main(): Promise<void> {
  const db = await getLiveDb();
  let totalFixed = 0,
    totalSkip = 0;
  for (const { coll, corrField } of TARGETS) {
    const snap = await db
      .collection(coll)
      .where("transaction_date", ">", TODAY)
      .get();
    console.log(`\n=== ${coll}: ${snap.size} future transaction_date ===`);
    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      const x = doc.data() as Record<string, string>;
      const raw = x.transaction_date;
      const corr = x[corrField];
      const mmdd = /^\d{4}-(\d{2}-\d{2})/.exec(raw ?? "")?.[1];
      if (!corr || !mmdd) {
        totalSkip++;
        console.log(`  SKIP  ${raw} (no ${corrField}/parse) id=${doc.id.slice(0, 28)}`);
        continue;
      }
      const fixed = pickYear(mmdd, corr);
      if (!fixed || fixed === raw) {
        totalSkip++;
        console.log(`  SKIP  ${raw} (${corrField}=${corr} no safe year) id=${doc.id.slice(0, 28)}`);
        continue;
      }
      totalFixed++;
      console.log(
        `  FIX   ${raw} -> ${fixed}  (${corrField}=${corr}) ${(x.ticker || x.member_name || "").slice(0, 16)}`,
      );
      if (APPLY) {
        batch.update(doc.ref, {
          transaction_date: fixed,
          transaction_date_source: raw,
          date_corrected: true,
          date_correction_basis: corrField,
        });
        if (++inBatch >= 400) {
          await batch.commit();
          batch = db.batch();
          inBatch = 0;
        }
      }
    }
    if (APPLY && inBatch > 0) await batch.commit();
  }
  console.log(
    `\n${APPLY ? "APPLIED" : "DRY-RUN"}: ${totalFixed} corrected, ${totalSkip} skipped`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
