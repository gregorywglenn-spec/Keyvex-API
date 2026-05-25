/**
 * Final pre-deploy census read — resolve the Harvest sampling discrepancy.
 *
 * Context: Harvest's classification is already settled at (b) on raw numbers
 * (raw=55=declared, aggregated=43, dollar gate exact). What this resolves is
 * the SEPARATE sampling discrepancy from the 4-fund census run: a Harvest
 * doc the 16:00Z tick should have stamped came back unstamped via the
 * default-ordered first-doc sampler. Almost certainly because the sampler
 * grabbed one of the ~29 stale pre-tick docs (out of 72 total) instead of
 * one of the 43 this tick wrote.
 *
 * Decisive outcomes (per Greg's protocol):
 *   - count == 43 AND all verification_status = INSUFFICIENT_DATA AND
 *     verification_actual = 43 → expected; sampler-selection confirmed;
 *     5/5 census branch closes clean.
 *   - count != 43 OR any post-cutoff doc unstamped → genuine anomaly;
 *     tick touched Harvest but didn't stamp; flag, do not commit B+.
 *
 * READ-ONLY. One query. Phase B LOCKED. Does NOT authorize B+ commit;
 * clears the gate only.
 */
import { Timestamp } from "firebase-admin/firestore";
import { getLiveDb } from "../src/firestore.js";

const HARVEST_CIK = "0001140315";
const QUARTER = "2026-03-31";
const TICK_CUTOFF_ISO = "2026-05-25T16:00:00Z";
const EXPECTED_POST_TICK_COUNT = 43; // from the 16:00Z post-tick snapshot

