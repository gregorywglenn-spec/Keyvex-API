/**
 * Cron freshness + collection-age audit for every scheduled scraper.
 *
 * For each scraper, reads /meta/{jobName}.lastSyncedAt and the max date
 * from its target collection. Flags scrapers whose:
 *   - meta sync timestamp is older than cadence × ~2 (cron missed)
 *   - collection max-date is much older than cadence (silent failure)
 *
 * Run: npx tsx scripts/audit-scraper-health.ts
 */
import { getLiveDb } from "../src/firestore.js";

type ScraperRow = [
  jobName: string,
  collection: string,
  dateField: string | null,
  cadence: string,
  maxStaleDays: number,
  notes: string,
];

const SCRAPERS: ScraperRow[] = [
  ["form4LiveFeedSync",       "insider_trades",                  "filing_date",         "30 min",   1,   "Form 4"],
  ["form5LiveFeedSync",       "insider_trades",                  "filing_date",         "daily",    2,   "Form 5"],
  ["form144LiveFeedSync",     "planned_insider_sales",           "filing_date",         "hourly",   1,   "Form 144"],
  ["form3LiveFeedSync",       "initial_ownership_baselines",     "filing_date",         "hourly",   1,   "Form 3"],
  ["activistLiveFeedSync",    "activist_ownership",              "filing_date",         "hourly",   1,   "13D/13G"],
  ["form13fLiveFeedSync",     "institutional_holdings",          "filing_date",         "4 hr",     14,  "13F"],
  ["materialEventsLiveFeedSync", "material_events",              "filing_date",         "hourly",   1,   "8-K"],
  ["proxyFilingsSync",        "proxy_filings",                   "filing_date",         "daily",    2,   "DEF 14A"],
  ["registrationStmtsSync",   "registration_statements",         "filing_date",         "daily",    2,   "S-1 / S-3"],
  ["privatePlacementsSync",   "private_placements",              "file_date",           "daily",    2,   "Form D"],
  ["tenderOffersSync",        "tender_offers",                   "filing_date",         "daily",    2,   "Schedule TO"],
  ["nportFilingsSync",        "nport_filings",                   "file_date",           "daily",    2,   "N-PORT metadata"],
  ["federalContractsSync",    "federal_contracts",               "last_modified_date",  "daily",    2,   "USAspending contracts"],
  ["federalGrantsSync",       "federal_grants",                  "last_modified_date",  "daily",    2,   "USAspending grants"],
  ["senatePtrSync",           "congressional_trades",            "disclosure_date",     "daily",    3,   "Senate eFD"],
  ["housePtrSync",            "congressional_trades",            "disclosure_date",     "daily",    7,   "House Clerk"],
  ["ldaDailySync",            "lobbying_filings",                "dt_posted",           "daily",    3,   "LDA"],
  ["bioguideWeeklySync",      "legislators",                     null,                  "weekly",   14,  "Catalog"],
  ["form278WeeklySync",       "annual_financial_disclosures",    "filing_date",         "weekly",   30,  "Form 278"],
  ["fecScheduleADailySync",   "fec_contributions",               "contribution_receipt_date", "daily", 7, "FEC Sched A"],
  ["fecScheduleEDailySync",   "fec_independent_expenditures",    "expenditure_date",    "daily",    7,   "FEC Sched E"],
  ["fecCandidatesWeeklySync", "fec_candidates",                  null,                  "weekly",   14,  "FEC candidates"],
  ["fecCommitteesWeeklySync", "fec_committees",                  null,                  "weekly",   14,  "FEC committees"],
  ["secFtdSync",              "sec_fails_to_deliver",            "settlement_date",     "semi-monthly", 30, "SEC FTD"],
  ["cftcCotSync",             "cftc_cot_reports",                "report_date",         "weekly",   10,  "CFTC COT"],
  ["enforcementDailySync",    "enforcement_actions",             "published_date",      "daily",    3,   "SEC/DOJ/CFTC/OCC/FDIC/FTC"],
  ["congressLegislationSync", "bills",                           "latest_action_date",  "daily",    3,   "Bills"],
  ["federalRegisterDaily",    "federal_register_documents",      "publication_date",    "daily",    3,   "Federal Register"],
  ["ofacSdnDailySync",        "ofac_sdn",                        null,                  "daily",    3,   "OFAC SDN"],
  ["fdaRecallsSync",          "product_recalls",                 "recall_initiation_date", "daily", 7,   "FDA recalls"],
  ["cpscRecallsSync",         "product_recalls",                 "recall_initiation_date", "daily", 7,   "CPSC recalls"],
  ["consumerComplaintsSync",  "consumer_complaints",             "date_received",       "daily",    3,   "CFPB"],
  ["xbrlSync",                "xbrl_fundamentals",               "filed_date",          "weekly",   14,  "XBRL fundamentals"],
  ["blsDailySync",            "economic_indicators",             null,                  "daily",    7,   "BLS"],
  ["fredDailySync",           "economic_indicators",             null,                  "daily",    7,   "FRED"],
  ["eiaDailySync",            "economic_indicators",             null,                  "daily",    7,   "EIA"],
  ["treasuryAuctionsDaily",   "treasury_auctions",               "auction_date",        "daily",    7,   "Treasury auctions"],
  ["govInfoDaily",            "gov_documents",                   "date_issued",         "daily",    7,   "GovInfo"],
  ["oigExclusionsMonthly",    "oig_exclusions",                  null,                  "monthly",  35,  "HHS OIG"],
  ["faraWeeklySync",          "foreign_agents",                  "registration_date",   "weekly",   14,  "FARA"],
  ["cslDailySync",            "screening_list",                  null,                  "daily",    3,   "CSL"],
  ["finraOtcWeeklySync",      "otc_market_weekly",               "week_start_date",     "weekly",   14,  "FINRA OTC"],
];

