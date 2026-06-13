/**
 * SEC EDGAR XBRL Fundamentals scraper.
 *
 * Source: data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json
 *
 * One API call per company returns ALL tagged XBRL observations across
 * every 10-K + 10-Q the company has ever filed. We extract a curated
 * subset (~40 concepts) covering the standard income statement / balance
 * sheet / cash flow surface plus a few entity-level metrics.
 *
 * Architecture mirrors the other SEC scrapers (Form 4 / 144 / 3 / 8-K /
 * proxy): same EDGAR plumbing, same rate-limit (150ms = ~6 req/sec), same
 * User-Agent requirement.
 *
 * Output: one XbrlFundamental record per (cik, concept, period_end, form).
 * Idempotent — re-runs overwrite cleanly via merge:true.
 *
 * v1A scope: curated 40-concept watchlist. Full XBRL coverage (every
 * concept, every company) is v1.1.
 *
 * Pure-publisher posture: we surface values AS FILED. We do NOT compute
 * derived ratios (P/E, ROE, ROIC, etc.) or YoY/QoQ deltas — agents do
 * those calculations on top.
 */
import type { XbrlFundamental } from "../types.js";
import { preferPrimaryTicker } from "../sec-tickers.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  RATE_LIMIT_MS: 150,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

const formatAccession = (a: string): string => a.replace(/-/g, "");

// ─── Curated concept catalog ─────────────────────────────────────────────

/**
 * Each entry maps an XBRL tag to its category bucket. v1A watchlist covers
 * the standard fundamental analysis surface — income statement,
 * balance sheet, cash flow, and a few entity-level metrics.
 *
 * Categories:
 *   - income_statement: revenue, costs, profitability metrics
 *   - balance_sheet: assets, liabilities, equity (point-in-time)
 *   - cash_flow: operating / investing / financing cash flow components
 *   - metrics: per-share + ratio inputs (EPS, share counts)
 *   - entity: company-level info (shares outstanding, employee count)
 */
