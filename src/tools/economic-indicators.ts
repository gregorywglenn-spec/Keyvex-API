/**
 * MCP tool: get_economic_indicators
 *
 * Returns observations of key US macro indicators — unemployment, payrolls,
 * CPI, PPI, wages, productivity — sourced from BLS. v1A covers a curated
 * watchlist of ~20 high-signal series. The generic schema is designed to
 * extend to FRED + BEA in later versions.
 *
 * Pairs naturally with congressional roll-call votes on economic bills
 * (does CPI accelerate after stimulus passes? does unemployment fall after
 * tax bills?) and with Treasury auctions for yield-vs-jobs analysis.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryEconomicIndicators } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  EconomicIndicator,
  EconomicIndicatorsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_economic_indicators",
  annotations: {
    title: "Economic Indicators (BLS / FRED / EIA)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns observations of key US macro + energy indicators from three sources:",
    "  - BLS (Bureau of Labor Statistics): the canonical labor + price",
    "    statistics. ~20-series watchlist covering unemployment, payrolls,",
    "    wages, CPI, PPI, productivity. Most monthly, ECI/productivity",
    "    quarterly.",
    "  - FRED (Federal Reserve Economic Data, St Louis Fed): rates, money",
    "    supply, GDP, PCE inflation, mortgage rates, jobless claims, Fed",
    "    balance sheet, breakeven inflation, dollar index, consumer",
    "    sentiment. ~30-series watchlist. Some daily (rates, dollar),",
    "    weekly (mortgage, Fed assets, jobless claims), monthly, quarterly.",
    "  - EIA (Energy Information Administration): WTI + Brent crude oil",
    "    spot prices, Henry Hub natural gas, US gasoline retail price, US",
    "    crude oil production. Unique energy data not in BLS or FRED.",
    "    Mostly weekly cadence.",
    "",
    "Filter to one source via `source: 'bls' | 'fred' | 'eia'`. Default",
    "returns all three unified — `series_id` disambiguates across catalogs.",
    "",
    "Use this when the user asks about: unemployment rate, jobs report,",
    "nonfarm payrolls, CPI / PCE / inflation, Fed Funds rate, Treasury",
    "yields, mortgage rates, yield-curve inversion, money supply / M2,",
    "Fed balance sheet / QE / QT activity, GDP, housing starts, retail",
    "sales, consumer sentiment, jobless claims, trade balance, dollar",
    "strength, or general macro context for cross-source analysis.",
    "",
    "Categories (for filtering):",
    "  - rates          — Fed Funds, Treasury yields, mortgage, corporate bonds",
    "  - gdp            — Real + nominal GDP, GDP growth rate",
    "  - activity       — Industrial production, housing starts, retail sales",
    "  - inflation      — CPI/PPI (BLS) + PCE/Core PCE/breakevens (FRED)",
    "  - employment     — Unemployment rates (U-3, U-6), payrolls, jobless claims",
    "  - labor-force    — Labor force participation rate",
    "  - wages          — Average hourly earnings, employment cost index",
    "  - hours          — Average weekly hours",
    "  - productivity   — Nonfarm productivity, unit labor costs",
    "  - money          — M2, Fed total assets, overnight reverse repo",
    "  - debt           — Federal debt, Treasury general account",
    "  - trade          — Trade balance, trade-weighted dollar index",
    "  - sentiment      — U Michigan Consumer Sentiment",
    "  - energy         — WTI/Brent crude, Henry Hub natural gas, retail gasoline,",
    "                    US crude production (EIA)",
    "",
    "Period format is fixed-width per cadence so lexicographic sort = chronological:",
    "  - 2026M04 (April 2026), 2026Q01 (Q1 2026), 2026A01 (annual 2026),",
    "    2026W18 (week 18 of 2026), 2026D258 (day-of-year 258).",
    "",
    "Set `latest_only=true` to get one record per series (the most-recent",
    "observation) — useful for 'where are things now' snapshot questions.",
    "Daily series under latest_only return only the latest day per series",
    "(deduped client-side); without it you can pull arbitrary history.",
    "",
    "Pure-publisher posture: the unit on each series is documented in the",
    "`unit` field; we do not compute year-over-year deltas, seasonally",
    "adjust differently, or derive 'real' vs 'nominal' versions — agents",
    "do those calculations on top.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        enum: ["bls", "fred", "eia"],
        description:
          "Filter to one source. Omit to query all three. BLS = canonical labor + price stats. FRED = rates, money, GDP, PCE inflation, sentiment. EIA = energy prices + production.",
      },
      series_id: {
        type: "string",
        description:
          "Exact series ID. BLS examples: 'LNS14000000' (U-3), 'CES0000000001' (payrolls), 'CUUR0000SA0' (CPI). FRED examples: 'DFF' (Fed Funds), 'DGS10' (10Y Treasury), 'PCEPILFE' (Core PCE), 'M2SL' (M2), 'WALCL' (Fed assets), 'UMCSENT' (sentiment).",
      },
      category: {
        type: "string",
        enum: [
          "employment",
          "labor-force",
          "wages",
          "hours",
          "inflation",
          "productivity",
          "rates",
          "gdp",
          "activity",
          "money",
          "debt",
          "trade",
          "sentiment",
          "energy",
        ],
        description: "Bucket filter.",
      },
      period_type: {
        type: "string",
        enum: ["monthly", "quarterly", "semiannual", "annual", "weekly", "daily"],
        description: "Cadence filter.",
      },
      since_year: {
        type: "integer",
        description: "Calendar-year lower bound (inclusive).",
      },
      until_year: {
        type: "integer",
        description: "Calendar-year upper bound (inclusive).",
      },
      latest_only: {
        type: "boolean",
        description:
          "When true, return only the most-recent observation per series. Useful for 'current state' snapshots.",
      },
      sort_by: {
        type: "string",
        enum: ["period", "value", "year"],
        description: "Default period (chronological).",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default desc.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<EconomicIndicator>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryEconomicIndicators(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): EconomicIndicatorsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: EconomicIndicatorsQuery = {};

  if (args.source !== undefined) {
    if (
      args.source !== "bls" &&
      args.source !== "fred" &&
      args.source !== "eia"
    ) {
      throw new Error(
        `INVALID source: '${String(args.source)}' — expected 'bls' | 'fred' | 'eia'`,
      );
    }
    out.source = args.source;
  }
  if (args.series_id !== undefined) {
    if (typeof args.series_id !== "string") {
      throw new Error("series_id must be a string");
    }
    out.series_id = args.series_id;
  }
  if (args.category !== undefined) {
    const valid = [
      "employment",
      "labor-force",
      "wages",
      "hours",
      "inflation",
      "productivity",
      "rates",
      "gdp",
      "activity",
      "money",
      "debt",
      "trade",
      "sentiment",
      "energy",
    ];
    if (!valid.includes(args.category as string)) {
      throw new Error(
        `INVALID category: '${String(args.category)}' — expected one of: ${valid.join(", ")}`,
      );
    }
    out.category = args.category as string;
  }
  if (args.period_type !== undefined) {
    const valid = [
      "monthly",
      "quarterly",
      "semiannual",
      "annual",
      "weekly",
      "daily",
    ];
    if (!valid.includes(args.period_type as string)) {
      throw new Error(
        `INVALID period_type: '${String(args.period_type)}' — expected one of: ${valid.join(", ")}`,
      );
    }
    out.period_type = args.period_type as EconomicIndicatorsQuery["period_type"];
  }
  if (args.since_year !== undefined) {
    if (
      typeof args.since_year !== "number" ||
      !Number.isInteger(args.since_year) ||
      args.since_year < 1900
    ) {
      throw new Error(`INVALID since_year: '${String(args.since_year)}'`);
    }
    out.since_year = args.since_year;
  }
  if (args.until_year !== undefined) {
    if (
      typeof args.until_year !== "number" ||
      !Number.isInteger(args.until_year) ||
      args.until_year < 1900
    ) {
      throw new Error(`INVALID until_year: '${String(args.until_year)}'`);
    }
    out.until_year = args.until_year;
  }
  if (args.latest_only !== undefined) {
    out.latest_only = parseBooleanArg(args.latest_only, "latest_only");
  }
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "period" &&
      args.sort_by !== "value" &&
      args.sort_by !== "year"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected one of: period, value, year`,
      );
    }
    out.sort_by = args.sort_by;
  }
  if (args.sort_order !== undefined) {
    if (args.sort_order !== "desc" && args.sort_order !== "asc") {
      throw new Error(`INVALID sort_order: '${String(args.sort_order)}'`);
    }
    out.sort_order = args.sort_order;
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    ) {
      throw new Error(`INVALID limit: '${String(args.limit)}'`);
    }
    out.limit = args.limit;
  }
  return out;
}
