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
  saveBills,
  saveCongressionalTrades,
  saveFecCandidates,
  saveFecCommittees,
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
  saveEnforcementActions,
  saveNportFilings,
  saveOtcMarketWeekly,
  savePrivatePlacements,
  saveRollCallVotes,
  saveTenderOffers,
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
import {
  scrapeFecCandidates,
  scrapeFecCommittees,
} from "../../src/scrapers/fec.js";
import { scrapeTenderOffersLiveFeed } from "../../src/scrapers/tender-offers.js";
import {
  scrapeBills,
  scrapeRollCallVotes,
} from "../../src/scrapers/congress-legislation.js";
import { scrapeFinraOtcWeek } from "../../src/scrapers/finra-otc.js";
import { scrapeFormDLiveFeed } from "../../src/scrapers/form-d.js";
import { scrapeEnforcementActions } from "../../src/scrapers/enforcement-actions.js";
import { scrapeNportLiveFeed } from "../../src/scrapers/nport.js";

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

// ─── api.data.gov key (shared by FEC + Congress scrapers) ────────────────

/**
 * api.data.gov bearer key, used for both api.open.fec.gov AND
 * api.congress.gov calls (they share the same gateway). Stored in
 * Google Secret Manager via `firebase functions:secrets:set FEC_API_KEY`.
 * Both FEC and congress.gov scrapers read process.env.FEC_API_KEY at
 * runtime; Firebase auto-injects when `secrets: [fecApiKey]` is in the
 * function config.
 */
const fecApiKey = defineSecret("FEC_API_KEY");

// ─── New scheduled scrapers (Day 8) ───────────────────────────────────────

/**
 * FEC candidates. Weekly Sunday 6:30 AM ET.
 *
 * Cadence: weekly. FEC publishes new candidate filings within days of
 * receipt, but the universe of registered candidates changes slowly.
 * Weekly catches >99% of relevant changes without burning api.data.gov
 * budget.
 *
 * Cost per run: ~150 API calls (3 cycles × ~50 candidate pages), <10 min
 * runtime, ~3.5K Firestore upserts. Light, fast.
 *
 * Split from committees because the Cloud Functions Gen 2 timeout cap is
 * 30 min; the combined FEC pull can exceed that during heavy committee
 * weeks with retries.
 */
