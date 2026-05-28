/**
 * Pre-save verification: build the v2 docs for 2023q1 in memory and dump
 * representative samples. Lets Greg eyeball the doc shape before any
 * Firestore writes happen.
 *
 * Picks:
 *   - 1 nonderiv transaction with AFF10B5ONE present
 *   - 1 nonderiv transaction WITHOUT AFF10B5ONE (the typical default-blank)
 *   - 1 deriv transaction (option / RSU / etc.)
 *   - 1 transaction that references footnotes (so we see inlined text)
 *   - 1 holding (nonderiv preferred — common stock position)
 *   - 1 filing envelope with multiple reporting owners
 */
import { scrapeForm345BulkQuarter } from "../src/scrapers/form345-bulk.js";

async function main() {
  const r = await scrapeForm345BulkQuarter("2023q1");

  console.log("\n=== SAMPLE A: nonderiv transaction with AFF10B5ONE != '' ===\n");
  const withPlan = r.transactions.find(
    (t) => t.transaction_type === "nonderiv" && (t.aff10b5one === "1" || t.aff10b5one === "0"),
  );
  if (withPlan) {
    console.log(JSON.stringify(withPlan, null, 2));
  } else {
    console.log("  NONE FOUND");
  }

  console.log("\n=== SAMPLE B: nonderiv transaction with AFF10B5ONE blank (era_2023_plus default) ===\n");
  const blankPlan = r.transactions.find(
    (t) => t.transaction_type === "nonderiv" && t.aff10b5one === "",
  );
  if (blankPlan) {
    console.log(JSON.stringify(blankPlan, null, 2));
  } else {
    console.log("  NONE FOUND");
  }

  console.log("\n=== SAMPLE C: deriv transaction (option/RSU/warrant) ===\n");
  const deriv = r.transactions.find((t) => t.transaction_type === "deriv");
  if (deriv) {
    console.log(JSON.stringify(deriv, null, 2));
  } else {
    console.log("  NONE FOUND");
  }

  console.log("\n=== SAMPLE D: transaction with footnote_refs.length > 0 (inlined text) ===\n");
  const withFn = r.transactions.find((t) => t.footnote_refs.length > 0);
  if (withFn) {
    console.log(JSON.stringify(withFn, null, 2));
  } else {
    console.log("  NONE FOUND");
  }

  console.log("\n=== SAMPLE E: nonderiv holding (common-stock position) ===\n");
  const holding = r.holdings.find((h) => h.holding_type === "nonderiv");
  if (holding) {
    console.log(JSON.stringify(holding, null, 2));
  } else {
    console.log("  NONE FOUND");
  }

  console.log("\n=== SAMPLE F: filing with multiple reporting owners ===\n");
  const multiOwner = r.filings.find((f) => f.reporting_owners.length > 1);
  if (multiOwner) {
    console.log(JSON.stringify(multiOwner, null, 2));
  } else {
    console.log("  NONE FOUND");
  }

  console.log("\n=== AFF10B5ONE distribution (2023q1, schema_era=2023_plus) ===\n");
  const counts = { "1": 0, "0": 0, "": 0, NOT_TRACKED: 0 };
  for (const t of r.transactions) counts[t.aff10b5one] += 1;
  console.log(
    `  aff10b5one="1" (plan adopted):  ${counts["1"].toLocaleString()} transactions`,
  );
  console.log(
    `  aff10b5one="0" (no plan):       ${counts["0"].toLocaleString()} transactions`,
  );
  console.log(
    `  aff10b5one="" (blank/unknown):  ${counts[""].toLocaleString()} transactions`,
  );
  console.log(
    `  aff10b5one="NOT_TRACKED" (should be 0 for 2023+): ${counts.NOT_TRACKED}`,
  );

  console.log("\n=== Document type distribution ===\n");
  const docTypeCounts = new Map<string, number>();
  for (const t of r.transactions) {
    docTypeCounts.set(t.document_type, (docTypeCounts.get(t.document_type) ?? 0) + 1);
  }
  for (const [dt, n] of [...docTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${dt.padEnd(8)} ${n.toLocaleString()} transactions`);
  }

  console.log("\n=== Transaction-code distribution (top 15) ===\n");
  const codeCounts = new Map<string, number>();
  for (const t of r.transactions) {
    codeCounts.set(t.trans_code, (codeCounts.get(t.trans_code) ?? 0) + 1);
  }
  const sortedCodes = [...codeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [c, n] of sortedCodes) {
    console.log(`  ${c.padEnd(4)} ${n.toLocaleString()} transactions`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
