import { handler } from "../src/tools/fec-candidate-profile.js";
import type { FecCandidateProfile, ResultEnvelope } from "../src/types.js";

const r = (await handler({
  candidate_id: "S2PA00661",
  include_committees: true,
})) as ResultEnvelope<FecCandidateProfile>;

const c = r.results[0];
if (c) {
  console.log(`Candidate: ${c.name} (${c.party}, ${c.office}-${c.state})`);
  console.log(`Cycles: ${c.cycles.join(", ")}`);
  console.log(`Committees (${c.committees?.length ?? 0}):`);
  for (const cmt of c.committees ?? []) {
    console.log(
      `  ${cmt.committee_id} | ${cmt.designation_full} | ${cmt.committee_type_full} | ${cmt.name} | last_file=${cmt.last_file_date}`,
    );
  }
}
process.exit(0);
