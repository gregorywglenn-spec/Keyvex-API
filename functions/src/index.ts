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

import { checkRateLimit, RATE_LIMIT_CONFIG } from "./rate-limit.js";

import {
  getLiveDb,
  saveActivistOwnership,
  saveBills,
  saveCongressionalTrades,
  saveFecCandidates,
  saveFecCommittees,
  saveFecContributions,
  saveFecIndependentExpenditures,
  saveCftcCotReports,
  saveSecFailsToDeliver,
  saveFederalContractAwards,
  saveFederalGrants,
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
  saveFederalRegisterDocuments,
  saveNportFilings,
  saveNportHoldings,
  saveProductRecalls,
  saveGovDocuments,
  saveForeignAgents,
  saveScreeningList,
  saveOfacSdn,
  saveOtcMarketWeekly,
  saveConsumerComplaints,
  saveEconomicIndicators,
  saveOigExclusions,
  savePrivatePlacements,
  saveProxyFilings,
  saveRegistrationStatements,
  saveTreasuryAuctions,
  saveXbrlFundamentals,
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
import { scrapeProxyLiveFeed } from "../../src/scrapers/proxy.js";
import { scrapeTreasuryAuctions } from "../../src/scrapers/treasury-auctions.js";
import { scrapeBlsIndicators } from "../../src/scrapers/bls.js";
import { scrapeFredIndicators } from "../../src/scrapers/fred.js";
import { scrapeEia } from "../../src/scrapers/eia.js";
import { scrapeGovInfo } from "../../src/scrapers/govinfo.js";
import { scrapeFara } from "../../src/scrapers/fara.js";
import { scrapeConsolidatedScreeningList } from "../../src/scrapers/csl.js";
import { scrapeOigExclusions } from "../../src/scrapers/oig-exclusions.js";
import { scrapeCfpbComplaints } from "../../src/scrapers/cfpb-complaints.js";
import { scrapeAndSaveXbrlStreaming } from "../../src/scrapers/xbrl.js";
import { XBRL_UNIVERSE } from "../../src/data/xbrl-universe.js";
import { scrapeForm144LiveFeed } from "../../src/scrapers/form144.js";
import { scrapeForm3LiveFeed } from "../../src/scrapers/form3.js";
import {
  scrapeForm4LiveFeed,
  scrapeForm5LiveFeed,
} from "../../src/scrapers/form4.js";
import { scrapeHouseLiveFeed } from "../../src/scrapers/house.js";
import { scrapeLobbyingByPeriod } from "../../src/scrapers/lobbying.js";
import { scrapeSenateLiveFeed } from "../../src/scrapers/senate.js";
import {
  scrapeSenateForm278,
  scrapeHouseForm278,
} from "../../src/scrapers/form278.js";
import { scrapeContractsLiveFeed } from "../../src/scrapers/usaspending.js";
import { scrapeGrantsLiveFeed } from "../../src/scrapers/usaspending-grants.js";
import {
  scrapeFecCandidates,
  scrapeFecCommittees,
} from "../../src/scrapers/fec.js";
import { scrapeFecScheduleA } from "../../src/scrapers/fec-schedule-a.js";
import { scrapeFecScheduleE } from "../../src/scrapers/fec-schedule-e.js";
import { scrapeCftcCot } from "../../src/scrapers/cftc-cot.js";
import { scrapeSecFailsToDeliver } from "../../src/scrapers/sec-ftd.js";
import { scrapeTenderOffersLiveFeed } from "../../src/scrapers/tender-offers.js";
import {
  scrapeBills,
  scrapeRollCallVotes,
} from "../../src/scrapers/congress-legislation.js";
import { scrapeFinraOtcWeek } from "../../src/scrapers/finra-otc.js";
import { scrapeFormDLiveFeed } from "../../src/scrapers/form-d.js";
import { scrapeEnforcementActions } from "../../src/scrapers/enforcement-actions.js";
import {
  scrapeNportHoldings,
  scrapeNportLiveFeed,
} from "../../src/scrapers/nport.js";
import { scrapeAllFdaRecalls } from "../../src/scrapers/fda-recalls.js";
import { scrapeCpscRecalls } from "../../src/scrapers/cpsc-recalls.js";
import { scrapeRegistrationStatementsLiveFeed } from "../../src/scrapers/registration-statements.js";
import { scrapeOfacSdn } from "../../src/scrapers/ofac-sdn.js";
import { scrapeFederalRegister } from "../../src/scrapers/federal-register.js";

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
 * DEF 14A Proxy filings. Annual + merger-vote proxies.
 * Fires daily at 7:15 AM ET. 2-day lookback. Volume varies seasonally
 * (heavy in Q1-Q2 during annual-meeting season); idempotent saves on
 * accession handle the overlap.
 */
export const scrapeProxyDaily = onSchedule(
  {
    schedule: "15 7 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[proxy-daily] starting (2-day lookback)");
    const filings = await scrapeProxyLiveFeed(2);
    logger.info(`[proxy-daily] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await saveProxyFilings(filings);
      logger.info(`[proxy-daily] saved ${r.saved} filings to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("proxyFilingsSync", { started, docsWritten });
  },
);

/**
 * Treasury Auctions. Bills/Notes/Bonds/TIPS/FRN auction records.
 * Fires daily at 7:30 AM ET. 14-day lookback. Two-stage records
 * (announcement → results) overwrite cleanly via idempotent saves on
 * cusip+auction_date.
 */
export const scrapeTreasuryAuctionsDaily = onSchedule(
  {
    schedule: "30 7 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[treasury-auctions-daily] starting (14-day lookback)");
    const since = new Date();
    since.setDate(since.getDate() - 14);
    const sinceDate = since.toISOString().split("T")[0]!;
    const auctions = await scrapeTreasuryAuctions({ sinceDate });
    logger.info(
      `[treasury-auctions-daily] scraper returned ${auctions.length} auctions`,
    );
    let docsWritten = 0;
    if (auctions.length > 0) {
      const r = await saveTreasuryAuctions(auctions);
      logger.info(
        `[treasury-auctions-daily] saved ${r.saved} auctions to ${r.collection}`,
      );
      docsWritten = r.saved;
    }
    await writeJobMeta("treasuryAuctionsSync", { started, docsWritten });
  },
);