async function main() {
  const db = await getLiveDb();
  const todayMs = Date.now();
  console.log(`Today: ${new Date(todayMs).toISOString().slice(0, 16)}\n`);

  const issues: string[] = [];
  const lines: Array<{ severity: number; line: string }> = [];

  for (const [jobName, coll, dateField, cadence, maxStaleDays] of SCRAPERS) {
    let metaAgeDays: number | null = null;

    try {
      const metaDoc = await db.doc(`meta/${jobName}`).get();
      if (metaDoc.exists) {
        const d = metaDoc.data() as Record<string, unknown>;
        const ts = d.lastSyncedAt as { _seconds?: number; toMillis?: () => number } | string | undefined;
        let ms: number | null = null;
        if (ts && typeof ts === "object" && typeof (ts as { toMillis?: () => number }).toMillis === "function") {
          ms = (ts as { toMillis: () => number }).toMillis();
        } else if (ts && typeof ts === "object" && typeof (ts as { _seconds?: number })._seconds === "number") {
          ms = (ts as { _seconds: number })._seconds * 1000;
        } else if (typeof ts === "string") {
          ms = new Date(ts).getTime();
        }
        if (ms !== null && !isNaN(ms)) {
          metaAgeDays = Math.round(((todayMs - ms) / 86400000) * 10) / 10;
        }
      }
    } catch {
      /* skip */
    }

    let collMaxDate = "?";
    let collMaxAgeDays: number | null = null;
    if (dateField) {
      try {
        const snap = await db.collection(coll).orderBy(dateField, "desc").limit(1).get();
        if (!snap.empty) {
          const d = snap.docs[0]!.data() as Record<string, unknown>;
          const v = String(d[dateField] ?? "").slice(0, 10);
          collMaxDate = v;
          if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            collMaxAgeDays = Math.round((todayMs - new Date(v).getTime()) / 86400000);
          }
        }
      } catch {
        /* index missing for some sort fields — skip */
      }
    }

    let severity = 0;
    let flag = "OK  ";
    if (metaAgeDays !== null && metaAgeDays > maxStaleDays) {
      severity = 2;
      flag = "!!!! ";
      issues.push(`${jobName}: meta lastSyncedAt is ${metaAgeDays}d old (max ${maxStaleDays}d)`);
    } else if (metaAgeDays === null) {
      // No meta data — could be a never-run scraper OR a recently-added one
      severity = 1;
      flag = "?   ";
    } else if (collMaxAgeDays !== null && collMaxAgeDays > maxStaleDays + 7) {
      severity = 1;
      flag = "*   ";
      issues.push(
        `${jobName}: ${coll}.${dateField} max-date is ${collMaxAgeDays}d old (cadence ${cadence})`,
      );
    }

    const metaStr = metaAgeDays === null ? "no meta" : `${metaAgeDays}d ago`;
    const collStr =
      collMaxAgeDays === null ? "n/a" : `${collMaxAgeDays}d ago (${collMaxDate})`;
    lines.push({
      severity,
      line: `  ${flag}  ${jobName.padEnd(28)}  cadence=${cadence.padEnd(13)}  meta=${metaStr.padEnd(14)}  maxDate=${collStr}`,
    });
  }

  lines.sort((a, b) => b.severity - a.severity);
  for (const l of lines) console.log(l.line);

  console.log("");
  console.log(`=== ISSUES (${issues.length}) ===`);
  if (issues.length === 0) {
    console.log("  (none — all crons are within their expected staleness window)");
  } else {
    for (const i of issues) console.log(`  - ${i}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
