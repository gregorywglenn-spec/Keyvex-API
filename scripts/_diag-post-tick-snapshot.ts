/**
 * Post-tick snapshot of institutional_holdings after the 2026-05-25 16:00Z
 * 4-hourly tick fired on pre-fix code. Three deliverables, all read-only:
 *
 *   1. FALSIFICATION CHECK on the C diagnosis. Berkshire (fund_cik =
 *      0001067983) must have ZERO docs with updateTime >= cutoff. Any
 *      post-tick Berkshire write contradicts the discovery-cap mechanism
 *      and must be flagged loudly — Greg's stop-condition.
 *
 *   2. QUARANTINED BASELINE — collection-wide verification_status
 *      distribution AFTER the tick. The pre-fix count-check bug stamps
 *      INSUFFICIENT_DATA on every aggregating filer (the false positive
 *      we just fixed in B+). This number is a known-false baseline for
 *      comparing against the post-B+-deploy re-tick count, NOTHING more.
 *      DO NOT use it to size a heal population.
 *
 *   3. WIRE-CLAUDE HANDOFF — exact list of funds (fund_cik + fund_name)
 *      that wrote at least one doc with updateTime >= cutoff this tick.
 *      Wire-Claude pulls these on the serving layer and reconciles
 *      Firestore (this side) vs the MCP surface (wire side).
 *
 * READ-ONLY. No writes. No mutation. Phase B stays LOCKED.
 */
import { Timestamp } from "firebase-admin/firestore";
import { getLiveDb } from "../src/firestore.js";

const TICK_CUTOFF_ISO = "2026-05-25T16:00:00Z";
const BERKSHIRE_CIK = "0001067983";

interface FundActivity {
  fund_cik: string;
  fund_name_observed: string;
  totalDocs: number;
  postTickDocs: number;
  earliestPostTick: Date | null;
  latestPostTick: Date | null;
  accessionsPostTick: Set<string>;
  quartersPostTick: Set<string>;
  withVerStatus: number;
  verifiedCount: number;
  insufficientCount: number;
  unstamped: number;
}

function newFundActivity(fund_cik: string, fund_name: string): FundActivity {
  return {
    fund_cik,
    fund_name_observed: fund_name,
    totalDocs: 0,
    postTickDocs: 0,
    earliestPostTick: null,
    latestPostTick: null,
    accessionsPostTick: new Set(),
    quartersPostTick: new Set(),
    withVerStatus: 0,
    verifiedCount: 0,
    insufficientCount: 0,
    unstamped: 0,
  };
}

