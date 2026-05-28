/**
 * Diagnostic: validate that Phase B Index Pass's "0 across the board"
 * result is a TRUE NULL (Phase A hasn't tagged anything yet because
 * forward-write only + no new ingestion since landing) vs a query bug.
 *
 * Read-only. No writes.
 */
import { getLiveDb } from "../src/firestore.js";

async function main(): Promise<void> {
  const db = await getLiveDb();

  // 1) Are there ANY rows in institutional_holdings that carry the
  //    verification_status field at all? (Phase A writes the field on
  //    new ingestion; historical rows omit it entirely.)
  console.log("─".repeat(72));
  console.log("Q1: Do ANY institutional_holdings rows carry verification_status?");
  console.log("─".repeat(72));
  // Use orderBy on verification_status — Firestore only returns rows that
  // have the field set (Firestore's orderBy semantics exclude rows missing
  // the ordered field). limit(5) for a cheap probe.
  const vsAny = await db
    .collection("institutional_holdings")
    .orderBy("verification_status")
    .limit(5)
    .get();
  console.log(`  rows with verification_status SET: ${vsAny.size} (probe of 5)`);
  for (const d of vsAny.docs) {
    const data = d.data() as Record<string, unknown>;
    console.log(
      `    ${d.id}: vs=${data.verification_status} acc=${data.accession_number} quarter=${data.quarter}`,
    );
  }

  // 2) What's the most recent filing_date in institutional_holdings?
  console.log("");
  console.log("─".repeat(72));
  console.log("Q2: Most recent institutional_holdings.filing_date");
  console.log("─".repeat(72));
  const recent13F = await db
    .collection("institutional_holdings")
    .orderBy("filing_date", "desc")
    .limit(3)
    .select("filing_date", "fund_cik", "verification_status", "position_change", "accession_number")
    .get();
  for (const d of recent13F.docs) {
    const data = d.data() as Record<string, unknown>;
    console.log(
      `    ${d.id}: filed=${data.filing_date} vs=${data.verification_status ?? "(unset)"} pc=${data.position_change ?? "(unset)"}`,
    );
  }

  // 3) Same for insider_transactions_v2 — any verification_status set?
  console.log("");
  console.log("─".repeat(72));
  console.log("Q3: Do ANY insider_transactions_v2 rows carry verification_status?");
  console.log("─".repeat(72));
  const vsInsV2 = await db
    .collection("insider_transactions_v2")
    .orderBy("verification_status")
    .limit(5)
    .get();
  console.log(`  rows with verification_status SET: ${vsInsV2.size} (probe of 5)`);

  // 4) Same for insider_trades legacy
  console.log("");
  console.log("─".repeat(72));
  console.log("Q4: Do ANY insider_trades rows carry verification_status?");
  console.log("─".repeat(72));
  const vsInsLeg = await db
    .collection("insider_trades")
    .orderBy("verification_status")
    .limit(5)
    .get();
  console.log(`  rows with verification_status SET: ${vsInsLeg.size} (probe of 5)`);

  // 5) Probe the COUNT of all-zero, NEW-tagged rows (VERIFIED) — these are
  //    the rows Phase A wrote on its (post-deploy) ingestion runs.
  console.log("");
  console.log("─".repeat(72));
  console.log("Q5: VERIFIED-tagged rows per collection (post-Phase-A ingestion)");
  console.log("─".repeat(72));
  for (const col of [
    "institutional_holdings",
    "insider_transactions_v2",
    "insider_trades",
  ]) {
    const agg = await db
      .collection(col)
      .where("verification_status", "==", "VERIFIED")
      .count()
      .get();
    console.log(`  ${col}: ${agg.data().count.toLocaleString()} VERIFIED rows`);
  }

  // 6) Sanity: how many TOTAL rows are in each collection? Ground the zero
  //    in a denominator so "0 of 0" reads different from "0 of millions."
  console.log("");
  console.log("─".repeat(72));
  console.log("Q6: Total rows per collection (denominator)");
  console.log("─".repeat(72));
  for (const col of [
    "institutional_holdings",
    "insider_transactions_v2",
    "insider_trades",
  ]) {
    const agg = await db.collection(col).count().get();
    console.log(`  ${col}: ${agg.data().count.toLocaleString()} rows total`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
