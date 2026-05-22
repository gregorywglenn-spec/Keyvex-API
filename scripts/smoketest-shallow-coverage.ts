/**
 * Smoketest for Greg's 2026-05-22 federal_contracts coverage bug.
 *
 * Before:
 *   queryFederalContractAwards({recipient_name:"Lockheed"}) returns ~6
 *   records max $42M with has_more=false. No notice. Agent assumes
 *   completeness; assumption is structurally wrong (rolling 7-day
 *   action_date window misses historical mega-contracts).
 *
 * After:
 *   Same query returns the same data PLUS a coverage_warning explaining
 *   the rolling-window limitation + pointing to USAspending.gov for
 *   full history.
 *
 * Tests:
 *   - Greg's exact Lockheed Martin repro
 *   - A non-empty deep query (Triad Nat'l Sec, $35B award in collection)
 *     to verify the notice fires regardless of result count
 *   - An empty entity query (random name) to verify shallow notice
 *     takes precedence over the "no records match" generic message
 *   - federal_grants gets the same treatment (same scraper shape)
 *   - A NON-shallow collection (insider_trades) does NOT get a shallow
 *     notice — negative control to confirm scope is narrow
 */
import {
  queryFederalContractAwards,
  queryFederalGrants,
  queryInsiderTransactions,
} from "../src/firestore.js";

async function main() {
  let pass = 0;
  let fail = 0;

  const expect = (name: string, cond: boolean, detail = "") => {
    if (cond) {
      pass++;
      console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
    } else {
      fail++;
      console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
  };

  console.log("=== federal_contracts: Greg's Lockheed repro ===");
  const r1 = await queryFederalContractAwards({
    recipient_name: "Lockheed",
    limit: 10,
  } as Parameters<typeof queryFederalContractAwards>[0]);
  console.log(`  results: ${r1.results.length}`);
  console.log(`  coverage_warning present: ${!!r1.coverage_warning}`);
  expect(
    "federal_contracts with thin result returns shallow notice",
    !!r1.coverage_warning &&
      r1.coverage_warning.includes("rolling slice") &&
      r1.coverage_warning.includes("usaspending.gov"),
  );

  console.log("\n=== federal_contracts: NON-empty deep query (the $35B Triad) ===");
  const r2 = await queryFederalContractAwards({
    sort_by: "award_amount",
    sort_order: "desc",
    limit: 3,
  } as Parameters<typeof queryFederalContractAwards>[0]);
  console.log(`  results: ${r2.results.length}`);
  console.log(`  coverage_warning present: ${!!r2.coverage_warning}`);
  expect(
    "federal_contracts NON-empty also gets the shallow notice",
    !!r2.coverage_warning && r2.coverage_warning.includes("rolling slice"),
  );

  console.log("\n=== federal_contracts: empty entity query (random name) ===");
  const r3 = await queryFederalContractAwards({
    recipient_name: "ZZZNOSUCHCOMPANY",
    limit: 5,
  } as Parameters<typeof queryFederalContractAwards>[0]);
  console.log(`  results: ${r3.results.length}`);
  console.log(`  coverage_warning present: ${!!r3.coverage_warning}`);
  expect(
    "federal_contracts empty query also gets shallow notice (takes precedence over generic empty)",
    !!r3.coverage_warning && r3.coverage_warning.includes("rolling slice"),
  );

  console.log("\n=== federal_grants: same scraper shape, same notice ===");
  const r4 = await queryFederalGrants({
    recipient_name: "University",
    limit: 3,
  } as Parameters<typeof queryFederalGrants>[0]);
  console.log(`  results: ${r4.results.length}`);
  console.log(`  coverage_warning present: ${!!r4.coverage_warning}`);
  expect(
    "federal_grants gets the shallow notice",
    !!r4.coverage_warning && r4.coverage_warning.includes("rolling slice"),
  );

  console.log("\n=== insider_trades: negative control — should NOT get shallow notice ===");
  const r5 = await queryInsiderTransactions({
    ticker: "AAPL",
    limit: 3,
  } as Parameters<typeof queryInsiderTransactions>[0]);
  console.log(`  results: ${r5.results.length}`);
  console.log(`  coverage_warning present: ${!!r5.coverage_warning}`);
  expect(
    "insider_trades does NOT get a shallow notice (it's a deep collection)",
    !r5.coverage_warning ||
      !r5.coverage_warning.includes("rolling slice"),
  );

  console.log("");
  console.log(`Summary: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNHANDLED:", e);
  process.exit(2);
});
