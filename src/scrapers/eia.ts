/**
 * EIA energy data scraper.
 *
 * Source: api.eia.gov/v2 (US Energy Information Administration).
 *
 * Auth REQUIRED: register at https://www.eia.gov/opendata/register.php for
 * a free key. Set EIA_API_KEY env var (locally + Firebase Secret Manager).
 *
 * Why EIA matters: unique energy data that's NOT in BLS or FRED — crude
 * oil spot prices (WTI, Brent), natural gas (Henry Hub), gasoline retail,
 * crude oil production. Pairs with congressional trades + lobbying spend
 * by energy-sector clients, with FRED breakeven inflation for the energy-
 * inflation overlay, and with macro activity for the energy-cost-pass-
 * through narrative.
 *
 * v1A scope: ~5 high-signal series covering oil + natural gas + gasoline.
 * Catalog can grow by adding entries to EIA_SERIES_CATALOG.
 *
 * Pure-publisher posture: prices as published. No derived spreads (Brent-
 * WTI), no seasonal adjustment, no real-vs-nominal conversion. Agents
 * compute those on top.
 */
import "../load-secrets.js";
import type { EconomicIndicator } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  API_URL: "https://api.eia.gov/v2",
  /** Required. Without it EIA returns 401. */
  API_KEY: process.env.EIA_API_KEY ?? "",
  /** Be polite. EIA throttles aggressively but doesn't publish exact limits. */
  RATE_LIMIT_MS: 250,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Curated series watchlist ─────────────────────────────────────────────

/**
 * EIA v2 series spec. Each entry maps a customer-facing display ID to the
 * exact API path + facet filters needed to pull it. v2 doesn't use a
 * single-series-ID model — each dataset path is a "table" with one or more
 * "data" columns and any number of facet dimensions.
 *
 * `facets` is an object of {dimension: [acceptedValue, ...]} pairs that
 * select a specific row (e.g., specific product + area + duration).
 */
interface SeriesSpec {
  /** Stable customer-facing series id (used in `series_id` field). */
  id: string;
  name: string;
  category: string;
  unit: string;
  period_type: EconomicIndicator["period_type"];
  description: string;
  /** Path under /v2/ (no leading slash). e.g. "petroleum/pri/spt". */
  apiPath: string;
  /** EIA's frequency code: "daily" | "weekly" | "monthly" | "quarterly" | "annual". */
  frequency: string;
  /** Data column to fetch. Most spot-price tables use "value". */
  dataColumn: string;
  /** Facet filters identifying the specific row. */
  facets: Record<string, string[]>;
}

