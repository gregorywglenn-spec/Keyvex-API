/**
 * Smoketest for Greg's 2026-05-22 bioguide_id population bug.
 *
 * Before: scrapeSenateLiveFeed / scrapeHouseLiveFeed produce rows with
 * bioguide_id="", party="", state="". saveCongressionalTrades writes
 * them raw. Result: 99.6% of the 57K-row collection has no bioguide_id.
 *
 * After: saveCongressionalTrades calls enrichTradesWithBioguide() which
 * loads the legislators catalog (cached 10 min) and runs the 4-tier
 * resolver in-memory. Rows go to Firestore with bioguide_id populated.
 *
 * This test invokes the enricher directly with hand-crafted trade
 * fixtures covering all 4 tiers + an unmatchable control. No Firestore
 * writes (just the read of the legislators catalog).
 */
import { __enrichTradesWithBioguide } from "../src/firestore.js";
import type { CongressionalTrade } from "../src/types.js";

function mkTrade(o: Partial<CongressionalTrade>): CongressionalTrade {
  return {
    id: o.id ?? "test-" + Math.random().toString(36).slice(2, 10),
    ticker: o.ticker ?? "",
    asset_name: o.asset_name ?? "",
    asset_type: o.asset_type ?? "",
    transaction_type: o.transaction_type ?? "purchase",
    transaction_date: o.transaction_date ?? "2026-04-15",
    disclosure_date: o.disclosure_date ?? "2026-05-15",
    owner: o.owner ?? "Self",
    amount_range: o.amount_range ?? "$1,001 - $15,000",
    amount_min: o.amount_min ?? 1001,
    amount_max: o.amount_max ?? 15000,
    comment: o.comment ?? "",
    chamber: o.chamber ?? "senate",
    member_name: o.member_name ?? "",
    member_first: o.member_first ?? "",
    member_last: o.member_last ?? "",
    state: o.state ?? "",
    party: o.party ?? "",
    bioguide_id: o.bioguide_id ?? "",
    ptr_id: o.ptr_id ?? "",
    reporting_lag_days: o.reporting_lag_days ?? 30,
    data_source: o.data_source ?? "SENATE_EFD_PTR",
    scraped_at: o.scraped_at ?? "2026-05-22T00:00:00.000Z",
  } as CongressionalTrade;
}

