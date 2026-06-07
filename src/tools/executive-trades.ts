/**
 * MCP tool: get_executive_trades
 *
 * Returns securities transactions disclosed by senior executive-branch
 * officials on OGE Form 278-T — the executive-branch sibling of the
 * congressional STOCK Act PTR. Each record is one disclosed transaction.
 *
 * Pairs with get_congressional_trades for the cross-branch query no other MCP
 * server can answer: "show me congressional AND executive-branch trades in
 * $NVDA in the last 90 days" — call both tools and merge by ticker + date.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryExecutiveTrades } from "../firestore.js";
import type {
  ExecutiveTrade,
  ExecutiveTradesQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_executive_trades",
  annotations: {
    title: "Executive-Branch Trades (OGE 278-T)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns securities transactions disclosed by senior executive-branch",
    "officials on OGE Form 278-T (Periodic Transaction Report) — the",
    "executive-branch counterpart to congressional STOCK Act PTRs. Each record",
    "is one disclosed purchase, sale, or exchange over $1,000 by the filer,",
    "their spouse, or a dependent child, reported within 30-45 days.",
    "",
    "Use this when the user asks about executive-branch officials' trading —",
    "Cabinet secretaries, agency heads — in a stock, or recent activity. Pair",
    "with get_congressional_trades (same shape) for cross-branch queries like",
    "'who in government traded NVDA': call both and merge by ticker + date.",
    "",
    "To query by AGENCY/DEPARTMENT, use filer_position (substring) — the",
    "department is embedded in the position title, e.g. filer_position:",
    "'Health & Human Services', 'Treasury', 'Department of Defense'.",
    "",
    "COVERAGE (v1): Cabinet secretaries and Senate-confirmed appointees, via",
    "the OGE PAS Index (clean electronic filings). The President and Vice",
    "President are NOT yet covered — their 278-Ts are published in a separate",
    "collection whose PDFs have a corrupted text layer that needs OCR;",
    "President/VP coverage is planned for v1.1.",
    "",
    "Amounts are disclosed as ranges, e.g. '$1,000,001 - $5,000,000', stored",
    "verbatim; amount_min/amount_max parse the bounds (amount_max is absent for",
    "open-ended 'Over $50,000,000' ranges). Note: the 278-T transaction table",
    "has no per-row owner column, so owner defaults to 'self' unless the filing",
    "text explicitly indicates a spouse or dependent transaction.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description:
          "Stock symbol filter, e.g. 'NVDA'. Case-insensitive. Many 278-T holdings (private funds, municipal bonds) have no ticker and won't match a ticker filter.",
      },
      filer_name: {
        type: "string",
        description:
          "Full or partial filer name; case-insensitive substring match. Examples: 'Lutnick', 'Bessent'.",
      },
      filer_position: {
        type: "string",
        description:
          "Case-insensitive substring against the filer's position/title, which carries the AGENCY/DEPARTMENT. This is how you query by agency. Examples: 'Health & Human Services' (note the ampersand, not 'and'), 'Treasury', 'Department of Defense', 'Secretary'. Free-text from OGE filings, so match on a distinctive phrase.",
      },
      filer_type: {
        type: "string",
        enum: ["cabinet", "appointee", "other"],
        description:
          "Coarse role classification derived from the filer's position. 'cabinet' = a Secretary / Attorney General; 'appointee' = other Senate-confirmed officials.",
      },
      transaction_type: {
        type: "string",
        enum: ["purchase", "sale", "exchange"],
        description: "Filter to purchases, sales, or exchanges.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only records on or after this date, using sort_by as the date field.",
      },
      until: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Only records on or before this date.",
      },
      min_amount: {
        type: "number",
        description:
          "Filter to trades with amount_min >= this value (USD). Amount ranges are minimums: '$1,000,001 - $5,000,000' has amount_min=1000001.",
      },
      sort_by: {
        type: "string",
        enum: ["filing_date", "transaction_date"],
        description:
          "Field used by since/until and ordering. Default: filing_date (when the public first saw the filing).",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (most recent first).",
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
): Promise<ResultEnvelope<ExecutiveTrade>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } =
    await queryExecutiveTrades(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): ExecutiveTradesQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ExecutiveTradesQuery = {};

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

  if (args.filer_name !== undefined) {
    if (typeof args.filer_name !== "string") {
      throw new Error("filer_name must be a string");
    }
    out.filer_name = args.filer_name;
  }

  if (args.filer_position !== undefined) {
    if (typeof args.filer_position !== "string") {
      throw new Error("filer_position must be a string");
    }
    out.filer_position = args.filer_position;
  }

  if (args.filer_type !== undefined) {
    const valid = ["cabinet", "appointee", "other"];
    if (
      typeof args.filer_type !== "string" ||
      !valid.includes(args.filer_type)
    ) {
      throw new Error(
        `INVALID filer_type: '${String(args.filer_type)}' — expected one of ${valid.join(", ")}`,
      );
    }
    out.filer_type = args.filer_type as ExecutiveTradesQuery["filer_type"];
  }

  if (args.transaction_type !== undefined) {
    const valid = ["purchase", "sale", "exchange"];
    if (
      typeof args.transaction_type !== "string" ||
      !valid.includes(args.transaction_type)
    ) {
      throw new Error(
        `INVALID transaction_type: '${String(args.transaction_type)}' — expected one of ${valid.join(", ")}`,
      );
    }
    out.transaction_type =
      args.transaction_type as ExecutiveTradesQuery["transaction_type"];
  }

  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    ) {
      throw new Error(
        `INVALID since: '${String(args.since)}' — expected YYYY-MM-DD`,
      );
    }
    out.since = args.since;
  }

  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    ) {
      throw new Error(
        `INVALID until: '${String(args.until)}' — expected YYYY-MM-DD`,
      );
    }
    out.until = args.until;
  }

  if (args.min_amount !== undefined) {
    if (typeof args.min_amount !== "number" || args.min_amount < 0) {
      throw new Error("min_amount must be a non-negative number");
    }
    out.min_amount = args.min_amount;
  }

  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "filing_date" &&
      args.sort_by !== "transaction_date"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected 'filing_date' or 'transaction_date'`,
      );
    }
    out.sort_by = args.sort_by;
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
