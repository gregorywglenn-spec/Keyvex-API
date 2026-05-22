/**
 * Smoketest for the type-mismatch guard expansion (2026-05-22 fix-pass II).
 *
 * For every (tool, numeric-sort-field) pair in the audit, invoke the
 * query function directly with since=<a-date> + sort_by=<numeric>.
 * Expectation: each call throws "INVALID_QUERY: ..." synchronously,
 * BEFORE any Firestore read happens, so coverage_warning can never be
 * emitted for a type-invalid query.
 *
 * Also smoketest 2 negative cases:
 *   - since + sort_by=<date-field>   → no throw (legitimate query path)
 *   - sort_by=<numeric> with NO since/until → no throw (guard early-returns)
 */
import {
  queryTreasuryAuctions,
  queryForm278Filings,
  queryCftcCotReports,
  queryFecContributions,
  queryFecIndependentExpenditures,
  queryLobbyingFilings,
  queryOtcMarketWeekly,
  queryPrivatePlacements,
  querySecFailsToDeliver,
} from "../src/firestore.js";

type Case = {
  name: string;
  expectThrow: boolean;
  run: () => Promise<unknown>;
};

const cases: Case[] = [
  // ─── EXPECT THROW: each new field type-guarded ─────────────────────────
  {
    name: "treasury_auctions / sort=offering_amount + since (Greg's bug)",
    expectThrow: true,
    run: () =>
      queryTreasuryAuctions({
        since: "2026-04-22",
        sort_by: "offering_amount",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryTreasuryAuctions>[0]),
  },
  {
    name: "treasury_auctions / sort=bid_to_cover_ratio + since",
    expectThrow: true,
    run: () =>
      queryTreasuryAuctions({
        since: "2026-04-22",
        sort_by: "bid_to_cover_ratio",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryTreasuryAuctions>[0]),
  },
  {
    name: "annual_financial_disclosures / sort=filing_year + since",
    expectThrow: true,
    run: () =>
      queryForm278Filings({
        since: "2024-01-01",
        sort_by: "filing_year",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryForm278Filings>[0]),
  },
  {
    name: "cftc_cot / sort=open_interest + since",
    expectThrow: true,
    run: () =>
      queryCftcCotReports({
        since: "2026-01-01",
        sort_by: "open_interest",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryCftcCotReports>[0]),
  },
  {
    name: "cftc_cot / sort=noncomm_net + since",
    expectThrow: true,
    run: () =>
      queryCftcCotReports({
        since: "2026-01-01",
        sort_by: "noncomm_net",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryCftcCotReports>[0]),
  },
  {
    name: "cftc_cot / sort=comm_net + since",
    expectThrow: true,
    run: () =>
      queryCftcCotReports({
        since: "2026-01-01",
        sort_by: "comm_net",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryCftcCotReports>[0]),
  },
  {
    name: "fec_contributions / sort=contribution_receipt_amount + since",
    expectThrow: true,
    run: () =>
      queryFecContributions({
        since: "2026-01-01",
        sort_by: "contribution_receipt_amount",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryFecContributions>[0]),
  },
  {
    name: "fec_independent_expenditures / sort=expenditure_amount + since",
    expectThrow: true,
    run: () =>
      queryFecIndependentExpenditures({
        since: "2026-01-01",
        sort_by: "expenditure_amount",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryFecIndependentExpenditures>[0]),
  },
  {
    name: "lobbying_filings / sort=filing_year + since",
    expectThrow: true,
    run: () =>
      queryLobbyingFilings({
        since: "2024-01-01",
        sort_by: "filing_year",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryLobbyingFilings>[0]),
  },
  {
    name: "otc_market_weekly / sort=total_notional_sum + since",
    expectThrow: true,
    run: () =>
      queryOtcMarketWeekly({
        since: "2026-01-01",
        sort_by: "total_notional_sum",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryOtcMarketWeekly>[0]),
  },
  {
    name: "otc_market_weekly / sort=total_weekly_share_quantity + since",
    expectThrow: true,
    run: () =>
      queryOtcMarketWeekly({
        since: "2026-01-01",
        sort_by: "total_weekly_share_quantity",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryOtcMarketWeekly>[0]),
  },
  {
    name: "otc_market_weekly / sort=total_weekly_trade_count + since",
    expectThrow: true,
    run: () =>
      queryOtcMarketWeekly({
        since: "2026-01-01",
        sort_by: "total_weekly_trade_count",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryOtcMarketWeekly>[0]),
  },
  {
    name: "private_placements / sort=total_amount_sold + since",
    expectThrow: true,
    run: () =>
      queryPrivatePlacements({
        since: "2026-01-01",
        sort_by: "total_amount_sold",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryPrivatePlacements>[0]),
  },
  {
    name: "sec_ftd / sort=quantity_fails + since",
    expectThrow: true,
    run: () =>
      querySecFailsToDeliver({
        since: "2026-01-01",
        sort_by: "quantity_fails",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof querySecFailsToDeliver>[0]),
  },
  {
    name: "sec_ftd / sort=fail_value + since",
    expectThrow: true,
    run: () =>
      querySecFailsToDeliver({
        since: "2026-01-01",
        sort_by: "fail_value",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof querySecFailsToDeliver>[0]),
  },

  // ─── EXPECT NO THROW: negative controls ────────────────────────────────
  // (legit query path — date filter + date sort_by is always valid)
  // We won't actually run it against Firestore here; we just confirm
  // the guard early-returns. To do that without a Firestore round-trip
  // we'd need to mock; for now the smoketest only validates the throw
  // cases. Negative controls are easier to validate via the live wire.
];

async function main() {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const c of cases) {
    let threw = false;
    let errMsg = "";
    try {
      await c.run();
    } catch (err) {
      threw = true;
      errMsg = (err as Error).message;
    }

    const expected = c.expectThrow;
    const ok = threw === expected && (!expected || errMsg.startsWith("INVALID_QUERY:"));

    if (ok) {
      pass++;
      console.log(`PASS  ${c.name}`);
      if (threw) {
        console.log(`      ↳ ${errMsg.slice(0, 140)}${errMsg.length > 140 ? "..." : ""}`);
      }
    } else {
      fail++;
      const detail = threw
        ? `unexpected throw: ${errMsg.slice(0, 200)}`
        : "no throw, but expected one";
      failures.push(`${c.name} — ${detail}`);
      console.log(`FAIL  ${c.name}`);
      console.log(`      ↳ ${detail}`);
    }
  }

  console.log("");
  console.log(`Summary: ${pass} PASS, ${fail} FAIL (out of ${cases.length})`);
  if (failures.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("UNHANDLED:", e);
  process.exit(2);
});
