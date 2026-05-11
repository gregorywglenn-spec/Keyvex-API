import { handler } from "../src/tools/fec-candidate-profile.js";
import type { FecCandidateProfile, ResultEnvelope } from "../src/types.js";

console.log("=== TEST 1: direct candidate_id lookup ===");
const r1 = (await handler({
  candidate_id: "S2PA00661",
  include_committees: true,
})) as ResultEnvelope<FecCandidateProfile>;
console.log(
  JSON.stringify(
    {
      count: r1.count,
      candidate: r1.results[0]
        ? {
            id: r1.results[0].candidate_id,
            name: r1.results[0].name,
            party: r1.results[0].party,
            committees: r1.results[0].committees?.length ?? 0,
          }
        : null,
    },
    null,
    2,
  ),
);

console.log("\n=== TEST 2: substring search by name (active_only) ===");
const r2 = (await handler({
  candidate_name: "mccormick",
  office: "S",
  state: "PA",
  active_only: true,
  include_committees: false,
})) as ResultEnvelope<FecCandidateProfile>;
console.log(
  JSON.stringify(
    {
      count: r2.count,
      results: r2.results.map((c) => ({
        id: c.candidate_id,
        name: c.name,
        party: c.party,
        incumbent_challenge: c.incumbent_challenge,
      })),
    },
    null,
    2,
  ),
);

console.log("\n=== TEST 3: state + office + party filter ===");
const r3 = (await handler({
  state: "PA",
  office: "S",
  party: "REP",
  active_only: true,
  include_committees: false,
  limit: 10,
})) as ResultEnvelope<FecCandidateProfile>;
console.log(
  JSON.stringify(
    {
      count: r3.count,
      has_more: r3.has_more,
      results: r3.results.map((c) => ({
        id: c.candidate_id,
        name: c.name,
        incumbent_challenge: c.incumbent_challenge,
        last_file_date: c.last_file_date,
      })),
    },
    null,
    2,
  ),
);

console.log("\n=== TEST 4: validation error path ===");
try {
  await handler({ candidate_id: "INVALID" });
  console.log("FAIL: expected validation error");
} catch (e) {
  console.log("OK: " + (e as Error).message);
}

process.exit(0);
