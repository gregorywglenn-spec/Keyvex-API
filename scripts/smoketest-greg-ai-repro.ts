/**
 * Greg's exact repro from 2026-05-22:
 *
 *   - get_enforcement_actions(text="AI") returned 15 results, 14 noise.
 *   - bills title="AI" returned 243 garbage matches.
 *
 * Re-run after the matchesSubstringSafe helper is wired in. Expectation:
 * dramatically fewer matches (only genuine "AI"-as-token results).
 *
 * Prints both counts + a sample of the first 5 matched titles so we
 * can verify by eye.
 */
import { queryEnforcementActions, queryBills } from "../src/firestore.js";

async function main() {
  console.log("=== get_enforcement_actions(text='AI') ===");
  try {
    const r = await queryEnforcementActions({
      text: "AI",
      limit: 50,
    } as Parameters<typeof queryEnforcementActions>[0]);
    console.log(`  results: ${r.results.length}  has_more: ${r.has_more}`);
    if (r.coverage_warning) console.log(`  warning: ${r.coverage_warning.slice(0, 100)}...`);
    console.log(`  sample of first matches (by title):`);
    for (const a of r.results.slice(0, 10)) {
      const a2 = a as unknown as { title?: string; teaser?: string; description?: string };
      const t = a2.title ?? "(no title)";
      console.log(`    - ${t.slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("");
  console.log("=== get_bills(title='AI') ===");
  try {
    const r = await queryBills({
      title: "AI",
      limit: 50,
    } as Parameters<typeof queryBills>[0]);
    console.log(`  results: ${r.results.length}  has_more: ${r.has_more}`);
    if (r.coverage_warning) console.log(`  warning: ${r.coverage_warning.slice(0, 100)}...`);
    console.log(`  sample of first matches:`);
    for (const b of r.results.slice(0, 10)) {
      const b2 = b as unknown as { title?: string; bill_id?: string };
      const t = b2.title ?? "(no title)";
      console.log(`    - [${b2.bill_id ?? "?"}] ${t.slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 200)}`);
  }

  console.log("");
  console.log("=== Negative control: get_bills(title='artificial intelligence') ===");
  try {
    const r = await queryBills({
      title: "artificial intelligence",
      limit: 5,
    } as Parameters<typeof queryBills>[0]);
    console.log(`  results: ${r.results.length}  has_more: ${r.has_more}`);
    for (const b of r.results.slice(0, 5)) {
      const b2 = b as unknown as { title?: string; bill_id?: string };
      const t = b2.title ?? "(no title)";
      console.log(`    - [${b2.bill_id ?? "?"}] ${t.slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${(e as Error).message.slice(0, 200)}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("UNHANDLED:", e);
  process.exit(2);
});
