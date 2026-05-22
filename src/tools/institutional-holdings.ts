/**
 * MCP tool: get_institutional_holdings
 *
 * Returns 13F holdings — quarterly snapshots of institutional manager
 * positions. Full design rationale, parameter semantics, and response shape
 * live in TOOL_DESIGN.md (Tool 3).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryInstitutionalHoldings } from "../firestore.js";
import type {
  InstitutionalHolding,
  InstitutionalHoldingsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_institutional_holdings",
  annotations: {
    title: "Institutional Holdings (SEC Form 13F)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns 13F holdings — quarterly snapshots of equity positions held by",
    "institutional investment managers with $100M+ AUM, filed with the SEC.",
    "Each record is one (fund, security, quarter) tuple.",
    "",
    "Use this when the user asks about: which institutions hold a stock, a",
    "fund's portfolio, position changes quarter-over-quarter, or 'whale'",
    "activity in a specific name.",
    "",
    "Reporting lag: up to 45 days after quarter end. A 2026-Q1 filing",
    "typically appears in mid-May 2026. The most recent quarter visible",
    "always lags real time.",
    "",
    "Important: 13F covers institutional managers ≥ $100M AUM but does NOT",
    "include short positions, cash, options (with rare exceptions), or",
    "non-US-listed equities. It's a snapshot of long equity positions only.",
    "For 'did the fund increase its AAPL stake?' questions, check the",
    "position_change field — values are 'new', 'increased', 'decreased',",
    "'closed', or 'unchanged' relative to the same fund's prior quarter.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description:
          "Filter to holdings of one stock by US ticker, e.g. 'AAPL'. Case-insensitive.",
      },
      cusip: {
        type: "string",
        description:
          "Alternative to ticker — 9-character SEC CUSIP identifier. Useful when a security has multiple share classes with different tickers.",
      },
      fund_name: {
        type: "string",
        description:
          "Full or partial fund name; case-insensitive substring match. Examples: 'Berkshire', 'Bridgewater', 'Citadel'.",
      },
      fund_cik: {
        type: "string",
        description:
          "SEC CIK of the fund (10-digit, padded). Preferred over fund_name when known. Berkshire Hathaway = '0001067983'.",
      },
      quarter: {
        type: "string",
        description:
          "Period ending date in YYYY-MM-DD form (e.g. '2026-03-31'). Defaults to all quarters available in the database.",
      },
      position_change: {
        type: "string",
        enum: ["new", "increased", "decreased", "closed", "unchanged"],
        description:
          "Filter to position-change type. Common queries: 'increased' for funds adding to a position, 'closed' for funds that exited.",
      },
      min_value: {
        type: "number",
        description:
          "Filter to positions with market_value >= this amount (USD). Use to focus on large positions.",
      },
      sort_by: {
        type: "string",
        enum: ["market_value", "shares_held", "shares_change_pct"],
        description:
          "Field used for ordering. Default: market_value (largest positions first).",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (largest first).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum records to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<InstitutionalHolding>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryInstitutionalHoldings(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): InstitutionalHoldingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: InstitutionalHoldingsQuery = {};

  if (args.ticker !== undefined) {
    if (
      typeof args.ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.ticker)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.ticker)}' — expected 1-10 chars, letters first, optional . / - for share classes`,
      );
    }
    out.ticker = args.ticker.toUpperCase();
  }

  if (args.cusip !== undefined) {
    if (
      typeof args.cusip !== "string" ||
      !/^[A-Za-z0-9]{8,9}$/.test(args.cusip)
    ) {
      throw new Error(
        `INVALID_CUSIP: '${String(args.cusip)}' — expected 8-9 alphanumeric characters`,
      );
    }
    out.cusip = args.cusip;
  }

  if (args.fund_name !== undefined) {
    if (typeof args.fund_name !== "string") {
      throw new Error("fund_name must be a string");
    }
    out.fund_name = args.fund_name;
  }

  if (args.fund_cik !== undefined) {
    if (typeof args.fund_cik !== "string") {
      throw new Error("fund_cik must be a string");
    }
    out.fund_cik = args.fund_cik;
  }

  if (args.quarter !== undefined) {
    if (
      typeof args.quarter !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.quarter)
    ) {
      throw new Error(
        `INVALID quarter: '${String(args.quarter)}' — expected YYYY-MM-DD`,
      );
    }
    out.quarter = args.quarter;
  }

  if (args.position_change !== undefined) {
    const valid: InstitutionalHoldingsQuery["position_change"][] = [
      "new",
      "increased",
      "decreased",
      "closed",
      "unchanged",
    ];
    if (
      typeof args.position_change !== "string" ||
      !valid.includes(
        args.position_change as InstitutionalHoldingsQuery["position_change"],
      )
    ) {
      throw new Error(
        `INVALID position_change: '${String(args.position_change)}' — expected one of ${valid.join(", ")}`,
      );
    }
    out.position_change =
      args.position_change as InstitutionalHoldingsQuery["position_change"];
  }

  if (args.min_value !== undefined) {
    if (typeof args.min_value !== "number" || args.min_value < 0) {
      throw new Error("min_value must be a non-negative number");
    }
    out.min_value = args.min_value;
  }

  if (args.sort_by !== undefined) {
    const valid: InstitutionalHoldingsQuery["sort_by"][] = [
      "market_value",
      "shares_held",
      "shares_change_pct",
    ];
    if (
      typeof args.sort_by !== "string" ||
      !valid.includes(
        args.sort_by as InstitutionalHoldingsQuery["sort_by"],
      )
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected one of ${valid.join(", ")}`,
      );
    }
    out.sort_by =
      args.sort_by as InstitutionalHoldingsQuery["sort_by"];
  }

  if (args.sort_order !== undefined) {
    if (args.sort_order !== "desc" && args.sort_order !== "asc") {
      throw new Error(
        `INVALID sort_order: '${String(args.sort_order)}' — expected 'desc' or 'asc'`,
      );
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
      throw new Error(
        `INVALID limit: '${String(args.limit)}' — expected integer 1..500`,
      );
    }
    out.limit = args.limit;
  }

  return out;
}
