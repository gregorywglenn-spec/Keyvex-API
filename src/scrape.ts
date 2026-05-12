/**
 * Scraper CLI — runs scrapers from the command line.
 *
 * Usage:
 *   tsx src/scrape.ts ping                       Verify Firestore connection
 *   tsx src/scrape.ts bioguide [--save]          Ingest unitedstates/congress-legislators
 *                                                YAML catalog (legislators + committees +
 *                                                committee memberships joined into one
 *                                                Legislator record per current member)
 *   tsx src/scrape.ts bioguide-historical [--save]
 *                                                Ingest legislators-historical.yaml — every
 *                                                member who has ever served Congress (1789→present,
 *                                                ~12K entries). Required for back-fill Tier-4
 *                                                fallback on former-member trades.
 *   tsx src/scrape.ts backfill-bioguide [--dry-run]
 *                                                Back-fill bioguide_id on every
 *                                                congressional_trades record by joining
 *                                                (chamber, state, last_name) against
 *                                                the legislators collection
 *   tsx src/scrape.ts 8k <TICKER> [--save]       Recent Form 8-K material events for one ticker
 *   tsx src/scrape.ts 8k-feed [days] [--save]    Form 8-K filings across all companies, last N days
 *   tsx src/scrape.ts lobbying-registrant <NAME> [--save]
 *                                                LDA filings by registrant (lobbying firm) name
 *   tsx src/scrape.ts lobbying-client <NAME> [--save]
 *                                                LDA filings by client (paying entity) name
 *   tsx src/scrape.ts lobbying-feed <YEAR> <PERIOD> [--save] [--max=N]
 *                                                Bulk LDA filings for a (year, period); period =
 *                                                first_quarter | second_quarter | third_quarter |
 *                                                fourth_quarter | mid_year | year_end
 *   tsx src/scrape.ts usaspending <RECIPIENT> [days]
 *                                                Federal contract awards for one recipient (default 365 days)
 *   tsx src/scrape.ts usaspending-feed [days] --save
 *                                                Recent federal contracts across all recipients (default 7 days)
 *   tsx src/scrape.ts 13d-13g <TICKER>           Schedule 13D/13G stakes filed against one issuer
 *   tsx src/scrape.ts 13d-13g <TICKER> --save    ...and write them to Firestore
 *   tsx src/scrape.ts 13d-13g-feed [days]        Schedule 13D/13G across all issuers, last N days
 *   tsx src/scrape.ts 13d-13g-feed 7 --save      ...and write them to Firestore
 *   tsx src/scrape.ts form3 AAPL                 Form 3 initial-ownership baselines for one ticker
 *   tsx src/scrape.ts form3 AAPL --save          ...and write them to Firestore
 *   tsx src/scrape.ts form3-feed [days]          Form 3 across all companies, last N days
 *   tsx src/scrape.ts form3-feed 7 --save        ...and write them to Firestore
 *   tsx src/scrape.ts form4 AAPL                 Form 4 trades for one ticker
 *   tsx src/scrape.ts form4 AAPL --save          ...and write them to Firestore
 *   tsx src/scrape.ts form4-feed [days]          Form 4 across all companies, last N days
 *   tsx src/scrape.ts form4-feed 2 --save        ...and write them to Firestore
 *   tsx src/scrape.ts form144 AAPL [--save]      Form 144 planned-sale notices for one ticker
 *   tsx src/scrape.ts form144-feed [days]        Form 144 across all companies, last N days
 *   tsx src/scrape.ts form144-feed 7 --save      ...and write them to Firestore
 *   tsx src/scrape.ts 13f berkshire              Latest 13F-HR for one fund (alias or CIK)
 *   tsx src/scrape.ts 13f 0001067983 --save      ...and write to Firestore
 *   tsx src/scrape.ts 13f-feed [days]            Recent 13F filings across all funds
 *   tsx src/scrape.ts 13f-feed 30 --save         ...and write to Firestore
 *   tsx src/scrape.ts funds                      List tracked fund aliases
 *   tsx src/scrape.ts senate [days]              Senate PTRs (default 7 days)
 *   tsx src/scrape.ts senate 7 --save            ...and write to Firestore
 *   tsx src/scrape.ts senate-ptr <PTR_ID>        One specific PTR (testing)
 *   tsx src/scrape.ts house-index [days]         House PTR metadata (XML index, no PDFs)
 *   tsx src/scrape.ts house-text <DOC_ID>        Dump raw extracted text from one PTR PDF
 *   tsx src/scrape.ts house [days] [--extract] [--save]
 *                                                House PTRs (default 7 days; --extract
 *                                                fetches and parses each PDF; --save
 *                                                writes parsed trades to Firestore)
 *
 * Diagnostics:
 *   tsx src/scrape.ts test-normalize             Smoke-test EDGAR name fallback
 *   tsx src/scrape.ts search-edgar <SUBSTRING>   Search EDGAR catalog
 *   tsx src/scrape.ts dump-edgar                 Dump EDGAR catalog stats
 *   tsx src/scrape.ts flush-cusip-cache          Clear cusip_map cache
 *
 * JSON results print to stdout, log lines to stderr — pipe-friendly.
 */