export const EIA_SERIES_CATALOG: SeriesSpec[] = [
  {
    id: "EIA-WTI-SPOT-WEEKLY",
    name: "WTI Crude Oil Spot Price (Cushing OK)",
    category: "energy",
    unit: "dollars per barrel",
    period_type: "weekly",
    description:
      "West Texas Intermediate crude oil spot price at Cushing, Oklahoma. Benchmark for North American light sweet crude. EIA series RWTC; weekly average.",
    apiPath: "petroleum/pri/spt",
    frequency: "weekly",
    dataColumn: "value",
    facets: { series: ["RWTC"] },
  },
  {
    id: "EIA-BRENT-SPOT-WEEKLY",
    name: "Brent Crude Oil Spot Price (Europe)",
    category: "energy",
    unit: "dollars per barrel",
    period_type: "weekly",
    description:
      "Europe Brent crude oil spot price. Benchmark for waterborne light sweet crude. EIA series RBRTE; weekly average.",
    apiPath: "petroleum/pri/spt",
    frequency: "weekly",
    dataColumn: "value",
    facets: { series: ["RBRTE"] },
  },
  {
    id: "EIA-HENRY-HUB-NATGAS-WEEKLY",
    name: "Henry Hub Natural Gas Spot Price",
    category: "energy",
    unit: "dollars per million btu",
    period_type: "weekly",
    description:
      "Henry Hub natural gas spot price — North American benchmark. Weekly average.",
    apiPath: "natural-gas/pri/fut",
    frequency: "weekly",
    dataColumn: "value",
    facets: { series: ["RNGWHHD"] },
  },
  {
    id: "EIA-GASOLINE-RETAIL-WEEKLY",
    name: "US Regular Gasoline Retail Price (All Formulations)",
    category: "energy",
    unit: "dollars per gallon",
    period_type: "weekly",
    description:
      "Average US retail price for regular gasoline (all formulations). EIA series EMM_EPMR_PTE_NUS_DPG; weekly survey.",
    apiPath: "petroleum/pri/gnd",
    frequency: "weekly",
    dataColumn: "value",
    facets: { series: ["EMM_EPMR_PTE_NUS_DPG"] },
  },
  {
    id: "EIA-CRUDE-OIL-PROD-MONTHLY",
    name: "US Crude Oil Production",
    category: "energy",
    unit: "thousand barrels per day",
    period_type: "monthly",
    description:
      "Total US crude oil field production. Monthly. EIA petroleum supply database.",
    apiPath: "petroleum/crd/crpdn",
    frequency: "monthly",
    dataColumn: "value",
    facets: { duoarea: ["NUS"], product: ["EPC0"] },
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

interface RawEiaObservation {
  period?: string;
  value?: string | number | null;
  [key: string]: unknown;
}

interface EiaResponse {
  response?: {
    total?: number | string;
    dateFormat?: string;
    frequency?: string;
    data?: RawEiaObservation[];
  };
  error?: string;
}

/**
 * Convert an EIA period string to a KeyVex period label. EIA serves dates
 * in one of these shapes depending on cadence:
 *   daily   → "YYYY-MM-DD"
 *   weekly  → "YYYY-MM-DD" (week-ending Friday)
 *   monthly → "YYYY-MM"
 *   annual  → "YYYY"
 */
function periodToLabel(
  raw: string,
  periodType: EconomicIndicator["period_type"],
): { period: string; year: number } | null {
  if (periodType === "annual") {
    if (!/^\d{4}$/.test(raw)) return null;
    const year = parseInt(raw, 10);
    return { period: `${year}A01`, year };
  }
  if (periodType === "monthly") {
    if (!/^\d{4}-\d{2}$/.test(raw)) return null;
    const year = parseInt(raw.slice(0, 4), 10);
    const month = parseInt(raw.slice(5, 7), 10);
    return { period: `${year}M${String(month).padStart(2, "0")}`, year };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const year = parseInt(raw.slice(0, 4), 10);
  const month = parseInt(raw.slice(5, 7), 10);
  const day = parseInt(raw.slice(8, 10), 10);
  if (!year || !month || !day) return null;

  if (periodType === "weekly") {
    // ISO week of the period date.
    const d = new Date(Date.UTC(year, month - 1, day));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return {
      period: `${d.getUTCFullYear()}W${String(weekNo).padStart(2, "0")}`,
      year: d.getUTCFullYear(),
    };
  }
  if (periodType === "daily") {
    const start = new Date(Date.UTC(year, 0, 1));
    const target = new Date(Date.UTC(year, month - 1, day));
    const dayOfYear =
      Math.floor((target.getTime() - start.getTime()) / 86400000) + 1;
    return { period: `${year}D${String(dayOfYear).padStart(3, "0")}`, year };
  }
  if (periodType === "quarterly") {
    const q = Math.ceil(month / 3);
    return { period: `${year}Q${String(q).padStart(2, "0")}`, year };
  }
  return null;
}

function parseEiaValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Build the EIA v2 URL for a single series. Facets are encoded as repeated
 * `facets[dim][]=value` query params — that's the v2 convention.
 */
function buildUrl(spec: SeriesSpec, startYear: number): string {
  const params: string[] = [
    `api_key=${encodeURIComponent(CONFIG.API_KEY)}`,
    `frequency=${encodeURIComponent(spec.frequency)}`,
    `data[]=${encodeURIComponent(spec.dataColumn)}`,
    `start=${encodeURIComponent(`${startYear}-01-01`)}`,
    `sort[0][column]=period`,
    `sort[0][direction]=desc`,
    `length=5000`,
  ];
  for (const [dim, values] of Object.entries(spec.facets)) {
    for (const v of values) {
      params.push(`facets[${encodeURIComponent(dim)}][]=${encodeURIComponent(v)}`);
    }
  }
  return `${CONFIG.API_URL}/${spec.apiPath}/data/?${params.join("&")}`;
}

export interface ScrapeEiaOptions {
  /** Earliest calendar year to include (inclusive). Default 2018. */
  startYear?: number;
}

/**
 * Pull all series in the catalog. Sequential to stay comfortably under EIA's
 * unpublished rate limit. Returns whatever it successfully fetched —
 * per-series fetch errors are logged and skipped.
 */
export async function scrapeEia(
  options: ScrapeEiaOptions = {},
): Promise<EconomicIndicator[]> {
  if (!CONFIG.API_KEY) {
    throw new Error(
      "EIA_API_KEY not set. Register at https://www.eia.gov/opendata/register.php and export EIA_API_KEY=...",
    );
  }
  const startYear = options.startYear ?? 2018;
  const scrapedAt = new Date().toISOString();
  const out: EconomicIndicator[] = [];

  for (const spec of EIA_SERIES_CATALOG) {
    const url = buildUrl(spec, startYear);
    await sleep(CONFIG.RATE_LIMIT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[eia] ${spec.id}: fetch failed — ${msg}`);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[eia] ${spec.id}: HTTP ${res.status} — ${body.slice(0, 200)}`,
      );
      continue;
    }
    let data: EiaResponse;
    try {
      data = (await res.json()) as EiaResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[eia] ${spec.id}: JSON parse failed — ${msg}`);
      continue;
    }
    if (data.error) {
      console.error(`[eia] ${spec.id}: API error — ${data.error}`);
      continue;
    }
    const observations = data.response?.data ?? [];
    let added = 0;
    for (const obs of observations) {
      if (!obs.period) continue;
      const label = periodToLabel(obs.period, spec.period_type);
      if (!label) continue;
      const value = parseEiaValue(obs.value ?? obs[spec.dataColumn]);
      out.push({
        id: `${spec.id}-${label.period}`,
        source: "eia",
        series_id: spec.id,
        series_name: spec.name,
        category: spec.category,
        period: label.period,
        period_type: spec.period_type,
        year: label.year,
        value,
        unit: spec.unit,
        series_description: spec.description,
        notes: "",
        source_url: `https://www.eia.gov/opendata/browser/${spec.apiPath}`,
        scraped_at: scrapedAt,
      });
      added++;
    }
    console.error(
      `[eia] ${spec.id}: ${added} observations (since ${startYear})`,
    );
  }

  console.error(
    `[eia] TOTAL: ${out.length} observations across ${EIA_SERIES_CATALOG.length} series`,
  );
  return out;
}
