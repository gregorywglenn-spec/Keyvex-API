import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  let total = 0, withPor = 0, withoutPor = 0;
  const recentBlank: any[] = [];
  const recentFilled: any[] = [];
  let last;
  while (true) {
    let q: FirebaseFirestore.Query = db.collection("material_events").orderBy("filing_date", "desc").limit(2000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      total++;
      const d = doc.data() as any;
      if (d.period_of_report && d.period_of_report.length > 0) {
        withPor++;
        if (recentFilled.length < 3 && d.filing_date >= "2026-05-15") {
          recentFilled.push({ id: doc.id, fd: d.filing_date, por: d.period_of_report, ticker: d.ticker });
        }
      } else {
        withoutPor++;
        if (recentBlank.length < 6 && d.filing_date >= "2026-05-15") {
          recentBlank.push({ id: doc.id, fd: d.filing_date, ticker: d.ticker, items: d.item_codes });
        }
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
  }
  console.log(`material_events total: ${total}`);
  console.log(`  with period_of_report:    ${withPor}  (${(100*withPor/total).toFixed(1)}%)`);
  console.log(`  without period_of_report: ${withoutPor}  (${(100*withoutPor/total).toFixed(1)}%)`);
  console.log(`\nRecent (since 2026-05-15) WITHOUT period_of_report:`);
  for (const r of recentBlank) console.log(`  ${r.id}  filed=${r.fd} ticker=${r.ticker} items=${r.items}`);
  console.log(`\nRecent (since 2026-05-15) WITH period_of_report:`);
  for (const r of recentFilled) console.log(`  ${r.id}  filed=${r.fd} ticker=${r.ticker} por=${r.por}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
