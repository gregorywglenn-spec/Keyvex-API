/**
 * Smoketest for Greg's unified 4-case empty-result spec (2026-05-22).
 *
 *   1. INVALID_QUERY (type mismatch)   → INVALID_QUERY error first, no warning
 *   2. KNOWN-UNSUPPORTED filter value  → explicit static notice
 *   3a. VALID + empty WITH date filter → coverage_warning w/ min/max + window
 *   3b. VALID + empty WITHOUT filter   → coverage_warning w/ collection coverage
 *   4. VALID + non-empty results       → no warning, results returned
 *
 * Verifies the four cases against the AFD collection (Form 278), which is
 * the canonical example: chamber=house is the documented gap, chamber=senate
 * is the working path, and the collection has a date field for coverage.
 */
import {
  queryForm278Filings,
  queryTreasuryAuctions,
  queryConsumerComplaints,
} from "../src/firestore.js";

type Case = {
  name: string;
  expect: "throw" | "results" | "warning_only" | "warning_with_results";
  warningContains?: string;
  run: () => Promise<unknown>;
};

const cases: Case[] = [
  // ── Case 1: INVALID_QUERY (treasury_auctions guard) ────────────────────
  {
    name: "Case 1: INVALID_QUERY — treasury_auctions(since + sort_by=offering_amount)",
    expect: "throw",
    run: () =>
      queryTreasuryAuctions({
        since: "2026-04-22",
        sort_by: "offering_amount",
        sort_order: "desc",
        limit: 3,
      } as Parameters<typeof queryTreasuryAuctions>[0]),
  },

  // ── Case 2: KNOWN-UNSUPPORTED — AFD chamber=house ──────────────────────
  {
    name: "Case 2: KNOWN-UNSUPPORTED — AFD chamber='house'",
    expect: "warning_only",
    warningContains: "House Form 278 filings are not yet available",
    run: () =>
      queryForm278Filings({
        chamber: "house",
        limit: 3,
      } as Parameters<typeof queryForm278Filings>[0]),
  },

  // ── Case 3a: VALID + empty WITH date filter ────────────────────────────
  {
    name: "Case 3a: VALID + empty WITH date filter — CFPB since 2024",
    expect: "warning_only",
    warningContains: "Returned 0 results in the requested range",
    run: () =>
      queryConsumerComplaints({
        since: "2024-01-01",
        until: "2024-01-31",
        limit: 3,
      } as Parameters<typeof queryConsumerComplaints>[0]),
  },

  // ── Case 3b: VALID + empty WITHOUT any date filter ─────────────────────
  // AFD with a bioguide_id we know doesn't exist as a filer in our 50 ingested rows
  {
    name: "Case 3b: VALID + empty WITHOUT date filter — AFD bioguide=Z999999",
    expect: "warning_only",
    warningContains: "Returned 0 results for this query",
    run: () =>
      queryForm278Filings({
        bioguide_id: "Z999999",
        limit: 3,
      } as Parameters<typeof queryForm278Filings>[0]),
  },

  // ── Case 4: VALID + non-empty results ──────────────────────────────────
  {
    name: "Case 4: VALID + results — AFD chamber='senate'",
    expect: "results",
    run: () =>
      queryForm278Filings({
        chamber: "senate",
        limit: 3,
      } as Parameters<typeof queryForm278Filings>[0]),
  },
];

async function main() {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const c of cases) {
    let outcome: "throw" | "results" | "warning_only" | "warning_with_results";
    let detail = "";
    let warningSeen = "";

    try {
      const r = (await c.run()) as {
        results: unknown[];
        coverage_warning?: string;
      };
      const hasResults = r.results.length > 0;
      const hasWarning = !!r.coverage_warning;
      warningSeen = r.coverage_warning ?? "";

      if (hasResults && hasWarning) outcome = "warning_with_results";
      else if (hasResults) outcome = "results";
      else if (hasWarning) outcome = "warning_only";
      else outcome = "results"; // bare empty falls into "results" (no warning, no data)

      detail = `outcome=${outcome} results=${r.results.length} warning=${
        hasWarning ? '"' + warningSeen.slice(0, 80) + '..."' : "(none)"
      }`;
    } catch (err) {
      outcome = "throw";
      detail = `threw: ${(err as Error).message.slice(0, 140)}`;
    }

    const ok =
      outcome === c.expect &&
      (!c.warningContains || warningSeen.includes(c.warningContains));

    if (ok) {
      pass++;
      console.log(`PASS  ${c.name}`);
      console.log(`      ${detail}`);
    } else {
      fail++;
      const want = c.warningContains
        ? `expected outcome=${c.expect} + warning containing "${c.warningContains}"`
        : `expected outcome=${c.expect}`;
      failures.push(`${c.name}\n      got:  ${detail}\n      want: ${want}`);
      console.log(`FAIL  ${c.name}`);
      console.log(`      ${detail}`);
      console.log(`      want: ${want}`);
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
