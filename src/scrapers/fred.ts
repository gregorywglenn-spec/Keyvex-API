/**
 * FRED economic-indicators scraper.
 *
 * Source: api.stlouisfed.org/fred/series/observations (V1 API)
 *
 * Auth REQUIRED: register at https://fredaccount.stlouisfed.org/apikeys for
 * a free key. Set FRED_API_KEY env var (locally + Firebase Secret Manager).
 *
 * FRED is the Federal Reserve Bank of St. Louis's economic-data system. It
 * republishes BLS data + adds tens of thousands of other series from BEA,
 * Treasury, Federal Reserve, OECD, World Bank, and many other publishers.
 *
 * v1A scope: a curated ~30-series watchlist covering rates (Fed Funds,
 * Treasury yields, mortgage), GDP + activity (real GDP, industrial
 * production, housing starts), inflation (PCE — Fed's preferred gauge),
 * employment (FRED versions of unemployment, payrolls), money supply
 * + Fed balance sheet, federal debt, trade, and consumer sentiment.
 *
 * Schema is the same generic `EconomicIndicator` we use for BLS — agents
 * query the unified `get_economic_indicators` tool with `source: "fred"`
 * filter or `source: "bls"` filter.
 *
 * Pure-publisher posture: values AS PUBLISHED. No derived YoY/QoQ deltas,
 * no real-vs-nominal recalculations, no model-implied forecasts. Agents
 * compute those on top.
 */
import "../load-secrets.js";
import type { EconomicIndicator } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  API_URL: "https://api.stlouisfed.org/fred",
  /** Required. Without it FRED returns 400. */
  API_KEY: process.env.FRED_API_KEY ?? "",
  /** Be polite. FRED's free tier doesn't publish a strict rate limit. */
  RATE_LIMIT_MS: 200,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Curated series watchlist ─────────────────────────────────────────────

interface SeriesSpec {
  id: string;
  name: string;
  category: string;
  unit: string;
  period_type: EconomicIndicator["period_type"];
  description: string;
}

/**
 * High-signal FRED series across rates, growth, inflation, employment,
 * money supply, debt, trade, and sentiment. Selection biased toward the
 * series most-asked by macro-aware agents.
 */