async function main(): Promise<void> {
  const tickCutoffMs = new Date(TICK_CUTOFF_ISO).getTime();
  const now = new Date();

  console.log("==========================================================");
  console.log("Post-tick snapshot — institutional_holdings");
  console.log(`  Tick cutoff: ${TICK_CUTOFF_ISO}`);
  console.log(`  Snapshot at: ${now.toISOString()}`);
  console.log(`  ${Math.round((now.getTime() - tickCutoffMs) / 60000)} min since cutoff`);
  console.log("==========================================================");
  console.log("");

  const db = await getLiveDb();

  // ─── Scan whole collection (with select to keep payloads light) ────────
  // updateTime is on the doc snapshot metadata, not in the body, so it's
  // returned regardless of which fields are projected.
  console.log("Pulling institutional_holdings (projected fields only)...");
  const t0 = Date.now();
  const snap = await db
    .collection("institutional_holdings")
    .select(
      "fund_cik",
      "fund_name",
      "accession_number",
      "quarter",
      "verification_status",
    )
    .get();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${snap.docs.length} docs in ${elapsed}s`);
  console.log("");

  // ─── Build per-fund activity map ───────────────────────────────────────
  const funds = new Map<string, FundActivity>();
  let totalPostTick = 0;
  let totalVerified = 0;
  let totalInsufficient = 0;
  let totalUnstamped = 0;
  let latestUpdateOverall = new Date(0);

  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const cik = (data.fund_cik as string | undefined) ?? "(missing)";
    const name = (data.fund_name as string | undefined) ?? "(missing)";
    const acc = (data.accession_number as string | undefined) ?? "(missing)";
    const quarter = (data.quarter as string | undefined) ?? "(missing)";
    const verStatus = data.verification_status as string | undefined;
    const upd = doc.updateTime?.toDate() ?? new Date(0);

    if (upd.getTime() > latestUpdateOverall.getTime()) {
      latestUpdateOverall = upd;
    }

    let f = funds.get(cik);
    if (!f) {
      f = newFundActivity(cik, name);
      funds.set(cik, f);
    }
    f.totalDocs += 1;

    if (verStatus === "VERIFIED") {
      f.withVerStatus += 1;
      f.verifiedCount += 1;
      totalVerified += 1;
    } else if (verStatus === "INSUFFICIENT_DATA") {
      f.withVerStatus += 1;
      f.insufficientCount += 1;
      totalInsufficient += 1;
    } else {
      f.unstamped += 1;
      totalUnstamped += 1;
    }

    if (upd.getTime() >= tickCutoffMs) {
      f.postTickDocs += 1;
      totalPostTick += 1;
      f.accessionsPostTick.add(acc);
      f.quartersPostTick.add(quarter);
      if (!f.earliestPostTick || upd.getTime() < f.earliestPostTick.getTime()) {
        f.earliestPostTick = upd;
      }
      if (!f.latestPostTick || upd.getTime() > f.latestPostTick.getTime()) {
        f.latestPostTick = upd;
      }
    }
  }

  // ─── ITEM 1: Berkshire falsification check ─────────────────────────────
  console.log("======================================================");
  console.log("ITEM 1 — Berkshire falsification check");
  console.log("======================================================");
  const brk = funds.get(BERKSHIRE_CIK);
  if (!brk) {
    console.log(`  ⚠️  No Berkshire docs found AT ALL in institutional_holdings. Anomaly.`);
  } else {
    console.log(
      `  Berkshire (CIK ${BERKSHIRE_CIK}): ${brk.totalDocs} total docs, ${brk.postTickDocs} written post-tick`,
    );
    if (brk.postTickDocs === 0) {
      console.log(
        `  ✅ FALSIFICATION ATTEMPT NULL — zero Berkshire docs with updateTime >= ${TICK_CUTOFF_ISO}.`,
      );
      console.log(
        `     Discovery-cap mechanism holds under live conditions. The 16:00Z tick did not write Berkshire.`,
      );
    } else {
      console.log(
        `  ❌ FALSIFICATION HIT — ${brk.postTickDocs} Berkshire docs with post-tick updateTime.`,
      );
      console.log(`     Range: ${brk.earliestPostTick?.toISOString()} → ${brk.latestPostTick?.toISOString()}`);
      console.log(`     Accessions: ${Array.from(brk.accessionsPostTick).join(", ")}`);
      console.log(`     Quarters: ${Array.from(brk.quartersPostTick).join(", ")}`);
      console.log(`     >>> C DIAGNOSIS CONTRADICTED. Stop and re-examine the mechanism. <<<`);
    }
  }
  console.log("");

  // ─── ITEM 3 (a): collection-wide verification_status distribution ──────
  console.log("======================================================");
  console.log("ITEM 3a — Collection-wide verification_status distribution");
  console.log("           (POST-TICK, PRE-FIX LOGIC — QUARANTINED AS KNOWN-FALSE)");
  console.log("           DO NOT use this count to size any heal population.");
  console.log("           These INSUFFICIENT_DATA stamps are the count-check");
  console.log("           bug, not signal. Recorded only as before-number for");
  console.log("           post-B+-deploy re-tick comparison.");
  console.log("======================================================");
  console.log(`  Total docs: ${snap.docs.length}`);
  console.log(`  VERIFIED:           ${totalVerified.toString().padStart(8)}`);
  console.log(`  INSUFFICIENT_DATA:  ${totalInsufficient.toString().padStart(8)}  (KNOWN-FALSE under pre-fix logic)`);
  console.log(`  unstamped (no field): ${totalUnstamped.toString().padStart(6)}  (pre-Phase-A writes)`);
  console.log("");

  // ─── ITEM 3 (b): wire-Claude handoff — funds with post-tick writes ─────
  console.log("======================================================");
  console.log("ITEM 3b — Wire-Claude handoff");
  console.log("           Funds that wrote at least one doc post-tick");
  console.log("           (updateTime >= " + TICK_CUTOFF_ISO + ")");
  console.log("======================================================");

  const wroteThisTick: FundActivity[] = Array.from(funds.values())
    .filter((f) => f.postTickDocs > 0)
    .sort((a, b) => b.postTickDocs - a.postTickDocs);

  console.log(`  Total post-tick docs: ${totalPostTick}`);
  console.log(`  Funds with any post-tick activity: ${wroteThisTick.length}`);
  console.log(`  Latest updateTime in collection: ${latestUpdateOverall.toISOString()}`);
  console.log("");

  if (wroteThisTick.length === 0) {
    console.log(`  ⚠️  ZERO funds wrote this tick. Either the cron didn't fire OR it`);
    console.log(`     fired and processed zero filings. Check /meta/institutional13FSync`);
    console.log(`     for the scheduler's own self-report.`);
  } else {
    console.log(
      `  fund_cik    | fund_name                                   | new docs | accessions | quarters    | VERIFIED | INSUFFICIENT_DATA | unstamped | post-tick window`,
    );
    console.log(
      `  ------------|---------------------------------------------|----------|------------|-------------|----------|-------------------|-----------|------------------`,
    );
    for (const f of wroteThisTick) {
      const accs = Array.from(f.accessionsPostTick).join(",");
      const qs = Array.from(f.quartersPostTick).join(",");
      // For a per-fund verification breakdown LIMITED to post-tick writes,
      // we'd need to re-iterate. Approximation: report the aggregate per-
      // fund counts; wire-Claude can do a finer split if needed.
      const window =
        f.earliestPostTick && f.latestPostTick
          ? f.earliestPostTick.getTime() === f.latestPostTick.getTime()
            ? f.earliestPostTick.toISOString().slice(11, 23)
            : `${f.earliestPostTick.toISOString().slice(11, 23)}-${f.latestPostTick.toISOString().slice(11, 23)}`
          : "-";
      console.log(
        `  ${f.fund_cik}  | ${f.fund_name_observed.slice(0, 43).padEnd(43)} | ${String(f.postTickDocs).padStart(8)} | ${accs.slice(0, 10).padEnd(10)} | ${qs.slice(0, 11).padEnd(11)} | ${String(f.verifiedCount).padStart(8)} | ${String(f.insufficientCount).padStart(17)} | ${String(f.unstamped).padStart(9)} | ${window}`,
      );
    }
  }
  console.log("");

  // ─── Meta self-report ──────────────────────────────────────────────────
  console.log("======================================================");
  console.log("Scheduler /meta self-report (cross-check)");
  console.log("======================================================");
  try {
    const metaSnap = await db
      .collection("meta")
      .doc("institutional13FSync")
      .get();
    if (metaSnap.exists) {
      const meta = metaSnap.data() as Record<string, unknown>;
      const lastSyncedAt = meta.lastSyncedAt;
      const lastSyncedAtDate =
        lastSyncedAt instanceof Timestamp
          ? lastSyncedAt.toDate()
          : lastSyncedAt instanceof Date
            ? lastSyncedAt
            : null;
      console.log(`  /meta/institutional13FSync.lastSyncedAt = ${lastSyncedAtDate?.toISOString() ?? "(none/unparseable)"}`);
      const docsWritten = meta.docsWritten ?? "(no field)";
      console.log(`  /meta/institutional13FSync.docsWritten   = ${docsWritten}`);
      if (lastSyncedAtDate && lastSyncedAtDate.getTime() >= tickCutoffMs) {
        console.log(`  ✅ Scheduler self-reports a post-tick sync (cron fired and ran writeJobMeta).`);
      } else {
        console.log(`  ⚠️  Scheduler's last self-reported sync predates the cutoff. Cron may not have fired OR writeJobMeta didn't land.`);
      }
    } else {
      console.log(`  ⚠️  /meta/institutional13FSync doc doesn't exist. Scheduler has never self-reported.`);
    }
  } catch (e) {
    console.log(`  ERROR reading /meta: ${(e as Error).message}`);
  }
  console.log("");

  console.log("======================================================");
  console.log("Snapshot complete. Read-only. Phase B stays LOCKED.");
  console.log("======================================================");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
