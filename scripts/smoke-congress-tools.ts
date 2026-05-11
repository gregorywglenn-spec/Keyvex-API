import { handler as billsHandler } from "../src/tools/bills.js";
import { handler as votesHandler } from "../src/tools/roll-call-votes.js";
import type {
  Bill,
  ResultEnvelope,
  RollCallVote,
} from "../src/types.js";

async function bills(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const r = (await billsHandler(args)) as ResultEnvelope<Bill>;
  console.log(
    JSON.stringify(
      {
        query: args,
        count: r.count,
        has_more: r.has_more,
        sample: r.results.slice(0, 3).map((b) => ({
          id: b.bill_id,
          type: b.bill_type,
          number: b.number,
          title: b.title.slice(0, 80),
          chamber: b.origin_chamber,
          latest: `${b.latest_action_date} — ${b.latest_action_text.slice(0, 60)}`,
        })),
      },
      null,
      2,
    ),
  );
}

async function votes(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const r = (await votesHandler(args)) as ResultEnvelope<RollCallVote>;
  console.log(
    JSON.stringify(
      {
        query: args,
        count: r.count,
        has_more: r.has_more,
        sample: r.results.slice(0, 3).map((v) => ({
          id: v.vote_id,
          chamber: v.chamber,
          rc: v.roll_call_number,
          type: v.vote_type,
          result: v.result,
          bill: v.bill_id || "(procedural)",
          when: v.start_date,
        })),
      },
      null,
      2,
    ),
  );
}

await bills("TEST 1: bills — congress=119, type=HR, sort latest", {
  congress: 119,
  bill_type: "HR",
  limit: 5,
});

await bills("TEST 2: bills — title substring 'artificial intelligence'", {
  title: "artificial intelligence",
  congress: 119,
  limit: 5,
});

await bills("TEST 3: bills — direct id lookup '119-HR-134'", {
  bill_id: "119-HR-134",
});

await votes("TEST 4: votes — house session 1, recent", {
  chamber: "house",
  congress: 119,
  session_number: 1,
  limit: 5,
});

await votes("TEST 5: votes — failed votes only", {
  chamber: "house",
  result: "Failed",
  limit: 5,
});

console.log("\n=== TEST 6: validation error path ===");
try {
  await billsHandler({ bill_id: "junk" });
  console.log("FAIL: expected validation error");
} catch (e) {
  console.log("OK: " + (e as Error).message);
}

process.exit(0);
