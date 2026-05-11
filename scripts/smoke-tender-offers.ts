import { handler } from "../src/tools/tender-offers.js";
import type { ResultEnvelope, TenderOffer } from "../src/types.js";

async function run(label: string, args: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`);
  const r = (await handler(args)) as ResultEnvelope<TenderOffer>;
  console.log(
    JSON.stringify(
      {
        query: args,
        count: r.count,
        has_more: r.has_more,
        sample: r.results.slice(0, 3).map((o) => ({
          accession: o.accession_number,
          form: o.form_type,
          filed: o.filing_date,
          target: `${o.target_name}${o.target_ticker ? " (" + o.target_ticker + ")" : ""}`,
          bidder: `${o.bidder_name}${o.bidder_ticker ? " (" + o.bidder_ticker + ")" : ""}`,
          is_issuer: o.is_issuer_tender,
          is_amendment: o.is_amendment,
        })),
      },
      null,
      2,
    ),
  );
}

await run("TEST 1: third-party only, exclude amendments, limit 5", {
  third_party_only: true,
  exclude_amendments: true,
  limit: 5,
});

await run("TEST 2: issuer buybacks (most recent first)", {
  issuer_only: true,
  exclude_amendments: true,
  limit: 5,
});

await run("TEST 3: target_ticker filter (KZR)", {
  target_ticker: "KZR",
});

await run("TEST 4: bidder_name substring", {
  bidder_name: "acquisition",
  limit: 5,
});

console.log("\n=== TEST 5: validation error path ===");
try {
  await handler({ third_party_only: true, issuer_only: true });
  console.log("FAIL: expected mutually-exclusive error");
} catch (e) {
  console.log("OK: " + (e as Error).message);
}

process.exit(0);
