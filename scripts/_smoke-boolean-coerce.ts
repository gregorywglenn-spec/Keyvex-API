/**
 * Smoke test for v0.52.1 parseBooleanArg helper across tools.
 * Confirms wire-form strings ("true" / "false") coerce, native booleans
 * pass through, and garbage throws loudly.
 */
import { handler as insiderHandler } from "../src/tools/insider-transactions.js";
import { handler as fundHoldingsHandler } from "../src/tools/fund-holdings.js";
import { handler as tenderHandler } from "../src/tools/tender-offers.js";

async function tryIt(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    if (typeof r === "object" && r !== null && "count" in (r as Record<string, unknown>)) {
      console.log(`[PASS] ${label}  (count=${(r as Record<string, unknown>).count})`);
    } else {
      console.log(`[PASS] ${label}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[FAIL] ${label}: ${msg}`);
  }
}

async function main(): Promise<void> {
  await tryIt('insider include_non_open_market="true" (string)', () =>
    insiderHandler({ ticker: "AAPL", include_non_open_market: "true", limit: 1 }),
  );
  await tryIt("insider include_non_open_market=true (bool)", () =>
    insiderHandler({ ticker: "AAPL", include_non_open_market: true, limit: 1 }),
  );
  await tryIt('insider is_derivative="false" (string)', () =>
    insiderHandler({ ticker: "AAPL", is_derivative: "false", limit: 1 }),
  );
  // is_derivative is legacy-only (v2 uses source_table). Route through
  // data_source:"legacy" so the validator actually runs.
  await tryIt(
    "insider is_derivative=42 LEGACY path (BAD - must throw loudly)",
    () =>
      insiderHandler({
        data_source: "legacy",
        ticker: "AAPL",
        is_derivative: 42,
        limit: 1,
      }),
  );
  await tryIt(
    'insider is_derivative="true" LEGACY path (string)',
    () =>
      insiderHandler({
        data_source: "legacy",
        ticker: "AAPL",
        is_derivative: "true",
        limit: 1,
      }),
  );
  await tryIt('fund-holdings is_derivative="true" (string)', () =>
    fundHoldingsHandler({ ticker: "AAPL", is_derivative: "true", limit: 1 }),
  );
  await tryIt('tender-offers third_party_only="true" (string)', () =>
    tenderHandler({ third_party_only: "true", limit: 1 }),
  );
  await tryIt(
    'tender-offers exclude_amendments="garbage" (BAD - must throw loudly)',
    () => tenderHandler({ exclude_amendments: "garbage", limit: 1 }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