/**
 * BLS economic indicators. Curated 20-series watchlist (unemployment, payrolls,
 * CPI, PPI, wages, productivity). Fires daily at 8:45 AM ET. BLS major series
 * release on different days of the month; daily run captures whichever
 * series updated since yesterday. Idempotent on (series_id, period).
 */
export const scrapeBlsDaily = onSchedule(
  {
    schedule: "45 8 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[bls-daily] starting (2-year lookback, curated watchlist)");
    const indicators = await scrapeBlsIndicators({});
    logger.info(`[bls-daily] scraper returned ${indicators.length} observations`);
    let docsWritten = 0;
    if (indicators.length > 0) {
      const r = await saveEconomicIndicators(indicators);
      logger.info(`[bls-daily] saved ${r.saved} observations to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("blsIndicatorsSync", { started, docsWritten });
  },
);

/**
 * FRED economic indicators. Curated 30-series watchlist covering rates,
 * GDP, money supply, inflation alternatives (PCE), Fed balance sheet,
 * debt, trade, sentiment. Fires daily at 9:00 AM ET. Series have varied
 * release cadences (daily for rates, monthly for jobs, quarterly for GDP)
 * so a daily refresh keeps everything current. Idempotent on
 * (series_id, period). Requires FRED_API_KEY secret.
 */
const fredApiKey = defineSecret("FRED_API_KEY");

export const scrapeFredDaily = onSchedule(
  {
    schedule: "0 9 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [fredApiKey],
  },
  async () => {
    const started = Date.now();
    process.env.FRED_API_KEY = fredApiKey.value();
    logger.info("[fred-daily] starting (5-year lookback, curated watchlist)");
    const indicators = await scrapeFredIndicators({});
    logger.info(`[fred-daily] scraper returned ${indicators.length} observations`);
    let docsWritten = 0;
    if (indicators.length > 0) {
      const r = await saveEconomicIndicators(indicators);
      logger.info(`[fred-daily] saved ${r.saved} observations to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("fredIndicatorsSync", { started, docsWritten });
  },
);

/**
 * Consolidated Screening List — daily 5:50 AM ET.
 *
 * One key-free fetch of api.trade.gov's bulk CSL file (~25K entries across
 * twelve Commerce/State/Treasury screening lists), normalized into the
 * screening_list collection. The file refreshes daily; idempotent on the
 * csl-{source}-{id} doc IDs. ~25K × 400-per-batch ≈ 65 batched writes.
 */
export const scrapeCslDaily = onSchedule(
  {
    schedule: "50 5 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[csl] starting daily refresh");
    const entries = await scrapeConsolidatedScreeningList();
    logger.info(`[csl] scraper returned ${entries.length} entries`);
    let docsWritten = 0;
    if (entries.length > 0) {
      const r = await saveScreeningList(entries);
      logger.info(`[csl] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("cslSync", { started, docsWritten });
  },
);

/**
 * FARA registrations — weekly, Sunday 5:30 AM ET.
 *
 * Pulls the active FARA registrant list, then queries each registration
 * number's foreign principals individually (the list endpoint is broken
 * FARA-side). ~500 registrants at a 2.2s pace ≈ 18-20 min, so the timeout
 * is raised well above the usual 540s. Memory 512 MiB is plenty — the
 * payload is small, it's the request count that takes time. Weekly cadence
 * fits FARA's filing volume (new registrations trickle in daily but the
 * full active set changes slowly). Idempotent on the fara-{reg}-{idx} IDs.
 */
export const scrapeFaraWeekly = onSchedule(
  {
    schedule: "30 5 * * 0",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[fara] starting weekly refresh (full active registrant sweep)");
    const agents = await scrapeFara({});
    logger.info(`[fara] scraper returned ${agents.length} records`);
    let docsWritten = 0;
    if (agents.length > 0) {
      const r = await saveForeignAgents(agents);
      logger.info(`[fara] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("faraSync", { started, docsWritten });
  },
);

/**
 * GovInfo packages — daily 9:30 AM ET (offset from FRED 9:00 + EIA 9:15).
 *
 * Pulls four collections in sequence: CRPT (committee reports), PLAW
 * (public laws), CHRG (hearings), GAOREPORTS (GAO oversight). Default
 * 7-day lookback — committee reports + hearings often trickle in days
 * after the actual event. ~50-150 packages/day across all four.
 * Idempotent on packageId. Requires GOVINFO_API_KEY secret.
 */
const govinfoApiKey = defineSecret("GOVINFO_API_KEY");

export const scrapeGovInfoDaily = onSchedule(
  {
    schedule: "30 9 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [govinfoApiKey],
  },
  async () => {
    const started = Date.now();
    process.env.GOVINFO_API_KEY = govinfoApiKey.value();
    logger.info(
      "[govinfo-daily] starting (7-day lookback, 4 collections: CRPT + PLAW + CHRG + GAOREPORTS)",
    );
    const docs = await scrapeGovInfo({ lookbackDays: 7 });
    logger.info(`[govinfo-daily] scraper returned ${docs.length} packages`);
    let docsWritten = 0;
    if (docs.length > 0) {
      const r = await saveGovDocuments(docs);
      logger.info(`[govinfo-daily] saved ${r.saved} packages to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("govinfoSync", { started, docsWritten });
  },
);

/**
 * EIA energy series — daily 9:15 AM ET (offset from FRED's 9:00 to stagger).
 *
 * ~5-series watchlist: WTI + Brent crude (weekly), Henry Hub natural gas
 * (weekly), US gasoline retail (weekly), US crude production (monthly).
 * Tiny payload (~hundreds of obs total per run). Requires EIA_API_KEY secret.
 * Idempotent on (series_id, period).
 */
const eiaApiKey = defineSecret("EIA_API_KEY");

export const scrapeEiaDaily = onSchedule(
  {
    schedule: "15 9 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
    secrets: [eiaApiKey],
  },
  async () => {
    const started = Date.now();
    process.env.EIA_API_KEY = eiaApiKey.value();
    logger.info("[eia-daily] starting (since 2018, curated watchlist)");
    const indicators = await scrapeEia({});
    logger.info(`[eia-daily] scraper returned ${indicators.length} observations`);
    let docsWritten = 0;
    if (indicators.length > 0) {
      const r = await saveEconomicIndicators(indicators);
      logger.info(`[eia-daily] saved ${r.saved} observations to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("eiaIndicatorsSync", { started, docsWritten });
  },
);

/**
 * HHS-OIG Exclusions list. ~90K entries; OIG updates monthly.
 * Fires monthly on the 5th at 7 AM ET (gives OIG time to publish the
 * monthly update which typically lands in the first few days). Bumps
 * up memory + timeout since we batch 90K + 400 = ~225 batched writes.
 */
export const scrapeOigExclusionsMonthly = onSchedule(
  {
    schedule: "0 7 5 * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[oig-monthly] starting (full LEIE CSV download)");
    const exclusions = await scrapeOigExclusions();
    logger.info(`[oig-monthly] scraper returned ${exclusions.length} exclusions`);
    let docsWritten = 0;
    if (exclusions.length > 0) {
      const r = await saveOigExclusions(exclusions);
      logger.info(`[oig-monthly] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("oigExclusionsSync", { started, docsWritten });
  },
);

/**
 * CFPB Consumer Complaints. Fires daily at 8:00 AM ET. 2-day overlap
 * window, capped at 2000 records per run. Captures the freshest
 * complaint volume for "what's happening right now" agent queries.
 * Idempotent on complaint_id.
 */
export const scrapeCfpbDaily = onSchedule(
  {
    schedule: "0 8 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[cfpb-daily] starting (2-day window, max 2000)");
    const complaints = await scrapeCfpbComplaints({});
    logger.info(`[cfpb-daily] scraper returned ${complaints.length} complaints`);
    let docsWritten = 0;
    if (complaints.length > 0) {
      const r = await saveConsumerComplaints(complaints);
      logger.info(`[cfpb-daily] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("consumerComplaintsSync", { started, docsWritten });
  },
);

/**
 * XBRL Fundamentals — weekly refresh of the curated ticker universe.
 *
 * Fires Sundays at 4 AM ET. Each company-facts call returns 1500-3000
 * observations, and SEC EDGAR allows ~6 req/sec, so ~110 companies takes
 * ~5-10 minutes of API time + ~5-10 minutes of Firestore writes.
 *
 * Uses scrapeAndSaveXbrlStreaming: saves per-company to keep peak memory
 * bounded (~10K records per company, not 700K accumulated). Critical for
 * the 1 GiB function memory budget.
 *
 * Universe is defined in src/data/xbrl-universe.ts. Expand there to grow.
 */
export const scrapeXbrlWeekly = onSchedule(
  {
    schedule: "0 4 * * 0",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info(
      `[xbrl-weekly] starting streaming refresh for ${XBRL_UNIVERSE.length} tickers`,
    );
    const summary = await scrapeAndSaveXbrlStreaming(
      XBRL_UNIVERSE,
      saveXbrlFundamentals,
    );
    logger.info(
      `[xbrl-weekly] DONE — ${summary.tickers_processed} ok / ${summary.tickers_skipped} skipped, ${summary.total_saved} obs saved`,
    );
    await writeJobMeta("xbrlFundamentalsSync", {
      started,
      docsWritten: summary.total_saved,
    });
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
 * Form 5 — the annual catch-up insider filing. Daily 8:20 AM ET, 3-day
 * lookback. Form 5 shares Form 4's XML schema and lands in the same
 * insider_trades collection (tagged data_source SEC_EDGAR_FORM5). Volume
 * is low — Form 5 is annual, concentrated after fiscal year-ends — so a
 * daily run with a short lookback is plenty. Idempotent on the shared
 * Form 4/5 doc-ID scheme.
 */
export const scrapeForm5Daily = onSchedule(
  {
    schedule: "20 8 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[form5] starting (3-day lookback)");
    const trades = await scrapeForm5LiveFeed(3);
    logger.info(`[form5] scraper returned ${trades.length} transactions`);
    let docsWritten = 0;
    if (trades.length > 0) {
      const r = await saveInsiderTransactions(trades);
      logger.info(`[form5] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("form5Sync", { started, docsWritten });
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
 * USAspending federal GRANTS (assistance awards). Daily 6:12 AM ET.
 *
 * Different universe than contracts — universities, non-profits, state
 * & local agencies, research institutions. CFDA-program-keyed.
 */
export const scrapeUSAspendingGrantsDaily = onSchedule(
  {
    schedule: "12 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[usaspending grants] starting (7-day lookback)");
    const grants = await scrapeGrantsLiveFeed(7);
    logger.info(`[usaspending grants] scraper returned ${grants.length}`);
    let docsWritten = 0;
    if (grants.length > 0) {
      const r = await saveFederalGrants(grants);
      logger.info(`[usaspending grants] saved ${r.saved} grants to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("federalGrantsSync", { started, docsWritten });
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
    // parseContent fetches + parses every filing's PDF/HTML, so this job
    // needs more headroom than the old metadata-only run (1 GiB for
    // pdf-parse, a longer timeout for the per-PDF fetch loop across both
    // chambers).
    memory: "1GiB",
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info(
      "[form278] starting weekly Form 278 refresh (both chambers, parsed)",
    );
    // 35-day window catches the 30-day "what just disclosed" cluster + 5
    // day buffer for delayed eFD/clerk updates over weekends. parseContent
    // extracts Schedule A (assets) + liabilities into structured fields.
    const senate = await scrapeSenateForm278({
      lookbackDays: 35,
      parseContent: true,
    });
    logger.info(`[form278] Senate returned ${senate.length} filings`);
    const house = await scrapeHouseForm278({
      lookbackDays: 35,
      parseContent: true,
    });
    logger.info(`[form278] House returned ${house.length} filings`);
    const filings = [...senate, ...house];
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
 * FEC Schedule A contributions (≥ $1,000 itemized). Daily 7:30 AM ET.
 *
 * Cadence: daily 7-day rolling window. FEC re-publishes corrections to
 * past filings, so the 7-day overlap on a daily cadence catches both
 * fresh disclosures and amendments. Idempotent via sub_id doc IDs.
 *
 * Scope discipline: $1,000+ floor (signal-rich; cuts payroll-deduction
 * noise) + cycle=2026 keeps the daily pull bounded under FEC's 10K-row
 * page-pagination ceiling. Heavy filtered backfills (committee_id /
 * candidate_id) are CLI-only via `npx tsx src/scrape.ts fec-contributions
 * --committee=C0XXXXXXX --save`.
 */
export const scrapeFecScheduleADaily = onSchedule(
  {
    schedule: "30 7 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 900,
    secrets: [fecApiKey],
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[fec sched-a] starting daily refresh (7-day window, $1K+)");
    const contributions = await scrapeFecScheduleA({
      lookbackDays: 7,
      minAmount: 1000,
      cycle: 2026,
    });
    logger.info(`[fec sched-a] scraper returned ${contributions.length}`);
    let docsWritten = 0;
    if (contributions.length > 0) {
      const r = await saveFecContributions(contributions);
      logger.info(`[fec sched-a] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("fecScheduleASync", { started, docsWritten });
  },
);

/**
 * FEC Schedule E independent expenditures (≥ $1,000). Daily 7:45 AM ET.
 *
 * Cadence: daily 7-day rolling window. Super PAC ad spending shows up
 * via F24 filings (24-hour notices) and F5 (quarterly) and gets amended
 * frequently — daily-overlap-on-7-days catches both new and corrections.
 *
 * Cycle scope: 2026. Pre-election windows can spike dramatically (e.g.,
 * the 60 days before a general election), so the 10K-page cap can hit
 * for the busiest days; tighten in v1.1 with cursor pagination across
 * the full result set.
 */
export const scrapeFecScheduleEDaily = onSchedule(
  {
    schedule: "45 7 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 900,
    secrets: [fecApiKey],
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[fec sched-e] starting daily refresh (7-day window, $1K+)");
    const ies = await scrapeFecScheduleE({
      lookbackDays: 7,
      minAmount: 1000,
      cycle: 2026,
    });
    logger.info(`[fec sched-e] scraper returned ${ies.length}`);
    let docsWritten = 0;
    if (ies.length > 0) {
      const r = await saveFecIndependentExpenditures(ies);
      logger.info(`[fec sched-e] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("fecScheduleESync", { started, docsWritten });
  },
);

/**
 * SEC Fails-to-Deliver (FTD) bi-monthly. Twice per month at 5 AM ET on
 * the 1st and 16th — SEC posts half-month files ~1 week behind so this
 * cadence catches the prior half-month with comfortable buffer.
 */
export const scrapeSecFtdSemimonthly = onSchedule(
  {
    schedule: "0 5 1,16 * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[sec-ftd] starting bi-monthly refresh");
    const rows = await scrapeSecFailsToDeliver({});
    logger.info(`[sec-ftd] scraper returned ${rows.length} FTD rows`);
    let docsWritten = 0;
    if (rows.length > 0) {
      const r = await saveSecFailsToDeliver(rows);
      logger.info(`[sec-ftd] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("secFtdSync", { started, docsWritten });
  },
);

/**
 * CFTC Commitments of Traders (COT) reports. Weekly Saturday 7 AM ET.
 *
 * COT data publishes Friday 3:30 PM ET for prior Tuesday close. Saturday
 * 7 AM pulls catches everything fresh with a comfortable buffer. 12-week
 * rolling window handles late corrections and amendments to prior reports.
 */
export const scrapeCftcCotWeekly = onSchedule(
  {
    schedule: "0 7 * * 6",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[cftc-cot] starting weekly refresh (12-week window)");
    const reports = await scrapeCftcCot({ lookbackWeeks: 12 });
    logger.info(`[cftc-cot] scraper returned ${reports.length} rows`);
    let docsWritten = 0;
    if (reports.length > 0) {
      const r = await saveCftcCotReports(reports);
      logger.info(`[cftc-cot] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("cftcCotSync", { started, docsWritten });
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

    // Both chambers — House via api.congress.gov, Senate via senate.gov XML.
    const votes = await scrapeRollCallVotes({ congress: 119 });
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
 * Federal Register documents (Rules / Proposed Rules / Notices /
 * Presidential Documents). Daily 6:55 AM ET.
 *
 * Cadence: daily. The Federal Register publishes business-days only;
 * a 3-day lookback covers Friday + weekend coverage plus daily overlap.
 * Volume ~100-200 documents/day; metadata-only ingest fits in 9 min.
 */
export const scrapeFederalRegisterDaily = onSchedule(
  {
    schedule: "55 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[fedreg] starting daily refresh (3-day lookback)");
    const docs = await scrapeFederalRegister({ lookbackDays: 3 });
    logger.info(`[fedreg] scraper returned ${docs.length} documents`);
    let docsWritten = 0;
    if (docs.length > 0) {
      const r = await saveFederalRegisterDocuments(docs);
      logger.info(`[fedreg] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("federalRegisterSync", { started, docsWritten });
  },
);

/**
 * OFAC SDN sanctions list. Daily 6:50 AM ET.
 *
 * Cadence: daily. OFAC updates the SDN list when new sanctions are
 * issued or existing ones modified (multiple times per week). Daily
 * full-list refresh keeps coverage current; idempotent saves on
 * ent_num mean unchanged records are no-op upserts.
 *
 * Volume: ~19K records, 5.5MB CSV — fits in default 9-min timeout
 * easily. 1GiB memory to handle the CSV parse + 48 Firestore batches.
 */
export const scrapeOfacSdnDaily = onSchedule(
  {
    schedule: "50 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "1GiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[ofac] starting daily SDN refresh");
    const entries = await scrapeOfacSdn();
    logger.info(`[ofac] scraper returned ${entries.length} entries`);
    let docsWritten = 0;
    if (entries.length > 0) {
      const r = await saveOfacSdn(entries);
      logger.info(`[ofac] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("ofacSdnSync", { started, docsWritten });
  },
);

/**
 * SEC registration statements (S-1, S-1/A, S-3, S-3/A). Daily 6:45 AM ET.
 *
 * Cadence: daily. Volume ~30-100 filings/day across all four variants.
 * 2-day lookback for late-filed weekend submissions. Metadata-only ingest
 * fits within 9 min Cloud Functions timeout.
 *
 * Aligns with the daily 6-7 AM scraper cluster.
 */
export const scrapeRegStatementsDaily = onSchedule(
  {
    schedule: "45 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[reg-stmt] starting daily refresh (2-day lookback)");
    const filings = await scrapeRegistrationStatementsLiveFeed({
      lookbackDays: 2,
    });
    logger.info(`[reg-stmt] scraper returned ${filings.length} filings`);
    let docsWritten = 0;
    if (filings.length > 0) {
      const r = await saveRegistrationStatements(filings);
      logger.info(`[reg-stmt] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("registrationStatementsSync", { started, docsWritten });
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
    memory: "1GiB",
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

    // Per-holding extraction. Wrapped separately so a holdings failure or
    // partial-fetch doesn't block the metadata writes above. Holdings rows
    // are batched into Firestore with merge:true so partial completions are
    // idempotent — the next run picks up where we left off.
    try {
      if (filings.length > 0) {
        logger.info(
          `[nport-holdings] starting holdings parse for ${filings.length} filings`,
        );
        const holdings = await scrapeNportHoldings(filings);
        if (holdings.length > 0) {
          const h = await saveNportHoldings(holdings);
          logger.info(
            `[nport-holdings] saved ${h.saved} to ${h.collection}`,
          );
          await writeJobMeta("nportHoldingsSync", {
            started,
            docsWritten: h.saved,
          });
        } else {
          await writeJobMeta("nportHoldingsSync", { started, docsWritten: 0 });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[nport-holdings] phase error — ${msg}`);
    }
  },
);

/**
 * openFDA recalls (drug + device + food) — daily 6:50 AM ET.
 *
 * Three sub-feeds in one run (drug/device/food), unified into the
 * product_recalls Firestore collection. No auth needed at default rate
 * limit (240 req/min). 7-day lookback gives ~10-50 new recalls/day across
 * all three sub-feeds — comfortable in <2 min total.
 *
 * NHTSA + CPSC sub-feeds layer in as additional sources without changing
 * this scheduler — only their per-source scrapers get added.
 */
export const scrapeFdaRecallsDaily = onSchedule(
  {
    schedule: "50 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "512MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    // Widened 2026-05-23 from 7 → 60: openFDA's record
    // `recall_initiation_date` is when the recall STARTED, not when
    // openFDA indexed it. openFDA has a ~30-45 day publication lag
    // between FDA classifying a recall and openFDA exposing it via
    // the API. A 7-day window kept missing entire weeks of fda_device
    // records whose initiation date pre-dated the window but who only
    // got openFDA-indexed in the last week. 60 days catches the
    // long tail of late-indexed records without re-pulling unnecessary
    // volume (idempotent on doc IDs anyway).
    logger.info("[fda-recalls] starting daily refresh (60-day lookback)");
    const recalls = await scrapeAllFdaRecalls({ lookbackDays: 60 });
    logger.info(`[fda-recalls] scraper returned ${recalls.length} recalls`);
    let docsWritten = 0;
    if (recalls.length > 0) {
      const r = await saveProductRecalls(recalls);
      logger.info(`[fda-recalls] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("fdaRecallsSync", { started, docsWritten });
  },
);

/**
 * CPSC consumer-product recalls — daily 6:55 AM ET.
 *
 * One-shot fetch with 30-day lookback against saferproducts.gov REST
 * endpoint. ~20-60 recalls/month, tiny payload (<100KB), no auth, no
 * pagination needed. Writes into the same `product_recalls` collection as
 * the FDA sub-feeds; source discriminator is "cpsc".
 */
export const scrapeCpscRecallsDaily = onSchedule(
  {
    schedule: "55 6 * * *",
    region: REGION,
    timeZone: TZ,
    memory: "256MiB",
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const started = Date.now();
    logger.info("[cpsc-recalls] starting daily refresh (30-day lookback)");
    const recalls = await scrapeCpscRecalls({ lookbackDays: 30 });
    logger.info(`[cpsc-recalls] scraper returned ${recalls.length} recalls`);
    let docsWritten = 0;
    if (recalls.length > 0) {
      const r = await saveProductRecalls(recalls);
      logger.info(`[cpsc-recalls] saved ${r.saved} to ${r.collection}`);
      docsWritten = r.saved;
    }
    await writeJobMeta("cpscRecallsSync", { started, docsWritten });
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
    logger.info("[enforcement] starting daily SEC + DOJ + CFTC + OCC + FDIC + FTC refresh");
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
 * Cron-freshness audit. Reads /meta/{jobName} for each monitored scraper,
 * checks lastSyncedAt is within cadence-matched thresholds, and pages Slack:
 * on any status change, on a 6h nag while still broken, and on a once-a-day
 * green heartbeat while healthy (so silence is never mistaken for a dead
 * monitor). See runHealthCheck() for the firing rules.
 *
 * Schedule: every 30 minutes — matches the tightest scraper cadence (Form 4)
 * so a sub-hourly scraper death is caught within the warn window instead of
 * up to a day later. The change/nag/heartbeat dedup inside runHealthCheck
 * keeps a healthy system to ~1 Slack message/day despite the 48 runs/day.
 *
 * Offset :07/:37 (not :00/:30) so we don't collide with the Form 4 scraper's
 * own :00/:30 ticks or Derek's 12:00 ET project health-check.
 */
export const scheduledHealthCheck = onSchedule(
  {
    schedule: "7,37 * * * *",
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
const SERVER_VERSION = "0.52.1";

/**
 * MCP_API_KEY is intentionally kept defined-but-unused after the 2026-05-22
 * switch to authless mode (Anthropic Connectors Directory auth type `none`).
 *
 * Why keep it: the secret value still lives in Google Secret Manager and may
 * be re-mounted on a future *paid-tier* endpoint (e.g., mcp.keyvex.com/v2 or
 * a separate enterprise function) where per-customer gating is required.
 * Removing the `defineSecret` declaration would not delete the secret, but
 * keeping it here documents the intent. To re-enable, add `secrets: [mcpApiKey]`
 * to a function's onRequest options and read `mcpApiKey.value()` at runtime.
 *
 * Authless rationale: KeyVex serves 38 read-only tools over US public-record
 * data. There are no per-user accounts; the prior shared bearer key was a
 * rate-limit / abuse token, not a tenant identifier. Anthropic's Connectors
 * Directory explicitly supports `none` out of the box; the documented auth
 * doc is at https://claude.com/docs/connectors/building/authentication.md
 * and the project memory entry is project_anthropic_directory_oauth.md.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mcpApiKey = defineSecret("MCP_API_KEY");

/**
 * MCP server exposed as an HTTPS endpoint at /mcp. Stateless (each request
 * spins up a fresh Server + transport pair, runs the request, tears down).
 *
 * Auth: NONE (`none` type per the Anthropic Connectors Directory auth
 * vocabulary). Abuse prevention has two layers:
 *
 *   1. `maxInstances` caps the worst-case Cloud Run bill — even under a
 *      coordinated flood, no more than this many containers ever exist.
 *   2. Per-IP sliding-window rate limit in `./rate-limit.ts` rejects a
 *      single IP that exceeds the cap (default 60 req/min). See that file
 *      for the trade-off note on multi-instance amplification.
 *
 * The health check at GET / remains auth-free and rate-limit-free so uptime
 * monitors can hit it freely.
 *
 * Cold-start: ~5-10 seconds on the bundled 14 MB function. After the first
 * request, the container stays warm for ~15 minutes of idle. Acceptable
 * for v1; can split into a dedicated MCP-only function later if it
 * becomes user-facing latency.
 */
export const mcp = onRequest(
  {
    region: REGION,
    memory: "1GiB",
    timeoutSeconds: 300,
    // NOTE: `secrets: [mcpApiKey]` intentionally NOT mounted — server is
    // authless after 2026-05-22 (Anthropic Directory auth type `none`).
    // The secret stays in Secret Manager for the future paid-tier endpoint.
    concurrency: 10,
    // Bill-cap backstop: even if a flood of IPs slips past per-IP limits,
    // total concurrent containers stops here. 50 instances × $X/instance-hr
    // = a knowable upper bound on a bad day. Tune up if legitimate load
    // approaches the ceiling; tune down if abuse is suspected.
    maxInstances: 50,
    // CORS enabled to allow browser-origin calls (some MCP clients connect
    // directly from the browser rather than through a server-side proxy).
    // `true` means firebase-functions adds permissive Access-Control-*
    // headers. Safe for our authless public endpoint — there's no
    // credential-bearing flow that CORS could compromise.
    cors: true,
    // Dedicated least-privilege runtime identity. This service account holds
    // only Cloud Datastore Viewer (Firestore READ-only) + Logs Writer +
    // Monitoring Metric Writer — NO Firestore write. The MCP server's tools
    // are all read-only by code; this makes that true at the credential layer
    // too, so a hypothetical bug or breach physically cannot write the DB.
    serviceAccount:
      "keyvex-mcp-readonly@capitaledge-api.iam.gserviceaccount.com",
  },
  async (req, res) => {
    // Health check — auth-free, rate-limit-free GET returns server status.
    if (req.method === "GET") {
      res.json({
        status: "ok",
        service: SERVER_NAME,
        version: SERVER_VERSION,
        tools: TOOLS.length,
        tool_names: TOOLS.map((t) => t.definition.name),
        auth: "none",
      });
      return;
    }

    // MCP protocol uses POST exclusively.
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed; use POST" });
      return;
    }

    // Per-IP rate limit. Prefer the leftmost entry of X-Forwarded-For (the
    // original client) over req.ip (which on Cloud Run reflects the load
    // balancer hop). Fall back to a sentinel so the limiter still buckets
    // unknown-source requests.
    const ip =
      req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";
    if (!checkRateLimit(ip)) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil(RATE_LIMIT_CONFIG.windowMs / 1000)),
      );
      res.status(429).json({
        error: "Rate limit exceeded",
        limit_per_window: RATE_LIMIT_CONFIG.maxRequestsPerWindow,
        window_seconds: RATE_LIMIT_CONFIG.windowMs / 1000,
        retry_after_seconds: Math.ceil(RATE_LIMIT_CONFIG.windowMs / 1000),
      });
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
