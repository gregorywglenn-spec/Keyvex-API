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
import type {
  EconomicIndicator,
  EconomicIndicatorsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_economic_indicators",
  description: [
    "Returns observations of key US macro indicators sourced from BLS",
    "(Bureau of Labor Statistics). v1A scope: a curated watchlist of ~20",
    "high-signal series across employment, wages, inflation, productivity,",
    "and hours-worked. Each record is one observation (one period of one",
    "series).",
    "",
    "Use this when the user asks about: unemployment rate, jobs report,",
    "nonfarm payrolls, CPI / inflation, PPI / wholesale inflation, labor",
    "force participation, average hourly earnings, productivity growth,",
    "unit labor costs, employment cost index (ECI), or general macro",
    "context for congressional voting or Treasury yield analysis.",
    "",
    "Categories (for filtering):",
    "  - employment     — unemployment rates (U-3, U-6), payrolls",
    "                     (total / private / government), employment level",
    "  - labor-force    — labor force participation rate",
    "  - wages          — average hourly earnings, employment cost index",
    "  - hours          — average weekly hours",
    "  - inflation      — CPI (all items, core, food, energy, housing),",
    "                     PPI (final demand, core)",
    "  - productivity   — nonfarm productivity, unit labor costs",
    "",
    "Most series are monthly; productivity + ECI are quarterly. Use",
    "`period_type` to filter. `period` is BLS's native format —",
    "'2026M04' (April 2026), '2026Q01' (Q1 2026), '2026A01' (annual).",
    "Lexicographic sort on `period` is chronological.",
    "",
    "Set `latest_only=true` to get one record per series (the most-recent",
    "observation) — useful for 'where are things now' snapshot questions.",
    "",
    "Pure-publisher posture: the unit on each series is documented in the",
    "`unit` field; we do not compute year-over-year deltas, seasonally",
    "adjust differently, or derive 'real' vs 'nominal' versions — agents",
    "do those calculations on top.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      series_id: {
        type: "string",
        description:
          "BLS series ID (e.g., 'LNS14000000' for U-3 unemployment, 'CES0000000001' for nonfarm payrolls, 'CUUR0000SA0' for CPI All Items).",
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
        ],
        description: "Bucket filter.",
      },
      period_type: {
        type: "string",
        enum: ["monthly", "quarterly", "semiannual", "annual"],
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
  const { results, has_more } = await queryEconomicIndicators(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): EconomicIndicatorsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: EconomicIndicatorsQuery = {};

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
    ];
    if (!valid.includes(args.category as string)) {
      throw new Error(`INVALID category: '${String(args.category)}'`);
    }
    out.category = args.category as string;
  }
  if (args.period_type !== undefined) {
    const valid = ["monthly", "quarterly", "semiannual", "annual"];
    if (!valid.includes(args.period_type as string)) {
      throw new Error(`INVALID period_type: '${String(args.period_type)}'`);
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
    if (typeof args.latest_only !== "boolean") {
      throw new Error("latest_only must be a boolean");
    }
    out.latest_only = args.latest_only;
  }
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "period" &&
      args.sort_by !== "value" &&
      args.sort_by !== "year"
    ) {
      throw new Error(`INVALID sort_by: '${String(args.sort_by)}'`);
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
