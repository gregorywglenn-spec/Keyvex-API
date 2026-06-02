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

/** While a problem persists, re-page at most this often (nag interval). */
const RENOTIFY_FAIL_MS = 6 * 3_600_000; // 6 hours
/** While everything is healthy, send a green "alive" ping at most this often. */
const HEARTBEAT_MS = 24 * 3_600_000; // once a day

export interface JobConfig {
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
 * Cadence → (warn, fail) thresholds in hours. One tuple per scheduler
 * cadence so a job's thresholds are derived from how often it's supposed to
 * run, not hand-tuned per job. A warn fires at ~1 missed run; a fail fires
 * when enough runs have been missed that it's clearly broken, not just late.
 *
 * Weekly+ tiers are generous because a single missed weekly/monthly tick is
 * not yet an emergency — but a doubled-or-worse gap is.
 */
const TIER = {
  min30: { warnHours: 4, failHours: 12 },
  hourly: { warnHours: 6, failHours: 24 },
  every4h: { warnHours: 12, failHours: 48 },
  daily: { warnHours: 36, failHours: 60 },
  weekly: { warnHours: 216, failHours: 336 }, // 9d / 14d
  semimonthly: { warnHours: 432, failHours: 840 }, // 18d / 35d
  monthly: { warnHours: 960, failHours: 1680 }, // 40d / 70d
} as const;

/**
 * EVERY scraper that writes a /meta doc in capitaledge-api is monitored here.
 *
 * Decision (2026-05-31, Greg): "we run independently of Derek." The old list
 * carried only 8 of 43 scrapers and explicitly excluded the congressional
 * scrapers on the theory that Derek's project is canonical for that data.
 * That left 35 scrapers — including silently-dead ones — completely
 * unwatched. KeyVex's production data integrity is KeyVex's responsibility,
 * regardless of what Derek's side also scrapes. So: monitor all of ours.
 *
 * Thresholds come from the TIER table by cadence. The `cadence` string is
 * documentation only — the real cron lives on each scheduler's onSchedule
 * config in index.ts.
 *
 * First-deploy note: any scraper that has never written a /meta doc shows as
 * "no successful run on record" → fail on the first expanded run. As of the
 * 2026-06-01 audit that's 2 jobs (oigExclusionsSync, legislatorsHistoricalSync)
 * — monthly scrapers whose first scheduled fire (the 5th / 1st) simply hasn't
 * come around since deploy. Those alerts are correct, not noise; they clear
 * once each job runs (or is seeded manually). FINRA OTC was removed
 * 2026-06-01 — it's a FINRA (SRO) source under a license agreement, not a
 * public US-government source, so it's out of scope for KeyVex.
 */
export const JOBS: JobConfig[] = [
  // ── 30-minute ──
  { key: "insiderTradesSync", label: "Form 4 (insider trades) sync", metaDoc: "insiderTradesSync", cadence: "every 30 min", ...TIER.min30 },

  // ── hourly ──
  { key: "materialEventsSync", label: "8-K (material events) sync", metaDoc: "materialEventsSync", cadence: "hourly", ...TIER.hourly },
  { key: "plannedInsiderSalesSync", label: "Form 144 (planned insider sales) sync", metaDoc: "plannedInsiderSalesSync", cadence: "hourly", ...TIER.hourly },
  { key: "initialOwnershipBaselinesSync", label: "Form 3 (initial ownership baselines) sync", metaDoc: "initialOwnershipBaselinesSync", cadence: "hourly", ...TIER.hourly },
  { key: "activistOwnershipSync", label: "13D/G (activist ownership) sync", metaDoc: "activistOwnershipSync", cadence: "hourly", ...TIER.hourly },

  // ── every 4 hours ──
  { key: "institutional13FSync", label: "13F (institutional holdings) sync", metaDoc: "institutional13FSync", cadence: "every 4 hours", ...TIER.every4h },

  // ── daily ──
  { key: "tenderOffersSync", label: "Tender offers (SC TO) sync", metaDoc: "tenderOffersSync", cadence: "daily", ...TIER.daily },
  { key: "proxyFilingsSync", label: "Proxy filings (DEF 14A) sync", metaDoc: "proxyFilingsSync", cadence: "daily", ...TIER.daily },
  { key: "treasuryAuctionsSync", label: "Treasury auctions sync", metaDoc: "treasuryAuctionsSync", cadence: "daily", ...TIER.daily },
  { key: "blsIndicatorsSync", label: "BLS economic indicators sync", metaDoc: "blsIndicatorsSync", cadence: "daily", ...TIER.daily },
  { key: "fredIndicatorsSync", label: "FRED economic indicators sync", metaDoc: "fredIndicatorsSync", cadence: "daily", ...TIER.daily },
  { key: "eiaIndicatorsSync", label: "EIA energy indicators sync", metaDoc: "eiaIndicatorsSync", cadence: "daily", ...TIER.daily },
  { key: "cslSync", label: "Consolidated Screening List sync", metaDoc: "cslSync", cadence: "daily", ...TIER.daily },
  { key: "govinfoSync", label: "GovInfo publications sync", metaDoc: "govinfoSync", cadence: "daily", ...TIER.daily },
  { key: "consumerComplaintsSync", label: "CFPB consumer complaints sync", metaDoc: "consumerComplaintsSync", cadence: "daily", ...TIER.daily },
  { key: "form5Sync", label: "Form 5 (annual insider) sync", metaDoc: "form5Sync", cadence: "daily", ...TIER.daily },
  { key: "senatePtrSync", label: "Senate PTR (trades) sync", metaDoc: "senatePtrSync", cadence: "daily", ...TIER.daily },
  { key: "housePtrSync", label: "House PTR (trades) sync", metaDoc: "housePtrSync", cadence: "daily", ...TIER.daily },
  { key: "federalContractsSync", label: "Federal contracts (USAspending) sync", metaDoc: "federalContractsSync", cadence: "daily", ...TIER.daily },
  { key: "federalGrantsSync", label: "Federal grants (USAspending) sync", metaDoc: "federalGrantsSync", cadence: "daily", ...TIER.daily },
  { key: "lobbyingFilingsSync", label: "Lobbying (LDA) sync", metaDoc: "lobbyingFilingsSync", cadence: "daily", ...TIER.daily },
  { key: "fecScheduleASync", label: "FEC Schedule A (contributions) sync", metaDoc: "fecScheduleASync", cadence: "daily", ...TIER.daily },
  { key: "fecScheduleESync", label: "FEC Schedule E (independent expenditures) sync", metaDoc: "fecScheduleESync", cadence: "daily", ...TIER.daily },
  { key: "congressLegislationSync", label: "Congress bills + roll-call votes sync", metaDoc: "congressLegislationSync", cadence: "daily", ...TIER.daily },
  { key: "federalRegisterSync", label: "Federal Register documents sync", metaDoc: "federalRegisterSync", cadence: "daily", ...TIER.daily },
  { key: "ofacSdnSync", label: "OFAC SDN sanctions sync", metaDoc: "ofacSdnSync", cadence: "daily", ...TIER.daily },
  { key: "registrationStatementsSync", label: "Registration statements (S-1/S-3) sync", metaDoc: "registrationStatementsSync", cadence: "daily", ...TIER.daily },
  { key: "nportFilingsSync", label: "N-PORT filings sync", metaDoc: "nportFilingsSync", cadence: "daily", ...TIER.daily },
  { key: "nportHoldingsSync", label: "N-PORT holdings sync", metaDoc: "nportHoldingsSync", cadence: "daily", ...TIER.daily },
  { key: "fdaRecallsSync", label: "FDA recalls sync", metaDoc: "fdaRecallsSync", cadence: "daily", ...TIER.daily },
  { key: "cpscRecallsSync", label: "CPSC recalls sync", metaDoc: "cpscRecallsSync", cadence: "daily", ...TIER.daily },
  { key: "enforcementActionsSync", label: "Enforcement actions (6 regulators) sync", metaDoc: "enforcementActionsSync", cadence: "daily", ...TIER.daily },
  { key: "privatePlacementsSync", label: "Form D (private placements) sync", metaDoc: "privatePlacementsSync", cadence: "daily", ...TIER.daily },

  // ── weekly ──
  { key: "faraSync", label: "FARA (foreign agents) sync", metaDoc: "faraSync", cadence: "weekly", ...TIER.weekly },
  { key: "xbrlFundamentalsSync", label: "XBRL fundamentals sync", metaDoc: "xbrlFundamentalsSync", cadence: "weekly", ...TIER.weekly },
  { key: "legislatorsSync", label: "Legislators (bioguide current) sync", metaDoc: "legislatorsSync", cadence: "weekly", ...TIER.weekly },
  { key: "form278Sync", label: "Form 278 (annual financial disclosures) sync", metaDoc: "form278Sync", cadence: "weekly", ...TIER.weekly },
  { key: "fecCandidatesSync", label: "FEC candidates sync", metaDoc: "fecCandidatesSync", cadence: "weekly", ...TIER.weekly },
  { key: "fecCommitteesSync", label: "FEC committees sync", metaDoc: "fecCommitteesSync", cadence: "weekly", ...TIER.weekly },
  { key: "cftcCotSync", label: "CFTC Commitments of Traders sync", metaDoc: "cftcCotSync", cadence: "weekly", ...TIER.weekly },

  // ── semimonthly ──
  { key: "secFtdSync", label: "SEC fails-to-deliver sync", metaDoc: "secFtdSync", cadence: "semimonthly (1st & 16th)", ...TIER.semimonthly },

  // ── monthly ──
  { key: "oigExclusionsSync", label: "HHS-OIG exclusions sync", metaDoc: "oigExclusionsSync", cadence: "monthly", ...TIER.monthly },
  { key: "legislatorsHistoricalSync", label: "Legislators (historical) sync", metaDoc: "legislatorsHistoricalSync", cadence: "monthly", ...TIER.monthly },
];

type JobStatus = "ok" | "warn" | "fail";

interface JobResult {
  ageHours: number | null;
  lastRunMillis?: number;
  status: JobStatus;
}

/**
 * One row of read-only status for the Dev Dashboard. Richer than JobResult
 * (carries label/cadence/docs/errors) so the dashboard can render cards +
 * a detail panel without re-deriving anything client-side.
 */
export interface JobStatusRow {
  key: string;
  label: string;
  cadence: string;
  /** Coarse bucket for the dashboard's cadence filter. */
  cadenceBucket: "sub-hourly" | "hourly" | "daily" | "weekly" | "monthly";
  status: JobStatus;
  ageHours: number | null;
  lastRun: string | null;
  docsWritten: number | null;
  errors: number | null;
  durationMs: number | null;
}

function cadenceBucketOf(cadence: string): JobStatusRow["cadenceBucket"] {
  const c = cadence.toLowerCase();
  if (c.includes("min")) return "sub-hourly";
  if (c.includes("hour")) return "hourly"; // "hourly" and "every 4 hours"
  if (c.includes("week")) return "weekly";
  if (c.includes("month") || c.includes("semimonthly")) return "monthly";
  return "daily";
}

/**
 * Pure read-only pass over the JOBS list: read each /meta doc, grade it
 * against the same thresholds the alerting path uses, and return enriched
 * rows. Writes nothing, sends no Slack. Powers the Dev Dashboard endpoint.
 *
 * Note: this duplicates the read+grade loop in runHealthCheck() rather than
 * sharing it, deliberately — runHealthCheck is the load-bearing alerting
 * path and is left untouched. Keep the two grading rules in sync if the
 * threshold semantics ever change.
 */
export async function readJobStatuses(
  db: Firestore,
  logger?: SimpleLogger,
): Promise<JobStatusRow[]> {
  const log: SimpleLogger = logger ?? console;
  const now = Date.now();
  const rows: JobStatusRow[] = [];

  for (const job of JOBS) {
    let data: Record<string, unknown> | null = null;
    try {
      const snap = await db.collection("meta").doc(job.metaDoc).get();
      data = snap.exists
        ? ((snap.data() as Record<string, unknown>) ?? null)
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[dev-dashboard] read /meta/${job.metaDoc}: ${msg}`);
    }

    const num = (v: unknown): number | null =>
      typeof v === "number" ? v : null;
    const docsWritten = num(data?.docsWritten);
    const errors = num(data?.errors);
    const durationMs = num(data?.durationMs);

    const lastMs = resolveTimestamp(data);
    let status: JobStatus = "ok";
    let ageHours: number | null = null;
    if (lastMs === null) {
      status = "fail";
    } else {
      ageHours = Math.round(((now - lastMs) / 3_600_000) * 10) / 10;
      if (ageHours > job.failHours) status = "fail";
      else if (ageHours > job.warnHours) status = "warn";
    }

    rows.push({
      key: job.key,
      label: job.label,
      cadence: job.cadence,
      cadenceBucket: cadenceBucketOf(job.cadence),
      status,
      ageHours,
      lastRun: lastMs === null ? null : new Date(lastMs).toISOString(),
      docsWritten,
      errors,
      durationMs,
    });
  }

  return rows;
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

/**
 * Coerce a single Firestore Timestamp | Date | ISO string | epoch-millis
 * value to epoch millis, or null. Used for the healthCheck doc's own
 * lastNotifiedAt bookkeeping field (single value, not the multi-field
 * scan resolveTimestamp() does on scraper meta docs).
 */
function resolveSingleTimestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "number") return value;
  return null;
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

  // Read prior notify state for the firing decision.
  let prevStatus: JobStatus | null = null;
  let lastNotifiedAt: number | null = null;
  try {
    const prev = await db.collection("meta").doc("healthCheck").get();
    if (prev.exists) {
      const d = prev.data() as Record<string, unknown> | undefined;
      const v = d?.lastNotifiedStatus;
      if (v === "ok" || v === "warn" || v === "fail") prevStatus = v;
      lastNotifiedAt = resolveSingleTimestamp(d?.lastNotifiedAt);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[health-check] read /meta/healthCheck: ${msg}`);
  }

  /**
   * Firing logic — the old code notified ONLY on a status change, which made
   * a real failure chirp once and then go silent forever while still broken,
   * and produced zero traffic during healthy stretches (so a dead monitor
   * looked identical to a healthy one). New rules:
   *
   *   1. Status CHANGED since last notify  → always notify (break OR recover).
   *   2. Still broken (warn/fail) and it's been ≥ RENOTIFY_FAIL_MS since the
   *      last notify → re-notify (nag, so an unfixed problem keeps paging).
   *   3. Healthy and it's been ≥ HEARTBEAT_MS since the last notify →
   *      send a green heartbeat (so silence is never ambiguous — the channel
   *      proves itself alive once a day).
   */
  const changed = overallStatus !== prevStatus;
  const sinceLast = lastNotifiedAt === null ? Infinity : now - lastNotifiedAt;
  const reNag = overallStatus !== "ok" && sinceLast >= RENOTIFY_FAIL_MS;
  const heartbeat = overallStatus === "ok" && sinceLast >= HEARTBEAT_MS;
  const shouldNotify = changed || reNag || heartbeat;

  let notified = false;
  let notifyError: string | null = null;
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
        // Only advance lastNotifiedStatus / lastNotifiedAt on a successful
        // Slack POST. If the POST failed, leave them so we retry next run.
        lastNotifiedStatus: notified ? overallStatus : prevStatus,
        lastNotifiedAt: notified ? new Date(now) : (lastNotifiedAt !== null ? new Date(lastNotifiedAt) : null),
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
