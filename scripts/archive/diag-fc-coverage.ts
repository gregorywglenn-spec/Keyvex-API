import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  console.log("=== federal_contracts: rough size + date range ===");
  // Min/max date probes
  const newestSnap = await db.collection("federal_contracts")
    .orderBy("last_modified_date", "desc").limit(1).get();
  const oldestSnap = await db.collection("federal_contracts")
    .orderBy("last_modified_date", "asc").limit(1).get();
  if (newestSnap.docs[0]) {
    const d = newestSnap.docs[0].data();
    console.log(`  newest: last_modified_date=${d.last_modified_date} recipient=${d.recipient_name}`);
  }
  if (oldestSnap.docs[0]) {
    const d = oldestSnap.docs[0].data();
    console.log(`  oldest: last_modified_date=${d.last_modified_date} recipient=${d.recipient_name}`);
  }
  // Top-amount probe (no filter) — does the collection have huge awards anywhere?
  const bigSnap = await db.collection("federal_contracts")
    .orderBy("award_amount", "desc").limit(5).get();
  console.log(`\n  top-5 awards in collection by award_amount:`);
  for (const doc of bigSnap.docs) {
    const d = doc.data();
    console.log(`    $${(d.award_amount ?? 0).toLocaleString()}  ${d.recipient_name}  (mod ${d.last_modified_date})`);
  }
  // Lockheed-specific probe — what's actually in there?
  const lmtSnap = await db.collection("federal_contracts")
    .where("recipient_name", "==", "LOCKHEED MARTIN CORPORATION").limit(20).get();
  console.log(`\n  records where recipient_name == 'LOCKHEED MARTIN CORPORATION': ${lmtSnap.size}`);
  for (const doc of lmtSnap.docs.slice(0, 5)) {
    const d = doc.data();
    console.log(`    $${(d.award_amount ?? 0).toLocaleString()}  mod=${d.last_modified_date}  agency=${d.awarding_agency}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