async function main(): Promise<void> {
  const cutoffMs = new Date(TICK_CUTOFF_ISO).getTime();

  console.log("============================================================");
  console.log("Harvest sampling-discrepancy resolution");
  console.log(`  fund_cik: ${HARVEST_CIK}`);
  console.log(`  quarter:  ${QUARTER}`);
  console.log(`  cutoff:   ${TICK_CUTOFF_ISO}`);
  console.log(`  expected post-cutoff count: ${EXPECTED_POST_TICK_COUNT}`);
  console.log("============================================================");
  console.log("");

  const db = await getLiveDb();
  // Firestore can't filter by updateTime in a where clause (it's snapshot
  // metadata, not a document field). Pull all 72 docs for the fund/quarter
  // and filter client-side by doc.updateTime.
  const snap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", HARVEST_CIK)
    .where("quarter", "==", QUARTER)
    .get();

  console.log(`Total docs for fund_cik=${HARVEST_CIK} quarter=${QUARTER}: ${snap.docs.length}`);
  console.log("");

  interface Row {
    docId: string;
    updateTime: Date;
    verificationStatus: string;
    verificationActual: number | string;
    verificationExpected: number | string;
  }

  const postTickRows: Row[] = [];
  const preTickRows: Row[] = [];

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const upd = doc.updateTime?.toDate() ?? new Date(0);
    const row: Row = {
      docId: doc.id,
      updateTime: upd,
      verificationStatus: (data.verification_status as string | undefined) ?? "(absent)",
      verificationActual: (data.verification_actual as number | undefined) ?? "(absent)",
      verificationExpected: (data.verification_expected as number | undefined) ?? "(absent)",
    };
    if (upd.getTime() >= cutoffMs) postTickRows.push(row);
    else preTickRows.push(row);
  }

  // ── Post-tick rows (the ones the 16:00Z tick should have stamped) ──────
  console.log(`Post-cutoff docs (updateTime >= ${TICK_CUTOFF_ISO}): ${postTickRows.length}`);
  console.log("");

  // Aggregate the post-tick verification field distribution
  const verStatusCounts: Record<string, number> = {};
  const verActualCounts: Record<string, number> = {};
  for (const r of postTickRows) {
    verStatusCounts[r.verificationStatus] = (verStatusCounts[r.verificationStatus] ?? 0) + 1;
    const ka = String(r.verificationActual);
    verActualCounts[ka] = (verActualCounts[ka] ?? 0) + 1;
  }
  console.log(`  verification_status distribution:`);
  for (const [k, v] of Object.entries(verStatusCounts)) {
    console.log(`    ${k.padEnd(25)} ${v}`);
  }
  console.log(`  verification_actual distribution:`);
  for (const [k, v] of Object.entries(verActualCounts)) {
    console.log(`    ${k.padEnd(25)} ${v}`);
  }
  console.log("");

  // Show first 5 and last 5 rows for transparency
  console.log("  Sample post-cutoff rows (first 5):");
  for (const r of postTickRows.slice(0, 5)) {
    console.log(
      `    ${r.docId.padEnd(40)} updateTime=${r.updateTime.toISOString()} status=${r.verificationStatus.padEnd(20)} actual=${String(r.verificationActual).padStart(4)} expected=${String(r.verificationExpected).padStart(4)}`,
    );
  }
  console.log("");

  // Pre-tick rows (the stale ones the sampler likely grabbed from)
  console.log(`Pre-cutoff docs (updateTime <  ${TICK_CUTOFF_ISO}): ${preTickRows.length}`);
  if (preTickRows.length > 0) {
    const preStatusCounts: Record<string, number> = {};
    for (const r of preTickRows) {
      preStatusCounts[r.verificationStatus] = (preStatusCounts[r.verificationStatus] ?? 0) + 1;
    }
    console.log(`  pre-cutoff verification_status distribution:`);
    for (const [k, v] of Object.entries(preStatusCounts)) {
      console.log(`    ${k.padEnd(25)} ${v}`);
    }
    console.log("  Sample pre-cutoff rows (first 3):");
    for (const r of preTickRows.slice(0, 3)) {
      console.log(
        `    ${r.docId.padEnd(40)} updateTime=${r.updateTime.toISOString()} status=${r.verificationStatus.padEnd(20)} actual=${String(r.verificationActual).padStart(4)}`,
      );
    }
  }
  console.log("");

  // ── Decisive outcome ──────────────────────────────────────────────────
  console.log("============================================================");
  console.log("DECISIVE OUTCOME");
  console.log("============================================================");
  const countMatches = postTickRows.length === EXPECTED_POST_TICK_COUNT;
  const allInsufficient =
    postTickRows.length > 0 &&
    postTickRows.every((r) => r.verificationStatus === "INSUFFICIENT_DATA");
  const allActualEq43 =
    postTickRows.length > 0 &&
    postTickRows.every((r) => r.verificationActual === 43);
  const anyUnstamped = postTickRows.some(
    (r) => r.verificationStatus === "(absent)",
  );

  console.log(`  post-cutoff count: ${postTickRows.length}  (expected ${EXPECTED_POST_TICK_COUNT}: ${countMatches ? "✓" : "✗"})`);
  console.log(`  all INSUFFICIENT_DATA: ${allInsufficient ? "✓" : "✗"}`);
  console.log(`  all verification_actual == 43: ${allActualEq43 ? "✓" : "✗"}`);
  console.log(`  any unstamped (verification_status absent): ${anyUnstamped ? "✗ ANOMALY" : "✓"}`);
  console.log("");

  if (countMatches && allInsufficient && allActualEq43 && !anyUnstamped) {
    console.log(`  ✅ EXPECTED OUTCOME — sampler-selection confirmed.`);
    console.log(`     The first-doc-by-id from my prior census grabbed a stale pre-tick`);
    console.log(`     doc (out of ${preTickRows.length} stale docs in storage). The`);
    console.log(`     16:00Z tick's actual ${postTickRows.length} writes were all stamped`);
    console.log(`     INSUFFICIENT_DATA with verification_actual=43, exactly matching the`);
    console.log(`     B+ artifact pattern observed for Atlas/EIP/Park West/Coastline.`);
    console.log(``);
    console.log(`     Harvest census closes (b) per raw-numbers classification, with`);
    console.log(`     stamping cross-confirmed on the post-tick subset. Sampling`);
    console.log(`     discrepancy has a known benign root cause.`);
  } else if (anyUnstamped) {
    console.log(`  ❌ GENUINE ANOMALY — the tick touched Harvest but DIDN'T fully stamp it.`);
    console.log(`     ${postTickRows.filter((r) => r.verificationStatus === "(absent)").length} post-cutoff doc(s) are unstamped.`);
    console.log(`     This is a different bug than the count-check artifact and must be`);
    console.log(`     diagnosed before B+ ships.`);
    console.log(`     >>> B+ COMMIT PAUSED. <<<`);
  } else if (!countMatches) {
    console.log(`  ⚠️  COUNT MISMATCH — post-cutoff count (${postTickRows.length}) ≠ expected (${EXPECTED_POST_TICK_COUNT}).`);
    console.log(`     The 16:00Z snapshot reported 43 INSUFF docs for Harvest; finding`);
    console.log(`     ${postTickRows.length} suggests something between snapshot and read changed.`);
    console.log(`     Investigate before commit.`);
  } else {
    console.log(`  ⚠️  Stamping pattern partially matches expected but not fully. Investigate.`);
  }
  console.log("");

  console.log("============================================================");
  console.log("Read-only complete. B+ NOT committed/deployed. Phase B LOCKED.");
  console.log("============================================================");

  // Silence unused-import warning if Timestamp isn't referenced
  void Timestamp;
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
