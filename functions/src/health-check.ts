/**
 * Cross-project health-check function for the KeyVex / Capital Edge
 * monitoring system. Mirrors Derek's `health-check.js` in `capital-edge-d5038`
 * — same logic, same Slack message shape, same change-detection dedup —
 * adapted to ESM + capitaledge-api's specific job set.
 *
 * High-level flow:
 *   1. Read /meta/{jobName} for each job in JOBS.
 *   2. Compute "hours since lastSyncedAt" → ok | warn | fail per threshold.
 *   3. Roll up to overall status (any fail → fail; else any warn → warn; else ok).
 *   4. Compare to lastNotifiedStatus on /meta/healthCheck — if status changed
 *      (or first non-ok run), POST to Slack.
 *   5. Persist current state to /meta/healthCheck for next run's comparison.
 *
 * Design philosophy (per the cross-project overview doc):
 *   - Coarse freshness check (cron fired & finished), not data-quality check
 *   - Slack only on status CHANGE — healthy weeks produce zero messages
 *   - Project label `[capitaledge-api]` in messages so the shared Slack
 *     channel can disambiguate from Derek's `[capital-edge-d5038]` alerts
 *   - No auto-remediation; humans fix things; this surfaces, doesn't repair
 *
 * The `[capitaledge-api]` prefix in Slack messages is LOAD-BEARING — must
 * match the convention exactly. Don't change without coordinating with
 * Derek's project.
 */

import type { Firestore } from "firebase-admin/firestore";

// ─── Config ─────────────────────────────────────────────────────────────────

const PROJECT_LABEL = "capitaledge-api";
const SLACK_WEBHOOK_TIMEOUT_MS = 10_000;

interface JobConfig {
  /** Internal key used in result objects; stable across runs. */
  key: string;
  /** Human-readable label for Slack messages. */
  label: string;
  /** Firestore doc id under /meta. */
  metaDoc: string;
  /** Documentation only — the actual cron lives on the scheduler config. */
  cadence: string;
  /** > this many hours since last successful run → warn. */
  warnHours: number;
  /** > this many hours since last successful run → fail. */
  failHours: number;
}

/**
 * Jobs monitored on the capitaledge-api side.
 *
 * Threshold philosophy: tighter than Derek's daily-cron defaults because
 * most of our SEC scrapers fire hourly or sub-hourly. A 36-hour warn on an
 * hourly scheduler would let problems run for a day and a half before
 * paging — too loose. Daily schedulers (LDA, USAspending) keep Derek's
 * standard 36/60 thresholds.
 *
 * Note: per the cross-project overview, a job should only appear here once
 * its scraper has run at least once and written a /meta doc. The first
 * deploy will fire one transient "no successful run on record" alert for
 * any sub-daily scheduler whose first cron tick hasn't fired yet — that's
 * expected and self-resolves within an hour.
 *
 * Senate / House / Bioguide-current / Bioguide-historical are NOT in this
 * list — Derek's project is canonical for congressional data, so monitoring
 * the duplicate scrapers here would just produce noise.
 */
