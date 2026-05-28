/**
 * Confirm the post-flip handler returns rows with BOTH v2 native fields
 * AND legacy field aliases (the shim). Hits the LOCAL handler — same code
 * path the deployed MCP function will use.
 *
 * Call get_insider_transactions WITHOUT data_source (relies on new default
 * = bulk_v2). Inspect one row. Confirm:
 *   - row has v2 fields: aff10b5one, footnote_refs, row_type, schema_era
 *   - row has legacy aliases: disclosure_date, shares, officer_name, etc.
 *   - row.transaction_type is "buy" or "sell" (NOT "nonderiv"/"deriv")
 *   - row.row_type carries the v2 source-table discriminator
 */
import { handler } from "../src/tools/insider-transactions.js";

async function main() {
  console.log("=== Acceptance: default-flip + shim round-trip ===\n");
  console.log("Calling handler({ ticker: 'PRTA', limit: 3 })  (no data_source — uses default)\n");

  const env = (await handler({ ticker: "PRTA", limit: 3 })) as { results: Record<string, unknown>[]; count: number; query: Record<string, unknown> };

  console.log(`Response envelope: count=${env.count}`);
  console.log(`Query echo:        ${JSON.stringify(env.query)}`);

  if (env.count === 0) {
    console.log("⚠ No rows returned — check ticker / Firestore state");
    process.exit(1);
  }

  const row = env.results[0] as Record<string, unknown>;
  console.log("\n--- First row, full keys ---");
  const keys = Object.keys(row).sort();
  console.log(keys.join(", "));

  // Pick the key fields and show side-by-side
  console.log("\n--- Field check ---");

  const V2_NATIVE = [
    "aff10b5one",
    "schema_era",
    "footnote_refs",
    "row_type",
    "reporting_owners",
    "trans_code",
    "trans_shares",
    "trans_price_per_share",
    "filing_date",
    "source",
    "source_zip",
    "document_type",
  ];
  const LEGACY_ALIASES = [
    "disclosure_date",
    "transaction_code",
    "shares",
    "price_per_share",
    "total_value",
    "officer_name",
    "is_derivative",
    "reporting_lag_days",
    "data_source",
    "sec_filing_url",
    "acquired_disposed",
    "shares_owned_after",
    "conversion_or_exercise_price",
  ];

  let pass = true;

  console.log("\nv2 native fields present:");
  for (const f of V2_NATIVE) {
    const has = f in row;
    console.log(`  ${has ? "✓" : "✗"}  ${f}`);
    if (!has) pass = false;
  }

  console.log("\nLegacy aliases present:");
  for (const f of LEGACY_ALIASES) {
    const has = f in row;
    console.log(`  ${has ? "✓" : "✗"}  ${f}`);
    if (!has) pass = false;
  }

  console.log("\nCritical semantic checks:");
  const txType = row.transaction_type;
  const isLegacy = txType === "buy" || txType === "sell";
  console.log(`  transaction_type = ${JSON.stringify(txType)}  ${isLegacy ? "✓ (legacy semantic)" : "✗ (should be 'buy' or 'sell')"}`);
  if (!isLegacy) pass = false;

  const rowType = row.row_type;
  const isV2 = rowType === "nonderiv" || rowType === "deriv";
  console.log(`  row_type         = ${JSON.stringify(rowType)}  ${isV2 ? "✓ (v2 source-table discriminator)" : "✗ (should be 'nonderiv' or 'deriv')"}`);
  if (!isV2) pass = false;

  // Cross-field invariant: disclosure_date should equal filing_date (aliased)
  if (row.disclosure_date !== row.filing_date) {
    console.log(`  ✗ disclosure_date (${row.disclosure_date}) != filing_date (${row.filing_date})`);
    pass = false;
  } else {
    console.log(`  ✓ disclosure_date == filing_date (alias works)`);
  }
  if (row.shares !== row.trans_shares) {
    console.log(`  ✗ shares (${row.shares}) != trans_shares (${row.trans_shares})`);
    pass = false;
  } else {
    console.log(`  ✓ shares == trans_shares (alias works)`);
  }
  if (row.officer_name !== row.reporting_owner_name) {
    console.log(`  ✗ officer_name (${row.officer_name}) != reporting_owner_name (${row.reporting_owner_name})`);
    pass = false;
  } else {
    console.log(`  ✓ officer_name == reporting_owner_name (alias works)`);
  }

  console.log(`\n${pass ? "✓ ACCEPTANCE PASS — default flipped, shim active, both shapes present" : "⚠ ACCEPTANCE FAIL — something missing"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
