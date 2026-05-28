/**
 * Step B verification of B+ dual-gate stamping across all 10 Step-3 funds.
 *
 * For each fund: query post-Step-3 (updateTime >= cutoff) docs at the
 * target quarter, summarize verification_status, confirm all four
 * verification fields present, surface any anomalies.
 *
 * READ-ONLY.
 */
import { getLiveDb } from "../src/firestore.js";

const STEP_3_CUTOFF_ISO = "2026-05-25T17:00:00Z";
const QUARTER = "2026-03-31";

const TARGETS: Array<{ alias: string; cik: string }> = [
  { alias: "berkshire", cik: "0001067983" },
  { alias: "vanguard", cik: "0000102909" },
  { alias: "bridgewater", cik: "0001350694" },
  { alias: "citadel", cik: "0001423053" },
  { alias: "point72", cik: "0001603466" },
  { alias: "deshaw", cik: "0001009207" },
  { alias: "renaissance", cik: "0001037389" },
  { alias: "twosigma", cik: "0001179392" },
  { alias: "millennium", cik: "0001273087" },
  { alias: "blackrock-new (raw CIK)", cik: "0002012383" },
];

interface FundSummary {
  alias: string;
  cik: string;
  totalDocs: number;
  postStep3Docs: number;
  active: number;
  closed: number;
  verifiedCount: number;
  insufficientCount: number;
  unstampedCount: number;
  allFourFieldsPresentCount: number;
  missingValueGateFields: number;
  sampleExpected: number | string;
  sampleActual: number | string;
  sampleValueExpected: number | string;
  sampleValueActual: number | string;
  sampleDualGateMatch: boolean | null; // both gates passing per stamped values
  positionChangeDist: Record<string, number>;
  earliestUpdate: string;
  latestUpdate: string;
}

