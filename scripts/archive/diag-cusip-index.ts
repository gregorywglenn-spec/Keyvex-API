import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();

  // A CUSIP we KNOW exists in the collection
  const CUSIP = "464287200";  // IVV per earlier probe

  console.log("=== TEST 1: where(cusip) only — pure equality (single-field auto-index) ===");
  try {
    const t0 = Date.now();
    const snap = await db.collection("institutional_holdings")
      .where("cusip", "==", CUSIP).limit(3).get();
    console.log(`  ${snap.size} rows in ${Date.now() - t0}ms — SUCCESS, no composite needed`);
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== TEST 2: where(cusip) + orderBy(market_value, desc) — what the current tool does ===");
  try {
    const t0 = Date.now();
    const snap = await db.collection("institutional_holdings")
      .where("cusip", "==", CUSIP)
      .orderBy("market_value", "desc")
      .limit(3).get();
    console.log(`  ${snap.size} rows in ${Date.now() - t0}ms — SUCCESS (composite index DOES exist)`);
  } catch (e) {
    const msg = (e as Error).message;
    const isIndexMissing = msg.includes("FAILED_PRECONDITION") || msg.includes("requires an index");
    console.log(`  ${isIndexMissing ? "INDEX_MISSING" : "OTHER ERROR"}: ${msg.slice(0, 300)}`);
  }

  console.log("\n=== TEST 3: actual queryInstitutionalHoldings({cusip: ...}) — through the tool ===");
  const { queryInstitutionalHoldings } = await import("../src/firestore.js");
  try {
    const r = await queryInstitutionalHoldings({ cusip: CUSIP } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  results: ${r.results.length}  has_more: ${r.has_more}`);
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 300)}`);
  }

  // Also test the case Greg reported (WFC ticker)
  console.log("\n=== TEST 4: where(ticker='WFC') only ===");
  try {
    const t0 = Date.now();
    const snap = await db.collection("institutional_holdings")
      .where("ticker", "==", "WFC").limit(3).get();
    console.log(`  ${snap.size} rows in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== TEST 5: where(ticker='WFC') + orderBy(market_value, desc) — through tool ===");
  try {
    const r = await queryInstitutionalHoldings({ ticker: "WFC" } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  results: ${r.results.length}  has_more: ${r.has_more}`);
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 300)}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
