/**
 * Firebase Cloud Functions entry — autonomous scheduled scrapers.
 *
 * Each export is an `onSchedule` Gen-2 function that fires on a cron
 * schedule, runs one of our existing scrapers, and writes results to
 * Firestore. No human at the keyboard required.
 *
 * Authentication: the runtime service account inherits Firestore write
 * access automatically. `src/firestore.ts` detects the Cloud Functions
 * environment via `process.env.K_SERVICE` and uses Application Default
 * Credentials instead of a local service-account.json.
 *
 * Deploy: `firebase deploy --only functions` from project root. The
 * predeploy step (configured in firebase.json) runs `npm --prefix
 * functions run build` to bundle src/ + scrapers via esbuild.
 *
 * Monitoring: each invocation shows up in Firebase Console > Functions >
 * <function name> > Logs. Failures auto-retry per schedule (default: no
 * retry — they re-fire on the next cron tick).
 *
 * Cost (rough): each scraper invocation is sub-second to a few minutes
 * of compute + a few MB of egress. Twelve schedules combined run for
 * under $5/month at Blaze pricing for our volume.
 *
 * Schedule offsets: hourly scrapers are staggered by ~5-minute offsets
 * so they don't all fire at the same moment and contend for outbound
 * rate limits at SEC EDGAR (which caps at 10 req/sec/IP).
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  getLiveDb,
  saveActivistOwnership,
  saveCongressionalTrades,
  saveFederalContractAwards,
  saveForm144Filings,
  saveForm278Filings,
  saveForm3Holdings,
  saveInsiderTransactions,
  saveInstitutionalHoldings,
  saveLegislators,
  saveLegislatorsHistorical,
  saveLobbyingFilings,
  saveMaterialEvents,
  writeJobMeta,
} from "../../src/firestore.js";
import { runHealthCheck } from "./health-check.js";
import {
  applyToolHandlers,
  createMcpServer,
} from "../../src/server-setup.js";
import { TOOLS } from "../../src/tools/index.js";
import { scrapeActivistLiveFeed } from "../../src/scrapers/activist.js";
import {
  scrapeBioguideCatalog,
  scrapeBioguideHistorical,
} from "../../src/scrapers/bioguide.js";
import { scrape13FLiveFeed } from "../../src/scrapers/13f.js";
import { scrape8kLiveFeed } from "../../src/scrapers/form8k.js";
import { scrapeForm144LiveFeed } from "../../src/scrapers/form144.js";
import { scrapeForm3LiveFeed } from "../../src/scrapers/form3.js";
import { scrapeForm4LiveFeed } from "../../src/scrapers/form4.js";
import { scrapeHouseLiveFeed } from "../../src/scrapers/house.js";
import { scrapeLobbyingByPeriod } from "../../src/scrapers/lobbying.js";
import { scrapeSenateLiveFeed } from "../../src/scrapers/senate.js";
import { scrapeSenateForm278 } from "../../src/scrapers/form278.js";
import { scrapeContractsLiveFeed } from "../../src/scrapers/usaspending.js";

// ─── Common config ──────────────────────────────────────────────────────────

const REGION = "us-central1";
const TZ = "America/New_York";

// ─── Hourly real-time disclosure scrapers (SEC EDGAR) ──────────────────────

/**
 * 8-K material events. Real-time corporate disclosures.
 * Fires every hour on the hour. 1-day lookback (24h overlap with prior
 * runs ensures no gaps; idempotent saves on filing_uuid handle dupes).
 */
