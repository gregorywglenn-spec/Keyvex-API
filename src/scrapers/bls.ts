/**
 * BLS economic-indicators scraper.
 *
 * Source: api.bls.gov/publicAPI/v2/timeseries/data/
 *
 * Auth: optional. Free tier without key = 50 requests/day. With registration
 * key (env BLS_API_KEY) = 500/day. v1A doesn't require a key — one scheduler
 * run pulls all curated series in 1-2 requests well under the daily limit.
 *
 * Scope: a curated watchlist of ~20 high-signal monthly + quarterly series
 * across employment, wages, inflation, productivity, and hours-worked.
 * Each pull returns ~13 months of history per series (~260 observations).
 *
 * Generic schema (`EconomicIndicator`) is designed to extend to FRED + BEA
 * later — same shape, different `source` value.
 */
import type { EconomicIndicator } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  API_URL: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  /** Optional registration key (env BLS_API_KEY). Without it: 50 req/day. */
  API_KEY: process.env.BLS_API_KEY ?? "",
  /** BLS limits a single API call to 25 series. */
  MAX_SERIES_PER_CALL: 25,
  /** 250ms between batched calls — well within their tolerance. */
  RATE_LIMIT_MS: 250,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Curated series watchlist ──────────────────────────────────────────────

/**
 * Each entry maps a BLS series ID to its agent-readable name, category bucket,
 * unit, and period type. The watchlist is the v1A surface — we run only these
 * series. Add new ones here to expand coverage.
 */
interface SeriesSpec {
  id: string;
  name: string;
  category: "employment" | "wages" | "inflation" | "productivity" | "hours" | "labor-force";
  unit: string;
  period_type: "monthly" | "quarterly" | "annual";
  description: string;
}

export const BLS_SERIES_CATALOG: SeriesSpec[] = [
  // ── Employment ─────────────────────────────────────────────────────────
  {
    id: "LNS14000000",
    name: "Unemployment Rate (U-3)",
    category: "employment",
    unit: "percent",
    period_type: "monthly",
    description: "Civilian unemployment rate, seasonally adjusted (U-3, the headline rate)",
  },
  {
    id: "LNS13327709",
    name: "Unemployment Rate (U-6)",
    category: "employment",
    unit: "percent",
    period_type: "monthly",
    description: "Broader unemployment rate including discouraged + part-time-for-economic-reasons (U-6)",
  },
  {
    id: "CES0000000001",
    name: "Total Nonfarm Payrolls",
    category: "employment",
    unit: "thousands",
    period_type: "monthly",
    description: "Total nonfarm payroll employment, seasonally adjusted (the 'jobs report' headline)",
  },
  {
    id: "CES0500000001",
    name: "Total Private Payrolls",
    category: "employment",
    unit: "thousands",
    period_type: "monthly",
    description: "Total private-sector payroll employment, seasonally adjusted",
  },
  {
    id: "CES9000000001",
    name: "Government Payrolls",
    category: "employment",
    unit: "thousands",
    period_type: "monthly",
    description: "Government payroll employment (federal + state + local), seasonally adjusted",
  },
  {
    id: "LNS12300000",
    name: "Labor Force Participation Rate",
    category: "labor-force",
    unit: "percent",
    period_type: "monthly",
    description: "Civilian labor force as a percent of the civilian noninstitutional population",
  },
  {
    id: "LNS12000000",
    name: "Employment Level",
    category: "employment",
    unit: "thousands",
    period_type: "monthly",
    description: "Civilian employment level, household survey",
  },

  // ── Hours + Earnings ───────────────────────────────────────────────────
  {
    id: "CES0500000003",
    name: "Average Hourly Earnings, Private",
    category: "wages",
    unit: "dollars",
    period_type: "monthly",
    description: "Average hourly earnings of all private-sector employees, seasonally adjusted",
  },
  {
    id: "CES0500000007",
    name: "Average Weekly Hours, Private",
    category: "hours",
    unit: "hours",
    period_type: "monthly",
    description: "Average weekly hours of all private-sector employees, seasonally adjusted",
  },

  // ── Inflation ──────────────────────────────────────────────────────────
  {
    id: "CUUR0000SA0",
    name: "CPI All Items",
    category: "inflation",
    unit: "index 1982-84=100",
    period_type: "monthly",
    description: "Consumer Price Index for All Urban Consumers, All Items, U.S. city average",
  },
  {
    id: "CUUR0000SA0L1E",
    name: "Core CPI (ex Food & Energy)",
    category: "inflation",
    unit: "index 1982-84=100",
    period_type: "monthly",
    description: "Consumer Price Index, all items less food and energy",
  },
  {
    id: "CUUR0000SAF1",
    name: "CPI Food",
    category: "inflation",
    unit: "index 1982-84=100",
    period_type: "monthly",
    description: "Consumer Price Index, food",
  },
  {
    id: "CUUR0000SA0E",
    name: "CPI Energy",
    category: "inflation",
    unit: "index 1982-84=100",
    period_type: "monthly",
    description: "Consumer Price Index, energy",
  },
  {
    id: "CUUR0000SAH",
    name: "CPI Housing",
    category: "inflation",
    unit: "index 1982-84=100",
    period_type: "monthly",
    description: "Consumer Price Index, housing",
  },
  {
    id: "WPUFD4",
    name: "PPI Final Demand",
    category: "inflation",
    unit: "index Nov-2009=100",
    period_type: "monthly",
    description: "Producer Price Index, final demand (the 'wholesale inflation' headline)",
  },
  {
    id: "WPUFD49104",
    name: "Core PPI Final Demand (ex Food, Energy, Trade)",
    category: "inflation",
    unit: "index Nov-2009=100",
    period_type: "monthly",
    description: "Producer Price Index, final demand less foods, energy, and trade services",
  },

  // ── Productivity + Compensation ────────────────────────────────────────
  {
    id: "PRS85006092",
    name: "Nonfarm Productivity",
    category: "productivity",
    unit: "percent change",
    period_type: "quarterly",
    description: "Nonfarm business sector labor productivity, quarterly percent change",
  },
  {
    id: "PRS85006152",
    name: "Unit Labor Costs, Nonfarm",
    category: "productivity",
    unit: "percent change",
    period_type: "quarterly",
    description: "Unit labor costs, nonfarm business sector, quarterly percent change",
  },
  {
    id: "CIU1010000000000A",
    name: "Employment Cost Index, Total Compensation",
    category: "wages",
    unit: "percent change",
    period_type: "quarterly",
    description: "Employment Cost Index, total compensation, all civilian workers, quarterly",
  },
];