import {
  backfillBioguideIds,
  getDbIfLive,
  pingFirestore,
  saveActivistOwnership,
  saveBills,
  saveCongressionalTrades,
  saveFecCandidates,
  saveFecCommittees,
  saveFederalContractAwards,
  saveForm144Filings,
  saveForm278Filings,
  saveEnforcementActions,
  saveFederalRegisterDocuments,
  saveNportFilings,
  saveOfacSdn,
  saveOtcMarketWeekly,
  savePrivatePlacements,
  saveRegistrationStatements,
  saveRollCallVotes,
  saveTenderOffers,
  saveForm3Holdings,
  saveInsiderTransactions,
  saveInstitutionalHoldings,
  saveLegislators,
  saveLegislatorsHistorical,
  saveLobbyingFilings,
  saveMaterialEvents,
} from "./firestore.js";
import {
  scrapeBioguideCatalog,
  scrapeBioguideHistorical,
} from "./scrapers/bioguide.js";
import { scrape8kByTicker, scrape8kLiveFeed } from "./scrapers/form8k.js";
import {
  scrapeLobbyingByClient,
  scrapeLobbyingByPeriod,
  scrapeLobbyingByRegistrant,
} from "./scrapers/lobbying.js";
import { scrapeForm4ByTicker, scrapeForm4LiveFeed } from "./scrapers/form4.js";
import {
  scrapeForm144ByTicker,
  scrapeForm144LiveFeed,
} from "./scrapers/form144.js";
import {
  scrapeForm3ByTicker,
  scrapeForm3LiveFeed,
} from "./scrapers/form3.js";
import {
  scrapeActivistByTicker,
  scrapeActivistLiveFeed,
} from "./scrapers/activist.js";
import {
  scrapeContractsByRecipient,
  scrapeContractsLiveFeed,
} from "./scrapers/usaspending.js";
import {
  scrapeFecCandidates,
  scrapeFecCommittees,
} from "./scrapers/fec.js";
import {
  scrapeTenderOffersByTicker,
  scrapeTenderOffersLiveFeed,
} from "./scrapers/tender-offers.js";
import {
  scrapeBills,
  scrapeRollCallVotes,
} from "./scrapers/congress-legislation.js";
import { scrapeFinraOtcWeek } from "./scrapers/finra-otc.js";
import { scrapeFormDLiveFeed } from "./scrapers/form-d.js";
import { scrapeEnforcementActions } from "./scrapers/enforcement-actions.js";
import { scrapeNportLiveFeed } from "./scrapers/nport.js";
import { scrapeRegistrationStatementsLiveFeed } from "./scrapers/registration-statements.js";
import { scrapeOfacSdn } from "./scrapers/ofac-sdn.js";
import { scrapeFederalRegister } from "./scrapers/federal-register.js";
import {
  listTrackedFunds,
  scrape13FByFund,
  scrape13FLiveFeed,
} from "./scrapers/13f.js";
import {
  scrapeSenateLiveFeed,
  scrapeSenatePtrById,
} from "./scrapers/senate.js";
import { scrapeSenateForm278 } from "./scrapers/form278.js";
import {
  dumpHousePtrText,
  scrapeHouseLiveFeed,
} from "./scrapers/house.js";
import {
  dumpEdgar,
  lookupTickerByName,
  normalizeName,
  searchEdgar,
} from "./sec-tickers.js";

interface CliCommand {
  description: string;
  run: (args: string[]) => Promise<unknown>;
}

function hasSaveFlag(args: string[]): boolean {
  return args.includes("--save");
}