export const scrape8kHourly = onSchedule(
  {
    schedule: "every 60 minutes",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[8k-hourly] starting (1-day lookback)");
    const events = await scrape8kLiveFeed(1);
    logger.info(`[8k-hourly] scraper returned ${events.length} filings`);
    let docsWritten = 0;
    if (events.length > 0) {
      const r = await saveMaterialEvents(events);
      logger.info(`[8k-hourly] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("materialEventsSync", { started, docsWritten });
  },
);

/**
 * Form 4 insider trades. Open-market purchases / sales by officers,
 * directors, 10%+ holders. Fires every 30 minutes during the trading day
 * cycle. 2-day lookback for headroom.
 */
export const scrapeForm4HalfHourly = onSchedule(
  {
    schedule: "every 30 minutes",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[form4] starting (2-day lookback)");
    const trades = await scrapeForm4LiveFeed(2);
    logger.info(`[form4] scraper returned ${trades.length} trades`);
    let docsWritten = 0;
    if (trades.length > 0) {
      const r = await saveInsiderTransactions(trades);
      logger.info(`[form4] saved ${r.saved} trades to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("insiderTradesSync", { started, docsWritten });
  },
);

/**
 * Form 144 planned-sale notices (forward-looking insider sells).
 * Fires hourly at :05. 2-day lookback.
 */
export const scrapeForm144Hourly = onSchedule(
  {
    schedule: "5 * * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[form144] starting (2-day lookback)");
    const filings = await scrapeForm144LiveFeed(2);
    logger.info(`[form144] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await saveForm144Filings(filings);
      logger.info(`[form144] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("plannedInsiderSalesSync", { started, docsWritten });
  },
);

/**
 * Form 3 initial-ownership baselines (filed when someone first becomes
 * an insider). Fires hourly at :10. 2-day lookback.
 */
export const scrapeForm3Hourly = onSchedule(
  {
    schedule: "10 * * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[form3] starting (2-day lookback)");
    const holdings = await scrapeForm3LiveFeed(2);
    logger.info(`[form3] scraper returned ${holdings.length} holdings`);
    let docsWritten = 0;
    if (holdings.length > 0) {
      const r = await saveForm3Holdings(holdings);
      logger.info(`[form3] saved ${r.saved} holdings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("initialOwnershipBaselinesSync", { started, docsWritten });
  },
);

/**
 * Schedule 13D/13G activist & passive 5%+ ownership disclosures.
 * Fires hourly at :20. 3-day lookback (these filings are less frequent;
 * a wider window catches late-filed ones reliably).
 */
export const scrapeActivistHourly = onSchedule(
  {
    schedule: "20 * * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[13d-13g] starting (3-day lookback)");
    const rows = await scrapeActivistLiveFeed(3);
    logger.info(`[13d-13g] scraper returned ${rows.length} rows`);
    let docsWritten = 0;
    if (rows.length > 0) {
      const r = await saveActivistOwnership(rows);
      logger.info(`[13d-13g] saved ${r.saved} rows to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("activistOwnershipSync", { started, docsWritten });
  },
);

// ─── Less-frequent SEC scrapers ─────────────────────────────────────────────

/**
 * 13F institutional holdings. Quarterly filings, but hits across our 10
 * tracked funds. Fires every 4 hours. 30-day lookback at the FTS level
 * to catch any newly-filed quarters.
 */
export const scrape13FQuarterHourly = onSchedule(
  {
    schedule: "0 */4 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[13f] starting (30-day lookback across tracked funds)");
    const db = await getLiveDb();
    const holdings = await scrape13FLiveFeed({ db, days: 30 });
    logger.info(`[13f] scraper returned ${holdings.length} holdings`);
    let docsWritten = 0;
    if (holdings.length > 0) {
      const r = await saveInstitutionalHoldings(holdings);
      logger.info(`[13f] saved ${r.saved} holdings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("institutional13FSync", { started, docsWritten });
  },
);

// ─── Daily scrapers (run at staggered 6 AM ET to spread load) ──────────────

/**
 * Senate eFD Periodic Transaction Reports (PTRs). Daily 6:00 AM ET.
 * 7-day lookback to handle any late-filed disclosures from the past week.
 */
export const scrapeSenateDaily = onSchedule(
  {
    schedule: "0 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[senate] starting (7-day lookback)");
    const trades = await scrapeSenateLiveFeed({ lookbackDays: 7 });
    logger.info(`[senate] scraper returned ${trades.length} trades`);
    let docsWritten = 0;
    if (trades.length > 0) {
      const r = await saveCongressionalTrades(trades);
      logger.info(`[senate] saved ${r.saved} trades to ${r.collection}`);
      docsWritten = r.saved;
    }
    // senate scraper not in Derek's monitored JOBS array (his project's
    // congressional_trades is canonical), but writing telemetry for
    // consistency + future visibility.
    await writeJobMeta("senatePtrSync", { started, docsWritten });
  },
);

/**
 * House Clerk PTRs (PDF-parsed). Daily 6:05 AM ET (offset from Senate
 * to avoid simultaneous PDF-parsing memory pressure).
 */
export const scrapeHouseDaily = onSchedule(
  {
    schedule: "5 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[house] starting (7-day lookback, --extract)");
    const { trades } = await scrapeHouseLiveFeed({
      lookbackDays: 7,
      extractTrades: true,
    });
    logger.info(`[house] scraper returned ${trades.length} trades`);
    let docsWritten = 0;
    if (trades.length > 0) {
      const r = await saveCongressionalTrades(trades);
      logger.info(`[house] saved ${r.saved} trades to ${r.collection}`);
      docsWritten = r.saved;
    }
    // house scraper not in Derek's monitored JOBS array; consistency-only meta.
    await writeJobMeta("housePtrSync", { started, docsWritten });
  },
);

/**
 * USAspending federal contract awards. Daily 6:10 AM ET.
 * 7-day lookback handles modifications to recently-awarded contracts.
 */
export const scrapeUSAspendingDaily = onSchedule(
  {
    schedule: "10 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[usaspending] starting (7-day lookback)");
    const awards = await scrapeContractsLiveFeed(7);
    logger.info(`[usaspending] scraper returned ${awards.length} awards`);
    let docsWritten = 0;
    if (awards.length > 0) {
      const r = await saveFederalContractAwards(awards);
      logger.info(`[usaspending] saved ${r.saved} awards to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("federalContractsSync", { started, docsWritten });
  },
);

/**
 * LDA lobbying filings. Daily 6:15 AM ET. Pulls the current calendar
 * quarter; capped at 1000 records per run. Over time the warehouse
 * accumulates the full quarterly slate (each quarter has ~27K filings).
 */
export const scrapeLDADaily = onSchedule(
  {
    schedule: "15 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const period =
      month <= 2
        ? "first_quarter"
        : month <= 5
          ? "second_quarter"
          : month <= 8
            ? "third_quarter"
            : "fourth_quarter";
    logger.info(`[lda] starting (${year} ${period}, max=1000)`);
    const started = Date.now();
    const filings = await scrapeLobbyingByPeriod(year, period, 1000);
    logger.info(`[lda] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await saveLobbyingFilings(filings);
      logger.info(`[lda] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("lobbyingFilingsSync", { started, docsWritten });
  },
);

// ─── Catalog refresh scrapers (rare cadence) ───────────────────────────────

/**
 * Bioguide catalog (current legislators). Weekly Sunday 6 AM ET.
 * The catalog rarely changes day-to-day; weekly is plenty.
 */
export const scrapeBioguideWeekly = onSchedule(
  {
    schedule: "0 6 * * 0",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[bioguide] starting weekly refresh");
    const legislators = await scrapeBioguideCatalog();
    logger.info(`[bioguide] scraper returned ${legislators.length} members`);
    let docsWritten = 0;
    if (legislators.length > 0) {
      const r = await saveLegislators(legislators);
      logger.info(`[bioguide] saved ${r.saved} legislators to ${r.collection}`);
      docsWritten = r.saved;
    }
    // legislators not in Derek's JOBS (his /congress is canonical); consistency-only.
    await writeJobMeta("legislatorsSync", { started, docsWritten });
  },
);

/**
 * Senate Form 278 (Annual Financial Disclosure / Public Financial Disclosure)
 * — captures filing metadata + URL to the actual report. Filings cluster in
 * May (annual deadline May 15) but trickle in throughout the year (extensions,
 * new filer reports on entering office, termination reports on leaving).
 *
 * Weekly Mondays @ 6:30 AM ET — staggered 30 min after senate/house/usaspending
 * cluster to avoid stepping on Senate eFD CSRF flow.
 *
 * v1A scope is metadata only (filer + filing_date + URL). PDF parsing for
 * Schedule A/B/C net-worth roll-ups lands in v1.1.
 */
export const scrapeForm278Weekly = onSchedule(
  {
    schedule: "30 6 * * 1",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[form278] starting weekly Senate Form 278 refresh");
    // 35-day window catches the 30-day "what just disclosed" cluster + 5
    // day buffer for delayed eFD updates over weekends.
    const filings = await scrapeSenateForm278({ lookbackDays: 35 });
    logger.info(`[form278] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await saveForm278Filings(filings);
      logger.info(`[form278] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("form278Sync", { started, docsWritten });
  },
);

/**
 * Bioguide historical catalog. Monthly 1st @ 6 AM ET.
 * The historical catalog is essentially static (only changes when a
 * sitting member departs Congress); monthly is plenty.
 */
export const scrapeBioguideHistoricalMonthly = onSchedule(
  {
    schedule: "0 6 1 * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[bioguide-historical] starting monthly refresh");
    const legislators = await scrapeBioguideHistorical();
    logger.info(
      `[bioguide-historical] scraper returned ${legislators.length} members`,
    );
    let docsWritten = 0;
    if (legislators.length > 0) {
      const r = await saveLegislatorsHistorical(legislators);
      logger.info(
        `[bioguide-historical] saved ${r.saved} legislators to ${r.collection}`,
      );
      docsWritten = r.saved;
    }
    await writeJobMeta("legislatorsHistoricalSync", { started, docsWritten });
  },
);

// ─── Cross-project health-check (Slack alerts to shared channel) ─────────

/**
 * Slack incoming-webhook URL stored in Google Secret Manager. Set via:
 *   firebase functions:secrets:set SLACK_HEALTHCHECK_WEBHOOK
 *
 * The same webhook is used by Derek's project (`capital-edge-d5038`) so
 * both projects' alerts land in the same Slack channel. Messages are
 * prefixed with `[capitaledge-api]` (this project) or `[capital-edge-d5038]`
 * (Derek's) so the recipient can tell which project alerted at a glance.
 */
const SLACK_HEALTHCHECK_WEBHOOK = defineSecret("SLACK_HEALTHCHECK_WEBHOOK");

/**
 * Daily cron-freshness audit. Reads /meta/{jobName} for each monitored
 * scraper, checks lastSyncedAt is within thresholds, posts to Slack on
 * status CHANGE only (healthy weeks produce zero messages).
 *
 * Schedule: 12:30 ET daily — offset 30 minutes after Derek's 12:00 ET
 * health-check so the two projects don't compete for resources or hit
 * Firestore at the same instant.
 */
export const scheduledHealthCheck = onSchedule(
  {
    schedule: "30 12 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "256MiB",
    timeoutSeconds: 60,
    secrets: [SLACK_HEALTHCHECK_WEBHOOK],
    retryCount: 0,
  },
  async () => {
    try {
      const db = await getLiveDb();
      const result = await runHealthCheck({
        db,
        slackWebhookUrl: SLACK_HEALTHCHECK_WEBHOOK.value(),
        logger,
      });
      logger.info("[health-check] result:", result);
    } catch (err) {
      logger.error("[health-check] failed:", err);
      throw err;
    }
  },
);

// ─── MCP HTTP server (remote-reachable tool API) ──────────────────────────

const SERVER_NAME = "keyvex";
const SERVER_VERSION = "0.17.0";

/**
 * The bearer token clients send in `Authorization: Bearer <key>` headers.
 * Stored in Google Secret Manager via `firebase functions:secrets:set
 * MCP_API_KEY`. Rotate with the same command.
 */
const mcpApiKey = defineSecret("MCP_API_KEY");

/**
 * MCP server exposed as an HTTPS endpoint at /mcp. Stateless (each request
 * spins up a fresh Server + transport pair, runs the request, tears down).
 *
 * Auth: bearer token in the Authorization header. The token is read from
 * Secret Manager via the firebase-functions/params helper.
 *
 * Cold-start: ~5-10 seconds on the bundled 14 MB function. After the first
 * request, the container stays warm for ~15 minutes of idle. Acceptable
 * for v1; can split into a dedicated MCP-only function later if it
 * becomes user-facing latency.
 *
 * Health-check: GET /mcp returns JSON with version + tool count, NO auth
 * required. Useful for uptime monitoring.
 */
export const mcp = onRequest(
  {
    region: REGION,
    memory: "1GiB",
    timeoutSeconds: 300,
    secrets: [mcpApiKey],
    concurrency: 10,
    cors: false,
  },
  async (req, res) => {
    // Health check — auth-free GET returns server status.
    if (req.method === "GET") {
      res.json({
        status: "ok",
        service: SERVER_NAME,
        version: SERVER_VERSION,
        tools: TOOLS.length,
        tool_names: TOOLS.map((t) => t.definition.name),
      });
      return;
    }

    // MCP protocol uses POST exclusively.
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed; use POST" });
      return;
    }

    // Bearer-token auth.
    const authHeader = req.header("authorization") ?? "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const expected = mcpApiKey.value();
    if (!m || m[1] !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Build a fresh server + stateless transport per request.
    let server: ReturnType<typeof createMcpServer> | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    try {
      server = createMcpServer(SERVER_NAME, SERVER_VERSION);
      applyToolHandlers(server);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("[mcp] request handler error", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    } finally {
      // Tear down once the response is fully sent. Stateless mode means
      // there's nothing to keep around between requests.
      res.on("close", () => {
        transport?.close().catch(() => {});
        server?.close().catch(() => {});
      });
    }
  },
);
