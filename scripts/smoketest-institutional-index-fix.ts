import { queryInstitutionalHoldings, getLiveDb } from "../src/firestore.js";

async function main() {
  // Use a CUSIP that we know exists in the collection (from the earlier diag)
  const CUSIP = "464287200"; // IVV per the probe

  console.log("=== AFTER: queryInstitutionalHoldings({cusip}) — no explicit sort ===");
  try {
    const r = await queryInstitutionalHoldings({
      cusip: CUSIP,
      limit: 3,
    } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows, has_more=${r.has_more}`);
    for (const row of r.results) {
      console.log(`    ${row.fund_name} — ${row.ticker} — market_value=${row.market_value}`);
    }
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== AFTER: queryInstitutionalHoldings({ticker:'WFC'}) — known empty, should not error ===");
  try {
    const r = await queryInstitutionalHoldings({ ticker: "WFC", limit: 3 } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows (empty is correct — WFC not held by any of the 18 funds we ingest)`);
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== AFTER: queryInstitutionalHoldings({quarter:'2026-03-31'}) — equality only ===");
  try {
    const r = await queryInstitutionalHoldings({ quarter: "2026-03-31", limit: 3 } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows, has_more=${r.has_more}`);
    for (const row of r.results) {
      console.log(`    ${row.ticker.padEnd(8)} ${row.fund_name.slice(0, 40).padEnd(40)} mv=${row.market_value}`);
    }
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== AFTER: queryInstitutionalHoldings({position_change:'new'}) — equality only ===");
  try {
    const r = await queryInstitutionalHoldings({ position_change: "new", limit: 3 } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows, has_more=${r.has_more}`);
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== AFTER: queryInstitutionalHoldings({}) — no filter at all, default sort APPLIED ===");
  try {
    const r = await queryInstitutionalHoldings({ limit: 3 } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows`);
    for (const row of r.results) {
      console.log(`    ${row.ticker.padEnd(8)} ${row.fund_name.slice(0, 40).padEnd(40)} mv=${row.market_value}`);
    }
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== AFTER: queryInstitutionalHoldings({ticker:'AAPL',sort_by:'market_value'}) — explicit sort, should use composite ===");
  try {
    const r = await queryInstitutionalHoldings({ ticker: "AAPL", sort_by: "market_value", sort_order: "desc", limit: 3 } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows`);
    for (const row of r.results) {
      console.log(`    ${row.ticker.padEnd(8)} ${row.fund_name.slice(0, 40).padEnd(40)} mv=${row.market_value}`);
    }
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("\n=== AFTER: queryInstitutionalHoldings({min_value:50000000000}) — inequality, default sort kept ===");
  try {
    const r = await queryInstitutionalHoldings({ min_value: 50_000_000_000, limit: 3 } as Parameters<typeof queryInstitutionalHoldings>[0]);
    console.log(`  PASS  ${r.results.length} rows`);
    for (const row of r.results) {
      console.log(`    ${row.ticker.padEnd(8)} ${row.fund_name.slice(0, 40).padEnd(40)} mv=${row.market_value}`);
    }
  } catch (e) {
    console.log(`  FAIL  ${(e as Error).message.slice(0, 200)}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