export const CONCEPT_CATALOG: Record<string, { category: string; taxonomy: string }> = {
  // ── Income statement ────────────────────────────────────────────────────
  Revenues: { category: "income_statement", taxonomy: "us-gaap" },
  RevenueFromContractWithCustomerExcludingAssessedTax: {
    category: "income_statement",
    taxonomy: "us-gaap",
  },
  CostOfRevenue: { category: "income_statement", taxonomy: "us-gaap" },
  CostOfGoodsAndServicesSold: { category: "income_statement", taxonomy: "us-gaap" },
  GrossProfit: { category: "income_statement", taxonomy: "us-gaap" },
  OperatingExpenses: { category: "income_statement", taxonomy: "us-gaap" },
  SellingGeneralAndAdministrativeExpense: {
    category: "income_statement",
    taxonomy: "us-gaap",
  },
  ResearchAndDevelopmentExpense: {
    category: "income_statement",
    taxonomy: "us-gaap",
  },
  OperatingIncomeLoss: { category: "income_statement", taxonomy: "us-gaap" },
  InterestExpense: { category: "income_statement", taxonomy: "us-gaap" },
  IncomeTaxExpenseBenefit: {
    category: "income_statement",
    taxonomy: "us-gaap",
  },
  NetIncomeLoss: { category: "income_statement", taxonomy: "us-gaap" },

  // ── Per-share metrics ───────────────────────────────────────────────────
  EarningsPerShareBasic: { category: "metrics", taxonomy: "us-gaap" },
  EarningsPerShareDiluted: { category: "metrics", taxonomy: "us-gaap" },
  WeightedAverageNumberOfSharesOutstandingBasic: {
    category: "metrics",
    taxonomy: "us-gaap",
  },
  WeightedAverageNumberOfDilutedSharesOutstanding: {
    category: "metrics",
    taxonomy: "us-gaap",
  },

  // ── Balance sheet ───────────────────────────────────────────────────────
  Assets: { category: "balance_sheet", taxonomy: "us-gaap" },
  AssetsCurrent: { category: "balance_sheet", taxonomy: "us-gaap" },
  CashAndCashEquivalentsAtCarryingValue: {
    category: "balance_sheet",
    taxonomy: "us-gaap",
  },
  AccountsReceivableNetCurrent: {
    category: "balance_sheet",
    taxonomy: "us-gaap",
  },
  InventoryNet: { category: "balance_sheet", taxonomy: "us-gaap" },
  PropertyPlantAndEquipmentNet: {
    category: "balance_sheet",
    taxonomy: "us-gaap",
  },
  Goodwill: { category: "balance_sheet", taxonomy: "us-gaap" },
  Liabilities: { category: "balance_sheet", taxonomy: "us-gaap" },
  LiabilitiesCurrent: { category: "balance_sheet", taxonomy: "us-gaap" },
  AccountsPayableCurrent: { category: "balance_sheet", taxonomy: "us-gaap" },
  LongTermDebt: { category: "balance_sheet", taxonomy: "us-gaap" },
  LongTermDebtNoncurrent: { category: "balance_sheet", taxonomy: "us-gaap" },
  StockholdersEquity: { category: "balance_sheet", taxonomy: "us-gaap" },
  CommonStockSharesOutstanding: {
    category: "balance_sheet",
    taxonomy: "us-gaap",
  },
  CommonStockSharesIssued: {
    category: "balance_sheet",
    taxonomy: "us-gaap",
  },

  // ── Cash flow ───────────────────────────────────────────────────────────
  NetCashProvidedByUsedInOperatingActivities: {
    category: "cash_flow",
    taxonomy: "us-gaap",
  },
  NetCashProvidedByUsedInInvestingActivities: {
    category: "cash_flow",
    taxonomy: "us-gaap",
  },
  NetCashProvidedByUsedInFinancingActivities: {
    category: "cash_flow",
    taxonomy: "us-gaap",
  },
  PaymentsToAcquirePropertyPlantAndEquipment: {
    category: "cash_flow",
    taxonomy: "us-gaap",
  },
  PaymentsForRepurchaseOfCommonStock: {
    category: "cash_flow",
    taxonomy: "us-gaap",
  },
  PaymentsOfDividends: { category: "cash_flow", taxonomy: "us-gaap" },
  DepreciationDepletionAndAmortization: {
    category: "cash_flow",
    taxonomy: "us-gaap",
  },

  // ── Entity-level (dei taxonomy) ─────────────────────────────────────────
  EntityCommonStockSharesOutstanding: { category: "entity", taxonomy: "dei" },
};

// ─── Ticker ↔ CIK lookup (same pattern as form8k.ts) ───────────────────────