export const FRED_SERIES_CATALOG: SeriesSpec[] = [
  // ── Interest rates ──────────────────────────────────────────────────────
  {
    id: "DFF",
    name: "Federal Funds Effective Rate",
    category: "rates",
    unit: "percent",
    period_type: "daily",
    description: "Daily effective federal funds rate — overnight interbank lending. The Fed's primary policy rate signal.",
  },
  {
    id: "DGS2",
    name: "2-Year Treasury Yield",
    category: "rates",
    unit: "percent",
    period_type: "daily",
    description: "Market yield on US Treasury securities at 2-year constant maturity.",
  },
  {
    id: "DGS10",
    name: "10-Year Treasury Yield",
    category: "rates",
    unit: "percent",
    period_type: "daily",
    description: "Market yield on US Treasury securities at 10-year constant maturity (the benchmark long rate).",
  },
  {
    id: "DGS30",
    name: "30-Year Treasury Yield",
    category: "rates",
    unit: "percent",
    period_type: "daily",
    description: "Market yield on US Treasury securities at 30-year constant maturity.",
  },
  {
    id: "T10Y2Y",
    name: "10Y/2Y Treasury Yield Spread",
    category: "rates",
    unit: "percent",
    period_type: "daily",
    description: "10-year minus 2-year Treasury yield. Inverted (negative) historically precedes recessions.",
  },
  {
    id: "MORTGAGE30US",
    name: "30-Year Fixed Mortgage Rate",
    category: "rates",
    unit: "percent",
    period_type: "weekly",
    description: "30-year fixed-rate mortgage average (Freddie Mac).",
  },
  {
    id: "AAA",
    name: "AAA Corporate Bond Yield",
    category: "rates",
    unit: "percent",
    period_type: "monthly",
    description: "Moody's seasoned AAA-rated corporate bond yield (highest credit quality). FRED publishes this as monthly averages.",
  },
  {
    id: "BAA",
    name: "BAA Corporate Bond Yield",
    category: "rates",
    unit: "percent",
    period_type: "monthly",
    description: "Moody's seasoned Baa-rated corporate bond yield. AAA-BAA spread = credit-risk premium. Monthly averages.",
  },

  // ── GDP + economic activity ─────────────────────────────────────────────
  {
    id: "GDP",
    name: "Nominal GDP",
    category: "gdp",
    unit: "billions of dollars",
    period_type: "quarterly",
    description: "Gross domestic product at current prices (not inflation-adjusted).",
  },
  {
    id: "GDPC1",
    name: "Real GDP",
    category: "gdp",
    unit: "billions of chained 2017 dollars",
    period_type: "quarterly",
    description: "Real (inflation-adjusted) gross domestic product. The headline GDP figure.",
  },
  {
    id: "A191RL1Q225SBEA",
    name: "Real GDP, Percent Change at Annual Rate",
    category: "gdp",
    unit: "percent change",
    period_type: "quarterly",
    description: "Annualized quarterly real GDP growth rate (the GDP-print headline).",
  },
  {
    id: "INDPRO",
    name: "Industrial Production Index",
    category: "activity",
    unit: "index 2017=100",
    period_type: "monthly",
    description: "Industrial production — manufacturing, mining, utilities.",
  },
  {
    id: "HOUST",
    name: "Housing Starts",
    category: "activity",
    unit: "thousands of units, SAAR",
    period_type: "monthly",
    description: "New privately-owned housing units started (seasonally adjusted annual rate).",
  },
  {
    id: "RSAFS",
    name: "Retail and Food Services Sales",
    category: "activity",
    unit: "millions of dollars",
    period_type: "monthly",
    description: "Total advance retail and food services sales.",
  },

  // ── Inflation (alternative gauges; BLS covers CPI) ──────────────────────
  {
    id: "PCEPI",
    name: "PCE Price Index",
    category: "inflation",
    unit: "index 2017=100",
    period_type: "monthly",
    description: "Personal consumption expenditures price index — the Fed's preferred inflation gauge.",
  },
  {
    id: "PCEPILFE",
    name: "Core PCE Price Index",
    category: "inflation",
    unit: "index 2017=100",
    period_type: "monthly",
    description: "PCE price index excluding food and energy. The Fed's PRIMARY policy-driving inflation measure.",
  },
  {
    id: "T5YIE",
    name: "5-Year Breakeven Inflation Rate",
    category: "inflation",
    unit: "percent",
    period_type: "daily",
    description: "Market-implied 5-year inflation expectation (5yr nominal Treasury minus 5yr TIPS).",
  },
  {
    id: "T10YIE",
    name: "10-Year Breakeven Inflation Rate",
    category: "inflation",
    unit: "percent",
    period_type: "daily",
    description: "Market-implied 10-year inflation expectation (10yr nominal Treasury minus 10yr TIPS).",
  },

  // ── Employment (FRED versions; BLS covers same series natively) ─────────
  {
    id: "UNRATE",
    name: "Unemployment Rate (FRED)",
    category: "employment",
    unit: "percent",
    period_type: "monthly",
    description: "Civilian unemployment rate, seasonally adjusted (FRED republish of BLS LNS14000000).",
  },
  {
    id: "PAYEMS",
    name: "Nonfarm Payrolls (FRED)",
    category: "employment",
    unit: "thousands",
    period_type: "monthly",
    description: "Total nonfarm payroll employment (FRED republish of BLS CES0000000001).",
  },
  {
    id: "JTSJOL",
    name: "Job Openings (JOLTS)",
    category: "employment",
    unit: "thousands",
    period_type: "monthly",
    description: "Total nonfarm job openings (BLS JOLTS report). Leading indicator for labor demand.",
  },
  {
    id: "ICSA",
    name: "Initial Jobless Claims",
    category: "employment",
    unit: "number",
    period_type: "weekly",
    description: "Weekly initial claims for unemployment insurance (DOL). Most-watched weekly labor data.",
  },

  // ── Money supply + Fed balance sheet ────────────────────────────────────
  {
    id: "M2SL",
    name: "M2 Money Supply",
    category: "money",
    unit: "billions of dollars",
    period_type: "monthly",
    description: "Broad money supply: currency + demand deposits + savings + small time deposits + retail money market funds.",
  },
  {
    id: "WALCL",
    name: "Fed Total Assets",
    category: "money",
    unit: "millions of dollars",
    period_type: "weekly",
    description: "Federal Reserve total assets. Direct measure of Fed balance sheet size (QE/QT).",
  },
  {
    id: "RRPONTSYD",
    name: "Fed Overnight Reverse Repo",
    category: "money",
    unit: "billions of dollars",
    period_type: "daily",
    description: "Federal Reserve overnight reverse repurchase agreements (excess-liquidity-absorption tool).",
  },

  // ── Debt + Treasury ─────────────────────────────────────────────────────
  {
    id: "GFDEBTN",
    name: "Federal Debt (Total Public)",
    category: "debt",
    unit: "millions of dollars",
    period_type: "quarterly",
    description: "Federal debt: total public debt.",
  },
  {
    id: "WTREGEN",
    name: "Treasury General Account",
    category: "debt",
    unit: "billions of dollars",
    period_type: "weekly",
    description: "US Treasury operating cash balance at the Fed. Changes affect short-term liquidity.",
  },

  // ── Trade ────────────────────────────────────────────────────────────────
  {
    id: "BOPGSTB",
    name: "Trade Balance (Goods + Services)",
    category: "trade",
    unit: "millions of dollars",
    period_type: "monthly",
    description: "US international trade balance in goods and services (BEA).",
  },
  {
    id: "DTWEXBGS",
    name: "Trade-Weighted Dollar Index (Broad)",
    category: "trade",
    unit: "index Jan-2006=100",
    period_type: "daily",
    description: "Real broad trade-weighted US dollar index. Up = dollar strengthening.",
  },

  // ── Sentiment ───────────────────────────────────────────────────────────
  {
    id: "UMCSENT",
    name: "U Michigan Consumer Sentiment",
    category: "sentiment",
    unit: "index 1966Q1=100",
    period_type: "monthly",
    description: "University of Michigan Consumer Sentiment Index. Leading indicator of consumer spending.",
  },
];

