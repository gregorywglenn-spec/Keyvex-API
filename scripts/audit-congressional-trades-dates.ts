import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  const todayYear = new Date().getFullYear();
  const MAX_YEAR = todayYear + 1;  // sane ceiling
  const MIN_YEAR = 2012;             // House PTR era start

  let total = 0, future = 0, ancient = 0, lagWeird = 0;
  let chamberHouse = 0, chamberSenate = 0;
  const samples: any[] = [];
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
      if (isNaN(yr)) continue;
      if (yr > MAX_YEAR) {
        future++;
        if (d.chamber === "house") chamberHouse++; else chamberSenate++;
        if (samples.length < 12) {
          samples.push({ id: doc.id, chamber: d.chamber, member: d.member_name,
            transaction_date: td, disclosure_date: d.disclosure_date,
            reporting_lag_days: d.reporting_lag_days, ticker: d.ticker });
        }
      } else if (yr < MIN_YEAR) {
        ancient++;
      }
      if (Math.abs(d.reporting_lag_days ?? 0) > 400) lagWeird++;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
  }
  console.log(`congressional_trades total: ${total}`);
  console.log(`  future transaction_date (year > ${MAX_YEAR}): ${future}  (${(100*future/total).toFixed(2)}%)`);
  console.log(`    breakdown: house=${chamberHouse}  senate=${chamberSenate}`);
  console.log(`  ancient transaction_date (year < ${MIN_YEAR}): ${ancient}  (${(100*ancient/total).toFixed(2)}%)`);
  console.log(`  weird reporting_lag (>400 days): ${lagWeird}  (${(100*lagWeird/total).toFixed(2)}%)`);
  console.log(`\nSample corrupted rows (first 12):`);
  for (const s of samples) {
    console.log(`  ${s.id}`);
    console.log(`    chamber=${s.chamber}  member=${s.member}  ticker=${s.ticker}`);
    console.log(`    tx_date=${s.transaction_date}  disc_date=${s.disclosure_date}  lag_days=${s.reporting_lag_days}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
