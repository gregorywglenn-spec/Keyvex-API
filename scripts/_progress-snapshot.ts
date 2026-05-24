/**
 * Read-only progress snapshot — safe to run while the orchestrator is live.
 * Reads the checkpoint file + queries Firestore counts. No writes, no
 * locks, no impact on the running job.
 */
import * as fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLiveDb } from "../src/firestore.js";
import type { CheckpointFile } from "../src/scrapers/form345-bulk-orchestrator.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_PATH = resolve(MODULE_DIR, "..", "secrets/form345-bulk-checkpoint.json");

async function main() {
  const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8")) as CheckpointFile;
  const quarters = Object.entries(cp.quarters);

  const completed = quarters.filter(([, q]) => q.status === "completed");
  const inProgress = quarters.filter(([, q]) => q.status === "in_progress");
  const failed = quarters.filter(([, q]) => q.status === "failed");
  const notPublished = quarters.filter(([, q]) => q.status === "not_published");

  // Compute total ingested counts (per checkpoint claims)
  let totalTx = 0,
    totalHold = 0,
    totalFiling = 0;
  for (const [, q] of completed) {
    totalTx += q.tx_count ?? 0;
    totalHold += q.hold_count ?? 0;
    totalFiling += q.filing_count ?? 0;
  }

  // Latest completed
  const sortedCompleted = [...completed].sort(
    (a, b) =>
      Date.parse(b[1].completed_at ?? "1970") -
      Date.parse(a[1].completed_at ?? "1970"),
  );
  const latest = sortedCompleted[0];

  // Average wall per quarter (last 10 completed for fresh signal)
  const last10 = sortedCompleted.slice(0, 10);
  let avgMs = 0;
  if (last10.length > 0) {
    const wallsMs: number[] = [];
    for (const [, q] of last10) {
      if (q.started_at && q.completed_at) {
        wallsMs.push(Date.parse(q.completed_at) - Date.parse(q.started_at));
      }
    }
    avgMs = wallsMs.reduce((a, b) => a + b, 0) / wallsMs.length;
  }
  const avgSec = (avgMs / 1000).toFixed(0);
  const avgMin = (avgMs / 60000).toFixed(1);

  // ETA
  const remaining = 82 - completed.length - notPublished.length - failed.length;
  const etaMs = remaining * avgMs;
  const etaHours = (etaMs / 3_600_000).toFixed(1);
  const etaCompletionAt = new Date(Date.now() + etaMs);

  console.log("============================================================");
  console.log("BULK LOAD — LIVE PROGRESS SNAPSHOT");
  console.log("============================================================");
  console.log(`  Checkpoint last_run_at:  ${cp.last_run_at}`);
  console.log(`  Snapshot taken at:       ${new Date().toISOString()}`);
  console.log("");
  console.log(`  Completed quarters:      ${completed.length} / 82`);
  console.log(`  In-progress:             ${inProgress.length}`);
  console.log(`  Failed:                  ${failed.length}`);
  console.log(`  Not published:           ${notPublished.length}`);
  console.log("");
  if (latest) {
    console.log(`  Latest completed:        ${latest[0]} @ ${latest[1].completed_at}`);
  }
  if (inProgress.length > 0) {
    for (const [q, c] of inProgress) {
      const startedMs = Date.parse(c.started_at ?? "0");
      const elapsed = (Date.now() - startedMs) / 1000;
      console.log(`  Currently writing:       ${q} (started ${c.started_at}, ${elapsed.toFixed(0)}s elapsed)`);
    }
  }
  console.log("");
  console.log("  Per-quarter wall (last 10 completed):");
  console.log(`    avg: ${avgSec}s = ${avgMin} min`);
  console.log("");
  console.log("  Aggregate ingested per checkpoint:");
  console.log(`    insider_transactions_v2:  ${totalTx.toLocaleString()}`);
  console.log(`    insider_holdings_v2:      ${totalHold.toLocaleString()}`);
  console.log(`    insider_filings_v2:       ${totalFiling.toLocaleString()}`);
  console.log("");
  console.log(`  Remaining quarters:      ${remaining}`);
  console.log(`  ETA at current pace:     ${etaHours} hours`);
  console.log(`    → projected finish:    ${etaCompletionAt.toISOString()}`);
  console.log("");

  // Cross-check Firestore counts (sanity vs checkpoint claims)
  console.log("  Sanity check: live Firestore total counts (across ALL eras)");
  const db = await getLiveDb();
  const [txTotal, holdTotal, filingTotal] = await Promise.all([
    db.collection("insider_transactions_v2").count().get(),
    db.collection("insider_holdings_v2").count().get(),
    db.collection("insider_filings_v2").count().get(),
  ]);
  console.log(`    insider_transactions_v2:  ${txTotal.data().count.toLocaleString()}  (checkpoint claims: ${totalTx.toLocaleString()})`);
  console.log(`    insider_holdings_v2:      ${holdTotal.data().count.toLocaleString()}  (checkpoint claims: ${totalHold.toLocaleString()})`);
  console.log(`    insider_filings_v2:       ${filingTotal.data().count.toLocaleString()}  (checkpoint claims: ${totalFiling.toLocaleString()})`);

  // Recent completion list — last 8 to show velocity
  console.log("");
  console.log("  Most recent 8 completed quarters (newest first):");
  for (const [q, c] of sortedCompleted.slice(0, 8)) {
    const startedMs = Date.parse(c.started_at ?? "0");
    const completedMs = Date.parse(c.completed_at ?? "0");
    const wallMin = ((completedMs - startedMs) / 60000).toFixed(1);
    const total = (c.tx_count ?? 0) + (c.hold_count ?? 0) + (c.filing_count ?? 0);
    console.log(`    ${q}  ${total.toLocaleString().padStart(8)} docs in ${wallMin.padStart(5)} min`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