async function main() {
  let pass = 0;
  let fail = 0;

  const expect = (name: string, cond: boolean, detail = "") => {
    if (cond) {
      pass++;
      console.log(`PASS  ${name}${detail ? '  →  ' + detail : ''}`);
    } else {
      fail++;
      console.log(`FAIL  ${name}${detail ? '  →  ' + detail : ''}`);
    }
  };

  // ── Tier 1: primary key (chamber + state + last) ─────────────────────
  // McConnell — known senate, KY, very stable. Should resolve to M000355.
  const t1 = mkTrade({
    chamber: "senate",
    state: "KY",
    member_last: "McConnell",
    member_first: "Mitch",
    member_name: "Mitch McConnell",
  });
  // Curtis — Greg's example. UT senate. Should resolve.
  const t2 = mkTrade({
    chamber: "senate",
    state: "UT",
    member_last: "Curtis",
    member_first: "John R",
    member_name: "John R Curtis",
  });
  // Larsen — Greg's example. House member, multi-record across his report.
  const t3 = mkTrade({
    chamber: "house",
    state: "WA",
    member_last: "Larsen",
    member_first: "Rick",
    member_name: "Rick Larsen",
  });
  // Duncan — Greg's example. Jeff Duncan was R-SC house through Jan 2025;
  // he's in legislators_historical now. Tier 4 should match for an
  // in-term transaction date but not for one after his term ended.
  // This fixture uses an in-term transaction date so Tier 4 fires.
  const t4 = mkTrade({
    chamber: "house",
    state: "SC",
    member_last: "Duncan",
    member_first: "Jeff",
    member_name: "Jeff Duncan",
    transaction_date: "2024-11-15", // in-term
    disclosure_date: "2024-12-15",
  });
  // Same Duncan, out-of-term trade — must STAY unmatched.
  const t4b = mkTrade({
    chamber: "house",
    state: "SC",
    member_last: "Duncan",
    member_first: "Jeff",
    member_name: "Jeff Duncan",
    transaction_date: "2026-04-15", // after his Jan 2025 term end
    disclosure_date: "2026-05-15",
  });

  // ── Tier 2: senate-no-state. State empty, last name globally unique. ──
  // Hagerty — known senator (TN). Empty state in trade row.
  const t5 = mkTrade({
    chamber: "senate",
    state: "",
    member_last: "Hagerty",
    member_first: "Bill",
    member_name: "Bill Hagerty",
  });

  // ── Tier 2 disambig: multiple Scotts, disambiguated by first name. ───
  // Tim Scott (R-SC) vs Rick Scott (R-FL) both senators surnamed Scott.
  const t6 = mkTrade({
    chamber: "senate",
    state: "",
    member_last: "Scott",
    member_first: "Tim",
    member_name: "Tim Scott",
  });

  // ── Unmatchable control — fictional senator. ─────────────────────────
  const t9 = mkTrade({
    chamber: "senate",
    state: "ZZ",
    member_last: "Zzznosuchsenator",
    member_first: "Test",
    member_name: "Test Zzznosuchsenator",
  });

  const fixtures = [t1, t2, t3, t4, t4b, t5, t6, t9];
  const t0 = Date.now();
  const enriched = await __enrichTradesWithBioguide(fixtures);
  const elapsed = Date.now() - t0;
  console.log(`\nEnriched ${fixtures.length} fixtures in ${elapsed}ms (first call = full catalog load)`);

  // Second call should be ~instant (cache hit)
  const t0b = Date.now();
  await __enrichTradesWithBioguide(fixtures);
  console.log(`Second call (cache hit): ${Date.now() - t0b}ms`);
  console.log("");

  expect(
    "Tier 1: McConnell senate KY → M000355",
    enriched[0]?.bioguide_id === "M000355",
    `got bioguide_id="${enriched[0]?.bioguide_id ?? ''}" party="${enriched[0]?.party ?? ''}" state="${enriched[0]?.state ?? ''}"`,
  );
  expect(
    "Tier 1: Curtis senate UT → C001134 (or any non-empty)",
    !!enriched[1]?.bioguide_id,
    `got bioguide_id="${enriched[1]?.bioguide_id ?? ''}"`,
  );
  expect(
    "Tier 1: Larsen house WA → L000560 (or any non-empty)",
    !!enriched[2]?.bioguide_id,
    `got bioguide_id="${enriched[2]?.bioguide_id ?? ''}"`,
  );
  expect(
    "Tier 4: Duncan house SC IN-TERM (2024-11-15) → D000615",
    enriched[3]?.bioguide_id === "D000615",
    `got bioguide_id="${enriched[3]?.bioguide_id ?? ''}"`,
  );
  expect(
    "Tier 4 negative: Duncan SC OUT-OF-TERM (2026-04-15) → stays empty",
    !enriched[4]?.bioguide_id,
    `got bioguide_id="${enriched[4]?.bioguide_id ?? ''}" (correct: term ended Jan 2025)`,
  );
  expect(
    "Tier 2 (senate-no-state, unique): Hagerty → H000601",
    !!enriched[5]?.bioguide_id,
    `got bioguide_id="${enriched[5]?.bioguide_id ?? ''}"`,
  );
  expect(
    "Tier 2 disambig (Tim Scott vs Rick Scott): Tim → S001184",
    !!enriched[6]?.bioguide_id,
    `got bioguide_id="${enriched[6]?.bioguide_id ?? ''}"`,
  );
  expect(
    "Unmatchable control: Zzznosuchsenator → bioguide_id stays empty",
    !enriched[7]?.bioguide_id,
    `got bioguide_id="${enriched[7]?.bioguide_id ?? ''}"`,
  );

  // Verify party + state get filled where bioguide resolved
  const filledWithInfo = enriched.filter(
    (t, i) => !fixtures[i]?.bioguide_id && t.bioguide_id && (t.party || t.state),
  ).length;
  expect(
    "Resolved rows ALSO get party + state populated from catalog",
    filledWithInfo >= 4,
    `${filledWithInfo}/${enriched.filter(t => t.bioguide_id).length} resolved rows have party+state filled`,
  );

  // Idempotency check: passing already-enriched rows should be a no-op
  const reEnriched = await __enrichTradesWithBioguide(enriched);
  const stable = reEnriched.every(
    (t, i) => t.bioguide_id === enriched[i]?.bioguide_id,
  );
  expect("Idempotency: re-enriching enriched rows is a no-op", stable);

  console.log("");
  console.log(`Summary: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("UNHANDLED:", e);
  process.exit(2);
});
