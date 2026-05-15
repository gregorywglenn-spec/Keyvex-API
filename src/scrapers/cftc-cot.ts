/**
 * CFTC Commitments of Traders (COT) scraper.
 *
 * The COT report is the CFTC's free, public weekly disclosure of aggregated
 * futures + options-on-futures positioning across every regulated U.S.
 * commodity, financial, FX, and crypto contract. Released every Friday at
 * 3:30 PM ET, covering the prior Tuesday's close.
 *
 * Three trader classes (legacy "futures-only" report shape):
 *   - Non-commercial (large speculators — hedge funds, CTAs, money managers)
 *   - Commercial (hedgers — producers, merchants, swap dealers)
 *   - Non-reportable (small speculators below the reporting threshold)
 *
 * Signal value: positioning extremes (e.g., "commercials net-short to a
 * multi-year extreme") have historically led major turning points in
 * commodities, treasuries, and currencies. The COT is THE positioning
 * dataset for macro futures analysis.
 *
 * Source: Socrata API at publicreporting.cftc.gov/resource/jun7-fc8e.json
 * (legacy futures-only). Free, unauthenticated, JSON in/out. The
 * disaggregated report (72hh-3qpy) breaks commercials further into
 * producer_merchant / swap_dealer / managed_money / other_reportables —
 * v1.1 polish. v1A uses the legacy 3-class breakdown for broadest
 * comparability with historical analysis.
 */

import type { CftcCotReport } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.KEYVEX_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://publicreporting.cftc.gov/resource/jun7-fc8e.json",
  /** 200ms = 5 req/sec — Socrata is generous, no documented limit. */
  RATE_LIMIT_MS: 200,
  /** Per-page cap on Socrata is 50K. We use 5K to keep batches manageable. */
  PAGE_SIZE: 5000,
  /** Default lookback in weeks. 12 weeks ≈ 3 months of weekly reports. */
  DEFAULT_LOOKBACK_WEEKS: 12,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Raw API shape ──────────────────────────────────────────────────────────

interface RawCotRow {
  id?: string;
  market_and_exchange_names?: string;
  report_date_as_yyyy_mm_dd?: string;
  yyyy_report_week_ww?: string;
  contract_market_name?: string;
  cftc_contract_market_code?: string;
  cftc_market_code?: string;
  cftc_region_code?: string;
  cftc_commodity_code?: string;
  commodity_name?: string;
  open_interest_all?: string | number;
  noncomm_positions_long_all?: string | number;
  noncomm_positions_short_all?: string | number;
  noncomm_postions_spread_all?: string | number; // CFTC typo in field name
  comm_positions_long_all?: string | number;
  comm_positions_short_all?: string | number;
  tot_rept_positions_long_all?: string | number;
  tot_rept_positions_short?: string | number;
  nonrept_positions_long_all?: string | number;
  nonrept_positions_short_all?: string | number;
  change_in_open_interest_all?: string | number;
  change_in_noncomm_long_all?: string | number;
  change_in_noncomm_short_all?: string | number;
  change_in_noncomm_spead_all?: string | number; // CFTC typo
  change_in_comm_long_all?: string | number;
  change_in_comm_short_all?: string | number;
  change_in_nonrept_long_all?: string | number;
  change_in_nonrept_short_all?: string | number;
  pct_of_open_interest_all?: string | number;
  pct_of_oi_noncomm_long_all?: string | number;
  pct_of_oi_noncomm_short_all?: string | number;
  pct_of_oi_comm_long_all?: string | number;
  pct_of_oi_comm_short_all?: string | number;
  pct_of_oi_nonrept_long_all?: string | number;
  pct_of_oi_nonrept_short_all?: string | number;
  traders_tot_all?: string | number;
  traders_noncomm_long_all?: string | number;
  traders_noncomm_short_all?: string | number;
  traders_comm_long_all?: string | number;
  traders_comm_short_all?: string | number;
  conc_gross_le_4_tdr_long?: string | number;
  conc_gross_le_4_tdr_short?: string | number;
  conc_gross_le_8_tdr_long?: string | number;
  conc_gross_le_8_tdr_short?: string | number;
  conc_net_le_4_tdr_long_all?: string | number;
  conc_net_le_4_tdr_short_all?: string | number;
  conc_net_le_8_tdr_long_all?: string | number;
  conc_net_le_8_tdr_short_all?: string | number;
}

// ─── Normalizer ─────────────────────────────────────────────────────────────

