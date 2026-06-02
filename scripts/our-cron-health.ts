/**
 * Read-only cron-health report for capitaledge-api (KeyVex's own project).
 *
 * Reads every /meta/{job} freshness doc and grades it against the SAME
 * thresholds the production scheduledHealthCheck uses (imported verbatim
 * from functions/src/health-check.ts). Does NOT write anything and does NOT
 * post to Slack — purely a local diagnostic to confirm our crons are alive.
 *
 *   npx tsx scripts/our-cron-health.ts
 */
import { JOBS } from "../functions/src/health-check.js";
import { getLiveDb, isStubMode } from "../src/firestore.js";

function resolveTimestamp(data: Record<string, unknown> | null): number | null {
  if (!data) return null;
  const candidates = ["lastSyncedAt", "lastRunAt", "lastFinishedAt", "lastChecked", "completedAt"];
  let latest: number | null = null;
  for (const field of candidates) {
    const value = data[field];
    if (value == null) continue;
    let ms: number | null = null;
    if (typeof value === "object" && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      ms = (value as { toMillis: () => number }).toMillis();
    } else if (value instanceof Date) {
      ms = value.getTime();
    } else if (typeof value === "string") {
      const p = Date.parse(value);
      if (!Number.isNaN(p)) ms = p;
    } else if (typeof value === "number") {
      ms = value;
    }
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

function fmtAge(h: number): string {
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

async function main() {
  if (isStubMode()) {
    console.error("STUB MODE — no secrets/service-account.json found. Cannot read live Firestore.");
    process.exit(1);
  }
  const db = await getLiveDb();
  const now = Date.now();

  const rows: Array<{ status: string; label: string; age: string; cadence: string; detail: string }> = [];
  const counts = { ok: 0, warn: 0, fail: 0 };

  for (const job of JOBS) {
    let data: Record<string, unknown> | null = null;
    try {
      const snap = await db.collection("meta").doc(job.metaDoc).get();
      data = snap.exists ? ((snap.data() as Record<string, unknown>) ?? null) : null;
    } catch (err) {
      rows.push({ status: "ERR", label: job.label, age: "-", cadence: job.cadence, detail: `read error: ${String(err)}` });
      continue;
    }
    const lastMs = resolveTimestamp(data);
    if (lastMs === null) {
      counts.fail++;
      rows.push({ status: "FAIL", label: job.label, age: "never", cadence: job.cadence, detail: "no successful run on record" });
      continue;
    }
    const ageH = (now - lastMs) / 3_600_000;
    const docs = data && typeof data.docsWritten === "number" ? ` (${data.docsWritten} docs)` : "";
    const last = new Date(lastMs).toISOString().replace("T", " ").slice(0, 16) + "Z";
    if (ageH > job.failHours) {
      counts.fail++;
      rows.push({ status: "FAIL", label: job.label, age: fmtAge(ageH), cadence: job.cadence, detail: `stale — last ${last}${docs}` });
    } else if (ageH > job.warnHours) {
      counts.warn++;
      rows.push({ status: "WARN", label: job.label, age: fmtAge(ageH), cadence: job.cadence, detail: `last ${last}${docs}` });
    } else {
      counts.ok++;
      rows.push({ status: "ok", label: job.label, age: fmtAge(ageH), cadence: job.cadence, detail: `last ${last}${docs}` });
    }
  }

  // Sort: FAIL first, then WARN, then ok.
  const order: Record<string, number> = { ERR: 0, FAIL: 1, WARN: 2, ok: 3 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || a.label.localeCompare(b.label));

  console.log(`\n=== capitaledge-api cron health (${JOBS.length} jobs) — ${new Date(now).toISOString()} ===\n`);
  for (const r of rows) {
    const tag = r.status === "ok" ? "  ok " : r.status === "WARN" ? "⚠ WARN" : r.status === "FAIL" ? "✖ FAIL" : "‼ ERR ";
    console.log(`${tag}  ${r.age.padStart(5)}  ${r.label.padEnd(46)} [${r.cadence}]  ${r.detail}`);
  }
  console.log(`\nSummary: ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail (of ${JOBS.length})\n`);

  // Also report the health-check doc's own last run, so we know if the
  // monitor itself is alive.
  try {
    const hc = await db.collection("meta").doc("healthCheck").get();
    if (hc.exists) {
      const d = hc.data() as Record<string, unknown>;
      const lc = resolveTimestamp({ lastChecked: d.lastChecked });
      console.log(`healthCheck doc: status=${String(d.status)} lastNotifiedStatus=${String(d.lastNotifiedStatus)} lastChecked=${lc ? fmtAge((now - lc) / 3_600_000) + " ago" : "?"}`);
    } else {
      console.log("healthCheck doc: MISSING — scheduledHealthCheck has never written /meta/healthCheck (likely never run / not deployed).");
    }
  } catch (err) {
    console.log(`healthCheck doc: read error ${String(err)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
