import { getLiveDb } from "../src/firestore.js";
const db = await getLiveDb();
const tx = await db
  .collection("insider_transactions_v2")
  .where("source_zip", "==", "2008q2_form345.zip")
  .count()
  .get();
const hold = await db
  .collection("insider_holdings_v2")
  .where("source_zip", "==", "2008q2_form345.zip")
  .count()
  .get();
const filing = await db
  .collection("insider_filings_v2")
  .where("source_zip", "==", "2008q2_form345.zip")
  .count()
  .get();
console.log("2008q2 in Firestore:");
console.log(`  filings:      ${filing.data().count.toLocaleString()} / 67,641 expected`);
console.log(`  transactions: ${tx.data().count.toLocaleString()} / 222,376 expected`);
console.log(`  holdings:     ${hold.data().count.toLocaleString()} / 73,197 expected`);
