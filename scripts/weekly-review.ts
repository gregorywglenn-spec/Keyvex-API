/**
 * Deterministic scraper-health gather pass for the Mon/Wed/Fri Claude review.
 *
 *   npx tsx scripts/weekly-review.ts
 *
 * This script GATHERS facts and FLAGS obvious anomalies — it does NOT make
 * judgment calls and it does NOT post anywhere. It reads every /meta doc,
 * cross-references the authoritative JOBS list from the health-check (single
 * source of truth — imported, never copied), and prints a worst-first table
 * plus a machine-readable JSON block.
 *
 * The division of labor is deliberate:
 *   - THIS script = the meter readings (age, docsWritten, errors, status).
 *   - The scheduled Claude task = the judgment ("13F wrote 0 docs three runs
 *     in a row, that's off" / "FINRA still red, same root cause as last week")
 *     and the Slack write-up. That judgment layer is what makes this "Claude
 *     looking at them" rather than just a second cron.
 *
 * Read-only. Safe to run anytime. Never writes Firestore, never hits Slack.
 */
import { getLiveDb } from "../src/firestore.js";
import { JOBS } from "../functions/src/health-check.js";

const HOUR = 3_600_000;

type Status = "ok" | "warn" | "fail" | "no-meta";

interface Row {
  job: string;
  cadence: string;
  status: Status;
  ageHours: number | null;
  ageStr: string;
  docs: number | null;
  errors: number | null;
  flags: string[];
}

function ageStr(ms: number): string {
  const h = ms / HOUR;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Latest of any known "completed at" field on a /meta doc, or null. */
function lastSyncedMs(data: Record<string, unknown>): number | null {
  const fields = [
    "lastSyncedAt",
    "lastRunAt",
    "lastFinishedAt",
    "lastChecked",
    "completedAt",
  ];
  let best: number | null = null;
  for (const f of fields) {
    const v = data[f] as { toMillis?: () => number; toDate?: () => Date } | undefined;
    let ms: number | null = null;
    if (v && typeof v.toMillis === "function") ms = v.toMillis();
    else if (v && typeof v.toDate === "function") ms = v.toDate().getTime();
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Status ordering so we can sort worst-first.
const STATUS_RANK: Record<Status, number> = { fail: 0, "no-meta": 1, warn: 2, ok: 3 };

async function main() {
  const db = await getLiveDb();
  const snap = await db.collection("meta").get();
  const now = Date.now();

  // Index every /meta doc by id (minus the healthCheck bookkeeping doc).
  const metaById = new Map<string, Record<string, unknown>>();
  snap.forEach((doc) => {
    if (doc.id === "healthCheck") return;
    metaById.set(doc.id, doc.data());
  });

  const rows: Row[] = [];

  for (const job of JOBS) {
    const data = metaById.get(job.metaDoc);
    const flags: string[] = [];

    if (!data) {
      rows.push({
        job: job.metaDoc,
        cadence: job.cadence,
        status: "no-meta",
        ageHours: null,
        ageStr: "NO-META",
        docs: null,
        errors: null,
        flags: ["never written a success meta — dead OR pending first cron"],
      });
      continue;
    }

    const lastMs = lastSyncedMs(data);
    const docs = num(data.docsWritten);
    const errors = num(data.errors);

    let status: Status = "ok";
    let ageHours: number | null = null;
    let age = "NO-TIMESTAMP";
    if (lastMs !== null) {
      ageHours = (now - lastMs) / HOUR;
      age = ageStr(now - lastMs);
      if (ageHours > job.failHours) status = "fail";
      else if (ageHours > job.warnHours) status = "warn";
    } else {
      status = "fail";
      flags.push("meta doc exists but has no parseable timestamp");
    }

    if (errors !== null && errors > 0) flags.push(`errors=${errors}`);
    if (docs === 0) flags.push("docsWritten=0 (ran but produced nothing)");

    rows.push({
      job: job.metaDoc,
      cadence: job.cadence,
      status,
      ageHours,
      ageStr: age,
      docs,
      errors,
      flags,
    });
  }

  // Any /meta docs that exist but aren't monitored by JOBS — surface so we
  // notice drift in either direction.
  const monitored = new Set(JOBS.map((j) => j.metaDoc));
  const unmonitored = [...metaById.keys()].filter((id) => !monitored.has(id));

  rows.sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (r !== 0) return r;
    return (b.ageHours ?? Infinity) - (a.ageHours ?? Infinity);
  });

  const fails = rows.filter((r) => r.status === "fail" || r.status === "no-meta");
  const warns = rows.filter((r) => r.status === "warn");
  const anomalies = rows.filter((r) => r.flags.length > 0 && r.status !== "no-meta");

  // ── Human-readable table ──
  console.log(`\nKeyVex scraper review — ${new Date().toISOString()}`);
  console.log(`${JOBS.length} monitored jobs · ${fails.length} fail/no-meta · ${warns.length} warn · ${anomalies.length} with data-anomaly flags\n`);
  console.log(
    "STATUS".padEnd(9) +
      "AGE".padEnd(11) +
      "DOCS".padEnd(9) +
      "ERR".padEnd(6) +
      "CADENCE".padEnd(22) +
      "JOB",
  );
  console.log("-".repeat(95));
  for (const r of rows) {
    console.log(
      r.status.padEnd(9) +
        r.ageStr.padEnd(11) +
        String(r.docs ?? "").padEnd(9) +
        String(r.errors ?? "").padEnd(6) +
        r.cadence.padEnd(22) +
        r.job +
        (r.flags.length ? `   ⚠ ${r.flags.join("; ")}` : ""),
    );
  }

  if (unmonitored.length) {
    console.log(`\nUnmonitored /meta docs (exist but not in JOBS): ${unmonitored.join(", ")}`);
  }

  // ── Machine-readable block for the scheduled task to parse if it wants ──
  console.log("\n--- JSON ---");
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: { jobs: JOBS.length, fail: fails.length, warn: warns.length, anomalies: anomalies.length },
        fails: fails.map((r) => ({ job: r.job, status: r.status, age: r.ageStr, flags: r.flags })),
        warns: warns.map((r) => ({ job: r.job, age: r.ageStr })),
        anomalies: anomalies.map((r) => ({ job: r.job, docs: r.docs, errors: r.errors, flags: r.flags })),
        unmonitored,
      },
      null,
      2,
    ),
  );
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