// ─── FRED API response types ──────────────────────────────────────────────

interface RawObservation {
  date?: string;
  value?: string;
  realtime_start?: string;
  realtime_end?: string;
}
interface ObservationsResponse {
  observation_start?: string;
  observation_end?: string;
  count?: number;
  observations?: RawObservation[];
}

interface RawSeries {
  id?: string;
  title?: string;
  units?: string;
  frequency?: string;
  seasonal_adjustment_short?: string;
  notes?: string;
}
interface SeriesResponse {
  seriess?: RawSeries[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert a FRED observation date ("2024-09-01") to a KeyVex period label.
 * Returns "{YYYY}{period_code}" matching BLS conventions where possible.
 *
 * Monthly:    "2024-09-01" → "2024M09"
 * Quarterly:  "2024-09-01" → "2024Q03"
 * Annual:     "2024-01-01" → "2024A01"
 * Weekly:     "2024-09-15" → "2024W37"  (ISO week number)
 * Daily:      "2024-09-15" → "2024D258" (day-of-year, zero-padded)
 */
function dateToPeriodLabel(
  date: string,
  periodType: EconomicIndicator["period_type"],
): { period: string; year: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const year = parseInt(date.slice(0, 4), 10);
  const month = parseInt(date.slice(5, 7), 10);
  const day = parseInt(date.slice(8, 10), 10);
  if (!year || !month || !day) return null;

  if (periodType === "monthly") {
    return { period: `${year}M${String(month).padStart(2, "0")}`, year };
  }
  if (periodType === "quarterly") {
    const q = Math.ceil(month / 3);
    return { period: `${year}Q${String(q).padStart(2, "0")}`, year };
  }
  if (periodType === "annual") {
    return { period: `${year}A01`, year };
  }
  if (periodType === "weekly") {
    // ISO week number
    const d = new Date(Date.UTC(year, month - 1, day));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return {
      period: `${d.getUTCFullYear()}W${String(weekNo).padStart(2, "0")}`,
      year: d.getUTCFullYear(),
    };
  }
  if (periodType === "daily") {
    // Day-of-year, zero-padded to 3 digits
    const start = new Date(Date.UTC(year, 0, 1));
    const target = new Date(Date.UTC(year, month - 1, day));
    const dayOfYear = Math.floor(
      (target.getTime() - start.getTime()) / 86400000,
    ) + 1;
    return { period: `${year}D${String(dayOfYear).padStart(3, "0")}`, year };
  }
  return null;
}

function parseFredValue(raw: string | undefined): number | null {
  if (!raw || raw === "." || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FRED ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Per-series fetch ─────────────────────────────────────────────────────

export interface ScrapeFredOptions {
  /** Optional override of the curated series list. */
  seriesIds?: string[];
  /** Start year (4-digit). Default: 5 years ago. */
  startYear?: number;
  /** End year (4-digit). Default: current calendar year. */
  endYear?: number;
}

/**
 * Pull observations for the curated FRED watchlist. Each series gets one
 * API call. The free tier doesn't publish strict rate limits but we
 * throttle to 200ms anyway to be a good citizen.
 */
export async function scrapeFredIndicators(
  options: ScrapeFredOptions = {},
): Promise<EconomicIndicator[]> {
  if (!CONFIG.API_KEY) {
    throw new Error(
      "FRED_API_KEY env var not set. Register at https://fredaccount.stlouisfed.org/apikeys",
    );
  }

  const scrapedAt = new Date().toISOString();
  const now = new Date();
  const startYear = options.startYear ?? now.getFullYear() - 5;
  const endYear = options.endYear ?? now.getFullYear();
  const observationStart = `${startYear}-01-01`;
  const observationEnd = `${endYear}-12-31`;

  const targetIds =
    options.seriesIds ?? FRED_SERIES_CATALOG.map((s) => s.id);
  const specBy: Record<string, SeriesSpec> = {};
  for (const s of FRED_SERIES_CATALOG) specBy[s.id] = s;

  const out: EconomicIndicator[] = [];

  for (const id of targetIds) {
    const spec = specBy[id];
    if (!spec) {
      console.error(`[fred] ${id}: skipped — not in catalog`);
      continue;
    }
    const url =
      `${CONFIG.API_URL}/series/observations?` +
      `series_id=${encodeURIComponent(id)}&` +
      `api_key=${CONFIG.API_KEY}&` +
      `file_type=json&` +
      `observation_start=${observationStart}&` +
      `observation_end=${observationEnd}&` +
      `sort_order=desc`;

    let data: ObservationsResponse;
    try {
      data = await fetchJson<ObservationsResponse>(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fred] ${id}: SKIP — ${msg}`);
      continue;
    }
    const obs = data.observations ?? [];
    console.error(`[fred]   ${id} (${spec.period_type}): ${obs.length} observations`);

    for (const o of obs) {
      const value = parseFredValue(o.value);
      const date = o.date ?? "";
      const periodInfo = dateToPeriodLabel(date, spec.period_type);
      if (!periodInfo) continue;
      out.push({
        id: `${id}-${periodInfo.period}`,
        source: "fred",
        series_id: id,
        series_name: spec.name,
        category: spec.category,
        period: periodInfo.period,
        period_type: spec.period_type,
        year: periodInfo.year,
        value,
        unit: spec.unit,
        series_description: spec.description,
        notes: "",
        source_url: `https://fred.stlouisfed.org/series/${id}`,
        scraped_at: scrapedAt,
      });
    }
  }

  console.error(
    `[fred] TOTAL: ${out.length} observations across ${targetIds.length} series`,
  );
  return out;
}