export const scrapeFecCandidatesWeekly = onSchedule(
  {
    schedule: "30 6 * * 0",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 900, // 15 min — well within actual runtime
    secrets: [fecApiKey],
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[fec candidates] starting weekly refresh");
    const candidates = await scrapeFecCandidates({ activeOnly: true });
    logger.info(`[fec candidates] scraper returned ${candidates.length}`);
    let docsWritten = 0;
    if (candidates.length > 0) {
      const r = await saveFecCandidates(candidates);
      logger.info(`[fec candidates] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("fecCandidatesSync", { started, docsWritten });
  },
);

/**
 * FEC committees. Weekly Sunday 7 AM ET (30 min offset from candidates).
 *
 * Cadence: weekly. ~30K committees across 3 cycles. Heaviest scheduled
 * scraper in the codebase by API pages (~600) and Firestore writes
 * (~30K). The 30-min offset from FEC candidates avoids competing for
 * the same api.data.gov 1000 req/hr budget back-to-back.
 *
 * Cost per run: ~600 API calls, ~20-30 min runtime, ~30K Firestore
 * upserts (most are no-ops via merge:true). 1800s timeout is the
 * Cloud Functions Gen 2 maximum for scheduled triggers — sized to fit.
 */
export const scrapeFecCommitteesWeekly = onSchedule(
  {
    schedule: "0 7 * * 0",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    secrets: [fecApiKey],
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[fec committees] starting weekly refresh");
    const committees = await scrapeFecCommittees({});
    logger.info(`[fec committees] scraper returned ${committees.length}`);
    let docsWritten = 0;
    if (committees.length > 0) {
      const r = await saveFecCommittees(committees);
      logger.info(`[fec committees] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("fecCommitteesSync", { started, docsWritten });
  },
);

/**
 * SEC Schedule TO (tender offers). Daily 7 AM ET.
 *
 * Cadence: daily. New tender offer filings can land any business day;
 * amendments to existing offers update prices / extend expiration dates
 * frequently. 2-day lookback catches anything filed late on Friday or
 * over a weekend.
 *
 * No secret needed — SEC EDGAR FTS is unauthenticated. Volume is small
 * (handful to a couple dozen filings per day) so memory + timeout
 * defaults are plenty.
 */
export const scrapeTenderOffersDaily = onSchedule(
  {
    schedule: "0 7 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[tender-offers] starting daily refresh (2-day lookback)");
    const offers = await scrapeTenderOffersLiveFeed(2);
    logger.info(`[tender-offers] scraper returned ${offers.length} filings`);
    let docsWritten = 0;
    if (offers.length > 0) {
      const r = await saveTenderOffers(offers);
      logger.info(`[tender-offers] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("tenderOffersSync", { started, docsWritten });
  },
);

/**
 * Congressional bills + House roll-call votes (combined). Daily 7:15 AM ET.
 *
 * Cadence: daily. Bills get latest-action updates daily when Congress is
 * in session; House roll-call votes happen multiple times per session
 * week. Both scrapers re-pull the full 119th Congress every run because
 * merge-on-upsert is cheap and the api.congress.gov totals are well
 * within our 1000 req/hr budget.
 *
 * Cost per run: ~100 API calls (bills: ~80 pages × 8 types ÷ pagination
 * dedup + votes: ~5 pages), ~5 min runtime, ~16K Firestore upserts (mostly
 * unchanged via merge).
 *
 * Senate roll-call votes are NOT scraped here — they live on senate.gov
 * XML, not api.congress.gov. v1.1 polish.
 */
export const scrapeCongressLegislationDaily = onSchedule(
  {
    schedule: "15 7 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    secrets: [fecApiKey],
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[congress] starting daily refresh (Congress 119)");

    const bills = await scrapeBills({ congress: 119 });
    logger.info(`[congress] bills scraper returned ${bills.length}`);
    let billsWritten = 0;
    if (bills.length > 0) {
      const r = await saveBills(bills);
      logger.info(`[congress] saved ${r.saved} bills to ${r.collection}`);
      billsWritten = r.saved;
    }

    const votes = await scrapeRollCallVotes({ congress: 119, chamber: "house" });
    logger.info(`[congress] votes scraper returned ${votes.length}`);
    let votesWritten = 0;
    if (votes.length > 0) {
      const r = await saveRollCallVotes(votes);
      logger.info(`[congress] saved ${r.saved} votes to ${r.collection}`);
      votesWritten = r.saved;
    }

    await writeJobMeta("congressLegislationSync", {
      started,
      docsWritten: billsWritten + votesWritten,
      stats: { bills: billsWritten, votes: votesWritten },
    });
  },
);

/**
 * SEC Form N-PORT mutual fund / ETF / closed-end fund monthly portfolio
 * reports. Daily 6:40 AM ET.
 *
 * Cadence: daily. Volume ~20-50 filings/day across all registered
 * investment companies. 2-day lookback catches anything filed late or
 * over weekends. Metadata-only ingest fits within 9 min comfortably.
 *
 * Aligns with the existing daily 6-7 AM scraper cluster.
 */
export const scrapeNportDaily = onSchedule(
  {
    schedule: "40 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[nport] starting daily refresh (2-day lookback)");
    const filings = await scrapeNportLiveFeed({ lookbackDays: 2 });
    logger.info(`[nport] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await saveNportFilings(filings);
      logger.info(`[nport] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("nportFilingsSync", { started, docsWritten });
  },
);

/**
 * SEC + DOJ enforcement-related press releases. Daily 6:35 AM ET.
 *
 * Cadence: daily. SEC RSS is a rolling ~50-item window; DOJ JSON pulls
 * the most-recent ~200 records per run. Both refresh quickly into the
 * unified enforcement_actions collection. Daily catches anything
 * announced over the past 24h.
 *
 * No secret needed — SEC RSS and DOJ JSON are unauthenticated public
 * endpoints. Small dataset per run (~250 records combined), fast.
 */
export const scrapeEnforcementDaily = onSchedule(
  {
    schedule: "35 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[enforcement] starting daily SEC + DOJ refresh");
    const actions = await scrapeEnforcementActions({});
    logger.info(`[enforcement] scraper returned ${actions.length} actions`);
    let docsWritten = 0;
    if (actions.length > 0) {
      const r = await saveEnforcementActions(actions);
      logger.info(`[enforcement] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("enforcementActionsSync", { started, docsWritten });
  },
);

/**
 * SEC Form D private placements. Daily 6:30 AM ET.
 *
 * Cadence: daily. Form D must be filed within 15 days of first sale, so
 * the universe of "new private raises this week" turns over fast. Volume
 * is ~150-175 filings per business day across all Reg D variants —
 * comfortable within a 9 min Cloud Functions timeout with the SEC's
 * 10 req/sec rate limit.
 *
 * Daily 6:30 AM ET aligns with the existing daily 6-7 AM scraper cluster
 * (Senate / House / USAspending / LDA) for operational simplicity.
 *
 * No secret needed — SEC EDGAR is unauthenticated. Memory + timeout
 * sized for the per-filing XML fetch pace.
 */
export const scrapeFormDDaily = onSchedule(
  {
    schedule: "30 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[form-d] starting daily refresh (2-day lookback)");
    const filings = await scrapeFormDLiveFeed({ lookbackDays: 2 });
    logger.info(`[form-d] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await savePrivatePlacements(filings);
      logger.info(`[form-d] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("privatePlacementsSync", { started, docsWritten });
  },
);

/**
 * FINRA OTC Transparency weekly summary. Weekly Sunday 8 AM ET.
 *
 * Cadence: weekly. FINRA publishes weekly aggregated data with a ~2-week
 * lag (a "fully published" week is typically 2-3 weeks prior). Sunday
 * cron pulls the most-recent fully-published Monday. Since prior weeks
 * are immutable once finalized, weekly cadence captures everything.
 *
 * Target Monday computation: today's date - 14 days, rolled back to Monday.
 * Idempotent — re-running for the same week upserts the same doc IDs.
 *
 * Cost per run: ~37 API pages (T1 ~52K, T2 ~128K, OTCE ~5K, paginated at
 * 5000 per page), ~5 min runtime, ~180-250K Firestore upserts. The heavy
 * write step explains the 30-min timeout + 1GiB memory.
 */
export const scrapeFinraOtcWeekly = onSchedule(
  {
    schedule: "0 8 * * 0",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    // Compute most-recent published Monday: today minus 14 days, rolled
    // back to Monday in UTC. FINRA's weekStartDate is always a Monday.
    const target = new Date();
    target.setUTCDate(target.getUTCDate() - 14);
    const dow = target.getUTCDay(); // 0=Sun..6=Sat
    const daysBackToMonday = dow === 0 ? 6 : dow - 1;
    target.setUTCDate(target.getUTCDate() - daysBackToMonday);
    const weekStartDate = target.toISOString().split("T")[0]!;
    logger.info(`[finra-otc] starting weekly refresh for ${weekStartDate}`);

    const rows = await scrapeFinraOtcWeek({ weekStartDate });
    logger.info(`[finra-otc] scraper returned ${rows.length} rows`);
    let docsWritten = 0;
    if (rows.length > 0) {
      const r = await saveOtcMarketWeekly(rows);
      logger.info(`[finra-otc] saved ${r.saved} rows to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("otcMarketWeeklySync", {
      started,
      docsWritten,
      stats: { weekStartDate },
    });
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
const SERVER_VERSION = "0.24.0";

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
