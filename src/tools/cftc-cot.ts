/**
 * MCP tool: get_cftc_cot_reports
 *
 * CFTC Commitments of Traders — weekly aggregated futures + options-on-futures
 * positioning by trader class. The macro positioning dataset, released every
 * Friday for prior Tuesday close.
 *
 * Killer query patterns:
 *   - "Show commercial positioning extremes" — latest_only=true + sort by comm_net
 *   - "How are large specs positioned in S&P?" — contract_market_name='E-MINI S&P' + recent dates
 *   - "Gold COT this year" — commodity_name='GOLD' + since='2026-01-01'
 *   - "Currency COT extremes" — contract_market_name='JAPANESE YEN' or 'EURO'
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryCftcCotReports } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  CftcCotReport,
  CftcCotReportQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_cftc_cot_reports",
  annotations: {
    title: "CFTC Commitments of Traders",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns CFTC Commitments of Traders (COT) report rows — weekly",
    "aggregated futures + options-on-futures positioning by trader class.",
    "The COT report is the macro positioning dataset for U.S. futures",
    "markets. Released every Friday 3:30 PM ET for the prior Tuesday close.",
    "",
    "Trader classes (legacy futures-only report):",
    "  - Non-commercial (large speculators — hedge funds, CTAs)",
    "  - Commercial (hedgers — producers, swap dealers)",
    "  - Non-reportable (small speculators)",
    "",
    "Killer query patterns:",
    "  - Macro positioning snapshot this week: latest_only=true (gives the",
    "    latest report row for every contract in one query)",
    "  - Large-spec extremes in S&P: commodity_name='S&P 500 STOCK INDEX'",
    "    + sort_by='noncomm_net' + sort_order='desc'",
    "  - Gold positioning history: commodity_name='GOLD' + since='2026-01-01'",
    "  - Currency COT: contract_market_name substring 'YEN' / 'EURO'",
    "",
    "Source: publicreporting.cftc.gov/resource/jun7-fc8e.json (Socrata API,",
    "free, unauthenticated). Covers EVERY regulated U.S. futures + options-",
    "on-futures contract — agricultural commodities, metals, energy,",
    "financials, FX, crypto. Pure-publisher posture: raw positioning numbers,",
    "no derived sentiment scores.",
    "",
    "Key derived fields (computed from raw): noncomm_net (large-spec net),",
    "comm_net (hedger net), nonrept_net (small-spec net). Concentration",
    "fields show top-4 / top-8 trader net long/short concentration.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Direct doc lookup ({contract_code}-{YYYY-MM-DD}). Fastest path.",
      },
      cftc_contract_market_code: {
        type: "string",
        description:
          "Exact CFTC contract code (e.g., '13874A' = E-mini S&P 500, '088691' = Gold, '067651' = Crude Oil WTI).",
      },
      contract_market_name: {
        type: "string",
        description:
          "Case-insensitive substring on contract_market_name (e.g., 'S&P 500', 'GOLD', 'CRUDE OIL', 'JAPANESE YEN'). Client-side filter.",
      },
      commodity_name: {
        type: "string",
        description:
          "Exact commodity name from CFTC's catalog (e.g., 'S&P 500 STOCK INDEX', 'GOLD', 'CRUDE OIL', 'EURO FX').",
      },
      since: {
        type: "string",
        description: "Inclusive lower bound on report_date (YYYY-MM-DD).",
      },
      until: {
        type: "string",
        description: "Inclusive upper bound on report_date (YYYY-MM-DD).",
      },
      latest_only: {
        type: "boolean",
        description:
          "When true, returns only the most recent report row per contract (one row per contract instead of weekly history).",
      },
      sort_by: {
        type: "string",
        enum: ["report_date", "open_interest", "noncomm_net", "comm_net"],
        description: "Sort key. Default: report_date.",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Max records. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<CftcCotReport>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryCftcCotReports(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): CftcCotReportQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: CftcCotReportQuery = {};

  if (args.id !== undefined) {
    if (typeof args.id !== "string") throw new Error("id must be string");
    out.id = args.id;
  }
  if (args.cftc_contract_market_code !== undefined) {
    if (typeof args.cftc_contract_market_code !== "string")
      throw new Error("cftc_contract_market_code must be string");
    out.cftc_contract_market_code = args.cftc_contract_market_code;
  }
  if (args.contract_market_name !== undefined) {
    if (typeof args.contract_market_name !== "string")
      throw new Error("contract_market_name must be string");
    out.contract_market_name = args.contract_market_name;
  }
  if (args.commodity_name !== undefined) {
    if (typeof args.commodity_name !== "string")
      throw new Error("commodity_name must be string");
    out.commodity_name = args.commodity_name;
  }
  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    )
      throw new Error("INVALID since: expected YYYY-MM-DD");
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    )
      throw new Error("INVALID until: expected YYYY-MM-DD");
    out.until = args.until;
  }
  if (args.latest_only !== undefined) {
    out.latest_only = parseBooleanArg(args.latest_only, "latest_only");
  }
  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["report_date", "open_interest", "noncomm_net", "comm_net"].includes(
        args.sort_by,
      )
    )
      throw new Error(
        "INVALID sort_by: expected report_date | open_interest | noncomm_net | comm_net",
      );
    out.sort_by = args.sort_by as CftcCotReportQuery["sort_by"];
  }
  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    )
      throw new Error("INVALID sort_order: expected asc | desc");
    out.sort_order = args.sort_order as CftcCotReportQuery["sort_order"];
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    )
      throw new Error("INVALID limit: expected integer 1..500");
    out.limit = args.limit;
  }

  return out;
}
