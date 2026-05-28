/**
 * Greg's 2026-05-23 refined audit: characterize the 1,509 rows with
 * abs(reporting_lag_days) > 400. Some are legitimately late filings;
 * some may be PDF-parse corruption that landed in a valid-year range
 * but still produced a wrong lag. Need to separate the two.
 */
import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  let total = 0, weird = 0;
  let chamberHouse = 0, chamberSenate = 0;
  const bins: Record<string, number> = { "400-1000": 0, "1001-2000": 0, "2001-3650": 0, ">3650": 0, "negative": 0 };
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
      const lag = d.reporting_lag_days;
      if (lag === null || lag === undefined) continue;
      if (Math.abs(lag) > 400) {
        weird++;
        if (d.chamber === "house") chamberHouse++; else chamberSenate++;
        if (lag < 0) bins["negative"]++;
        else if (lag <= 1000) bins["400-1000"]++;
        else if (lag <= 2000) bins["1001-2000"]++;
        else if (lag <= 3650) bins["2001-3650"]++;
        else bins[">3650"]++;
        if (samples.length < 15) {
          samples.push({
            id: doc.id,
            chamber: d.chamber,
            member: d.member_name,
            ticker: d.ticker,
            transaction_date: d.transaction_date,
            disclosure_date: d.disclosure_date,
            lag: lag,
          });
        }
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
  }
  console.log(`Total: ${total}  Weird lag (>400 days): ${weird}`);
  console.log(`  by chamber: house=${chamberHouse}  senate=${chamberSenate}`);
  console.log(`  lag distribution: ${JSON.stringify(bins)}`);
  console.log(`\nSample (first 15):`);
  for (const s of samples) {
    const txYr = parseInt((s.transaction_date || "").slice(0,4), 10);
    const dcYr = parseInt((s.disclosure_date || "").slice(0,4), 10);
    const yearDelta = (!isNaN(txYr) && !isNaN(dcYr)) ? dcYr - txYr : "?";
    console.log(`  ${s.id.slice(0,40).padEnd(40)} ${s.chamber} ${(s.member||"").slice(0,18).padEnd(18)} ${(s.ticker||"").padEnd(6)} tx=${s.transaction_date} disc=${s.disclosure_date} lag=${s.lag}d yrDelta=${yearDelta}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
