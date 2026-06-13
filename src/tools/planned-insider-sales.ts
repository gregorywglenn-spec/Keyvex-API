/**
 * MCP tool: get_planned_insider_sales
 *
 * Returns Form 144 filings — notices of proposed sale by corporate insiders.
 * Forward-looking complement to get_insider_transactions (Form 4 = what
 * already happened; Form 144 = what's about to happen).
 *
 * Almost no aggregator exposes Form 144 cleanly — Bloomberg buries it,
 * Capitol Trades doesn't carry it, Quiver doesn't either. Real differentiator
 * for the hub.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryForm144Filings } from "../firestore.js";
import type {
  Form144Filing,
  Form144FilingsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_planned_insider_sales",
  annotations: {
    title: "Planned Insider Sales (SEC Form 144)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns Form 144 filings — notices of proposed sale by corporate insiders",
    "(officers, directors, 10%+ holders) under Rule 144 of the Securities Act.",
    "Each record is one planned-sale line from one filing.",
    "",
    "Use this when the user asks about: insiders who have announced they're",
    "about to sell, upcoming insider sales at a specific company, large",
    "planned sales by value, or which executives are signaling intent to",
    "exit positions.",
    "",
    "Form 144 is a *forward-looking* signal. It's filed BEFORE the actual",
    "sale, which later lands as a Form 4. The complement to",
    "get_insider_transactions: that tool tells you what insiders just did,",
    "this one tells you what they're about to do. Filing thresholds: ≥5,000",
    "shares OR ≥$50,000 aggregate value.",
    "",
    "The aggregate_market_value is the insider's estimate at filing time;",
    "the actual sale price/value can differ. The approximate_sale_date is",
    "also an estimate — the real Form 4 transaction_date may be days later.",
    "",
    "Most Form 144 filings list one security line, but a single filing can",
    "cover multiple share classes (e.g., separate Class A + Class B). Each",
    "line is returned as its own record.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "Stock symbol filter, e.g. 'AAPL'. Case-insensitive.",
      },
      company_cik: {
        type: "string",
        description:
          "SEC CIK number (10-digit, padded with leading zeros). Alternative to ticker when known.",
      },
      filer_name: {
        type: "string",
        description:
          "Full or partial filer name; case-insensitive substring match. Example: 'Cook' matches Tim Cook's filings. NOTE: plain substring (not word-boundary) match — a short surname can match mid-word too (e.g. 'Huang' also matches 'CHUANG'). Pass a longer/fuller name to disambiguate a specific person.",
      },
      min_value: {
        type: "number",
        description:
          "Filter to filings with aggregate_market_value >= this amount (USD). Use to focus on large planned sales.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only records on or after this date, using sort_by as the date field.",
      },
      until: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only records on or before this date.",
      },
      sort_by: {
        type: "string",
        enum: [
          "filing_date",
          "approximate_sale_date",
          "aggregate_market_value",
        ],
        description:
          "Field used for ordering and for the since/until date filters. Default: filing_date.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (most recent / largest first).",
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
): Promise<ResultEnvelope<Form144Filing>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryForm144Filings(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): Form144FilingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: Form144FilingsQuery = {};

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

  if (args.company_cik !== undefined) {
    if (typeof args.company_cik !== "string") {
      throw new Error("company_cik must be a string");
    }
    out.company_cik = args.company_cik;
  }

  if (args.filer_name !== undefined) {
    if (typeof args.filer_name !== "string") {
      throw new Error("filer_name must be a string");
    }
    out.filer_name = args.filer_name;
  }

  if (args.min_value !== undefined) {
    if (typeof args.min_value !== "number" || args.min_value < 0) {
      throw new Error("min_value must be a non-negative number");
    }
    out.min_value = args.min_value;
  }

  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }

  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }

  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "filing_date" &&
      args.sort_by !== "approximate_sale_date" &&
      args.sort_by !== "aggregate_market_value"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected filing_date | approximate_sale_date | aggregate_market_value`,
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

function parseIsoDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`INVALID_DATE: ${fieldName} must be a string`);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
