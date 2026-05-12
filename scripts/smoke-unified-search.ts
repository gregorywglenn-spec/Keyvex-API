/**
 * Local smoke-test for the unified_search MCP tool. Bypasses MCP transport
 * and calls the handler directly against live Firestore via the local
 * service-account.json. Validates that:
 *   1. The handler accepts the documented input shape
 *   2. Fan-out to all applicable collections returns without throwing
 *   3. The envelope structure matches UnifiedSearchEnvelope
 *
 * Run: npx tsx scripts/smoke-unified-search.ts
 */
import { handler } from "../src/tools/unified-search.js";
import type { UnifiedSearchEnvelope } from "../src/types.js";

async function runCase(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  console.log(`args: ${JSON.stringify(args)}`);
  const t0 = Date.now();
  try {
    const result = (await handler(args)) as UnifiedSearchEnvelope;
    const elapsed = Date.now() - t0;
    console.log(`time: ${elapsed}ms`);
    console.log(`sources_queried (${result.sources_queried.length}):`, result.sources_queried.join(", "));
    console.log(`sources_with_results (${result.sources_with_results.length}):`, result.sources_with_results.join(", "));
    console.log(`total_count: ${result.total_count}`);
    for (const src of result.sources_with_results) {
      const block = result.results_by_source[src]!;
      console.log(`  ${src}: ${block.count} row(s), has_more=${block.has_more}`);
    }
    // Surface any errored sources
    for (const [name, block] of Object.entries(result.results_by_source)) {
      if (block.error) console.log(`  ${name}: ERROR — ${block.error}`);
    }
  } catch (err) {
    console.log(`HANDLER THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── ticker fan-out (10 collections) ────────────────────────────────────
await runCase("ticker=LMT (Lockheed Martin)", { ticker: "LMT", per_source_limit: 2 });

// ── bioguide_id fan-out (2 collections) ─────────────────────────────────
await runCase("bioguide_id=P000197 (Pelosi)", { bioguide_id: "P000197", per_source_limit: 3 });

// ── company_cik fan-out (8 collections) ─────────────────────────────────
// Apple CIK
await runCase("company_cik=0000320193 (Apple)", { company_cik: "0000320193", per_source_limit: 2 });

// ── source whitelist ────────────────────────────────────────────────────
await runCase("ticker=NVDA + sources whitelist", {
  ticker: "NVDA",
  sources: ["insider_trades", "material_events", "congressional_trades"],
  per_source_limit: 2,
});

// ── error case: no identifiers ──────────────────────────────────────────
await runCase("missing identifier (should throw)", {});

// ── invalid bioguide_id ─────────────────────────────────────────────────
await runCase("invalid bioguide_id format", { bioguide_id: "lowercase999" });

process.exit(0);
