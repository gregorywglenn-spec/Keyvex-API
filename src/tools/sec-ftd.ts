/**
 * MCP tool: get_sec_fails_to_deliver
 *
 * SEC bi-monthly Fails-to-Deliver dataset — daily settlement failures
 * by ticker. Persistent FTDs are a contrarian short-squeeze leading
 * indicator (naked short pressure overwhelming locate supply).
 *
 * Related but distinct from Reg SHO Threshold Securities (a derived list:
 * tickers with FTDs > 0.5% of issued shares for 5+ consecutive days).
 * This tool exposes the underlying daily FTD data.
 *
 * Killer queries:
 *   - Recent FTD spikes for one ticker: ticker='XYZ' + sort_by='fail_value'
 *   - Biggest FTD failures overall this month: min_value=1000000 + sort by value
 *   - Squeeze candidates: min_quantity=100000 + recent dates
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { querySecFailsToDeliver } from "../firestore.js";
import type {
  ResultEnvelope,
  SecFailToDeliver,
  SecFailsToDeliverQuery,
} from "../types.js";

export const definition: Tool = {
  name: "get_sec_fails_to_deliver",
  annotations: {
    title: "SEC Fails-to-Deliver",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns SEC Fails-to-Deliver (FTD) rows — daily settlement failures",
    "by ticker / CUSIP / date. Each row is one ticker on one settlement",
    "date where a clearing-member's short sale FAILED to deliver shares.",
    "",
    "Signal value: persistent FTDs are a contrarian short-squeeze leading",
    "indicator. When the daily FTD quantity spikes on a ticker, it often",
    "means naked short pressure overwhelming locate supply or settlement /",
    "locate mechanism breaking down. The Reg SHO Threshold Securities list",
    "(FTDs > 0.5% of issued shares for 5+ consecutive days) is a derived",
    "view; this tool exposes the underlying daily data.",
    "",
    "Source: SEC bi-monthly cnsfails<YYYYMM><a|b>.zip files at",
    "sec.gov/files/data/fails-deliver-data/. Published ~1 week after each",
    "half-month settlement period. Coverage: every U.S.-listed security",
    "with a recorded settlement failure during the period.",
    "",
    "Killer query patterns:",
    "  - Daily FTD history for a ticker: ticker='GME' + sort_by='settlement_date'",
    "  - Largest FTDs this month: min_value=1000000 + sort_by='fail_value'",
    "  - Squeeze setup candidates: min_quantity=100000 + recent dates",
    "  - Look-up by CUSIP: cusip='B6S7WD106' (foreign issuers, complex names)",
    "",
    "Derived field: fail_value = quantity_fails × price (dollar magnitude of",
    "the failure on that day). Reference price comes from the SEC's posted",
    "value at settlement.",
    "",
    "Note: FTDs are bi-monthly batch-published, not real-time. The most",
    "recent settlement date will typically be 7-10 days behind today.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Direct doc lookup ({YYYY-MM-DD}-{cusip}). Fastest path.",
      },
      ticker: {
        type: "string",
        description: "Ticker symbol (uppercased automatically).",
      },
      cusip: {
        type: "string",
        description: "Exact CUSIP (preferred for foreign issuers / class shares).",
      },
      since: {
        type: "string",
        description: "Inclusive lower bound on settlement_date (YYYY-MM-DD).",
      },
      until: {
        type: "string",
        description: "Inclusive upper bound on settlement_date (YYYY-MM-DD).",
      },
      min_quantity: {
        type: "number",
        description:
          "Inclusive lower bound on quantity_fails (shares). E.g., 100000 surfaces only large failures.",
      },
      min_value: {
        type: "number",
        description:
          "Inclusive lower bound on fail_value (dollars). E.g., 1000000 surfaces only $1M+ failures.",
      },
      sort_by: {
        type: "string",
        enum: ["settlement_date", "quantity_fails", "fail_value"],
        description: "Sort key. Default: settlement_date.",
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
): Promise<ResultEnvelope<SecFailToDeliver>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await querySecFailsToDeliver(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): SecFailsToDeliverQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: SecFailsToDeliverQuery = {};

  if (args.id !== undefined) {
    if (typeof args.id !== "string") throw new Error("id must be string");
    out.id = args.id;
  }
  if (args.ticker !== undefined) {
    if (typeof args.ticker !== "string")
      throw new Error("ticker must be string");
    out.ticker = args.ticker.toUpperCase();
  }
  if (args.cusip !== undefined) {
    if (typeof args.cusip !== "string") throw new Error("cusip must be string");
    out.cusip = args.cusip;
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
  if (args.min_quantity !== undefined) {
    if (typeof args.min_quantity !== "number" || args.min_quantity < 0)
      throw new Error("min_quantity must be a non-negative number");
    out.min_quantity = args.min_quantity;
  }
  if (args.min_value !== undefined) {
    if (typeof args.min_value !== "number" || args.min_value < 0)
      throw new Error("min_value must be a non-negative number");
    out.min_value = args.min_value;
  }
  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["settlement_date", "quantity_fails", "fail_value"].includes(args.sort_by)
    )
      throw new Error(
        "INVALID sort_by: expected settlement_date | quantity_fails | fail_value",
      );
    out.sort_by = args.sort_by as SecFailsToDeliverQuery["sort_by"];
  }
  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    )
      throw new Error("INVALID sort_order: expected asc | desc");
    out.sort_order = args.sort_order as SecFailsToDeliverQuery["sort_order"];
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
