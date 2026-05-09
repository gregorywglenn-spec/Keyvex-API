/**
 * MCP tool: get_insider_transactions
 *
 * Returns Form 4 open-market purchases and sales by corporate insiders.
 * Full design rationale, parameter semantics, and response shape live in
 * TOOL_DESIGN.md (Tool 2).
 *
 * Implementation pattern that the other four tools will follow:
 *   - export `definition` (Tool object — name, description, inputSchema)
 *   - export `handler` (validates input, calls firestore.ts, returns envelope)
 *
 * The MCP entry point in src/index.ts iterates a registry of these.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  queryForm3Holdings,
  queryInsiderTransactions,
} from "../firestore.js";
import type {
  Form3Holding,
  InsiderTransactionsEnvelope,
  InsiderTransactionsQuery,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_insider_transactions",
  description: [
    "Returns executive insider transactions filed on SEC Form 4 — open-market",
    "purchases and sales by officers, directors, and 10%-owners of public",
    "companies. Each record is one transaction line item from one filing.",
    "",
    "Use this when the user asks about: insider buying or selling at a",
    "specific company, all recent insider activity across the market,",
    "transactions by a specific officer, or large insider trades by value.",
    "",
    "Form 4 is the fastest insider-trade signal in the public record — must",
    "be filed within 2 business days of the trade. The reporting_lag_days",
    "field tells you how stale a particular disclosure is.",
    "",
    "This tool returns only open-market purchases (transaction_code 'P') and",
    "sales (transaction_code 'S'). It excludes grants, option exercises,",
    "tax-withholding sales, and other non-discretionary transactions.",
    "",
    "Optional include_baseline=true: also returns matching Form 3 initial-",
    "ownership records (the insider's *starting* position when they first",
    "became an insider) under a `baselines` field. Use this when you need",
    "to know how big a sale is relative to the insider's full position —",
    "Form 4 alone shows the delta, Form 3 anchors the baseline. Requires",
    "ticker or company_cik to be set.",
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
      officer_name: {
        type: "string",
        description:
          "Full or partial officer name; case-insensitive substring match. Example: 'Cook' matches Tim Cook's filings.",
      },
      transaction_type: {
        type: "string",
        enum: ["buy", "sell"],
        description: "Filter to purchases or sales only.",
      },
      min_value: {
        type: "number",
        description:
          "Filter to trades with total_value >= this amount (USD). Use to focus on large trades.",
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
        enum: ["disclosure_date", "transaction_date", "total_value"],
        description:
          "Field used for ordering and for the since/until date filters. disclosure_date = when filed with SEC; transaction_date = when the trade actually occurred; total_value = USD size of the trade. Default: disclosure_date.",
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
      include_baseline: {
        type: "boolean",
        description:
          "When true, the response includes matching Form 3 initial-ownership records under a `baselines` field — lets you anchor Form 4 deltas to the insider's starting position. Requires ticker or company_cik. Default false.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<InsiderTransactionsEnvelope> {
  const query = validateAndNormalize(args);

  // Run trades fetch and (optionally) baselines fetch in parallel.
  // Baselines lookup uses the same ticker / company_cik / officer_name
  // filters so the returned Form 3 rows align with the active query.
  const tradesPromise = queryInsiderTransactions(query);
  const baselinesPromise: Promise<Form3Holding[]> = query.include_baseline
    ? fetchMatchingBaselines(query)
    : Promise.resolve([]);

  const [{ results, has_more }, baselines] = await Promise.all([
    tradesPromise,
    baselinesPromise,
  ]);

  const envelope: InsiderTransactionsEnvelope = {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };

  if (query.include_baseline) {
    envelope.baselines = baselines;
  }

  return envelope;
}

/**
 * Pull Form 3 baseline rows that align with the active insider-trades
 * query. Matches by ticker or company_cik; if officer_name substring is
 * set, applies the same substring against filer_name (Form 3 doesn't have
 * an "officer_name" column — same person, different schema field).
 *
 * Capped at 100 baselines — agents don't typically need more, and bigger
 * pulls would dwarf the trades payload.
 */
async function fetchMatchingBaselines(
  query: InsiderTransactionsQuery,
): Promise<Form3Holding[]> {
  const { results } = await queryForm3Holdings({
    ticker: query.ticker,
    company_cik: query.company_cik,
    filer_name: query.officer_name,
    sort_by: "filing_date",
    sort_order: "desc",
    limit: 100,
  });
  return results;
}

// ─── Input validation ───────────────────────────────────────────────────────

/**
 * Validates and normalizes raw tool-call arguments into a typed query.
 *
 * MCP clients are supposed to honor inputSchema, but defense-in-depth says
 * validate at the handler boundary anyway. Bad input throws an error that
 * the MCP server returns as an isError content block.
 */
function validateAndNormalize(raw: unknown): InsiderTransactionsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: InsiderTransactionsQuery = {};

  if (args.ticker !== undefined) {
    // Permissive — accepts AAPL, BRK.A, BRK-B, HEI/A, LEN/B, BF.B, etc.
    // Letters first, then up to 9 more chars including digits, period, slash,
    // hyphen for share-class designators.
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

  if (args.officer_name !== undefined) {
    if (typeof args.officer_name !== "string") {
      throw new Error("officer_name must be a string");
    }
    out.officer_name = args.officer_name;
  }

  if (args.transaction_type !== undefined) {
    if (args.transaction_type !== "buy" && args.transaction_type !== "sell") {
      throw new Error(
        `INVALID transaction_type: '${String(args.transaction_type)}' — expected 'buy' or 'sell'`,
      );
    }
    out.transaction_type = args.transaction_type;
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
      args.sort_by !== "disclosure_date" &&
      args.sort_by !== "transaction_date" &&
      args.sort_by !== "total_value"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected disclosure_date | transaction_date | total_value`,
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

  if (args.include_baseline !== undefined) {
    if (typeof args.include_baseline !== "boolean") {
      throw new Error("include_baseline must be a boolean");
    }
    if (args.include_baseline && !out.ticker && !out.company_cik) {
      throw new Error(
        "INVALID_BASELINE_QUERY: include_baseline=true requires ticker or company_cik to be set",
      );
    }
    out.include_baseline = args.include_baseline;
  }

  return out;
}

function parseIsoDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`INVALID_DATE: ${fieldName} must be a string`);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
