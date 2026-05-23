/**
 * Cleanup for Greg's 2026-05-23 finding: handful of House PTRs have
 * pdf-parse-corrupted transaction_date with year > current+1
 * ("04/30/2021" → "04/30/3031").
 *
 * Action: for each corrupted row, NULL out the transaction_date
 * (preserve disclosure_date, ticker, member, amount — those are
 * still correct). The blank transaction_date sorts to the bottom
 * of date-DESC queries naturally and won't poison the headline
 * "most recent trades" surface.
 *
 * Conservative — does NOT delete rows (the OTHER fields are useful);
 * just clears the one corrupted field + sets a comment flag for
 * later re-parse audit.
 */
import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  const cutoffYear = new Date().getUTCFullYear() + 1;
  const dryRun = process.argv.includes("--dry-run");
  console.log(`cutoff year: ${cutoffYear}  dryRun: ${dryRun}`);

  let total = 0, corrupted = 0;
  const toFix: Array<{ id: string; oldDate: string }> = [];
  let last;
  while (true) {
    let q: FirebaseFirestore.Query = db.collection("congressional_trades").limit(2000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      total++;
      const d = doc.data() as any;
      const td = d.transaction_date as string;
      if (!td) continue;
      const yr = parseInt(td.slice(0, 4), 10);
      if (!isNaN(yr) && yr > cutoffYear) {
        corrupted++;
        toFix.push({ id: doc.id, oldDate: td });
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
  }

  console.log(`\nFound ${corrupted} corrupted rows of ${total}:`);
  for (const f of toFix) console.log(`  ${f.id}  oldDate=${f.oldDate}`);

  if (dryRun) { console.log("\nDRY RUN — no writes"); process.exit(0); }
  if (toFix.length === 0) { console.log("Nothing to fix."); process.exit(0); }

  const coll = db.collection("congressional_trades");
  const batch = db.batch();
  for (const f of toFix) {
    batch.update(coll.doc(f.id), {
      transaction_date: "",
      reporting_lag_days: null,
      comment: `[2026-05-23 cleanup] transaction_date was "${f.oldDate}" (pdf-parse corruption, year out of [2012, ${cutoffYear}]); cleared so it doesn't poison date-sorted queries. Re-scrape needed to recover original.`,
    });
  }
  await batch.commit();
  console.log(`\nCleared ${toFix.length} corrupted transaction_dates.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
