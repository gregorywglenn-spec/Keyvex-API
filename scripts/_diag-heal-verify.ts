/**
 * Verify the 5-fund heal completed correctly:
 *   - Each fund's active rows transitioned INSUFFICIENT_DATA → VERIFIED
 *   - All four B+ fields present on active rows
 *   - For Harvest: explicit orphan count remaining
 *
 * READ-ONLY.
 */
import { getLiveDb } from "../src/firestore.js";

const HEAL_CUTOFF_ISO = "2026-05-25T19:19:29Z"; // heal start
const QUARTER = "2026-03-31";

const TARGETS: Array<{ alias: string; cik: string }> = [
  { alias: "Coastline", cik: "0001324279" },
  { alias: "Atlas Brown", cik: "0001388168" },
  { alias: "Energy Income Partners", cik: "0001388814" },
  { alias: "Park West", cik: "0001386928" },
  { alias: "Harvest", cik: "0001140315" },
];

async function main(): Promise<void> {
  const cutoffMs = new Date(HEAL_CUTOFF_ISO).getTime();
  const db = await getLiveDb();

  console.log("============================================================");
  console.log("5-fund heal verification");
  console.log(`  cutoff:  ${HEAL_CUTOFF_ISO}`);
  console.log(`  quarter: ${QUARTER}`);
  console.log("============================================================");
  console.log("");

  for (const t of TARGETS) {
    const snap = await db
      .collection("institutional_holdings")
      .where("fund_cik", "==", t.cik)
      .where("quarter", "==", QUARTER)
      .get();

    interface Row {
      docId: string;
      updateTime: Date;
      sharesHeld: number;
      positionChange: string;
      verStatus: string;
      verExpected: number | string;
      verActual: number | string;
      verValExpected: number | string;
      verValActual: number | string;
    }

    const postHeal: Row[] = [];
    const preHeal: Row[] = [];

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const upd = doc.updateTime?.toDate() ?? new Date(0);
      const row: Row = {
        docId: doc.id,
        updateTime: upd,
        sharesHeld: (data.shares_held as number | undefined) ?? -1,
        positionChange: (data.position_change as string | undefined) ?? "(absent)",
        verStatus: (data.verification_status as string | undefined) ?? "(absent)",
        verExpected: (data.verification_expected as number | undefined) ?? "(absent)",
        verActual: (data.verification_actual as number | undefined) ?? "(absent)",
        verValExpected: (data.verification_value_expected as number | undefined) ?? "(absent)",
        verValActual: (data.verification_value_actual as number | undefined) ?? "(absent)",
      };
      if (upd.getTime() >= cutoffMs) postHeal.push(row);
      else preHeal.push(row);
    }

    const active = postHeal.filter(
      (r) => r.positionChange !== "closed" && r.sharesHeld > 0,
    );
    const closed = postHeal.filter((r) => r.positionChange === "closed");
    const activeVerified = active.filter((r) => r.verStatus === "VERIFIED");
    const activeAllFourFields = active.filter(
      (r) =>
        r.verExpected !== "(absent)" &&
        r.verActual !== "(absent)" &&
        r.verValExpected !== "(absent)" &&
        r.verValActual !== "(absent)",
    );

    const sample = active[0];

    console.log(`────── ${t.alias} (CIK ${t.cik}) ──────`);
    console.log(`  total docs at quarter=${QUARTER}: ${snap.docs.length}`);
    console.log(`  post-heal (updateTime >= ${HEAL_CUTOFF_ISO}): ${postHeal.length}`);
    console.log(`    active:                 ${active.length}`);
    console.log(`    closed:                 ${closed.length}`);
    console.log(`    active VERIFIED:        ${activeVerified.length} / ${active.length}`);
    console.log(`    active all-4-fields:    ${activeAllFourFields.length} / ${active.length}`);
    console.log(`  pre-heal (stale, NOT touched by this run): ${preHeal.length}`);
    if (sample) {
      console.log(`  sample active row:`);
      console.log(`    doc=${sample.docId}`);
      console.log(`    verification_status:         ${sample.verStatus}`);
      console.log(`    verification_expected:       ${sample.verExpected}`);
      console.log(`    verification_actual:         ${sample.verActual}`);
      console.log(`    verification_value_expected: ${typeof sample.verValExpected === "number" ? "$" + sample.verValExpected.toLocaleString() : sample.verValExpected}`);
      console.log(`    verification_value_actual:   ${typeof sample.verValActual === "number" ? "$" + sample.verValActual.toLocaleString() : sample.verValActual}`);
      const dualGateMatch =
        typeof sample.verExpected === "number" &&
        sample.verExpected === sample.verActual &&
        typeof sample.verValExpected === "number" &&
        sample.verValExpected === sample.verValActual;
      console.log(`    dual-gate exact match:       ${dualGateMatch ? "✓ PASS" : "✗ FAIL"}`);
    }

    // Per-fund pass/fail verdict
    const cleanFlip =
      active.length > 0 &&
      activeVerified.length === active.length &&
      activeAllFourFields.length === active.length;
    console.log(`  verdict: ${cleanFlip ? "✅ active rows all VERIFIED with all four B+ fields" : "❌ verdict NOT clean — investigate"}`);

    // For Harvest specifically: explicit orphan accounting
    if (t.cik === "0001140315") {
      console.log("");
      console.log(`  ── HARVEST ORPHAN ACCOUNTING ──`);
      console.log(`    pre-heal stale docs (updateTime < ${HEAL_CUTOFF_ISO}): ${preHeal.length}`);
      const preHealUnstamped = preHeal.filter((r) => r.verStatus === "(absent)");
      const preHealStamped = preHeal.filter((r) => r.verStatus !== "(absent)");
      console.log(`      unstamped (pre-Phase-A, pre-2026-05-24): ${preHealUnstamped.length}`);
      console.log(`      stamped but stale: ${preHealStamped.length}`);
      console.log(`    closed rows synthesized by heal: ${closed.length}`);
      // Did any synthesized closed rows OVERLAP with stale orphans?
      // Synthesized closed rows would have updateTime >= cutoff; orphans < cutoff.
      // Doc IDs use cusip — if a synthesized closed row's CUSIP matched an orphan's,
      // the merge would have updated the orphan in-place to post-heal time.
      // So: pre-heal docs that REMAIN AFTER heal = orphans NOT cleared by closed-row overlap.
      console.log(`    orphans remaining after heal (pre-heal docs that survived): ${preHeal.length}`);
      if (preHeal.length > 0) {
        console.log(`    sample orphan:`);
        const o = preHeal[0]!;
        console.log(`      doc=${o.docId}  updateTime=${o.updateTime.toISOString()}`);
        console.log(`      shares_held=${o.sharesHeld}  position_change=${o.positionChange}  verification_status=${o.verStatus}`);
      }
    }

    console.log("");
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
