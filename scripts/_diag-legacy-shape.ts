/**
 * Pre-Gate-7 shape diagnostic: understand the legacy insider_trades
 * collection (what daily scraper produces) before building the diff.
 */
import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  const legacy = db.collection("insider_trades");

  // Total count
  const total = await legacy.count().get();
  console.log(`insider_trades total: ${total.data().count.toLocaleString()}`);

  // Sample 3 docs to see shape + doc-ID format
  const snap = await legacy.limit(3).get();
  console.log(`\nSample doc IDs + key fields:`);
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    console.log(`\n  doc_id: ${d.id}`);
    console.log(`    accession_number: ${JSON.stringify(data.accession_number)}`);
    console.log(`    ticker:           ${JSON.stringify(data.ticker)}`);
    console.log(`    disclosure_date:  ${JSON.stringify(data.disclosure_date)}`);
    console.log(`    transaction_date: ${JSON.stringify(data.transaction_date)}`);
    console.log(`    transaction_type: ${JSON.stringify(data.transaction_type)}`);
    console.log(`    transaction_code: ${JSON.stringify(data.transaction_code)}`);
    console.log(`    is_derivative:    ${JSON.stringify(data.is_derivative)}`);
    console.log(`    data_source:      ${JSON.stringify(data.data_source)}`);
    console.log(`    officer_name:     ${JSON.stringify(data.officer_name)}`);
  }

  // Date range — figure out what the overlap window is
  console.log(`\nDate ranges:`);
  const oldest = await legacy.orderBy("disclosure_date", "asc").limit(1).get();
  const newest = await legacy.orderBy("disclosure_date", "desc").limit(1).get();
  if (oldest.docs[0]) {
    const d = oldest.docs[0].data() as Record<string, unknown>;
    console.log(`  oldest disclosure_date: ${d.disclosure_date}`);
  }
  if (newest.docs[0]) {
    const d = newest.docs[0].data() as Record<string, unknown>;
    console.log(`  newest disclosure_date: ${d.disclosure_date}`);
  }

  // is_derivative distribution
  const ndCount = await legacy.where("is_derivative", "==", false).count().get();
  const dCount = await legacy.where("is_derivative", "==", true).count().get();
  console.log(`\nis_derivative distribution:`);
  console.log(`  false (nonderiv): ${ndCount.data().count.toLocaleString()}`);
  console.log(`  true  (deriv):    ${dCount.data().count.toLocaleString()}`);

  // data_source distribution
  const f4Count = await legacy.where("data_source", "==", "SEC_EDGAR_FORM4").count().get();
  const f5Count = await legacy.where("data_source", "==", "SEC_EDGAR_FORM5").count().get();
  console.log(`\ndata_source distribution:`);
  console.log(`  SEC_EDGAR_FORM4: ${f4Count.data().count.toLocaleString()}`);
  console.log(`  SEC_EDGAR_FORM5: ${f5Count.data().count.toLocaleString()}`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
