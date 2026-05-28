/**
 * Greg's promised cross-era cold check (post-Gate-6):
 *
 *   "Bring me the full load when it's done and I'll do the same kind of
 *    independent cold-check across multiple eras — query a 2008 row, a
 *    2015 row, a 2024 row — to confirm 20 years landed correctly, not
 *    just the one pilot quarter."
 *
 * What this proves:
 *   1. Per-era field-by-field round-trip on real rows pulled from the
 *      cached source TSV vs Firestore docs (by doc-ID lookup).
 *   2. Era-tag invariant: aff10b5one MUST be "NOT_TRACKED" for every
 *      pre-2023 row and NEVER "NOT_TRACKED" for any 2023+ row.
 *   3. Aggregate count = source TSV row count, per quarter.
 *
 * Runs READ-ONLY against the v2 collections — no writes, safe to run
 * any time. ~2-3 min wall time for a 3-era pull.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLiveDb } from "../src/firestore.js";
import {
  buildQuarterDocs,
  eraForQuarter,
  loadQuarterTables,
  scratchDirFor,
} from "../src/scrapers/form345-bulk.js";
import type {
  InsiderFilingV2,
  InsiderHoldingV2,
  InsiderTransactionV2,
} from "../src/types.js";

// One quarter from each era of interest.
//   2008q2 — post-financial-crisis peak, pre_2023 era, AFF10B5ONE should be NOT_TRACKED
//   2015q3 — mid-cycle calm, pre_2023 era, AFF10B5ONE should be NOT_TRACKED
//   2024q1 — modern era, 2023_plus, AFF10B5ONE should be one of "1" / "0" / ""
const TARGET_QUARTERS = ["2008q2", "2015q3", "2024q1"];
const SAMPLE_PER_QUARTER = 5;

// Stable hash → pick a deterministic but spread-out sample
function pickDeterministicSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const step = Math.floor(arr.length / n);
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = (i * step + Math.floor(step / 2)) % arr.length;
    out.push(arr[idx]!);
  }
  return out;
}

interface Mismatch {
  doc_id: string;
  field: string;
  source: unknown;
  firestore: unknown;
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
      const k = ka[i]!;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}

function compareDocs(
  docId: string,
  source: Record<string, unknown>,
  firestore: Record<string, unknown> | undefined,
  ignore: string[],
): Mismatch[] {
  if (!firestore) {
    return [{ doc_id: docId, field: "(entire doc)", source: "expected", firestore: "MISSING IN FIRESTORE" }];
  }
  const out: Mismatch[] = [];
  for (const k of Object.keys(source)) {
    if (ignore.includes(k)) continue;
    if (!deepEqual(source[k], firestore[k])) {
      out.push({ doc_id: docId, field: k, source: source[k], firestore: firestore[k] });
    }
  }
  return out;
}

async function main() {
  const db = await getLiveDb();
  const txCol = db.collection("insider_transactions_v2");
  const holdCol = db.collection("insider_holdings_v2");
  const filingCol = db.collection("insider_filings_v2");

  const IGNORE_FIELDS = ["bulk_loaded_at"]; // per-build timestamp; differs every run

  console.log("================================================================");
  console.log("CROSS-ERA COLD VERIFICATION — Greg's post-Gate-6 acceptance");
  console.log("================================================================\n");

  const allMismatches: Mismatch[] = [];
  let totalDocsChecked = 0;
  let totalDocsMismatched = 0;
  const eraTagViolations: string[] = [];

  for (const quarter of TARGET_QUARTERS) {
    console.log(`────────────────────────────────────────────────────`);
    console.log(`QUARTER: ${quarter}  (era: ${eraForQuarter(quarter)})`);
    console.log(`────────────────────────────────────────────────────`);

    // Rebuild source-of-truth docs from cached TSVs
    const scratch = scratchDirFor(quarter);
    if (!fs.existsSync(path.join(scratch, "SUBMISSION.tsv"))) {
      console.log(`  ⚠ no cached TSV at ${scratch} — skipping`);
      continue;
    }
    const tables = loadQuarterTables(scratch);
    const built = buildQuarterDocs(tables, quarter);
    console.log(
      `  Built ${built.transactions.length.toLocaleString()} transactions, ` +
        `${built.holdings.length.toLocaleString()} holdings, ` +
        `${built.filings.length.toLocaleString()} filings`,
    );

    // Aggregate Firestore counts
    const [fsTxCount, fsHoldCount, fsFilingCount] = await Promise.all([
      txCol.where("source_zip", "==", `${quarter}_form345.zip`).count().get(),
      holdCol.where("source_zip", "==", `${quarter}_form345.zip`).count().get(),
      filingCol.where("source_zip", "==", `${quarter}_form345.zip`).count().get(),
    ]);
    const fsTx = fsTxCount.data().count;
    const fsHold = fsHoldCount.data().count;
    const fsFiling = fsFilingCount.data().count;
    const okCount =
      fsTx === built.transactions.length &&
      fsHold === built.holdings.length &&
      fsFiling === built.filings.length;
    console.log(`  Firestore counts (by source_zip filter):`);
    console.log(
      `    transactions:  ${fsTx.toLocaleString().padStart(8)} vs ${built.transactions.length.toLocaleString().padStart(8)} (built)  ${fsTx === built.transactions.length ? "✓" : "⚠ MISMATCH"}`,
    );
    console.log(
      `    holdings:      ${fsHold.toLocaleString().padStart(8)} vs ${built.holdings.length.toLocaleString().padStart(8)} (built)  ${fsHold === built.holdings.length ? "✓" : "⚠ MISMATCH"}`,
    );
    console.log(
      `    filings:       ${fsFiling.toLocaleString().padStart(8)} vs ${built.filings.length.toLocaleString().padStart(8)} (built)  ${fsFiling === built.filings.length ? "✓" : "⚠ MISMATCH"}`,
    );

    // Sample accessions for field-by-field round-trip
    const sampleAccessions = pickDeterministicSample(
      [...new Set(built.transactions.map((t) => t.accession_number))],
      SAMPLE_PER_QUARTER,
    );
    console.log(`  Sampling ${sampleAccessions.length} accessions for field-by-field check:`);

    for (const acc of sampleAccessions) {
      const sourceFiling = built.filings.find((f) => f.accession_number === acc);
      const fsFiling = (await filingCol.doc(acc).get()).data() as InsiderFilingV2 | undefined;
      if (sourceFiling) {
        const m = compareDocs(acc, sourceFiling as unknown as Record<string, unknown>, fsFiling as unknown as Record<string, unknown> | undefined, IGNORE_FIELDS);
        totalDocsChecked++;
        if (m.length > 0) {
          totalDocsMismatched++;
          allMismatches.push(...m);
        }
      }

      const sourceTxs = built.transactions.filter((t) => t.accession_number === acc);
      for (const t of sourceTxs) {
        const fsTx = (await txCol.doc(t.id).get()).data() as InsiderTransactionV2 | undefined;
        const m = compareDocs(t.id, t as unknown as Record<string, unknown>, fsTx as unknown as Record<string, unknown> | undefined, IGNORE_FIELDS);
        totalDocsChecked++;
        if (m.length > 0) {
          totalDocsMismatched++;
          allMismatches.push(...m);
        }
      }

      const sourceHoldings = built.holdings.filter((h) => h.accession_number === acc);
      for (const h of sourceHoldings) {
        const fsH = (await holdCol.doc(h.id).get()).data() as InsiderHoldingV2 | undefined;
        const m = compareDocs(h.id, h as unknown as Record<string, unknown>, fsH as unknown as Record<string, unknown> | undefined, IGNORE_FIELDS);
        totalDocsChecked++;
        if (m.length > 0) {
          totalDocsMismatched++;
          allMismatches.push(...m);
        }
      }

      console.log(
        `    ${acc}: filing + ${sourceTxs.length} tx + ${sourceHoldings.length} hold ${okCount ? "✓" : ""}`,
      );
    }

    // Era-tag invariant check: pull 100 random Firestore docs from this
    // quarter and assert aff10b5one is consistent with era
    const era = eraForQuarter(quarter);
    const sampleDocs = await txCol
      .where("source_zip", "==", `${quarter}_form345.zip`)
      .limit(100)
      .get();
    let notTracked = 0;
    let oneOrZeroOrBlank = 0;
    let other = 0;
    for (const d of sampleDocs.docs) {
      const aff = (d.data() as InsiderTransactionV2).aff10b5one;
      if (aff === "NOT_TRACKED") notTracked++;
      else if (aff === "1" || aff === "0" || aff === "") oneOrZeroOrBlank++;
      else other++;
    }
    console.log(`  Era-tag invariant (100 doc sample, era=${era}):`);
    console.log(
      `    aff10b5one="NOT_TRACKED": ${notTracked.toString().padStart(3)}  ` +
        `aff10b5one in {1,0,""}: ${oneOrZeroOrBlank.toString().padStart(3)}  ` +
        `other: ${other.toString().padStart(3)}`,
    );

    if (era === "pre_2023") {
      if (notTracked !== sampleDocs.size || oneOrZeroOrBlank !== 0 || other !== 0) {
        eraTagViolations.push(
          `${quarter}: era=pre_2023 but found ${oneOrZeroOrBlank} non-NOT_TRACKED + ${other} other (should be 0)`,
        );
        console.log(`    ⚠ VIOLATION — pre_2023 must be 100% NOT_TRACKED`);
      } else {
        console.log(`    ✓ 100% NOT_TRACKED as required for pre_2023 era`);
      }
    } else {
      if (notTracked !== 0) {
        eraTagViolations.push(
          `${quarter}: era=2023_plus but found ${notTracked} NOT_TRACKED rows (should be 0)`,
        );
        console.log(`    ⚠ VIOLATION — 2023_plus must NEVER have NOT_TRACKED`);
      } else {
        console.log(`    ✓ 0 NOT_TRACKED — correct for 2023_plus era`);
      }
    }
    console.log("");
  }

  console.log("================================================================");
  console.log("VERIFICATION REPORT");
  console.log("================================================================");
  console.log(`  Eras checked:                   ${TARGET_QUARTERS.join(", ")}`);
  console.log(`  Docs round-tripped:             ${totalDocsChecked}`);
  console.log(`  Docs mismatched:                ${totalDocsMismatched}`);
  console.log(`  Field mismatches (all docs):    ${allMismatches.length}`);
  console.log(`  Era-tag invariant violations:   ${eraTagViolations.length}`);
  console.log("");

  if (allMismatches.length > 0) {
    console.log("First 5 field mismatches:");
    for (const m of allMismatches.slice(0, 5)) {
      console.log(`  ${m.doc_id} . ${m.field}`);
      console.log(`    source:    ${JSON.stringify(m.source).slice(0, 200)}`);
      console.log(`    firestore: ${JSON.stringify(m.firestore).slice(0, 200)}`);
    }
    console.log("");
  }

  if (eraTagViolations.length > 0) {
    console.log("Era-tag violations:");
    for (const v of eraTagViolations) console.log(`  ${v}`);
    console.log("");
  }

  const ok = totalDocsMismatched === 0 && eraTagViolations.length === 0;
  console.log(
    `=== ${ok ? "✓ ALL VERIFIED — Gate 6 PASS across 3 eras" : "⚠ MISMATCHES PRESENT — investigate before sign-off"} ===`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFY FAIL:", e);
  process.exit(1);
});
