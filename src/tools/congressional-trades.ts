/**
 * MCP tool: get_congressional_trades
 *
 * Returns disclosed trades by U.S. members of Congress under the STOCK Act —
 * Senate eFD and House Clerk Periodic Transaction Reports (PTRs). Each
 * record is one disclosed transaction by a member or their immediate family.
 *
 * Full design rationale, parameter semantics, and response shape live in
 * TOOL_DESIGN.md (Tool 1).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryCongressionalTrades } from "../firestore.js";
import { deriveCongressionalNature } from "./insider-transactions-v2-shim.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  CongressionalTrade,
  CongressionalTradesQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_congressional_trades",
  annotations: {
    title: "Congressional Trades",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns trade records disclosed by U.S. members of Congress under the",
    "STOCK Act — Senate eFD and House Clerk Periodic Transaction Reports",
    "(PTRs). Each record is one disclosed transaction by a member or their",
    "immediate family.",
    "",
    "Use this when the user asks about: who in Congress traded a specific",
    "stock, what trades a specific member made, recent congressional",
    "trading activity, or filings within a date range.",
    "",
    "Important: This data is *disclosed* trades, with reporting lag up to 45",
    "days. The disclosure_date is when the public could first see the trade;",
    "the transaction_date is when the trade actually happened. For 'what did",
    "Congress just disclose buying' questions, sort by disclosure_date. For",
    "'what did Congress hold around a specific market event', filter by",
    "transaction_date.",
    "",
    "Each amount is a range like '$1,001 - $15,000' (Senate filers report",
    "ranges, not exact amounts). The amount_min and amount_max fields parse",
    "those bounds for filtering. STOCK Act allows reporting in 11 standard",
    "ranges from $1,001 up to over $50,000,000.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description:
          "Stock symbol filter, e.g. 'AAPL'. Case-insensitive. Leave empty to query across all tickers.",
      },
      member_name: {
        type: "string",
        description:
          "Full or partial member name; case-insensitive substring match. Examples: 'Collins', 'Pelosi'.",
      },
      bioguide_id: {
        type: "string",
        description:
          "Member's permanent congressional ID, e.g. 'C001035' for Susan Collins. Preferred over member_name when known. Pair with get_member_profile to enrich a trade with the member's party/state/committee assignments.",
      },
      chamber: {
        type: "string",
        enum: ["senate", "house"],
        description:
          "Filter to one chamber. Senate PTRs are HTML-parsed from efdsearch.senate.gov. House PTRs are PDF-parsed from disclosures-clerk.house.gov.",
      },
      transaction_type: {
        type: "string",
        enum: ["buy", "sell"],
        description:
          "Purchases or sales only. Maps to Senate's 'Purchase' / 'Sale - Full' / 'Sale - Partial' columns.",
      },
      owner: {
        type: "string",
        enum: ["Self", "Spouse", "Joint", "Dependent"],
        description:
          "Who owns the asset. STOCK Act covers spouse and dependent children's trades too — this filter narrows to one ownership category.",
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
      min_amount: {
        type: "number",
        description:
          "Filter to trades with amount_min >= this value (USD). Use to focus on larger disclosed trades. Note: amount ranges are minimums, so '$1,001 - $15,000' has amount_min=1001.",
      },
      sort_by: {
        type: "string",
        enum: ["disclosure_date", "transaction_date"],
        description:
          "Field used by since/until and ordering. Default: disclosure_date (when the public first saw the trade).",
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
      include_non_open_market: {
        type: "boolean",
        description:
          "Phase A v0.52.0 (2026-05-24): controls whether NON-MARKET events appear in the result. When false (honest default for direction queries), keeps ONLY OPEN_MARKET rows plus INSUFFICIENT_DATA rows (passthrough — unclassified is not the same as confirmed non-market, never silently dropped). Excludes both NON_OPEN_MARKET_TRANSFER (charitable contributions, gifts, donations detected in `comment`) AND EQUITY_COMP (rare for congressional but handled identically for parity). Honest-by-default: with transaction_type='buy'|'sell' → defaults to FALSE so a charitable contribution can't pollute a sell-total query. Without transaction_type → defaults to TRUE (everything tagged honestly). The transaction_type field on each row is NEVER mutated. Example: `member_name:'Pelosi', transaction_type:'sell'` by default EXCLUDES Pelosi's Trinity University contribution; `include_non_open_market:true` re-includes it. Envelope carries `unclassifiable_records_retained: N` when any INSUFFICIENT_DATA rows passed through.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<CongressionalTrade>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryCongressionalTrades(query);

  // Phase A v0.52.0 (2026-05-24): refined honest-by-default filter — when
  // default-excluding (transaction_type set + no flag OR explicit false),
  // keep ONLY OPEN_MARKET + INSUFFICIENT_DATA (passthrough). Drop
  // NON_OPEN_MARKET_TRANSFER (gifts/contributions detected in comment).
  // Congressional doesn't typically populate EQUITY_COMP — but the rule
  // handles it identically for parity with insider-transactions.
  //
  // INSUFFICIENT_DATA passes through always. Envelope surfaces
  // unclassifiable_records_retained counter when > 0.
  const includeNonOpenMarket = resolveIncludeNonOpenMarket(
    query.transaction_type,
    query.include_non_open_market,
  );
  // Derive nature once per row (used twice: for filter + counter)
  const withNature = results.map((r) => ({
    row: r,
    nature:
      r.transaction_nature ??
      deriveCongressionalNature({
        comment: r.comment,
        transaction_type: r.transaction_type,
      }),
  }));
  const filteredResults = includeNonOpenMarket
    ? withNature.map((x) => x.row)
    : withNature
        .filter(
          (x) =>
            x.nature === "OPEN_MARKET" || x.nature === "INSUFFICIENT_DATA",
        )
        .map((x) => x.row);
  const unclassifiableCount = withNature.filter(
    (x) =>
      x.nature === "INSUFFICIENT_DATA" &&
      filteredResults.includes(x.row),
  ).length;

  return {
    results: filteredResults,
    count: filteredResults.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    ...(unclassifiableCount > 0 && {
      unclassifiable_records_retained: unclassifiableCount,
    }),
    query: query as Record<string, unknown>,
  };
}

/**
 * Phase A: resolve the context-driven default for include_non_open_market.
 * Identical semantic to insider-transactions: when transaction_type is set,
 * default to excluding transfers; otherwise include them all by default.
 */
