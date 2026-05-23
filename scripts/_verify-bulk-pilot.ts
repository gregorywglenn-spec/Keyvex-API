/**
 * Gate 5 re-query verification (per Greg's strict rule: verify by RESULT,
 * not "data present %"). Pulls 10 specific accessions from Firestore and
 * compares each field against the source TSV row to confirm round-trip
 * correctness.
 *
 * No new indexes required — uses doc-ID lookups + collection counts only.
 * HALTS on ANY mismatch.
 *
 * Usage: npx tsx scripts/_verify-bulk-pilot.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLiveDb } from "../src/firestore.js";
import { loadQuarterTables, scratchDirFor, buildQuarterDocs } from "../src/scrapers/form345-bulk.js";
import type {
  InsiderFilingV2,
  InsiderHoldingV2,
  InsiderTransactionV2,
} from "../src/types.js";

const QUARTER = "2023q1";
const SAMPLE_TARGET = 10;

interface Mismatch {
  doc_id: string;
  field: string;
  source_value: unknown;
  firestore_value: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;
      const key = ka[i]!;
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
  }
  return false;
}

function compareDoc(
  docId: string,
  source: Record<string, unknown>,
  firestore: Record<string, unknown> | undefined,
  ignoreFields: string[],
): { ok: boolean; mismatches: Mismatch[] } {
  const mismatches: Mismatch[] = [];
  if (!firestore) {
    return {
      ok: false,
      mismatches: [{ doc_id: docId, field: "(entire doc)", source_value: "expected", firestore_value: "MISSING" }],
    };
  }
  const keysToCheck = Object.keys(source).filter((k) => !ignoreFields.includes(k));
  for (const k of keysToCheck) {
    if (!deepEqual(source[k], firestore[k])) {
      mismatches.push({
        doc_id: docId,
        field: k,
        source_value: source[k],
        firestore_value: firestore[k],
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

async function main() {
  console.log("=== Gate 5 re-query verification ===\n");

  // Step 1: Re-build the source-of-truth docs from the cached TSVs
  console.log("[step 1] Re-building source-of-truth docs from cached 2023q1 TSVs...");
  const scratch = scratchDirFor(QUARTER);
  if (!fs.existsSync(path.join(scratch, "SUBMISSION.tsv"))) {
    throw new Error(`Scratch dir not populated at ${scratch}. Run the pilot save first.`);
  }
  const tables = loadQuarterTables(scratch);
  const built = buildQuarterDocs(tables, QUARTER);
  console.log(
    `  built ${built.transactions.length} transactions, ${built.holdings.length} holdings, ${built.filings.length} filings`,
  );

  // Step 2: Sample 10 diverse accessions
  console.log("\n[step 2] Selecting diverse sample of accessions...");

  // Group transactions by accession so we can pick filings with rich content
  const byAccession = new Map<string, InsiderTransactionV2[]>();
  for (const t of built.transactions) {
    let list = byAccession.get(t.accession_number);
    if (!list) {
      list = [];
      byAccession.set(t.accession_number, list);
    }
    list.push(t);
  }

  const sampleAccessions = new Set<string>();

  // a) 1 with aff10b5one='1' (plan adopted)
  const plan1 = built.transactions.find((t) => t.aff10b5one === "1");
  if (plan1) sampleAccessions.add(plan1.accession_number);

  // b) 1 with aff10b5one='0' (no plan explicitly)
  const plan0 = built.transactions.find((t) => t.aff10b5one === "0");
  if (plan0) sampleAccessions.add(plan0.accession_number);

  // c) 1 with aff10b5one='' (blank — most common in 2023q1)
  const planBlank = built.transactions.find((t) => t.aff10b5one === "");
  if (planBlank) sampleAccessions.add(planBlank.accession_number);

  // d) 1 deriv transaction with non-empty footnote_refs
  const derivFn = built.transactions.find(
    (t) => t.transaction_type === "deriv" && t.footnote_refs.length > 0,
  );
  if (derivFn) sampleAccessions.add(derivFn.accession_number);

  // e) 1 Form 4/A amendment
  const amend = built.transactions.find((t) => t.is_amendment && t.document_type === "4/A");
  if (amend) sampleAccessions.add(amend.accession_number);

  // f) 1 Form 5 (annual catch-up)
  const f5 = built.transactions.find((t) => t.document_type === "5");
  if (f5) sampleAccessions.add(f5.accession_number);

  // g) 1 multi-owner filing
  const multi = built.filings.find((f) => f.reporting_owners.length > 1);
  if (multi) sampleAccessions.add(multi.accession_number);

  // h) 1 with non-empty REMARKS (free text — exercises escape paths)
  const withRemarks = built.transactions.find(
    (t) => t.remarks !== null && t.remarks.length > 0,
  );
  if (withRemarks) sampleAccessions.add(withRemarks.accession_number);

  // i+j) 2 random additional filings (any kind) to round out to 10
  for (const a of byAccession.keys()) {
    if (sampleAccessions.size >= SAMPLE_TARGET) break;
    sampleAccessions.add(a);
  }

  console.log(`  selected ${sampleAccessions.size} accessions for round-trip check:`);
  for (const a of sampleAccessions) console.log(`    ${a}`);

  // Step 3: For each accession, fetch corresponding docs from Firestore + compare
  console.log("\n[step 3] Round-trip comparing each accession against Firestore...");
  const db = await getLiveDb();
  const txCol = db.collection("insider_transactions_v2");
  const holdCol = db.collection("insider_holdings_v2");
  const filingCol = db.collection("insider_filings_v2");

  // bulk_loaded_at differs between build runs (it's "now()") — ignore on compare.
  const IGNORE_FIELDS = ["bulk_loaded_at"];

  let totalChecked = 0;
  let totalMismatched = 0;
  const allMismatches: Mismatch[] = [];

  for (const accession of sampleAccessions) {
    // Pull the FILING envelope (one doc per accession)
    const sourceFiling = built.filings.find((f) => f.accession_number === accession);
    if (!sourceFiling) {
      console.error(`  ${accession}: SOURCE FILING NOT FOUND — should be impossible`);
      continue;
    }
    const fsFiling = (await filingCol.doc(accession).get()).data() as InsiderFilingV2 | undefined;
    const fr = compareDoc(accession, sourceFiling as unknown as Record<string, unknown>, fsFiling as unknown as Record<string, unknown> | undefined, IGNORE_FIELDS);
    totalChecked += 1;
    if (!fr.ok) {
      totalMismatched += 1;
      allMismatches.push(...fr.mismatches);
      console.error(`  ${accession} [FILING] MISMATCH: ${fr.mismatches.length} field(s)`);
    }

    // Pull all transactions for this accession (source + firestore)
    const sourceTxs = built.transactions.filter((t) => t.accession_number === accession);
    for (const sourceTx of sourceTxs) {
      const fsTx = (await txCol.doc(sourceTx.id).get()).data() as InsiderTransactionV2 | undefined;
      const tr = compareDoc(sourceTx.id, sourceTx as unknown as Record<string, unknown>, fsTx as unknown as Record<string, unknown> | undefined, IGNORE_FIELDS);
      totalChecked += 1;
      if (!tr.ok) {
        totalMismatched += 1;
        allMismatches.push(...tr.mismatches);
        console.error(`  ${sourceTx.id} [TX] MISMATCH: ${tr.mismatches.length} field(s)`);
      }
    }

    // Pull all holdings for this accession (source + firestore)
    const sourceHoldings = built.holdings.filter((h) => h.accession_number === accession);
    for (const sourceHolding of sourceHoldings) {
      const fsHolding = (await holdCol.doc(sourceHolding.id).get()).data() as InsiderHoldingV2 | undefined;
      const hr = compareDoc(sourceHolding.id, sourceHolding as unknown as Record<string, unknown>, fsHolding as unknown as Record<string, unknown> | undefined, IGNORE_FIELDS);
      totalChecked += 1;
      if (!hr.ok) {
        totalMismatched += 1;
        allMismatches.push(...hr.mismatches);
        console.error(`  ${sourceHolding.id} [HOLD] MISMATCH: ${hr.mismatches.length} field(s)`);
      }
    }

    console.log(
      `  ${accession}: filing + ${sourceTxs.length} transaction(s) + ${sourceHoldings.length} holding(s) verified`,
    );
  }

  // Step 4: Collection-wide counts (lightweight aggregation; needs no composite index)
  console.log("\n[step 4] Collection-wide count verification (Firestore .count())...");
  const [txCount, holdCount, filingCount] = await Promise.all([
    txCol.count().get(),
    holdCol.count().get(),
    filingCol.count().get(),
  ]);
  const fsTxCount = txCount.data().count;
  const fsHoldCount = holdCount.data().count;
  const fsFilingCount = filingCount.data().count;

  console.log("\n=== VERIFICATION REPORT ===\n");
  console.log("Per-doc round-trip:");
  console.log(`  docs checked:     ${totalChecked}`);
  console.log(`  docs mismatched:  ${totalMismatched}`);
  console.log(`  fields mismatched (across all docs): ${allMismatches.length}`);
  if (allMismatches.length > 0) {
    console.log("\nFirst 10 field mismatches:");
    for (const m of allMismatches.slice(0, 10)) {
      console.log(`  ${m.doc_id} . ${m.field}`);
      console.log(`    source:    ${JSON.stringify(m.source_value)}`);
      console.log(`    firestore: ${JSON.stringify(m.firestore_value)}`);
    }
  }

  console.log("\nCollection-wide counts (Firestore vs source):");
  console.log(
    `  insider_transactions_v2:  firestore=${fsTxCount.toLocaleString()} vs source=${built.transactions.length.toLocaleString()}` +
      (fsTxCount === built.transactions.length ? "  ✓" : "  ⚠ MISMATCH"),
  );
  console.log(
    `  insider_holdings_v2:      firestore=${fsHoldCount.toLocaleString()} vs source=${built.holdings.length.toLocaleString()}` +
      (fsHoldCount === built.holdings.length ? "  ✓" : "  ⚠ MISMATCH"),
  );
  console.log(
    `  insider_filings_v2:       firestore=${fsFilingCount.toLocaleString()} vs source=${built.filings.length.toLocaleString()}` +
      (fsFilingCount === built.filings.length ? "  ✓" : "  ⚠ MISMATCH"),
  );

  const allOk =
    totalMismatched === 0 &&
    fsTxCount === built.transactions.length &&
    fsHoldCount === built.holdings.length &&
    fsFilingCount === built.filings.length;

  console.log(
    `\n=== ${allOk ? "✓ ALL VERIFIED — Gate 5 PASS" : "⚠ MISMATCHES PRESENT — Gate 5 HALT"} ===`,
  );

  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFICATION FAIL:", e);
  process.exit(1);
});
