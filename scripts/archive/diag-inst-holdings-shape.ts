/**
 * Probe institutional_holdings further — is the collection small,
 * or does it lack a scraped_at field?
 */
import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();

  console.log("=== Raw count: ANY 10 docs from institutional_holdings ===");
  const sample = await db.collection("institutional_holdings").limit(10).get();
  console.log(`  size: ${sample.size}`);
  for (const doc of sample.docs.slice(0, 3)) {
    console.log(`  ${doc.id}`);
    const d = doc.data() as Record<string, unknown>;
    console.log(`    keys: ${Object.keys(d).sort().join(", ")}`);
    console.log(`    ticker=${JSON.stringify(d.ticker)} cusip=${JSON.stringify(d.cusip)} fund_name=${JSON.stringify(d.fund_name)}`);
  }

  console.log("\n=== Order by reportPeriod desc, limit 5 ===");
  // common 13F fields: reportPeriod / period_of_report
  for (const orderField of ["period_of_report", "reportPeriod", "quarter", "filing_date", "market_value"]) {
    try {
      const s = await db.collection("institutional_holdings").orderBy(orderField, "desc").limit(3).get();
      console.log(`  orderBy ${orderField}: ${s.size} rows`);
      if (s.size > 0) {
        const d = s.docs[0].data() as Record<string, unknown>;
        console.log(`    first doc ${s.docs[0].id}: ticker=${JSON.stringify(d.ticker)} ${orderField}=${JSON.stringify(d[orderField])}`);
      }
    } catch (e) {
      console.log(`  orderBy ${orderField}: ERROR ${(e as Error).message.slice(0, 100)}`);
    }
  }

  // Real count via paginated read
  console.log("\n=== True size of institutional_holdings (cursored count) ===");
  let total = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const PAGE = 1000;
  let pages = 0;
  while (pages < 50) {
    let q: FirebaseFirestore.Query = db.collection("institutional_holdings").limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    total += snap.size;
    last = snap.docs[snap.docs.length - 1];
    pages++;
    if (snap.size < PAGE) break;
  }
  console.log(`  total docs counted: ${total} (over ${pages} pages)`);

  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