interface TickerInfo {
  cik: string;
  cikRaw: string;
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;
let cikToTicker: Record<string, string> | null = null;
let cikToName: Record<string, string> | null = null;

async function loadCaches(): Promise<void> {
  if (tickerCache && cikToTicker && cikToName) return;
  const data = (await fetchJson(
    `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
  )) as Record<string, { ticker: string; cik_str: number; title: string }>;
  tickerCache = {};
  cikToTicker = {};
  cikToName = {};
  for (const entry of Object.values(data)) {
    const ticker = entry.ticker.toUpperCase();
    const cikPadded = String(entry.cik_str).padStart(10, "0");
    tickerCache[ticker] = {
      cik: cikPadded,
      cikRaw: String(entry.cik_str),
      name: entry.title,
    };
    // Reverse-lookup cache: prefer the primary common ticker per CIK (shared
    // helper; see sec-tickers). scrapeXbrlByCik's `tickerOverride` still wins
    // caller-side for the bulk loader — this fixes the live-feed/per-CIK path.
    cikToTicker[cikPadded] = preferPrimaryTicker(cikToTicker[cikPadded], ticker);
    cikToName[cikPadded] = entry.title;
  }
}

export async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
  await loadCaches();
  const upper = ticker.toUpperCase();
  // Direct lookup first.
  const direct = tickerCache![upper];
  if (direct) return direct;
  // SEC's company_tickers.json class-share convention is currently HYPHENS
  // (BRK.B → BRK-B; verified live 2026-06-10 — BRKB is no longer present),
  // historically dot-stripped (BRKB). Try hyphen first, then the legacy
  // strip, so a future flip-back can't silently break lookups.
  const hyphens = upper.replace(/[./]/g, "-");
  if (hyphens !== upper) {
    const fallback = tickerCache![hyphens];
    if (fallback) return fallback;
  }
  const noDots = upper.replace(/\./g, "");
  if (noDots !== upper) {
    const fallback = tickerCache![noDots];
    if (fallback) return fallback;
  }
  // Some tickers in 13F filings use slash for class (BRK/B); also try.
  const noSlashes = upper.replace(/\//g, "");
  if (noSlashes !== upper && noSlashes !== noDots) {
    const fallback = tickerCache![noSlashes];
    if (fallback) return fallback;
  }
  return null;
}

async function getTickerFromCik(cik: string): Promise<string> {
  if (!cik) return "";
  await loadCaches();
  const padded = cik.replace(/^0+/, "").padStart(10, "0");
  return cikToTicker![padded] ?? "";
}

async function getNameFromCik(cik: string): Promise<string> {
  if (!cik) return "";
  await loadCaches();
  const padded = cik.replace(/^0+/, "").padStart(10, "0");
  return cikToName![padded] ?? "";
}

// ─── companyfacts JSON shape ────────────────────────────────────────────────

interface RawObservation {
  end?: string;
  start?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

interface RawConcept {
  label?: string;
  description?: string;
  units?: Record<string, RawObservation[]>;
}

interface RawTaxonomy {
  [conceptName: string]: RawConcept;
}

interface CompanyFactsResponse {
  cik?: number;
  entityName?: string;
  facts?: {
    "us-gaap"?: RawTaxonomy;
    dei?: RawTaxonomy;
  };
}

// ─── Per-company scraper ────────────────────────────────────────────────────

interface BuildArgs {
  ticker: string;
  cikPadded: string;
  cikRaw: string;
  companyName: string;
  concept: string;
  conceptLabel: string;
  category: string;
  taxonomy: string;
  unit: string;
  obs: RawObservation;
}

function buildRecord(args: BuildArgs, scrapedAt: string): XbrlFundamental | null {
  const periodEnd = (args.obs.end ?? "").slice(0, 10);
  const form = (args.obs.form ?? "").trim();
  if (!periodEnd || !form) return null;

  const accession = (args.obs.accn ?? "").trim();
  const accessionNoSlash = formatAccession(accession);
  const archiveBase = accession
    ? `${CONFIG.EDGAR_URL}/Archives/edgar/data/${args.cikRaw}/${accessionNoSlash}`
    : "";

  // Firestore doc IDs can't contain "/". Form codes like "10-K/A" need
  // sanitization. Replace "/" with "_" so the ID is "10-K_A".
  const safeForm = form.replace(/\//g, "_");
  // period_start distinguishes cumulative-YTD vs per-quarter observations
  // of the same concept on the same form. Both have the same period_end
  // (e.g., 2024-09-30) so without period_start in the ID they collide.
  // Real example: AAPL Revenues 2017-09-30 10-K has TWO observations —
  // FY2017 cumulative ($229B, start=2016-09-25) and Q4 standalone
  // ($52B, start=2017-07-02). Without including start, one overwrites
  // the other and agents can't tell which they're getting.
  // Balance-sheet concepts have no period_start (point-in-time) — use
  // "pit" sentinel so the ID stays well-formed and stable.
  const periodStartPart = args.obs.start ? args.obs.start.slice(0, 10) : "pit";
  return {
    id: `${args.cikPadded}-${args.concept}-${periodEnd}-${safeForm}-${periodStartPart}`,
    ticker: args.ticker,
    company_name: args.companyName,
    company_cik: args.cikPadded,
    concept_taxonomy: args.taxonomy,
    concept: args.concept,
    concept_label: args.conceptLabel,
    category: args.category,
    period_end: periodEnd,
    period_start: args.obs.start ? args.obs.start.slice(0, 10) : null,
    fiscal_year: args.obs.fy ?? 0,
    fiscal_period: args.obs.fp ?? "",
    form,
    filed_date: (args.obs.filed ?? "").slice(0, 10),
    accession_number: accession,
    value: args.obs.val ?? 0,
    unit: args.unit,
    frame: args.obs.frame ?? "",
    sec_source_url: archiveBase,
    scraped_at: scrapedAt,
  };
}

/**
 * Pull every observation of every curated concept for one CIK. Returns
 * a flat list — typically 1500-3000 records per company across all
 * concepts × all units × all periods.
 *
 * Optional `tickerOverride` — when set, uses the caller-supplied ticker
 * on every record rather than reverse-looking-up from CIK. Used by
 * `scrapeXbrlByTicker` to preserve the original input ticker (avoids
 * the preferred-share-class reverse-lookup ambiguity, e.g., JPM CIK
 * 19617 having multiple ticker entries including "JPM-PM" preferred).
 */
export async function scrapeXbrlByCik(
  cikPadded: string,
  tickerOverride?: string,
): Promise<XbrlFundamental[]> {
  const scrapedAt = new Date().toISOString();
  const padded = cikPadded.replace(/^0+/, "").padStart(10, "0");
  const url = `${CONFIG.BASE_URL}/api/xbrl/companyfacts/CIK${padded}.json`;

  console.error(`[xbrl] Fetching company facts for CIK ${padded}...`);
  const data = (await fetchJson(url)) as CompanyFactsResponse;
  const cikRaw = String(data.cik ?? "").replace(/^0+/, "") || padded.replace(/^0+/, "");

  const ticker = tickerOverride ?? (await getTickerFromCik(padded));
  const companyName = data.entityName ?? (await getNameFromCik(padded));

  // Dedup by doc id. SEC's company-facts repeats each annual/quarterly value
  // once per filing that reported it: the ORIGINAL 10-K (where the period was
  // the CURRENT year) plus later 10-Ks that carry it as a prior-year
  // COMPARATIVE. Every copy carries the FILING's fiscal-year focus in `fy`, so
  // a comparative's `fy` is a LATER year than the period actually describes.
  // Last-write-wins (SEC orders units ~filed-ascending) therefore tagged each
  // period with the most-recent filing's year — e.g. NVDA's FY2024 figure
  // (period_end 2024-01-28) surfaced as fiscal_year 2026.
  //
  // Fix: keep the LATEST-filed copy's value/frame/etc. UNCHANGED (the value is
  // source-faithful — and for restated/split-adjusted figures the latest
  // re-presentation is what agents expect; we deliberately do NOT reopen the
  // as-reported-vs-restated question), but TAKE fiscal_year from the EARLIEST-
  // filed copy, whose `fy` is the period's TRUE fiscal-year label (authoritative
  // — handles non-Dec / 52-53-week fiscal years a period_end heuristic gets
  // wrong). `frame` is period-canonical: keep any non-empty one.
  interface Agg {
    latest: XbrlFundamental;
    latestFiled: string;
    trueFy: number;
    earliestFiled: string;
    frame: string;
  }
  const agg = new Map<string, Agg>();

  for (const [conceptName, spec] of Object.entries(CONCEPT_CATALOG)) {
    const taxonomy = spec.taxonomy as "us-gaap" | "dei";
    const conceptData = data.facts?.[taxonomy]?.[conceptName];
    if (!conceptData) continue;
    const label = conceptData.label ?? conceptName;
    for (const [unit, observations] of Object.entries(conceptData.units ?? {})) {
      for (const obs of observations) {
        const rec = buildRecord(
          {
            ticker,
            cikPadded: padded,
            cikRaw,
            companyName,
            concept: conceptName,
            conceptLabel: label,
            category: spec.category,
            taxonomy,
            unit,
            obs,
          },
          scrapedAt,
        );
        if (!rec) continue;
        const prev = agg.get(rec.id);
        if (!prev) {
          agg.set(rec.id, {
            latest: rec,
            latestFiled: rec.filed_date,
            trueFy: rec.fiscal_year,
            earliestFiled: rec.filed_date,
            frame: rec.frame,
          });
          continue;
        }
        // Newest filing wins the row's value/frame/etc.
        if (rec.filed_date && rec.filed_date >= prev.latestFiled) {
          prev.latest = rec;
          prev.latestFiled = rec.filed_date;
        }
        // Earliest filing gives the period's true fiscal year.
        if (
          rec.filed_date &&
          (!prev.earliestFiled || rec.filed_date < prev.earliestFiled)
        ) {
          prev.trueFy = rec.fiscal_year;
          prev.earliestFiled = rec.filed_date;
        }
        if (!prev.frame && rec.frame) prev.frame = rec.frame;
      }
    }
  }

  const out = [...agg.values()].map((a) => ({
    ...a.latest,
    fiscal_year: a.trueFy,
    frame: a.latest.frame || a.frame,
  }));
  console.error(
    `[xbrl] CIK ${padded} (${ticker || "n/a"}): ${out.length} observations across ${Object.keys(CONCEPT_CATALOG).length} concepts`,
  );
  return out;
}

/**
 * Convenience wrapper: resolve ticker -> CIK then call scrapeXbrlByCik
 * with the original input ticker as the override. Ensures records get
 * stored with the agent's expected ticker rather than whatever the SEC
 * reverse-lookup returned (which can be a preferred-share series).
 */
export async function scrapeXbrlByTicker(
  ticker: string,
): Promise<XbrlFundamental[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  return scrapeXbrlByCik(info.cik, ticker.toUpperCase());
}

/**
 * Bulk scraper: iterate a list of tickers and concatenate. Skips on per-
 * company errors with a log warning rather than failing the whole batch.
 * Suitable for small batches (≤20 tickers). For the full universe use
 * `scrapeAndSaveXbrlStreaming` instead — it saves per-company instead of
 * holding all records in memory.
 */
export async function scrapeXbrlForTickers(
  tickers: string[],
): Promise<XbrlFundamental[]> {
  const out: XbrlFundamental[] = [];
  for (const t of tickers) {
    try {
      const recs = await scrapeXbrlByTicker(t);
      out.push(...recs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[xbrl] ${t}: SKIP — ${msg}`);
    }
  }
  console.error(
    `[xbrl] BATCH TOTAL: ${out.length} observations across ${tickers.length} tickers`,
  );
  return out;
}