const JOBS: JobConfig[] = [
  {
    key: "insiderTradesSync",
    label: "Form 4 (insider trades) sync",
    metaDoc: "insiderTradesSync",
    cadence: "every 30 min",
    warnHours: 4,
    failHours: 12,
  },
  {
    key: "materialEventsSync",
    label: "8-K (material events) sync",
    metaDoc: "materialEventsSync",
    cadence: "hourly",
    warnHours: 6,
    failHours: 24,
  },
  {
    key: "plannedInsiderSalesSync",
    label: "Form 144 (planned insider sales) sync",
    metaDoc: "plannedInsiderSalesSync",
    cadence: "hourly",
    warnHours: 6,
    failHours: 24,
  },
  {
    key: "initialOwnershipBaselinesSync",
    label: "Form 3 (initial ownership baselines) sync",
    metaDoc: "initialOwnershipBaselinesSync",
    cadence: "hourly",
    warnHours: 6,
    failHours: 24,
  },
  {
    key: "activistOwnershipSync",
    label: "13D/G (activist ownership) sync",
    metaDoc: "activistOwnershipSync",
    cadence: "hourly",
    warnHours: 6,
    failHours: 24,
  },
  {
    key: "institutional13FSync",
    label: "13F (institutional holdings) sync",
    metaDoc: "institutional13FSync",
    cadence: "every 4 hours",
    warnHours: 12,
    failHours: 48,
  },
  {
    key: "lobbyingFilingsSync",
    label: "Lobbying (LDA) sync",
    metaDoc: "lobbyingFilingsSync",
    cadence: "daily",
    warnHours: 36,
    failHours: 60,
  },
  {
    key: "federalContractsSync",
    label: "Federal contracts (USAspending) sync",
    metaDoc: "federalContractsSync",
    cadence: "daily",
    warnHours: 36,
    failHours: 60,
  },
];

type JobStatus = "ok" | "warn" | "fail";

interface JobResult {
  ageHours: number | null;
  lastRunMillis?: number;
  status: JobStatus;
}

interface HealthCheckResult {
  status: JobStatus;
  notified: boolean;
  notifyError: string | null;
  failures: string[];
  warnings: string[];
  jobs: Record<string, JobResult>;
}

interface SimpleLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve `lastSyncedAt`-equivalent timestamp from a /meta doc. Tries
 * canonical name first, then fallback aliases (lastRunAt, lastFinishedAt,
 * completedAt, lastChecked). Accepts Firestore Timestamp, Date, ISO
 * string, or epoch-millis number. Returns the LATEST millis value found
 * across any candidate field, or null if none parse.
 */
function resolveTimestamp(data: Record<string, unknown> | null): number | null {
  if (!data) return null;
  const candidates = [
    "lastSyncedAt",
    "lastRunAt",
    "lastFinishedAt",
    "lastChecked",
    "completedAt",
  ];
  let latest: number | null = null;
  for (const field of candidates) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    let millis: number | null = null;
    // Firestore Timestamp
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { toMillis?: unknown }).toMillis === "function"
    ) {
      millis = (value as { toMillis: () => number }).toMillis();
    } else if (value instanceof Date) {
      millis = value.getTime();
    } else if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) millis = parsed;
    } else if (typeof value === "number") {
      millis = value;
    }
    if (millis !== null && (latest === null || millis > latest)) {
      latest = millis;
    }
  }
  return latest;
}

function formatAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatLastRun(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

async function sendSlack(
  url: string | undefined,
  text: string,
): Promise<{ sent: boolean; reason?: string }> {
  if (!url) return { sent: false, reason: "no SLACK_HEALTHCHECK_WEBHOOK secret" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), SLACK_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Slack ${res.status}: ${body.slice(0, 200)}`);
    }
    return { sent: true };
  } finally {
    clearTimeout(t);
  }
}

function buildText(
  status: JobStatus,
  ctx: { failures: string[]; warnings: string[] },
): string {
  if (status === "ok") {
    return `✅ *Capital Edge [${PROJECT_LABEL}] — all crons healthy*`;
  }
  if (status === "warn") {
    return [
      `⚠️ *Capital Edge [${PROJECT_LABEL}] — cron(s) approaching staleness*`,
      ...ctx.warnings.map((w) => `• ${w}`),
    ].join("\n");
  }
  return [
    `🚨 *Capital Edge [${PROJECT_LABEL}] — cron(s) failing*`,
    ...ctx.failures.map((f) => `• ${f}`),
    `<https://console.firebase.google.com/project/capitaledge-api/functions/logs|Open Cloud Functions logs>`,
  ].join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Run one health-check pass.
 *
 * @param db Firestore instance for capitaledge-api (acquired via
 *           getLiveDb() from src/firestore.ts).
 * @param slackWebhookUrl The shared incoming-webhook URL from Secret Manager.
 *                       If undefined, the function still computes status
 *                       and writes /meta/healthCheck but skips notification.
 * @param logger Optional logger; defaults to console.
 */
export async function runHealthCheck(opts: {
  db: Firestore;
  slackWebhookUrl?: string;
  logger?: SimpleLogger;
}): Promise<HealthCheckResult> {
  const { db, slackWebhookUrl } = opts;
  const log: SimpleLogger = opts.logger ?? console;

  const now = Date.now();
  const jobResults: Record<string, JobResult> = {};
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const job of JOBS) {
    let data: Record<string, unknown> | null = null;
    try {
      const snap = await db.collection("meta").doc(job.metaDoc).get();
      data = snap.exists
        ? (snap.data() as Record<string, unknown>) ?? null
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[health-check] read /meta/${job.metaDoc}: ${msg}`);
    }

    const lastMs = resolveTimestamp(data);
    if (lastMs === null) {
      jobResults[job.key] = { ageHours: null, status: "fail" };
      failures.push(`${job.label}: no successful run on record`);
      continue;
    }

    const ageHours = (now - lastMs) / 3_600_000;
    let status: JobStatus = "ok";
    if (ageHours > job.failHours) {
      status = "fail";
      failures.push(
        `${job.label}: stale ${formatAge(ageHours)} (last ${formatLastRun(lastMs)})`,
      );
    } else if (ageHours > job.warnHours) {
      status = "warn";
      warnings.push(
        `${job.label}: stale ${formatAge(ageHours)} (last ${formatLastRun(lastMs)})`,
      );
    }
    jobResults[job.key] = {
      ageHours: Math.round(ageHours * 10) / 10,
      lastRunMillis: lastMs,
      status,
    };
  }

  const overallStatus: JobStatus = failures.length
    ? "fail"
    : warnings.length
      ? "warn"
      : "ok";

  // Read prior notified status for change-detection dedup.
  let prevStatus: JobStatus | null = null;
  try {
    const prev = await db.collection("meta").doc("healthCheck").get();
    if (prev.exists) {
      const d = prev.data() as Record<string, unknown> | undefined;
      const v = d?.lastNotifiedStatus;
      if (v === "ok" || v === "warn" || v === "fail") prevStatus = v;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[health-check] read /meta/healthCheck: ${msg}`);
  }

  // Notify on transitions; first non-ok run also notifies.
  let notified = false;
  let notifyError: string | null = null;
  const shouldNotify =
    overallStatus !== prevStatus ||
    (prevStatus === null && overallStatus !== "ok");

  if (shouldNotify) {
    const text = buildText(overallStatus, { failures, warnings });
    try {
      const r = await sendSlack(slackWebhookUrl, text);
      notified = r.sent === true;
      if (!notified) notifyError = r.reason ?? "unknown";
    } catch (err) {
      notifyError = err instanceof Error ? err.message : String(err);
      log.error("[health-check] slack failed:", err);
    }
  }

  // Persist current state for next run.
  try {
    await db.collection("meta").doc("healthCheck").set(
      {
        lastChecked: new Date(),
        status: overallStatus,
        jobs: jobResults,
        failureReasons: failures,
        warningReasons: warnings,
        // Only advance lastNotifiedStatus on successful Slack POST. If the
        // POST failed, leave it so we retry the same intent next run.
        lastNotifiedStatus: notified ? overallStatus : prevStatus,
        ...(notifyError ? { lastNotifyError: notifyError } : {}),
      },
      { merge: true },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[health-check] write /meta/healthCheck failed: ${msg}`);
  }

  log.info(
    `[health-check] status=${overallStatus} notified=${notified} (prev=${prevStatus ?? "null"})`,
  );

  return {
    status: overallStatus,
    notified,
    notifyError,
    failures,
    warnings,
    jobs: jobResults,
  };
}
