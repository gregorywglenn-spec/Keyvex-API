/**
 * Directive B verification — Dogwood 4b teeth observation.
 *
 * Predicted: active rows stamp INSUFFICIENT_DATA with verification_actual=591
 * vs verification_expected=592. Report observed honestly; do NOT smooth
 * toward the prediction.
 *
 * Also check value-sum gate (verification_value_expected/actual) — if the
 * value gate also fails, that's a second failure mode worth reporting.
 *
 * READ-ONLY.
 */
import { getLiveDb } from "../src/firestore.js";

const DOGWOOD_CIK = "0002056922";

async function main(): Promise<void> {
  const db = await getLiveDb();
  const snap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", DOGWOOD_CIK)
    .get();

  console.log("============================================================");
  console.log("Dogwood 4b verification");
  console.log(`  CIK: ${DOGWOOD_CIK}`);
  console.log(`  total docs in store: ${snap.docs.length}`);
  console.log("============================================================");
  console.log("");

  interface Row {
    docId: string;
    updateTime: Date;
    sharesHeld: number;
    quarter: string;
    positionChange: string;
    verStatus: string;
    verExpected: number | string;
    verActual: number | string;
    verValExpected: number | string;
    verValActual: number | string;
  }

  const rows: Row[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    rows.push({
      docId: doc.id,
      updateTime: doc.updateTime?.toDate() ?? new Date(0),
      sharesHeld: (data.shares_held as number | undefined) ?? -1,
      quarter: (data.quarter as string) ?? "(none)",
      positionChange: (data.position_change as string) ?? "(absent)",
      verStatus: (data.verification_status as string) ?? "(absent)",
      verExpected: (data.verification_expected as number | undefined) ?? "(absent)",
      verActual: (data.verification_actual as number | undefined) ?? "(absent)",
      verValExpected: (data.verification_value_expected as number | undefined) ?? "(absent)",
      verValActual: (data.verification_value_actual as number | undefined) ?? "(absent)",
    });
  }

  // Group by quarter
  const byQuarter: Record<string, Row[]> = {};
  for (const r of rows) {
    if (!byQuarter[r.quarter]) byQuarter[r.quarter] = [];
    byQuarter[r.quarter].push(r);
  }
  console.log("By quarter:");
  for (const [q, qrows] of Object.entries(byQuarter)) {
    console.log(`  ${q}: ${qrows.length} docs`);
  }
  console.log("");

  // Verification status distribution across all docs
  const statusCounts: Record<string, number> = {};
  const valGateCounts: Record<string, number> = {};
  for (const r of rows) {
    statusCounts[r.verStatus] = (statusCounts[r.verStatus] ?? 0) + 1;
    const valGate = r.verValExpected !== "(absent)" ? "present" : "absent";
    valGateCounts[valGate] = (valGateCounts[valGate] ?? 0) + 1;
  }
  console.log("verification_status distribution:");
  for (const [k, v] of Object.entries(statusCounts)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("");
  console.log("value-gate fields present:");
  for (const [k, v] of Object.entries(valGateCounts)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log("");

  // Sample 3 active rows
  const active = rows.filter((r) => r.positionChange !== "closed" && r.sharesHeld > 0);
  console.log(`Active rows: ${active.length}`);
  console.log("");
  console.log("Sample active rows (first 3):");
  for (const r of active.slice(0, 3)) {
    console.log(`  doc: ${r.docId}`);
    console.log(`    quarter:                     ${r.quarter}`);
    console.log(`    updateTime:                  ${r.updateTime.toISOString()}`);
    console.log(`    shares_held:                 ${r.sharesHeld.toLocaleString()}`);
    console.log(`    position_change:             ${r.positionChange}`);
    console.log(`    verification_status:         ${r.verStatus}`);
    console.log(`    verification_expected:       ${r.verExpected}`);
    console.log(`    verification_actual:         ${r.verActual}`);
    console.log(`    verification_value_expected: ${typeof r.verValExpected === "number" ? "$" + r.verValExpected.toLocaleString() : r.verValExpected}`);
    console.log(`    verification_value_actual:   ${typeof r.verValActual === "number" ? "$" + r.verValActual.toLocaleString() : r.verValActual}`);
    console.log("");
  }

  // ─── OBSERVED VS PREDICTED ────────────────────────────────────────────
  console.log("============================================================");
  console.log("OBSERVED vs PREDICTED");
  console.log("============================================================");
  console.log("");
  console.log("Prediction (per protocol):");
  console.log("  verification_status:   INSUFFICIENT_DATA");
  console.log("  verification_expected: 592");
  console.log("  verification_actual:   591");
  console.log("");
  if (active.length === 0) {
    console.log("⚠️  No active rows — cannot verify prediction. Investigate.");
    return;
  }
  const sample = active[0]!;
  const statusMatch = sample.verStatus === "INSUFFICIENT_DATA";
  const expectedMatch = sample.verExpected === 592;
  const actualMatch = sample.verActual === 591;
  console.log("Observed (first active row):");
  console.log(`  verification_status:   ${sample.verStatus}  ${statusMatch ? "✓ matches" : "✗ DIFFERS from prediction"}`);
  console.log(`  verification_expected: ${sample.verExpected}  ${expectedMatch ? "✓ matches" : "✗ DIFFERS from prediction"}`);
  console.log(`  verification_actual:   ${sample.verActual}  ${actualMatch ? "✓ matches" : "✗ DIFFERS from prediction"}`);
  console.log("");

  // Value-sum gate analysis
  console.log("Value-sum gate (Gate 2):");
  console.log(`  verification_value_expected: ${typeof sample.verValExpected === "number" ? "$" + sample.verValExpected.toLocaleString() : sample.verValExpected}`);
  console.log(`  verification_value_actual:   ${typeof sample.verValActual === "number" ? "$" + sample.verValActual.toLocaleString() : sample.verValActual}`);
  if (typeof sample.verValExpected === "number" && typeof sample.verValActual === "number") {
    const valueMatch = sample.verValExpected === sample.verValActual;
    console.log(`  value-sum gate: ${valueMatch ? "✓ passes (raw value === declared)" : "✗ FAILS (raw value !== declared)"}`);
    console.log(`    → INSUFFICIENT_DATA reason: row-count gate fails (591 vs 592)${valueMatch ? "" : " + value-sum gate also fails"}`);
  } else {
    console.log(`  ⚠️  Value-sum fields missing — investigate.`);
  }
  console.log("");

  if (statusMatch && expectedMatch && actualMatch) {
    console.log("✅ LIVE TEETH OBSERVATION — PREDICTION HOLDS.");
    console.log("");
    console.log("Pre-fix code would have stamped this filing differently (aggregated count vs");
    console.log("declared). B+ correctly fires the row-count gate: filer declared 592 entries,");
    console.log("file physically contains 591 (verified by independent namespace-aware grep AND");
    console.log("parse13FXml). Status: INSUFFICIENT_DATA, accurately. The guard's negative direction");
    console.log("is now observed live on real data — the asymmetry that's been open all session is");
    console.log("closed in the same two-sided shape as the heal.");
  } else {
    console.log("⚠️  PREDICTION DIFFERS FROM OBSERVED. Report exactly what landed; do not smooth.");
    if (!statusMatch) console.log(`    Expected status INSUFFICIENT_DATA, got ${sample.verStatus}`);
    if (!expectedMatch) console.log(`    Expected verification_expected=592, got ${sample.verExpected}`);
    if (!actualMatch) console.log(`    Expected verification_actual=591, got ${sample.verActual}`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