// ─── BLS API response types ────────────────────────────────────────────────

interface RawFootnote {
  code?: string;
  text?: string;
}
interface RawDataPoint {
  year?: string;
  period?: string;
  periodName?: string;
  value?: string;
  latest?: string;
  footnotes?: RawFootnote[];
}
interface RawSeries {
  seriesID?: string;
  data?: RawDataPoint[];
}
interface BlsResponse {
  status?: string;
  message?: string[];
  Results?: { series?: RawSeries[] };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseBlsValue(raw: string | undefined): number | null {
  if (!raw || raw === "-" || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function joinFootnotes(notes: RawFootnote[] | undefined): string {
  if (!notes || notes.length === 0) return "";
  return notes
    .map((n) =>
      n.code && n.text ? `${n.code}=${n.text}` : n.text ?? n.code ?? "",
    )
    .filter(Boolean)
    .join("; ");
}

function inferPeriodType(period: string): EconomicIndicator["period_type"] {
  if (period.startsWith("M")) return "monthly";
  if (period.startsWith("Q")) return "quarterly";
  if (period.startsWith("S")) return "semiannual";
  return "annual";
}

// ─── Scraper ───────────────────────────────────────────────────────────────

export interface ScrapeBlsOptions {
  /** Optional override of the curated series list. */
  seriesIds?: string[];
  /** Start year (4-digit). Default: 2 years ago. */
  startYear?: number;
  /** End year (4-digit). Default: current calendar year. */
  endYear?: number;
}

/**
 * Pull observations for the curated BLS watchlist across the specified
 * year range. BLS caps a single API call to 25 series; we batch
 * automatically and dedup by composite (series_id, period) key.
 */
export async function scrapeBlsIndicators(
  options: ScrapeBlsOptions = {},
): Promise<EconomicIndicator[]> {
  const scrapedAt = new Date().toISOString();
  const now = new Date();
  const startYear = options.startYear ?? now.getFullYear() - 2;
  const endYear = options.endYear ?? now.getFullYear();

  const targetIds =
    options.seriesIds ?? BLS_SERIES_CATALOG.map((s) => s.id);
  // Lookup map for enriching each observation back into our schema.
  const specBy: Record<string, SeriesSpec> = {};
  for (const s of BLS_SERIES_CATALOG) specBy[s.id] = s;

  const out: EconomicIndicator[] = [];

  // Batch by 25.
  for (let i = 0; i < targetIds.length; i += CONFIG.MAX_SERIES_PER_CALL) {
    const batch = targetIds.slice(i, i + CONFIG.MAX_SERIES_PER_CALL);
    await sleep(CONFIG.RATE_LIMIT_MS);

    const body: Record<string, unknown> = {
      seriesid: batch,
      startyear: String(startYear),
      endyear: String(endYear),
    };
    if (CONFIG.API_KEY) body.registrationkey = CONFIG.API_KEY;

    console.error(
      `[bls]   batch ${i / CONFIG.MAX_SERIES_PER_CALL + 1}: ${batch.length} series, ${startYear}-${endYear}`,
    );

    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`BLS HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as BlsResponse;
    if (json.status !== "REQUEST_SUCCEEDED") {
      const msg = (json.message ?? []).join("; ");
      throw new Error(`BLS error: ${msg || json.status}`);
    }
    for (const series of json.Results?.series ?? []) {
      const seriesId = series.seriesID ?? "";
      if (!seriesId) continue;
      const spec = specBy[seriesId];
      for (const dp of series.data ?? []) {
        const year = parseInt(dp.year ?? "0", 10);
        const period = dp.period ?? "";
        if (!year || !period) continue;
        const compositePeriod = `${year}${period}`;
        const value = parseBlsValue(dp.value);
        const periodType = inferPeriodType(period);

        out.push({
          id: `${seriesId}-${compositePeriod}`,
          source: "bls",
          series_id: seriesId,
          series_name: spec?.name ?? seriesId,
          category: spec?.category ?? "unknown",
          period: compositePeriod,
          period_type: spec?.period_type ?? periodType,
          year,
          value,
          unit: spec?.unit ?? "",
          series_description: spec?.description ?? "",
          notes: joinFootnotes(dp.footnotes),
          source_url: `https://data.bls.gov/timeseries/${seriesId}`,
          scraped_at: scrapedAt,
        });
      }
    }
  }
  console.error(
    `[bls] TOTAL: ${out.length} observations across ${targetIds.length} series`,
  );
  return out;
}
