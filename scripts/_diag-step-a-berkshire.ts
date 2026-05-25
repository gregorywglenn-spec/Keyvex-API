/**
 * Step A behavioral confirmation of B+-live (2026-05-25, post-Step-2-deploy).
 *
 * Per Greg's protocol: after the first re-tick writes rows, inspect a
 * freshly-stamped (verification_status SET) NON-CLOSED active row and check
 * for verification_value_expected AND verification_value_actual.
 *
 * READ-ONLY. One query, decisive result.
 */
import { getLiveDb } from "../src/firestore.js";

const BERKSHIRE_CIK = "0001067983";
const QUARTER = "2026-03-31";

// Step 3 re-tick wrote at this time. Anything before is pre-Step-3.
const STEP_3_CUTOFF_ISO = "2026-05-25T17:00:00Z";

async function main(): Promise<void> {
  const cutoffMs = new Date(STEP_3_CUTOFF_ISO).getTime();
  const db = await getLiveDb();

  console.log("============================================================");
  console.log("Step A — B+-live behavioral confirmation");
  console.log(`  target: Berkshire (CIK ${BERKSHIRE_CIK}), quarter ${QUARTER}`);
  console.log(`  cutoff: ${STEP_3_CUTOFF_ISO}`);
  console.log("============================================================");
  console.log("");

  const snap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", BERKSHIRE_CIK)
    .where("quarter", "==", QUARTER)
    .get();

  console.log(`Total Berkshire docs at quarter ${QUARTER}: ${snap.docs.length}`);
  console.log("");

  interface Row {
    docId: string;
    updateTime: Date;
    sharesHeld: number;
    positionChange: string;
    verificationStatus: string;
    verificationExpected: number | string;
    verificationActual: number | string;
    verificationValueExpected: number | string;
    verificationValueActual: number | string;
  }

  const postStep3Rows: Row[] = [];
  const preStep3Rows: Row[] = [];

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const upd = doc.updateTime?.toDate() ?? new Date(0);
    const row: Row = {
      docId: doc.id,
      updateTime: upd,
      sharesHeld: (data.shares_held as number | undefined) ?? -1,
      positionChange: (data.position_change as string | undefined) ?? "(absent)",
      verificationStatus: (data.verification_status as string | undefined) ?? "(absent)",
      verificationExpected: (data.verification_expected as number | undefined) ?? "(absent)",
      verificationActual: (data.verification_actual as number | undefined) ?? "(absent)",
      verificationValueExpected:
        (data.verification_value_expected as number | undefined) ?? "(absent)",
      verificationValueActual:
        (data.verification_value_actual as number | undefined) ?? "(absent)",
    };
    if (upd.getTime() >= cutoffMs) postStep3Rows.push(row);
    else preStep3Rows.push(row);
  }

  console.log(`Post-Step-3 docs (updateTime >= ${STEP_3_CUTOFF_ISO}): ${postStep3Rows.length}`);
  console.log(`Pre-Step-3 docs (updateTime <  ${STEP_3_CUTOFF_ISO}): ${preStep3Rows.length}`);
  console.log("");

  // Find the FIRST non-closed active row from post-Step-3 docs
  const activePostStep3 = postStep3Rows.filter(
    (r) => r.positionChange !== "closed" && r.sharesHeld > 0,
  );
  const closedPostStep3 = postStep3Rows.filter(
    (r) => r.positionChange === "closed",
  );

  console.log(`Post-Step-3 active (non-closed) rows: ${activePostStep3.length}`);
  console.log(`Post-Step-3 synthetic closed rows: ${closedPostStep3.length}`);
  console.log("");

  if (activePostStep3.length === 0) {
    console.log(`⚠️  No active post-Step-3 rows found. Step 3 re-tick may not have completed yet.`);
    return;
  }

  // Sample 3 active rows for inspection
  console.log("Sample post-Step-3 ACTIVE rows (first 3):");
  console.log("");
  for (const r of activePostStep3.slice(0, 3)) {
    console.log(`  doc: ${r.docId}`);
    console.log(`    updateTime:                      ${r.updateTime.toISOString()}`);
    console.log(`    shares_held:                     ${r.sharesHeld.toLocaleString()}`);
    console.log(`    position_change:                 ${r.positionChange}`);
    console.log(`    verification_status:             ${r.verificationStatus}`);
    console.log(`    verification_expected:           ${r.verificationExpected}`);
    console.log(`    verification_actual:             ${r.verificationActual}`);
    console.log(`    verification_value_expected:     ${r.verificationValueExpected}`);
    console.log(`    verification_value_actual:       ${r.verificationValueActual}`);
    console.log("");
  }

  // Sample 1 closed row to show the closed-row inheritance behavior
  if (closedPostStep3.length > 0) {
    console.log("Sample post-Step-3 SYNTHETIC CLOSED row (for context, not Step A check):");
    const r = closedPostStep3[0]!;
    console.log(`  doc: ${r.docId}`);
    console.log(`    updateTime:                      ${r.updateTime.toISOString()}`);
    console.log(`    shares_held:                     ${r.sharesHeld}  (synthetic 0 for closed)`);
    console.log(`    position_change:                 ${r.positionChange}`);
    console.log(`    verification_status:             ${r.verificationStatus}`);
    console.log(`    verification_expected:           ${r.verificationExpected}  (from spread of prior-quarter doc)`);
    console.log(`    verification_actual:             ${r.verificationActual}`);
    console.log(`    verification_value_expected:     ${r.verificationValueExpected}`);
    console.log(`    verification_value_actual:       ${r.verificationValueActual}`);
    console.log("");
  }

  // ─── STEP A VERDICT ────────────────────────────────────────────────────
  console.log("============================================================");
  console.log("STEP A VERDICT");
  console.log("============================================================");

  const sample = activePostStep3[0]!;
  const hasValueGateFields =
    sample.verificationValueExpected !== "(absent)" &&
    sample.verificationValueActual !== "(absent)";
  const hasVerStatus = sample.verificationStatus !== "(absent)";

  console.log(`  sample doc: ${sample.docId}`);
  console.log(`  verification_status set:                          ${hasVerStatus ? "✓" : "✗"}`);
  console.log(`  verification_value_expected present:              ${sample.verificationValueExpected !== "(absent)" ? "✓" : "✗"}`);
  console.log(`  verification_value_actual present:                ${sample.verificationValueActual !== "(absent)" ? "✓" : "✗"}`);
  console.log("");

  if (hasVerStatus && hasValueGateFields) {
    console.log(`  ✅ B+ CONFIRMED LIVE (write-side).`);
    console.log(`     Pre-fix code cannot emit verification_value_expected/actual — they did`);
    console.log(`     not exist in the schema before B+. Their presence on a post-Step-3 stamped`);
    console.log(`     row is proof the executing code path is the new dual-gate logic.`);
    console.log(`     Proceed to Step B (gate validation across remaining tracked funds + BlackRock-new).`);
  } else if (hasVerStatus && !hasValueGateFields) {
    console.log(`  ❌ CRITICAL — verification_status set but value-gate fields ABSENT.`);
    console.log(`     The bundle swapped but B+ is NOT the executing code path on this write.`);
    console.log(`     STOP. Do NOT proceed to Step B. Investigate before any further action.`);
    process.exit(2);
  } else {
    console.log(`  ⚠️  Sampled row has no verification_status — wrong row (pre-Phase-A stale).`);
    console.log(`     This shouldn't happen since we filtered to post-Step-3 updateTime. Investigate.`);
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