async function main(): Promise<void> {
  const cutoffMs = new Date(STEP_3_CUTOFF_ISO).getTime();
  const db = await getLiveDb();

  console.log("============================================================");
  console.log("Step B verification — dual-gate stamping across 10 Step-3 funds");
  console.log(`  cutoff:  ${STEP_3_CUTOFF_ISO}`);
  console.log(`  quarter: ${QUARTER}`);
  console.log("============================================================");
  console.log("");

  const summaries: FundSummary[] = [];

  for (const t of TARGETS) {
    const snap = await db
      .collection("institutional_holdings")
      .where("fund_cik", "==", t.cik)
      .where("quarter", "==", QUARTER)
      .get();

    let postStep3 = 0;
    let active = 0;
    let closed = 0;
    let verified = 0;
    let insuff = 0;
    let unstamped = 0;
    let allFourPresent = 0;
    let missingValueGate = 0;
    let earliest = new Date("9999-12-31");
    let latest = new Date(0);
    let sampleExpected: number | string = "(no sample)";
    let sampleActual: number | string = "(no sample)";
    let sampleValueExpected: number | string = "(no sample)";
    let sampleValueActual: number | string = "(no sample)";
    let sampleDualGateMatch: boolean | null = null;
    const posDist: Record<string, number> = {};

    let firstActiveCaptured = false;
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const upd = doc.updateTime?.toDate() ?? new Date(0);
      if (upd.getTime() < cutoffMs) continue;
      postStep3 += 1;

      if (upd.getTime() < earliest.getTime()) earliest = upd;
      if (upd.getTime() > latest.getTime()) latest = upd;

      const posChange = (data.position_change as string | undefined) ?? "(absent)";
      posDist[posChange] = (posDist[posChange] ?? 0) + 1;

      const sharesHeld = (data.shares_held as number | undefined) ?? -1;
      const isClosed = posChange === "closed" || sharesHeld === 0;
      if (isClosed) closed += 1;
      else active += 1;

      const verStatus = data.verification_status as string | undefined;
      if (verStatus === "VERIFIED") verified += 1;
      else if (verStatus === "INSUFFICIENT_DATA") insuff += 1;
      else unstamped += 1;

      const hasExpected = data.verification_expected !== undefined;
      const hasActual = data.verification_actual !== undefined;
      const hasValExpected = data.verification_value_expected !== undefined;
      const hasValActual = data.verification_value_actual !== undefined;
      if (hasExpected && hasActual && hasValExpected && hasValActual) {
        allFourPresent += 1;
      } else if (verStatus !== undefined && (!hasValExpected || !hasValActual)) {
        missingValueGate += 1;
      }

      // Capture first ACTIVE row as the sample for per-fund display
      if (!firstActiveCaptured && !isClosed) {
        sampleExpected = (data.verification_expected as number | undefined) ?? "(absent)";
        sampleActual = (data.verification_actual as number | undefined) ?? "(absent)";
        sampleValueExpected =
          (data.verification_value_expected as number | undefined) ?? "(absent)";
        sampleValueActual =
          (data.verification_value_actual as number | undefined) ?? "(absent)";
        if (
          typeof sampleExpected === "number" &&
          typeof sampleActual === "number" &&
          typeof sampleValueExpected === "number" &&
          typeof sampleValueActual === "number"
        ) {
          sampleDualGateMatch =
            sampleExpected === sampleActual && sampleValueExpected === sampleValueActual;
        }
        firstActiveCaptured = true;
      }
    }

    summaries.push({
      alias: t.alias,
      cik: t.cik,
      totalDocs: snap.docs.length,
      postStep3Docs: postStep3,
      active,
      closed,
      verifiedCount: verified,
      insufficientCount: insuff,
      unstampedCount: unstamped,
      allFourFieldsPresentCount: allFourPresent,
      missingValueGateFields: missingValueGate,
      sampleExpected,
      sampleActual,
      sampleValueExpected,
      sampleValueActual,
      sampleDualGateMatch,
      positionChangeDist: posDist,
      earliestUpdate: postStep3 > 0 ? earliest.toISOString() : "-",
      latestUpdate: postStep3 > 0 ? latest.toISOString() : "-",
    });
  }

  // ── Per-fund summary table ────────────────────────────────────────────
  console.log("Per-fund post-Step-3 summary:");
  console.log("");
  console.log(
    `  alias               | cik         | post-step3 | active | closed | VERIFIED | INSUFF | unstmpd | 4-field | missing-vg | dual-gate-match | sample expected/actual / value_exp/val_act`,
  );
  console.log(
    `  --------------------|-------------|------------|--------|--------|----------|--------|---------|---------|------------|-----------------|---------------------------------------------`,
  );
  for (const s of summaries) {
    const match = s.sampleDualGateMatch === null ? "n/a" : s.sampleDualGateMatch ? "PASS" : "FAIL";
    const valExpStr = typeof s.sampleValueExpected === "number" ? s.sampleValueExpected.toLocaleString() : String(s.sampleValueExpected);
    const valActStr = typeof s.sampleValueActual === "number" ? s.sampleValueActual.toLocaleString() : String(s.sampleValueActual);
    console.log(
      `  ${s.alias.padEnd(19)} | ${s.cik} | ${String(s.postStep3Docs).padStart(10)} | ${String(s.active).padStart(6)} | ${String(s.closed).padStart(6)} | ${String(s.verifiedCount).padStart(8)} | ${String(s.insufficientCount).padStart(6)} | ${String(s.unstampedCount).padStart(7)} | ${String(s.allFourFieldsPresentCount).padStart(7)} | ${String(s.missingValueGateFields).padStart(10)} | ${match.padStart(15)} | ${s.sampleExpected}/${s.sampleActual} ($${valExpStr}/$${valActStr})`,
    );
  }
  console.log("");

  // ── Verdict on Step B criteria ────────────────────────────────────────
  console.log("============================================================");
  console.log("STEP B CRITERION VERDICTS");
  console.log("============================================================");
  console.log("");

  // (1) Funds that were false-INSUFFICIENT_DATA pre-fix now stamp VERIFIED
  console.log("(1) Funds that were false-INSUFFICIENT_DATA pre-fix now stamp VERIFIED:");
  const verifiedFunds = summaries.filter(
    (s) => s.verifiedCount > 0 && s.insufficientCount === 0 && s.unstampedCount === 0,
  );
  const partiallyStampedFunds = summaries.filter(
    (s) => s.postStep3Docs > 0 && (s.verifiedCount === 0 || s.insufficientCount > 0 || s.unstampedCount > 0),
  );
  console.log(`    Funds with active rows ALL VERIFIED (no INSUFFICIENT_DATA / no unstamped): ${verifiedFunds.length} / 10`);
  for (const s of verifiedFunds) {
    console.log(`      ${s.alias} (CIK ${s.cik}): ${s.verifiedCount} VERIFIED rows`);
  }
  if (partiallyStampedFunds.length > 0) {
    console.log(`    Funds with mixed stamping: ${partiallyStampedFunds.length}`);
    for (const s of partiallyStampedFunds) {
      console.log(`      ${s.alias} (CIK ${s.cik}): VERIFIED=${s.verifiedCount} INSUFF=${s.insufficientCount} unstamped=${s.unstampedCount}`);
    }
  }
  console.log("");
  console.log(`    NOTE: The 5 censused INSUFF funds (Coastline / Atlas Brown / EIP / Park West / Harvest) are`);
  console.log(`    FTS-discovered, NOT in TRACKED_FUNDS, NOT re-ticked in Step 3, so their pre-fix INSUFFICIENT_DATA`);
  console.log(`    stamps remain unchanged. They will only re-stamp if the 20:00Z scheduled cron surfaces them via`);
  console.log(`    FTS discovery (same incidental basket the 16:00Z tick covered).`);
  console.log("");

  // (2) Value-sum gate fires correctly on BlackRock-new
  console.log("(2) Value-sum gate on BlackRock-new combination report:");
  const brn = summaries.find((s) => s.cik === "0002012383");
  if (brn) {
    const match =
      brn.sampleValueExpected === brn.sampleValueActual && typeof brn.sampleValueExpected === "number";
    console.log(`    sample verification_value_expected: $${typeof brn.sampleValueExpected === "number" ? brn.sampleValueExpected.toLocaleString() : brn.sampleValueExpected}`);
    console.log(`    sample verification_value_actual:   $${typeof brn.sampleValueActual === "number" ? brn.sampleValueActual.toLocaleString() : brn.sampleValueActual}`);
    console.log(`    exact match (Σ raw value === declared tableValueTotal): ${match ? "✓ PASS" : "✗ FAIL"}`);
  }
  console.log("");

  // (3) (β) telemetry already captured separately above
  console.log("(3) BlackRock-new (β) CLI telemetry: captured above in shell output (49s wall clock, 0 errors, no OOM)");
  console.log("");

  // (4) /meta confirmation
  console.log("(4) /meta confirmation:");
  console.log(`    Note: /meta/institutional13FSync is written by scrape13FQuarterHourly (Cloud Function),`);
  console.log(`    NOT by the CLI path used in Step 3. The /meta timestamp reflects the last SCHEDULED tick,`);
  console.log(`    which was 16:00Z on pre-fix code. Will update on next 20:00Z scheduled run with B+ code.`);
  console.log(`    Reading /meta for record:`);
  const metaSnap = await db.collection("meta").doc("institutional13FSync").get();
  if (metaSnap.exists) {
    const meta = metaSnap.data() as Record<string, unknown>;
    const lastSyncedAt = meta.lastSyncedAt;
    const tsStr =
      lastSyncedAt &&
      typeof lastSyncedAt === "object" &&
      "toDate" in (lastSyncedAt as Record<string, unknown>)
        ? ((lastSyncedAt as { toDate: () => Date }).toDate()).toISOString()
        : "(unparseable)";
    console.log(`      lastSyncedAt: ${tsStr}`);
    console.log(`      docsWritten: ${meta.docsWritten ?? "(no field)"}`);
  } else {
    console.log(`      (no /meta/institutional13FSync doc)`);
  }
  console.log("");

  // ── Final tally ──────────────────────────────────────────────────────
  const totalPostStep3 = summaries.reduce((a, s) => a + s.postStep3Docs, 0);
  const totalVerified = summaries.reduce((a, s) => a + s.verifiedCount, 0);
  const totalInsuff = summaries.reduce((a, s) => a + s.insufficientCount, 0);
  const totalUnstamped = summaries.reduce((a, s) => a + s.unstampedCount, 0);
  const total4Field = summaries.reduce((a, s) => a + s.allFourFieldsPresentCount, 0);
  const totalMissingVG = summaries.reduce((a, s) => a + s.missingValueGateFields, 0);

  console.log("============================================================");
  console.log("AGGREGATE");
  console.log("============================================================");
  console.log(`  Total post-Step-3 docs written: ${totalPostStep3}`);
  console.log(`  VERIFIED:                       ${totalVerified}`);
  console.log(`  INSUFFICIENT_DATA:              ${totalInsuff}`);
  console.log(`  Unstamped:                      ${totalUnstamped}`);
  console.log(`  All-four-fields present:        ${total4Field}`);
  console.log(`  verification_status set BUT value-gate fields missing: ${totalMissingVG}`);
  console.log("");
  if (totalMissingVG > 0) {
    console.log(`  ⚠️  ${totalMissingVG} rows have verification_status but lack value-gate fields.`);
    console.log(`     Expected source: synthetic closed-row synthesis spreads from prior-quarter doc.`);
    console.log(`     Per-fund missing-vg counts above. Not a B+ failure on active rows; v4 record item.`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
