/**
 * MCP tool: get_initial_ownership_baselines
 *
 * Surfaces the initial_ownership_baselines collection — Form 3 filings,
 * the *initial* statement of beneficial ownership filed when someone
 * first becomes an insider (officer, director, 10%+ holder).
 *
 * Form 3 is the BASELINE that anchors Form 4 deltas. Without it, "Tim
 * Cook sold 50,000 shares" floats with no anchor — you don't know if
 * that's 1% or 50% of his position. With Form 3, agents can stitch
 * together: "Filed Form 3 in 2011 with 1.0M shares, then years of Form 4
 * grants/sales net to current holdings of ~3.3M."
 *
 * Two ways to access this data:
 *   - This dedicated tool, for queries focused on baseline / starting
 *     positions ("show me all NEW insiders at AAPL this year").
 *   - The include_baseline:true parameter on get_insider_transactions,
 *     which folds Form 3 baselines onto the matching Form 4 query in
 *     a single round trip.
 *
 * One filing produces multiple records — typically common stock plus any
 * derivatives held (options, RSUs, warrants). is_derivative distinguishes
 * the two flavors.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryForm3Holdings } from "../firestore.js";
import type {
  Form3Holding,
  Form3HoldingsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_initial_ownership_baselines",
  description: [
    "Returns SEC Form 3 filings — the INITIAL statement of beneficial",
    "ownership filed when someone first becomes an insider (officer,",
    "director, 10%+ holder). Form 3 is the baseline that anchors Form 4",
    "deltas to a starting position; without it, transaction sizes have",
    "no context.",
    "",
    "Use this tool when the question is about:",
    "  - Who became a NEW insider at a company recently",
    "  - What positions a new officer/director started with",
    "  - The original holdings basis for a current insider",
    "  - Tracking 10%+ holders as they cross the disclosure threshold",
    "",
    "If you're already querying get_insider_transactions for the same",
    "ticker, you can pass include_baseline:true on THAT tool to get the",
    "matching Form 3 records folded in — one round trip instead of two.",
    "Use this dedicated tool when baseline data is the primary need.",
    "",
    "One filing produces multiple rows — typically the insider's common",
    "stock holdings PLUS any derivatives (options, RSUs, warrants).",
    "is_derivative=true filters to the derivative rows; false to common.",
    "",
    "Field set:",
    "  - filer_name + filer_cik: the new insider",
    "  - officer_title: their role at the issuer (empty for pure",
    "    directors / 10%+ holders)",
    "  - is_director / is_officer / is_ten_percent_owner / is_other:",
    "    relationship flags (a person can be more than one)",
    "  - shares_owned: snapshot count for non-derivative; for derivatives,",
    "    use underlying_security_shares for the underlying-share equivalent",
    "  - direct_or_indirect: 'D' (own name) or 'I' (via trust/spouse/etc.)",
    "  - For derivatives: conversion_or_exercise_price, exercise_date,",
    "    expiration_date, underlying_security_title",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description:
          "Issuer ticker symbol (1-10 characters; supports BRK.A, HEI/A, etc.).",
      },
      company_cik: {
        type: "string",
        description: "Issuer's SEC CIK (zero-padded). Joins to Form 4 filings on the same company.",
      },
      filer_name: {
        type: "string",
        description:
          "Case-insensitive substring against the insider's name. Joint filings concatenate names with ' / '.",
      },
      filer_cik: {
        type: "string",
        description:
          "Insider's SEC CIK. Persistent across Form 3 / Form 4 filings — useful join key.",
      },
      is_derivative: {
        type: "boolean",
        description:
          "True returns derivative-only rows (options/warrants/RSUs); false returns non-derivative (common/preferred). Omit for both.",
      },
      since: {
        type: "string",
        description:
          "ISO YYYY-MM-DD lower bound on filing_date. Inclusive.",
      },
      until: {
        type: "string",
        description:
          "ISO YYYY-MM-DD upper bound on filing_date. Inclusive.",
      },
      sort_by: {
        type: "string",
        enum: ["filing_date", "shares_owned"],
        description:
          "filing_date = SEC submission date (newest-first by default); shares_owned = absolute snapshot count (use for 'who has the largest baseline at this company'). Also bounds since/until. Default 'filing_date'.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default 'desc'.",
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
): Promise<ResultEnvelope<Form3Holding>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryForm3Holdings(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): Form3HoldingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: Form3HoldingsQuery = {};

  if (args.ticker !== undefined) {
    if (
      typeof args.ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.ticker)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.ticker)}' — expected 1-10 chars starting with a letter (e.g., 'AAPL', 'BRK.A')`,
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

  if (args.filer_cik !== undefined) {
    if (typeof args.filer_cik !== "string") {
      throw new Error("filer_cik must be a string");
    }
    out.filer_cik = args.filer_cik;
  }

  if (args.is_derivative !== undefined) {
    if (typeof args.is_derivative !== "boolean") {
      throw new Error("is_derivative must be a boolean");
    }
    out.is_derivative = args.is_derivative;
  }

  for (const field of ["since", "until"] as const) {
    const v = args[field];
    if (v !== undefined) {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error(
          `INVALID ${field}: '${String(v)}' — expected ISO YYYY-MM-DD`,
        );
      }
      out[field] = v;
    }
  }

  if (args.sort_by !== undefined) {
    if (args.sort_by !== "filing_date" && args.sort_by !== "shares_owned") {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected 'filing_date' or 'shares_owned'`,
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