/**
 * Streaming bulk scraper for large universes. Calls the provided saver
 * callback per-company instead of accumulating in memory. Returns
 * summary stats. Use for S&P 500 / Russell 1000 backfills.
 *
 * The saver is typically `saveXbrlFundamentals` from firestore.ts.
 * Per-company saving means peak memory is ~10K records (one company)
 * instead of ~700K records (full universe).
 *
 * Errors on individual companies are logged + skipped — the batch
 * continues. Returns at the end with counts of successes / failures.
 */
export async function scrapeAndSaveXbrlStreaming(
  tickers: ReadonlyArray<string>,
  saver: (
    records: XbrlFundamental[],
  ) => Promise<{ saved: number; collection: string }>,
): Promise<{
  tickers_processed: number;
  tickers_skipped: number;
  total_observations: number;
  total_saved: number;
  skipped_tickers: string[];
}> {
  let processed = 0;
  let skipped = 0;
  let totalObs = 0;
  let totalSaved = 0;
  const skippedTickers: string[] = [];

  console.error(
    `[xbrl-stream] Starting streaming backfill for ${tickers.length} tickers...`,
  );

  for (const t of tickers) {
    try {
      const recs = await scrapeXbrlByTicker(t);
      if (recs.length === 0) {
        console.error(`[xbrl-stream] ${t}: no observations`);
        skipped++;
        skippedTickers.push(t);
        continue;
      }
      const r = await saver(recs);
      console.error(
        `[xbrl-stream] ${t}: scraped ${recs.length}, saved ${r.saved} ` +
          `(running ${processed + 1}/${tickers.length} tickers, ${totalSaved + r.saved} obs)`,
      );
      processed++;
      totalObs += recs.length;
      totalSaved += r.saved;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[xbrl-stream] ${t}: SKIP — ${msg}`);
      skipped++;
      skippedTickers.push(t);
    }
  }

  console.error(
    `[xbrl-stream] DONE — ${processed} ok / ${skipped} skipped, ` +
      `${totalObs} obs scraped, ${totalSaved} obs saved`,
  );

  return {
    tickers_processed: processed,
    tickers_skipped: skipped,
    total_observations: totalObs,
    total_saved: totalSaved,
    skipped_tickers: skippedTickers,
  };
}
