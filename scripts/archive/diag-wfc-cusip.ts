/**
 * Diagnostic: do institutional_holdings rows exist for WFC's CUSIP
 * (949746101) with blank/null ticker? If so, the ticker-enrichment
 * gap is real and the WFC query returning 0 is a data-quality bug,
 * not a missing-records bug.
 *
 * Also: scan a sample of the whole collection for blank-ticker rows
 * to estimate how widespread the gap is.
 */
import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();

  // ── A.1: WFC CUSIP direct lookup ─────────────────────────────────────
  const WFC_CUSIP = "949746101";
  console.log(`\n=== A.1: institutional_holdings where cusip = "${WFC_CUSIP}" ===`);
  const wfcSnap = await db
    .collection("institutional_holdings")
    .where("cusip", "==", WFC_CUSIP)
    .limit(10)
    .get();
  console.log(`  rows: ${wfcSnap.size}`);
  for (const doc of wfcSnap.docs.slice(0, 5)) {
    const d = doc.data() as Record<string, unknown>;
    console.log(`  ${doc.id}`);
    console.log(`    ticker        = ${JSON.stringify(d.ticker)}`);
    console.log(`    cusip         = ${JSON.stringify(d.cusip)}`);
    console.log(`    fund_name     = ${JSON.stringify(d.fund_name)}`);
    console.log(`    company_name  = ${JSON.stringify(d.company_name)}`);
    console.log(`    market_value  = ${JSON.stringify(d.market_value)}`);
  }

  // ── A.2: WFC ticker direct lookup (the path the tool uses) ──────────
  console.log(`\n=== A.2: institutional_holdings where ticker = "WFC" ===`);
  const wfcByTicker = await db
    .collection("institutional_holdings")
    .where("ticker", "==", "WFC")
    .limit(3)
    .get();
  console.log(`  rows: ${wfcByTicker.size}`);

  // ── A.3: count how many recent rows have blank/null ticker ──────────
  console.log(`\n=== A.3: sample 5000 most-recent rows, count blank ticker ===`);
  const sample = await db
    .collection("institutional_holdings")
    .orderBy("scraped_at", "desc")
    .limit(5000)
    .get();
  let blank = 0;
  let nonblank = 0;
  const blankCusips = new Map<string, number>();
  for (const doc of sample.docs) {
    const d = doc.data() as Record<string, unknown>;
    const t = (d.ticker ?? "") as string;
    if (!t || t.trim() === "" || t === "--") {
      blank++;
      const c = (d.cusip ?? "?") as string;
      blankCusips.set(c, (blankCusips.get(c) ?? 0) + 1);
    } else {
      nonblank++;
    }
  }
  console.log(`  total sampled: ${sample.size}`);
  console.log(`  with ticker:   ${nonblank}`);
  console.log(`  blank ticker:  ${blank}  (${((blank / sample.size) * 100).toFixed(1)}%)`);
  console.log(`  distinct blank-ticker CUSIPs in sample: ${blankCusips.size}`);
  // Top 10 blank-ticker CUSIPs by holder count
  const top = Array.from(blankCusips.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log(`  top blank-ticker CUSIPs (cusip → holder count in sample):`);
  for (const [c, n] of top) console.log(`    ${c}  → ${n}`);

  // ── A.4: cusip_map lookup — is WFC's CUSIP in the cache? ────────────
  console.log(`\n=== A.4: cusip_map cache for ${WFC_CUSIP} ===`);
  const mapDoc = await db.collection("cusip_map").doc(WFC_CUSIP).get();
  if (mapDoc.exists) {
    console.log(`  EXISTS: ${JSON.stringify(mapDoc.data())}`);
  } else {
    console.log(`  MISSING — CUSIP→ticker cache has no entry for WFC's CUSIP`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
