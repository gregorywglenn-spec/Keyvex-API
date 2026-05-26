import { getLiveDb } from "../src/firestore.js";

async function probe(coll: string, field: string) {
  const db = await getLiveDb();
  let total = 0, filled = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let pages = 0;
  while (pages < 20) {
    let q: FirebaseFirestore.Query = db.collection(coll).limit(1000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      total++;
      const v = (doc.data() as Record<string, unknown>)[field];
      if (v && String(v).length > 0) filled++;
    }
    last = snap.docs[snap.docs.length - 1];
    pages++;
    if (snap.size < 1000) break;
  }
  const pct = total > 0 ? ((100 * filled) / total).toFixed(1) : "0";
  console.log(`  ${coll}.${field}: ${filled}/${total} populated (${pct}%)`);
}

async function main() {
  console.log("=== Enrichment-gap audit (same-pattern collections) ===");
  await probe("annual_financial_disclosures", "bioguide_id");
  await probe("annual_financial_disclosures", "party");
  await probe("congressional_trades", "bioguide_id");
  await probe("congressional_trades", "party");
  console.log("");
  console.log("=== Other commonly-deferred fields ===");
  await probe("congressional_trades", "ticker");
  await probe("insider_trades", "ticker");
  await probe("institutional_holdings", "ticker");
  await probe("federal_contracts", "recipient_uei");
  await probe("federal_grants", "recipient_uei");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