function toNum(v: string | number | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function normalize(
  raw: RawCotRow,
  scrapedAt: string,
): CftcCotReport | null {
  const code = raw.cftc_contract_market_code?.trim();
  const date = raw.report_date_as_yyyy_mm_dd;
  if (!code || !date) return null;
  // ISO date — strip the timestamp portion.
  const isoDate = date.slice(0, 10);
  const docId = `${code}-${isoDate}`;
  const ncLong = toNum(raw.noncomm_positions_long_all);
  const ncShort = toNum(raw.noncomm_positions_short_all);
  const cLong = toNum(raw.comm_positions_long_all);
  const cShort = toNum(raw.comm_positions_short_all);
  const nrLong = toNum(raw.nonrept_positions_long_all);
  const nrShort = toNum(raw.nonrept_positions_short_all);
  return {
    id: docId,
    cftc_contract_market_code: code,
    contract_market_name: (raw.contract_market_name ?? "").trim(),
    market_and_exchange_names: (raw.market_and_exchange_names ?? "").trim(),
    commodity_name: (raw.commodity_name ?? "").trim(),
    commodity_code: (raw.cftc_commodity_code ?? "").trim(),
    market_code: (raw.cftc_market_code ?? "").trim(),
    region_code: (raw.cftc_region_code ?? "").trim(),
    report_date: isoDate,
    report_week: raw.yyyy_report_week_ww ?? "",
    open_interest: toNum(raw.open_interest_all),
    // Non-commercial (large speculators)
    noncomm_long: ncLong,
    noncomm_short: ncShort,
    noncomm_net: ncLong - ncShort,
    noncomm_spread: toNum(raw.noncomm_postions_spread_all),
    // Commercial (hedgers)
    comm_long: cLong,
    comm_short: cShort,
    comm_net: cLong - cShort,
    // Non-reportable (small speculators)
    nonrept_long: nrLong,
    nonrept_short: nrShort,
    nonrept_net: nrLong - nrShort,
    // Week-over-week changes
    change_open_interest: toNum(raw.change_in_open_interest_all),
    change_noncomm_long: toNum(raw.change_in_noncomm_long_all),
    change_noncomm_short: toNum(raw.change_in_noncomm_short_all),
    change_comm_long: toNum(raw.change_in_comm_long_all),
    change_comm_short: toNum(raw.change_in_comm_short_all),
    change_nonrept_long: toNum(raw.change_in_nonrept_long_all),
    change_nonrept_short: toNum(raw.change_in_nonrept_short_all),
    // Percent of open interest
    pct_noncomm_long: toNum(raw.pct_of_oi_noncomm_long_all),
    pct_noncomm_short: toNum(raw.pct_of_oi_noncomm_short_all),
    pct_comm_long: toNum(raw.pct_of_oi_comm_long_all),
    pct_comm_short: toNum(raw.pct_of_oi_comm_short_all),
    pct_nonrept_long: toNum(raw.pct_of_oi_nonrept_long_all),
    pct_nonrept_short: toNum(raw.pct_of_oi_nonrept_short_all),
    // Trader counts
    traders_total: toNum(raw.traders_tot_all),
    traders_noncomm_long: toNum(raw.traders_noncomm_long_all),
    traders_noncomm_short: toNum(raw.traders_noncomm_short_all),
    traders_comm_long: toNum(raw.traders_comm_long_all),
    traders_comm_short: toNum(raw.traders_comm_short_all),
    // Concentration ratios (top 4 / top 8 net)
    conc_net_le_4_long: toNum(raw.conc_net_le_4_tdr_long_all),
    conc_net_le_4_short: toNum(raw.conc_net_le_4_tdr_short_all),
    conc_net_le_8_long: toNum(raw.conc_net_le_8_tdr_long_all),
    conc_net_le_8_short: toNum(raw.conc_net_le_8_tdr_short_all),
    source_url: `https://www.cftc.gov/dea/futures/deacmesf.htm`,
    scraped_at: scrapedAt,
  };
}

// ─── Public scraper ─────────────────────────────────────────────────────────

export interface ScrapeCftcCotOptions {
  /** Lookback in weeks. Default 12 (≈ 3 months of weekly reports). */
  lookbackWeeks?: number;
  /** Specific contract_market_code filter (e.g., "13874A" for S&P 500). */
  contractCode?: string;
  /** Substring filter on commodity_name. */
  commodityName?: string;
  /** Max pages of PAGE_SIZE each. Default 10 (= 50K rows). */
  maxPages?: number;
}

export async function scrapeCftcCot(
  options: ScrapeCftcCotOptions = {},
): Promise<CftcCotReport[]> {
  const scrapedAt = new Date().toISOString();
  const lookbackWeeks =
    options.lookbackWeeks ?? CONFIG.DEFAULT_LOOKBACK_WEEKS;
  const maxPages = options.maxPages ?? 10;

  // Build a date floor: today minus lookback*7 days, formatted YYYY-MM-DD.
  const sinceDate = new Date();
  sinceDate.setUTCDate(sinceDate.getUTCDate() - lookbackWeeks * 7);
  const sinceIso = sinceDate.toISOString().slice(0, 10);

  console.error(
    `[cftc-cot] Scraping COT reports since ${sinceIso}${
      options.contractCode ? ` contract=${options.contractCode}` : ""
    }${options.commodityName ? ` commodity~${options.commodityName}` : ""}`,
  );

  const whereParts = [`report_date_as_yyyy_mm_dd > '${sinceIso}'`];
  if (options.contractCode) {
    whereParts.push(
      `cftc_contract_market_code='${options.contractCode.replace(/'/g, "''")}'`,
    );
  }
  if (options.commodityName) {
    whereParts.push(
      `upper(commodity_name) like '%${options.commodityName.toUpperCase().replace(/'/g, "''")}%'`,
    );
  }
  const whereClause = whereParts.join(" AND ");

  const all: CftcCotReport[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(CONFIG.BASE_URL);
    url.searchParams.set("$where", whereClause);
    url.searchParams.set("$limit", String(CONFIG.PAGE_SIZE));
    url.searchParams.set("$offset", String(offset));
    url.searchParams.set("$order", "report_date_as_yyyy_mm_dd DESC");

    await sleep(CONFIG.RATE_LIMIT_MS);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cftc-cot]   page ${page + 1}: network error — ${msg}`);
      break;
    }
    if (!res.ok) {
      throw new Error(
        `CFTC Socrata HTTP ${res.status} ${res.statusText} on offset ${offset}`,
      );
    }
    const rows = (await res.json()) as RawCotRow[];
    const normalized = rows
      .map((r) => normalize(r, scrapedAt))
      .filter((x): x is CftcCotReport => x !== null);
    all.push(...normalized);
    console.error(
      `[cftc-cot]   page ${page + 1}: ${rows.length} rows (running ${all.length})`,
    );
    if (rows.length < CONFIG.PAGE_SIZE) break;
    offset += CONFIG.PAGE_SIZE;
  }

  console.error(`[cftc-cot] TOTAL: ${all.length} COT report rows`);
  return all;
}
