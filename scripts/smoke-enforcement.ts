import { handler } from "../src/tools/enforcement-actions.js";
import type {
  EnforcementAction,
  ResultEnvelope,
} from "../src/types.js";

async function run(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const r = (await handler(args)) as ResultEnvelope<EnforcementAction>;
  console.log(
    JSON.stringify(
      {
        query: args,
        count: r.count,
        has_more: r.has_more,
        sample: r.results.slice(0, 5).map((a) => ({
          id: a.action_id,
          source: a.source,
          when: a.published_date,
          title: a.title.slice(0, 80),
          component: a.agency_component,
          number: a.release_number,
          topics: a.topics.slice(0, 3),
        })),
      },
      null,
      2,
    ),
  );
}

await run("TEST 1: SEC only, most recent", { source: "sec", limit: 5 });
await run("TEST 2: DOJ only, most recent", { source: "doj", limit: 5 });
await run("TEST 3: title substring 'fraud'", { title: "fraud", limit: 5 });
await run("TEST 4: text 'insider trading' (full-text)", {
  text: "insider trading",
  limit: 5,
});
await run("TEST 5: agency 'criminal division' filter", {
  agency_component: "criminal",
  limit: 5,
});

console.log("\n=== TEST 6: validation error ===");
try {
  await handler({ source: "bogus" });
  console.log("FAIL");
} catch (e) {
  console.log("OK: " + (e as Error).message);
}

process.exit(0);
