import { handler } from "../src/tools/private-placements.js";
import type { PrivatePlacement, ResultEnvelope } from "../src/types.js";

async function run(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const r = (await handler(args)) as ResultEnvelope<PrivatePlacement>;
  console.log(
    JSON.stringify(
      {
        query: args,
        count: r.count,
        has_more: r.has_more,
        sample: r.results.slice(0, 5).map((p) => ({
          id: p.filing_id,
          name: p.issuer_name.slice(0, 50),
          type: p.entity_type,
          state: p.issuer_state,
          industry: p.industry_group_type,
          fund_subtype: p.investment_fund_type,
          exemptions: p.federal_exemptions.join(","),
          amount_sold: p.total_amount_sold,
          first_sale: p.date_of_first_sale,
          related_count: p.related_persons.length,
        })),
      },
      null,
      2,
    ),
  );
}

await run("TEST 1: VC funds (substring 'venture capital')", {
  investment_fund_type: "venture capital",
  sort_by: "file_date",
  limit: 5,
});

await run("TEST 2: Material 506(c) raises (general solicitation)", {
  federal_exemption: "06c",
  min_amount_sold: 1000000,
  sort_by: "total_amount_sold",
  limit: 5,
});

await run("TEST 3: California-based issuers, recent", {
  issuer_state: "CA",
  sort_by: "file_date",
  limit: 5,
});

await run("TEST 4: Real Estate filings", {
  industry_group_type: "real estate",
  limit: 5,
});

console.log("\n=== TEST 5: validation error ===");
try {
  await handler({ min_amount_sold: -1 });
  console.log("FAIL: expected validation error");
} catch (e) {
  console.log("OK: " + (e as Error).message);
}

process.exit(0);