function resolveIncludeNonOpenMarket(
  transactionType: string | undefined,
  callerValue: boolean | undefined,
): boolean {
  if (callerValue !== undefined) return callerValue;
  if (transactionType === "buy" || transactionType === "sell") return false;
  return true;
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): CongressionalTradesQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: CongressionalTradesQuery = {};

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

  if (args.member_name !== undefined) {
    if (typeof args.member_name !== "string") {
      throw new Error("member_name must be a string");
    }
    out.member_name = args.member_name;
  }

  if (args.bioguide_id !== undefined) {
    if (
      typeof args.bioguide_id !== "string" ||
      !/^[A-Z]\d{6}$/.test(args.bioguide_id)
    ) {
      throw new Error(
        `INVALID bioguide_id: '${String(args.bioguide_id)}' — expected single uppercase letter followed by 6 digits, e.g. 'C001035'`,
      );
    }
    out.bioguide_id = args.bioguide_id;
  }

  if (args.chamber !== undefined) {
    if (args.chamber !== "senate" && args.chamber !== "house") {
      throw new Error(
        `INVALID chamber: '${String(args.chamber)}' — expected 'senate' or 'house'`,
      );
    }
    out.chamber = args.chamber;
  }

  if (args.transaction_type !== undefined) {
    if (
      args.transaction_type !== "buy" &&
      args.transaction_type !== "sell"
    ) {
      throw new Error(
        `INVALID transaction_type: '${String(args.transaction_type)}' — expected 'buy' or 'sell'`,
      );
    }
    out.transaction_type = args.transaction_type;
  }

  if (args.owner !== undefined) {
    const valid: CongressionalTradesQuery["owner"][] = [
      "Self",
      "Spouse",
      "Joint",
      "Dependent",
    ];
    if (
      typeof args.owner !== "string" ||
      !valid.includes(args.owner as CongressionalTradesQuery["owner"])
    ) {
      throw new Error(
        `INVALID owner: '${String(args.owner)}' — expected one of ${valid.join(", ")}`,
      );
    }
    out.owner = args.owner as CongressionalTradesQuery["owner"];
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
      args.sort_by !== "disclosure_date" &&
      args.sort_by !== "transaction_date"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected 'disclosure_date' or 'transaction_date'`,
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

  // Phase A (2026-05-24): see CongressionalTradesQuery for full semantic
  if (args.include_non_open_market !== undefined) {
    out.include_non_open_market = parseBooleanArg(
      args.include_non_open_market,
      "include_non_open_market",
    );
  }

  return out;
}