const COMMANDS: Record<string, CliCommand> = {
  ping: {
    description: "Verify Firestore connection (live mode) or report stub mode",
    run: async () => {
      const result = await pingFirestore();
      if (result.mode === "stub") {
        console.error(
          "[ping] STUB MODE — no service account at secrets/service-account.json",
        );
      } else {
        console.error(
          `[ping] LIVE MODE — connected to project ${result.projectId ?? "(unknown id)"}, ${result.collectionsSeen} top-level collection(s)`,
        );
      }
      return result;
    },
  },
  bioguide: {
    description:
      "Ingest the unitedstates/congress-legislators YAML catalog (legislators-current + committees-current + committee-membership-current). Joins all three into Legislator records with party/state/district/chamber/committee_assignments. Add --save to write to Firestore. ~5 seconds end-to-end.",
    run: async (args) => {
      const legislators = await scrapeBioguideCatalog();
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${legislators.length} legislator records to Firestore...`,
        );
        const result = await saveLegislators(legislators);
        console.error(
          `[save] Saved ${result.saved} legislators to ${result.collection}`,
        );
      }
      return legislators;
    },
  },
  "bioguide-historical": {
    description:
      "Ingest legislators-historical.yaml — every member who has ever served Congress (1789→present, ~12K entries). Used by the bioguide-back-fill matcher's Tier-4 fallback to resolve trades by former members. Add --save to write to the legislators_historical Firestore collection. ~9 MB download, ~5-10 seconds.",
    run: async (args) => {
      const legislators = await scrapeBioguideHistorical();
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${legislators.length} historical legislator records to Firestore...`,
        );
        const result = await saveLegislatorsHistorical(legislators);
        console.error(
          `[save] Saved ${result.saved} historical legislators to ${result.collection}`,
        );
      }
      return legislators;
    },
  },
  "backfill-bioguide": {
    description:
      "Walk every congressional_trades record and write the matching bioguide_id back into the row by joining (chamber, state, last_name) against the legislators collection. Idempotent — safe to re-run. Pass --dry-run to count matches without writing.",
    run: async (args) => {
      const dryRun = args.includes("--dry-run");
      const stats = await backfillBioguideIds({ dryRun });
      return stats;
    },
  },
  "8k": {
    description:
      "Scrape recent Form 8-K material-event filings for a single ticker (add --save to write to Firestore). 8-K = the SEC's 'current report' form, filed within 4 business days of any material event. Each row is one filing, indexed by item_codes (1.01 / 2.01 / 5.02 / 7.01 / 8.01 / 9.01 etc.).",
    run: async (args) => {
      const ticker = args.find((a) => !a.startsWith("--"));
      if (!ticker) {
        throw new Error("Usage: tsx src/scrape.ts 8k <TICKER> [--save]");
      }
      const events = await scrape8kByTicker(ticker);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${events.length} material-event filings to Firestore...`,
        );
        const result = await saveMaterialEvents(events);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return events;
    },
  },
  "8k-feed": {
    description:
      "Scrape Form 8-K material-event filings across all companies for the last N days (default 1; add --save to write to Firestore). Indexed by item_codes — agents can query for exec changes (5.02), M&A (1.01/2.01), earnings (2.02), etc. without needing to parse the prose body.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 1;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const events = await scrape8kLiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${events.length} material-event filings to Firestore...`,
        );
        const result = await saveMaterialEvents(events);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return events;
    },
  },
  "lobbying-registrant": {
    description:
      "Scrape LDA filings by registrant (lobbying firm) name (substring match; add --save to write to Firestore). Returns every filing the firm has submitted, with client + issues + government entities + lobbyist names.",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const name = positional[0];
      if (!name) {
        throw new Error(
          "Usage: tsx src/scrape.ts lobbying-registrant <NAME> [--save]",
        );
      }
      const filings = await scrapeLobbyingByRegistrant(name);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} lobbying filings to Firestore...`,
        );
        const result = await saveLobbyingFilings(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "lobbying-client": {
    description:
      "Scrape LDA filings by client (paying entity) name (substring match; add --save to write to Firestore). Use to ask 'what is Pfizer paying lobbyists for' or 'which firms work for Lockheed Martin'.",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const name = positional[0];
      if (!name) {
        throw new Error(
          "Usage: tsx src/scrape.ts lobbying-client <NAME> [--save]",
        );
      }
      const filings = await scrapeLobbyingByClient(name);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} lobbying filings to Firestore...`,
        );
        const result = await saveLobbyingFilings(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "lobbying-feed": {
    description:
      "Bulk-scrape every LDA filing for a (year, period). Period = first_quarter | second_quarter | third_quarter | fourth_quarter | mid_year | year_end. Default cap 1000 filings; pass --max=N to override. Add --save to write to Firestore.",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const year = positional[0] ? parseInt(positional[0], 10) : NaN;
      const period = positional[1];
      if (Number.isNaN(year) || year < 1999 || year > 2100 || !period) {
        throw new Error(
          "Usage: tsx src/scrape.ts lobbying-feed <YEAR> <PERIOD> [--save] [--max=N]",
        );
      }
      const maxFlag = args.find((a) => a.startsWith("--max="));
      const maxRecords = maxFlag
        ? parseInt(maxFlag.slice("--max=".length), 10)
        : 1000;
      if (Number.isNaN(maxRecords) || maxRecords < 1) {
        throw new Error("--max=N must be a positive integer");
      }
      const filings = await scrapeLobbyingByPeriod(year, period, maxRecords);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} lobbying filings to Firestore...`,
        );
        const result = await saveLobbyingFilings(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  usaspending: {
    description:
      "Scrape federal contract awards for a recipient name (substring match) over the last N days (add --save to write to Firestore). Use 'Lockheed Martin' to catch all LMT subsidiaries; use a specific subsidiary name to narrow.",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const recipientName = positional[0];
      if (!recipientName) {
        throw new Error(
          "Usage: tsx src/scrape.ts usaspending <RECIPIENT_NAME> [days] [--save]",
        );
      }
      const daysArg = positional[1];
      const days = daysArg ? parseInt(daysArg, 10) : 365;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const awards = await scrapeContractsByRecipient(recipientName, days);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${awards.length} federal contract awards to Firestore...`,
        );
        const result = await saveFederalContractAwards(awards);
        console.error(
          `[save] Saved ${result.saved} awards to ${result.collection}`,
        );
      }
      return awards;
    },
  },
  "usaspending-feed": {
    description:
      "Scrape recent federal contract awards across all recipients for the last N days (default 7; add --save to write to Firestore). The political-alpha source — joins to congressional_trades by recipient_name + date.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const awards = await scrapeContractsLiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${awards.length} federal contract awards to Firestore...`,
        );
        const result = await saveFederalContractAwards(awards);
        console.error(
          `[save] Saved ${result.saved} awards to ${result.collection}`,
        );
      }
      return awards;
    },
  },
  "13d-13g": {
    description:
      "Scrape Schedule 13D / 13G beneficial-ownership disclosures for a single issuer (add --save to write to Firestore). 13D = activist (intent to influence control); 13G = passive institutional. Both filed when a holder crosses 5%.",
    run: async (args) => {
      const ticker = args.find((a) => !a.startsWith("--"));
      if (!ticker) {
        throw new Error(
          "Usage: tsx src/scrape.ts 13d-13g <TICKER> [--save]",
        );
      }
      const rows = await scrapeActivistByTicker(ticker);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${rows.length} activist/passive ownership rows to Firestore...`,
        );
        const result = await saveActivistOwnership(rows);
        console.error(
          `[save] Saved ${result.saved} rows to ${result.collection}`,
        );
      }
      return rows;
    },
  },
  "13d-13g-feed": {
    description:
      "Scrape Schedule 13D/13G filings across all issuers for the last N days (default 7; add --save to write to Firestore). Captures activist campaigns, hostile bids, large institutional accumulations.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const rows = await scrapeActivistLiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${rows.length} activist/passive ownership rows to Firestore...`,
        );
        const result = await saveActivistOwnership(rows);
        console.error(
          `[save] Saved ${result.saved} rows to ${result.collection}`,
        );
      }
      return rows;
    },
  },
  form3: {
    description:
      "Scrape Form 3 initial-ownership snapshots for a single ticker (add --save to write to Firestore). Form 3 = baseline filed when someone first becomes an insider — gives Form 4 deltas an anchor.",
    run: async (args) => {
      const ticker = args.find((a) => !a.startsWith("--"));
      if (!ticker) {
        throw new Error("Usage: tsx src/scrape.ts form3 <TICKER> [--save]");
      }
      const holdings = await scrapeForm3ByTicker(ticker);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${holdings.length} initial-ownership rows to Firestore...`,
        );
        const result = await saveForm3Holdings(holdings);
        console.error(
          `[save] Saved ${result.saved} rows to ${result.collection}`,
        );
      }
      return holdings;
    },
  },
  "form3-feed": {
    description:
      "Scrape Form 3 initial-ownership snapshots across all companies for the last N days (default 7; add --save to write to Firestore). Use to spot newly-named insiders and freshly-disclosed 10%+ holders.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const holdings = await scrapeForm3LiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${holdings.length} initial-ownership rows to Firestore...`,
        );
        const result = await saveForm3Holdings(holdings);
        console.error(
          `[save] Saved ${result.saved} rows to ${result.collection}`,
        );
      }
      return holdings;
    },
  },
  form4: {
    description:
      "Scrape Form 4 open-market trades for a single ticker (add --save to write to Firestore)",
    run: async (args) => {
      const ticker = args.find((a) => !a.startsWith("--"));
      if (!ticker) {
        throw new Error("Usage: tsx src/scrape.ts form4 <TICKER> [--save]");
      }
      const trades = await scrapeForm4ByTicker(ticker);
      if (hasSaveFlag(args)) {
        console.error(`[save] Writing ${trades.length} trades to Firestore...`);
        const result = await saveInsiderTransactions(trades);
        console.error(
          `[save] Saved ${result.saved} trades to ${result.collection}`,
        );
      }
      return trades;
    },
  },
  "form4-feed": {
    description:
      "Scrape Form 4 trades across all companies for the last N days (default 2; add --save to write to Firestore)",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 2;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const trades = await scrapeForm4LiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(`[save] Writing ${trades.length} trades to Firestore...`);
        const result = await saveInsiderTransactions(trades);
        console.error(
          `[save] Saved ${result.saved} trades to ${result.collection}`,
        );
      }
      return trades;
    },
  },
  form144: {
    description:
      "Scrape Form 144 planned-sale notices for a single ticker (add --save to write to Firestore). Form 144 is filed BEFORE the actual sale — forward-looking signal.",
    run: async (args) => {
      const ticker = args.find((a) => !a.startsWith("--"));
      if (!ticker) {
        throw new Error("Usage: tsx src/scrape.ts form144 <TICKER> [--save]");
      }
      const filings = await scrapeForm144ByTicker(ticker);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} planned-sale lines to Firestore...`,
        );
        const result = await saveForm144Filings(filings);
        console.error(
          `[save] Saved ${result.saved} lines to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "form144-feed": {
    description:
      "Scrape Form 144 planned-sale notices across all companies for the last N days (default 7; add --save to write to Firestore)",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const filings = await scrapeForm144LiveFeed(days);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} planned-sale lines to Firestore...`,
        );
        const result = await saveForm144Filings(filings);
        console.error(
          `[save] Saved ${result.saved} lines to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "13f": {
    description:
      "Scrape latest 13F-HR for a single fund (alias like 'berkshire' or 10-digit CIK; add --save to write to Firestore)",
    run: async (args) => {
      const fund = args.find((a) => !a.startsWith("--"));
      if (!fund) {
        throw new Error(
          "Usage: tsx src/scrape.ts 13f <ALIAS_OR_CIK> [--save]\n" +
            "Run `tsx src/scrape.ts funds` to see available aliases.",
        );
      }
      const db = await getDbIfLive();
      const holdings = await scrape13FByFund(fund, { db });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${holdings.length} holdings to Firestore...`,
        );
        const result = await saveInstitutionalHoldings(holdings);
        console.error(
          `[save] Saved ${result.saved} holdings to ${result.collection}`,
        );
      }
      return holdings;
    },
  },
  "13f-feed": {
    description:
      "Scan EDGAR for recent 13F-HR filings across all funds (default 30 days, max 25 funds; add --save to write to Firestore)",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 30;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const db = await getDbIfLive();
      const holdings = await scrape13FLiveFeed({ db, days });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${holdings.length} holdings to Firestore...`,
        );
        const result = await saveInstitutionalHoldings(holdings);
        console.error(
          `[save] Saved ${result.saved} holdings to ${result.collection}`,
        );
      }
      return holdings;
    },
  },
  funds: {
    description: "List the tracked institutional managers and their aliases",
    run: async () => {
      return listTrackedFunds();
    },
  },
  senate: {
    description:
      "Scrape Senate eFD Periodic Transaction Reports (PTRs) for the last N days (default 7; add --save to write to Firestore, --max=N to cap PTRs processed for testing). Each PTR may contain multiple equity trades.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const maxFlag = args.find((a) => a.startsWith("--max="));
      const maxPtrs = maxFlag
        ? parseInt(maxFlag.slice("--max=".length), 10)
        : undefined;
      if (maxPtrs !== undefined && (Number.isNaN(maxPtrs) || maxPtrs < 1)) {
        throw new Error("--max=N must be a positive integer");
      }
      const trades = await scrapeSenateLiveFeed({
        lookbackDays: days,
        maxPtrs,
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${trades.length} congressional trades to Firestore...`,
        );
        const result = await saveCongressionalTrades(trades);
        console.error(
          `[save] Saved ${result.saved} trades to ${result.collection}`,
        );
      }
      return trades;
    },
  },
  "senate-ptr": {
    description:
      "Scrape ONE specific Senate PTR by ID — useful for testing the parser against a known filing. Usage: tsx src/scrape.ts senate-ptr <PTR_ID> [--save]",
    run: async (args) => {
      const ptrId = args.find((a) => !a.startsWith("--"));
      if (!ptrId) {
        throw new Error(
          "Usage: tsx src/scrape.ts senate-ptr <PTR_ID> [--save]\n" +
            "PTR_ID is the UUID-like string from a Senate eFD URL like efdsearch.senate.gov/search/view/ptr/<PTR_ID>/",
        );
      }
      const trades = await scrapeSenatePtrById(ptrId);
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${trades.length} congressional trades to Firestore...`,
        );
        const result = await saveCongressionalTrades(trades);
        console.error(
          `[save] Saved ${result.saved} trades to ${result.collection}`,
        );
      }
      return trades;
    },
  },
  form278: {
    description:
      "Scrape Senate eFD Form 278 (Annual Financial Disclosure) filings. Default: last N days (positional integer, default 30). For historical backfill: --start-date=YYYY-MM-DD --end-date=YYYY-MM-DD covers an explicit window. Captures filing metadata + URL to the actual report PDF/HTML — agents follow the URL to read asset / liability / income detail (PDF parsing for net-worth roll-up is v1.1). Add --save to write to Firestore.",
    run: async (args) => {
      const startFlag = args.find((a) => a.startsWith("--start-date="));
      const endFlag = args.find((a) => a.startsWith("--end-date="));
      const startDate = startFlag ? startFlag.slice("--start-date=".length) : undefined;
      const endDate = endFlag ? endFlag.slice("--end-date=".length) : undefined;
      if ((startDate && !endDate) || (endDate && !startDate)) {
        throw new Error(
          "--start-date and --end-date must be provided together (or omit both for lookback mode)",
        );
      }
      let filings;
      if (startDate && endDate) {
        filings = await scrapeSenateForm278({ startDate, endDate });
      } else {
        const positional = args.find((a) => !a.startsWith("--"));
        const days = positional ? parseInt(positional, 10) : 30;
        if (Number.isNaN(days) || days < 1) {
          throw new Error("Days must be a positive integer");
        }
        filings = await scrapeSenateForm278({ lookbackDays: days });
      }
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} Form 278 filings to Firestore...`,
        );
        const result = await saveForm278Filings(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "fec-candidates": {
    description:
      "Scrape FEC-registered candidates (House / Senate / President) from api.open.fec.gov. Default: all candidates active in cycles 2022 / 2024 / 2026. Optional: --cycle=YYYY (single cycle), --office=H|S|P, --state=AA, --active-only (filter to candidate_status=C). Add --save to write to fec_candidates Firestore collection. Requires FEC_API_KEY env var for >30 req/hr; falls back to DEMO_KEY otherwise.",
    run: async (args) => {
      const cycleFlag = args.find((a) => a.startsWith("--cycle="));
      const officeFlag = args.find((a) => a.startsWith("--office="));
      const stateFlag = args.find((a) => a.startsWith("--state="));
      const cycle = cycleFlag
        ? parseInt(cycleFlag.slice("--cycle=".length), 10)
        : undefined;
      const office = officeFlag ? officeFlag.slice("--office=".length) : undefined;
      const state = stateFlag ? stateFlag.slice("--state=".length) : undefined;
      const activeOnly = args.includes("--active-only");
      if (cycle !== undefined && (Number.isNaN(cycle) || cycle < 1976)) {
        throw new Error("--cycle must be a year >= 1976");
      }
      const candidates = await scrapeFecCandidates({
        ...(cycle !== undefined && { cycle }),
        ...(office !== undefined && { office }),
        ...(state !== undefined && { state }),
        activeOnly,
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${candidates.length} FEC candidates to Firestore...`,
        );
        const result = await saveFecCandidates(candidates);
        console.error(
          `[save] Saved ${result.saved} candidates to ${result.collection}`,
        );
      }
      return candidates;
    },
  },
  "fec-committees": {
    description:
      "Scrape FEC-registered committees (campaign committees, PACs, Super PACs, party committees) from api.open.fec.gov. Default: all committees active in cycles 2022 / 2024 / 2026. Optional: --cycle=YYYY, --committee-type=H|S|P|Q|N|O|X|Y|Z, --designation=P|A|B|D|J|U, --state=AA. Add --save to write to fec_committees Firestore collection. Requires FEC_API_KEY env var for >30 req/hr.",
    run: async (args) => {
      const cycleFlag = args.find((a) => a.startsWith("--cycle="));
      const typeFlag = args.find((a) => a.startsWith("--committee-type="));
      const desFlag = args.find((a) => a.startsWith("--designation="));
      const stateFlag = args.find((a) => a.startsWith("--state="));
      const cycle = cycleFlag
        ? parseInt(cycleFlag.slice("--cycle=".length), 10)
        : undefined;
      const committeeType = typeFlag
        ? typeFlag.slice("--committee-type=".length)
        : undefined;
      const designation = desFlag
        ? desFlag.slice("--designation=".length)
        : undefined;
      const state = stateFlag ? stateFlag.slice("--state=".length) : undefined;
      if (cycle !== undefined && (Number.isNaN(cycle) || cycle < 1976)) {
        throw new Error("--cycle must be a year >= 1976");
      }
      const committees = await scrapeFecCommittees({
        ...(cycle !== undefined && { cycle }),
        ...(committeeType !== undefined && { committeeType }),
        ...(designation !== undefined && { designation }),
        ...(state !== undefined && { state }),
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${committees.length} FEC committees to Firestore...`,
        );
        const result = await saveFecCommittees(committees);
        console.error(
          `[save] Saved ${result.saved} committees to ${result.collection}`,
        );
      }
      return committees;
    },
  },
  "federal-register": {
    description:
      "Scrape Federal Register documents (Rules / Proposed Rules / Notices / Presidential Documents) from federalregister.gov API. Default 3-day lookback. Optional <days> positional. Add --save to write to federal_register_documents Firestore collection.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 3;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const docs = await scrapeFederalRegister({ lookbackDays: days });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${docs.length} Federal Register documents to Firestore...`,
        );
        const result = await saveFederalRegisterDocuments(docs);
        console.error(
          `[save] Saved ${result.saved} documents to ${result.collection}`,
        );
      }
      return docs;
    },
  },
  "ofac-sdn": {
    description:
      "Download the OFAC Specially Designated Nationals (SDN) list (~19K records, 5.5MB CSV). Full-list refresh — no incremental option. Add --save to write to ofac_sdn Firestore collection. Idempotent on ent_num.",
    run: async (args) => {
      const entries = await scrapeOfacSdn();
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${entries.length} OFAC SDN entries to Firestore...`,
        );
        const result = await saveOfacSdn(entries);
        console.error(
          `[save] Saved ${result.saved} entries to ${result.collection}`,
        );
      }
      return entries;
    },
  },
  "reg-stmts": {
    description:
      "Scrape SEC registration statements (Form S-1, S-1/A, S-3, S-3/A) from EDGAR FTS. Default 2-day lookback. Optional: <days> for longer window. Add --save to write to registration_statements Firestore collection. v1A is metadata-only — agents follow primary_document_url for offering size + use of proceeds prose.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 2;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const filings = await scrapeRegistrationStatementsLiveFeed({
        lookbackDays: days,
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} registration statements to Firestore...`,
        );
        const result = await saveRegistrationStatements(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  nport: {
    description:
      "Scrape SEC Form N-PORT (mutual fund / ETF / closed-end fund monthly portfolio reports) from EDGAR FTS. Default: last 2 days. Optional: <days> positional for longer lookback. Add --save to write to nport_filings Firestore collection. v1A is metadata-only — per-holding portfolio detail lives at primary_document_url (XML extraction is v1.1).",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 2;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const filings = await scrapeNportLiveFeed({ lookbackDays: days });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} N-PORT filings to Firestore...`,
        );
        const result = await saveNportFilings(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "enforcement-actions": {
    description:
      "Scrape SEC press releases (RSS) + DOJ press releases (JSON API) into unified enforcement_actions collection. Optional: --doj-pages=N (default 10 = ~200 DOJ records), --skip-sec or --skip-doj. Add --save to write to Firestore. v1A is metadata + teaser only; agents follow url for full prose.",
    run: async (args) => {
      const dojPagesFlag = args.find((a) => a.startsWith("--doj-pages="));
      const dojMaxPages = dojPagesFlag
        ? parseInt(dojPagesFlag.slice("--doj-pages=".length), 10)
        : undefined;
      if (dojMaxPages !== undefined && (Number.isNaN(dojMaxPages) || dojMaxPages < 1)) {
        throw new Error("--doj-pages must be a positive integer");
      }
      const actions = await scrapeEnforcementActions({
        ...(dojMaxPages !== undefined && { dojMaxPages }),
        skipSec: args.includes("--skip-sec"),
        skipDoj: args.includes("--skip-doj"),
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${actions.length} enforcement actions to Firestore...`,
        );
        const result = await saveEnforcementActions(actions);
        console.error(
          `[save] Saved ${result.saved} actions to ${result.collection}`,
        );
      }
      return actions;
    },
  },
  "form-d": {
    description:
      "Scrape SEC Form D (Reg D private placement / exempt offering) filings from EDGAR. Default: last 2 days. Optional: <days> as first positional arg for a longer lookback (be aware ~150 filings/day). Add --save to write to private_placements Firestore collection. Pairs naturally with get_member_profile + congressional_trades for 'who's raising private capital' analysis.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 2;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const filings = await scrapeFormDLiveFeed({ lookbackDays: days });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${filings.length} Form D filings to Firestore...`,
        );
        const result = await savePrivatePlacements(filings);
        console.error(
          `[save] Saved ${result.saved} filings to ${result.collection}`,
        );
      }
      return filings;
    },
  },
  "finra-otc": {
    description:
      "Scrape FINRA OTC Transparency weekly summary for a specific week. Required: <YYYY-MM-DD> Monday week-start. Optional: --tier=T1|T2|OTCE (default all three), --summary-type=ATS_W_SMBL_FIRM|ATS_W_VOL_STATS|OTCE_W_SMBL_FIRM|OTCE_W_VOL_STATS (default ATS_W_SMBL_FIRM — the granular dark-pool detail). Add --save to write to otc_market_weekly Firestore collection. ~250K rows per fully-published week across all tiers.",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const week = positional[0];
      if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
        throw new Error(
          "Usage: tsx src/scrape.ts finra-otc <YYYY-MM-DD> [--tier=T1|T2|OTCE] [--summary-type=...] [--save]",
        );
      }
      const tierFlag = args.find((a) => a.startsWith("--tier="));
      const typeFlag = args.find((a) => a.startsWith("--summary-type="));
      const tiers = tierFlag
        ? [tierFlag.slice("--tier=".length).toUpperCase()]
        : undefined;
      const summaryTypeCode = typeFlag
        ? typeFlag.slice("--summary-type=".length)
        : undefined;
      const rows = await scrapeFinraOtcWeek({
        weekStartDate: week,
        ...(tiers && { tiers }),
        ...(summaryTypeCode && { summaryTypeCode }),
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${rows.length} OTC weekly rows to Firestore...`,
        );
        const result = await saveOtcMarketWeekly(rows);
        console.error(
          `[save] Saved ${result.saved} rows to ${result.collection}`,
        );
      }
      return rows;
    },
  },
  bills: {
    description:
      "Scrape congressional bills (and resolutions) from api.congress.gov for a specific Congress. Default: 119th. Optional: --type=hr|s|hjres|sjres|hconres|sconres|hres|sres for a single bill type (default: all 8 types). Add --save to write to bills Firestore collection. Requires api.data.gov key in CONGRESS_API_KEY or FEC_API_KEY env var.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const congress = positional ? parseInt(positional, 10) : 119;
      if (Number.isNaN(congress) || congress < 1 || congress > 999) {
        throw new Error("Congress must be a positive integer (e.g., 119)");
      }
      const typeFlag = args.find((a) => a.startsWith("--type="));
      const billTypes = typeFlag
        ? [typeFlag.slice("--type=".length).toLowerCase()]
        : undefined;
      const bills = await scrapeBills({
        congress,
        ...(billTypes && { billTypes }),
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${bills.length} bills to Firestore...`,
        );
        const result = await saveBills(bills);
        console.error(
          `[save] Saved ${result.saved} bills to ${result.collection}`,
        );
      }
      return bills;
    },
  },
  "roll-call-votes": {
    description:
      "Scrape congressional roll-call votes from api.congress.gov for a specific Congress. Default: 119th. Optional: --session=1|2 (default both), --chamber=house|senate (default both). v1A is metadata-only — per-member vote positions live at source_data_url. Add --save to write to roll_call_votes Firestore collection.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const congress = positional ? parseInt(positional, 10) : 119;
      if (Number.isNaN(congress) || congress < 1 || congress > 999) {
        throw new Error("Congress must be a positive integer (e.g., 119)");
      }
      const sessionFlag = args.find((a) => a.startsWith("--session="));
      const chamberFlag = args.find((a) => a.startsWith("--chamber="));
      const session = sessionFlag
        ? parseInt(sessionFlag.slice("--session=".length), 10)
        : undefined;
      const chamber = chamberFlag
        ? (chamberFlag.slice("--chamber=".length) as "house" | "senate")
        : undefined;
      if (chamber && chamber !== "house" && chamber !== "senate") {
        throw new Error("--chamber must be 'house' or 'senate'");
      }
      if (session !== undefined && (Number.isNaN(session) || session < 1 || session > 2)) {
        throw new Error("--session must be 1 or 2");
      }
      const votes = await scrapeRollCallVotes({
        congress,
        ...(session !== undefined && { session }),
        ...(chamber && { chamber }),
      });
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${votes.length} roll-call votes to Firestore...`,
        );
        const result = await saveRollCallVotes(votes);
        console.error(
          `[save] Saved ${result.saved} votes to ${result.collection}`,
        );
      }
      return votes;
    },
  },
  "tender-offers": {
    description:
      "Scrape SEC Schedule TO (tender offer) filings from EDGAR. Forms covered: SC TO-T (third-party offers), SC TO-I (issuer buybacks), and amendments. Default: last 30 days, all forms. Optional: <ticker> as first positional arg to filter by target company ticker. Add --save to write to tender_offers Firestore collection. Pairs naturally with 13D activist stake data for the 'stake → bid' M&A cross-source story.",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const first = positional[0];
      // If the first positional looks like a ticker (uppercase letters,
      // length 1-5), treat it as a target-ticker query; otherwise treat
      // it as a lookback-days integer.
      const isTicker = first && /^[A-Z][A-Z0-9.]{0,4}$/.test(first.toUpperCase());
      let offers;
      if (isTicker) {
        const daysArg = positional[1];
        const days = daysArg ? parseInt(daysArg, 10) : 365;
        if (Number.isNaN(days) || days < 1) {
          throw new Error("Days (second positional) must be a positive integer");
        }
        offers = await scrapeTenderOffersByTicker(first!, days);
      } else {
        const days = first ? parseInt(first, 10) : 30;
        if (Number.isNaN(days) || days < 1) {
          throw new Error("Days must be a positive integer");
        }
        offers = await scrapeTenderOffersLiveFeed(days);
      }
      if (hasSaveFlag(args)) {
        console.error(
          `[save] Writing ${offers.length} tender offers to Firestore...`,
        );
        const result = await saveTenderOffers(offers);
        console.error(
          `[save] Saved ${result.saved} offers to ${result.collection}`,
        );
      }
      return offers;
    },
  },
  "house-index": {
    description:
      "Fetch the House Clerk yearly XML index, filter to PTRs filed in the last N days (default 7), and return PTR metadata only — does NOT fetch or parse PDFs. Fast 'what was filed this week' query.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const { ptrs } = await scrapeHouseLiveFeed({
        lookbackDays: days,
        extractTrades: false,
      });
      return ptrs;
    },
  },
  "house-text": {
    description:
      "Fetch one House PTR PDF by DocID and dump the raw extracted text. Diagnostic for designing the parser. Usage: tsx src/scrape.ts house-text <DOC_ID> [year]",
    run: async (args) => {
      const positional = args.filter((a) => !a.startsWith("--"));
      const docId = positional[0];
      const yearArg = positional[1];
      if (!docId) {
        throw new Error(
          "Usage: tsx src/scrape.ts house-text <DOC_ID> [year]\n" +
            "DOC_ID is the numeric ID from a House PTR PDF URL like\n" +
            "  https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/<DOC_ID>.pdf",
        );
      }
      const year = yearArg ? parseInt(yearArg, 10) : undefined;
      const { ptr, text } = await dumpHousePtrText(docId, year);
      console.error(
        `[house-text] ${ptr.first} ${ptr.last} (${ptr.state_district}) — filed ${ptr.filing_date}`,
      );
      console.error(`[house-text] PDF: ${ptr.pdf_url}`);
      console.error(
        `[house-text] Extracted ${text.length} chars. Raw text follows:\n${"=".repeat(72)}`,
      );
      // Raw text goes to stdout so it can be redirected to a file for closer
      // inspection: `npx tsx src/scrape.ts house-text 12345 > ptr.txt`
      return text;
    },
  },
  house: {
    description:
      "Scrape House Clerk PTRs filed in the last N days (default 7). Without --extract: index-only mode, returns PTR metadata. With --extract: fetches each PDF and runs the parser (Phase 2 — currently returns empty trades arrays until parser is tuned). With --save: writes trades to Firestore. Optional --max=N to cap PTRs processed.",
    run: async (args) => {
      const positional = args.find((a) => !a.startsWith("--"));
      const days = positional ? parseInt(positional, 10) : 7;
      if (Number.isNaN(days) || days < 1) {
        throw new Error("Days must be a positive integer");
      }
      const maxFlag = args.find((a) => a.startsWith("--max="));
      const maxPtrs = maxFlag
        ? parseInt(maxFlag.slice("--max=".length), 10)
        : undefined;
      if (maxPtrs !== undefined && (Number.isNaN(maxPtrs) || maxPtrs < 1)) {
        throw new Error("--max=N must be a positive integer");
      }
      const extractTrades = args.includes("--extract");
      const { ptrs, trades } = await scrapeHouseLiveFeed({
        lookbackDays: days,
        maxPtrs,
        extractTrades,
      });
      if (hasSaveFlag(args)) {
        if (!extractTrades) {
          console.error(
            "[save] --save requires --extract (nothing to save in index-only mode). Skipping Firestore write.",
          );
        } else if (trades.length === 0) {
          console.error(
            "[save] 0 trades parsed — Phase 2 parser is still a stub. Skipping Firestore write.",
          );
        } else {
          console.error(
            `[save] Writing ${trades.length} congressional trades to Firestore...`,
          );
          const result = await saveCongressionalTrades(trades);
          console.error(
            `[save] Saved ${result.saved} trades to ${result.collection}`,
          );
        }
      }
      return { ptrs_count: ptrs.length, trades_count: trades.length, ptrs, trades };
    },
  },
  "test-normalize": {
    description:
      "Smoke-test the EDGAR name fallback against given issuer names. Shows normalized form and EDGAR match (if any). Usage: tsx src/scrape.ts test-normalize \"CYBERARK SOFTWARE LTD\" \"JOHNSON CTLS INTL PLC\" ...",
    run: async (args) => {
      const names = args.filter((a) => !a.startsWith("--"));
      if (names.length === 0) {
        // Default: run the canary set known to fail before the fixes
        names.push(
          "CYBERARK SOFTWARE LTD",
          "JOHNSON CTLS INTL PLC",
          "ACCENTURE PLC IRELAND",
          "COOPER COS INC",
          "HOLOGIC INC",
          "CONFLUENT INC",
          "AVIDITY BIOSCIENCES INC",
          "DAYFORCE INC",
          "JAMF HLDG CORP",
          "EXACT SCIENCES CORP",
          "DUN & BRADSTREET CORP DEL NE",
          "OASIS PETE INC NEW",
          "AMERICAN ELEC PWR CO INC",
        );
      }
      const out: Array<{
        input: string;
        normalized: string;
        edgar_ticker: string;
      }> = [];
      for (const name of names) {
        const normalized = normalizeName(name);
        const ticker = await lookupTickerByName(name);
        out.push({ input: name, normalized, edgar_ticker: ticker });
      }
      return out;
    },
  },
  "dump-edgar": {
    description:
      "Diagnostic: print stats and a sample of EDGAR's company_tickers.json contents to verify the catalog loaded correctly. No arguments.",
    run: async () => {
      return await dumpEdgar(20);
    },
  },
  "search-edgar": {
    description:
      "Diagnostic: search EDGAR's company_tickers.json for entries containing a substring. Use to investigate why test-normalize reports a MISS for a given company. Usage: tsx src/scrape.ts search-edgar HOLOGIC",
    run: async (args) => {
      const term = args.find((a) => !a.startsWith("--"));
      if (!term) {
        throw new Error(
          "Usage: tsx src/scrape.ts search-edgar <SUBSTRING>\n" +
            'Example: tsx src/scrape.ts search-edgar "HOLOGIC"',
        );
      }
      return await searchEdgar(term);
    },
  },
  "flush-cusip-cache": {
    description:
      "Delete all entries in the cusip_map Firestore cache so the next 13f run re-resolves them. Use after changing OpenFIGI selection logic or EDGAR name-fallback normalization.",
    run: async () => {
      const db = await getDbIfLive();
      if (!db) {
        throw new Error(
          "flush-cusip-cache requires LIVE mode (no service account at secrets/service-account.json)",
        );
      }
      const COLLECTION = "cusip_map";
      const collection = db.collection(COLLECTION);
      let deleted = 0;
      const BATCH_SIZE = 400;
      // Loop: read up to BATCH_SIZE docs, batch-delete, repeat until empty.
      // Avoids loading the whole collection into memory at once.
      for (;;) {
        const snap = await collection.limit(BATCH_SIZE).get();
        if (snap.empty) break;
        const batch = db.batch();
        for (const doc of snap.docs) batch.delete(doc.ref);
        await batch.commit();
        deleted += snap.size;
        console.error(`[flush] Deleted ${deleted} cusip_map entries so far...`);
      }
      console.error(`[flush] DONE — ${deleted} entries deleted from ${COLLECTION}`);
      return { collection: COLLECTION, deleted };
    },
  },
};

function printUsage(): void {
  console.error("Usage: tsx src/scrape.ts <command> [args...]");
  console.error("");
  console.error("Available commands:");
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.error(`  ${name.padEnd(14)} ${cmd.description}`);
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const result = await cmd.run(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("FATAL:", msg);
  process.exit(1);
});
