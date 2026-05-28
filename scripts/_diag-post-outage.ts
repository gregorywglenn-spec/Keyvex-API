/**
 * Post-outage sanity check: what's in the v2 collections right now?
 *
 * The bh1tdu7ns orchestrator process was killed by the power outage
 * while 2006q1 was in_progress. Confirm:
 *   - 2023q1 pilot data still intact (148,685 / 49,348 / 69,457)
 *   - Whether 2006q1 partially wrote any docs
 *   - Total collection counts before restart
 */
import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  const txCol = db.collection("insider_transactions_v2");
  const holdCol = db.collection("insider_holdings_v2");
  const filingCol = db.collection("insider_filings_v2");

  console.log("=== Firestore v2 state after power-outage interrupt ===\n");

  const [txTotal, holdTotal, filingTotal] = await Promise.all([
    txCol.count().get(),
    holdCol.count().get(),
    filingCol.count().get(),
  ]);
  console.log("Total counts:");
  console.log(`  insider_transactions_v2:  ${txTotal.data().count.toLocaleString()}`);
  console.log(`  insider_holdings_v2:      ${holdTotal.data().count.toLocaleString()}`);
  console.log(`  insider_filings_v2:       ${filingTotal.data().count.toLocaleString()}`);
  console.log("");

  // Distinct source_zips on a 10K-doc sample
  console.log("Sampling 10K transactions for distinct source_zip values...");
  const snap = await txCol.select("source_zip").limit(10000).get();
  const zips = new Map<string, number>();
  for (const d of snap.docs) {
    const z = (d.data() as { source_zip?: string }).source_zip ?? "(missing)";
    zips.set(z, (zips.get(z) ?? 0) + 1);
  }
  for (const [z, n] of [...zips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${z.padEnd(28)} ${n.toLocaleString()} (from 10K sample)`);
  }
  console.log("");

  // Specifically look for 2006q1 rows (the in_progress quarter)
  console.log("2006q1 rows specifically (count via direct field filter)...");
  const q2006 = await txCol
    .where("source_zip", "==", "2006q1_form345.zip")
    .count()
    .get();
  console.log(`  2006q1 transactions in Firestore: ${q2006.data().count.toLocaleString()}`);

  const q2006Hold = await holdCol
    .where("source_zip", "==", "2006q1_form345.zip")
    .count()
    .get();
  console.log(`  2006q1 holdings in Firestore:     ${q2006Hold.data().count.toLocaleString()}`);

  const q2006Filing = await filingCol
    .where("source_zip", "==", "2006q1_form345.zip")
    .count()
    .get();
  console.log(`  2006q1 filings in Firestore:      ${q2006Filing.data().count.toLocaleString()}`);
  console.log("");

  console.log("(Expected post-orchestrator-restart for 2006q1: 234,592 / 110,258 / 83,657)");
  console.log("");
  console.log("Pilot 2023q1 (was already completed before outage)...");
  const q2023 = await txCol
    .where("source_zip", "==", "2023q1_form345.zip")
    .count()
    .get();
  console.log(`  2023q1 transactions: ${q2023.data().count.toLocaleString()} (expect 148,685)`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
