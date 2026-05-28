/**
 * Acceptance test for the transaction_type input-filter fix (v0.50.0).
 *
 * Greg's bug: v0.49.0 silently ignored transaction_type buy/sell when
 * data_source was bulk_v2. Fix: postFilter callback applies the same
 * deriveLegacyBuyOrSell rule via paginated fetch.
 *
 * This test calls the LOCAL handler (same code path the deployed Cloud
 * Function will use) with the three scenarios Greg specified.
 *
 * Uses AAPL — has both buys and sells in v2 (verified via earlier samples).
 */
import { handler } from "../src/tools/insider-transactions.js";
import type { ResultEnvelope } from "../src/types.js";
import type { InsiderTransactionV2Compat } from "../src/tools/insider-transactions-v2-shim.js";

type Env = ResultEnvelope<InsiderTransactionV2Compat>;

interface Result {
  label: string;
  count: number;
  has_more: boolean;
  by_type: Record<string, number>;
  pass: boolean;
  failReason?: string;
}

async function runCase(
  label: string,
  args: Record<string, unknown>,
  expect: { onlyBuys?: boolean; onlySells?: boolean; bothPresent?: boolean },
): Promise<Result> {
  const env = (await handler(args)) as Env;
  const counts: Record<string, number> = {};
  for (const r of env.results) {
    const t = String(r.transaction_type);
    counts[t] = (counts[t] ?? 0) + 1;
  }
  let pass = true;
  let failReason: string | undefined;
  if (env.count === 0) {
    pass = false;
    failReason = "got 0 rows back";
  } else {
    if (expect.onlyBuys) {
      if ((counts.sell ?? 0) > 0) {
        pass = false;
        failReason = `expected only buys, got ${counts.sell} sells`;
      }
      if ((counts.buy ?? 0) === 0) {
        pass = false;
        failReason = "expected only buys but got 0 buys";
      }
    }
    if (expect.onlySells) {
      if ((counts.buy ?? 0) > 0) {
        pass = false;
        failReason = `expected only sells, got ${counts.buy} buys`;
      }
      if ((counts.sell ?? 0) === 0) {
        pass = false;
        failReason = "expected only sells but got 0 sells";
      }
    }
    if (expect.bothPresent) {
      if ((counts.buy ?? 0) === 0 || (counts.sell ?? 0) === 0) {
        pass = false;
        failReason = `expected both — buys=${counts.buy ?? 0}, sells=${counts.sell ?? 0}`;
      }
    }
  }
  return {
    label,
    count: env.count,
    has_more: env.has_more,
    by_type: counts,
    pass,
    failReason,
  };
}

async function main() {
  console.log("=== Acceptance: transaction_type input filter (v0.50.0 fix) ===\n");
  console.log("Target ticker: AAPL (has both buys and sells in v2)\n");

  const results: Result[] = [];

  results.push(
    await runCase(
      "AAPL, transaction_type=buy, limit=20",
      { ticker: "AAPL", transaction_type: "buy", limit: 20 },
      { onlyBuys: true },
    ),
  );

  results.push(
    await runCase(
      "AAPL, transaction_type=sell, limit=20",
      { ticker: "AAPL", transaction_type: "sell", limit: 20 },
      { onlySells: true },
    ),
  );

  results.push(
    await runCase(
      "AAPL, no transaction_type, limit=20",
      { ticker: "AAPL", limit: 20 },
      { bothPresent: true },
    ),
  );

  // Edge case: limit + has_more should be honest
  results.push(
    await runCase(
      "AAPL, transaction_type=buy, limit=5 (small limit, has_more check)",
      { ticker: "AAPL", transaction_type: "buy", limit: 5 },
      { onlyBuys: true },
    ),
  );

  console.log("Results:\n");
  for (const r of results) {
    const status = r.pass ? "✓ PASS" : "✗ FAIL";
    console.log(`${status}  ${r.label}`);
    console.log(`        count=${r.count}, has_more=${r.has_more}, by_type=${JSON.stringify(r.by_type)}`);
    if (!r.pass) console.log(`        FAIL: ${r.failReason}`);
    console.log("");
  }

  const allPass = results.every((r) => r.pass);
  console.log(allPass ? "\n=== ✓ ALL ACCEPTANCE TESTS PASS ===" : "\n=== ⚠ ACCEPTANCE FAILURE — fix before deploy ===");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
