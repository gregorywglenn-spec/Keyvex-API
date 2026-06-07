/**
 * MCP tool: get_treasury_auctions
 *
 * Returns Treasury security auction records — Bills, Notes, Bonds, TIPS,
 * and FRNs. Each record is one specific CUSIP issuance with the auction's
 * pre-announcement metadata + post-auction results (bid-to-cover ratio,
 * yields, bidder breakdowns, Fed SOMA allocation).
 *
 * Use this when the user asks about: demand for Treasury debt, recent
 * auction results, yields at specific maturities, Fed QE/QT activity
 * (via SOMA holdings), foreign demand (indirect bidders), or upcoming
 * auction announcements.
 *
 * Pairs with congressional votes on debt-ceiling / budget bills and
 * with broader macro analysis when combined with bills + roll-call votes.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryTreasuryAuctions } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  ResultEnvelope,
  TreasuryAuction,
  TreasuryAuctionsQuery,
} from "../types.js";

export const definition: Tool = {
  name: "get_treasury_auctions",
  annotations: {
    title: "US Treasury Auctions",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns Treasury security auctions — Bills (≤1yr), Notes (2-10yr),",
    "Bonds (20-30yr), TIPS (inflation-protected), and FRNs (floating-rate).",
    "Each record is one CUSIP issuance with announcement metadata + post-",
    "auction results.",
    "",
    "Key signal fields agents care about:",
    "  - bid_to_cover_ratio: demand. >2.5 strong, <2.0 weak.",
    "  - high_yield / average_yield: market clearing rate.",
    "  - direct_bidder / indirect_bidder breakdowns: domestic vs foreign demand.",
    "  - soma_holdings + soma_included: Fed System Open Market Account",
    "    allocation. A live measure of Fed QE/QT activity on each issue.",
    "",
    "Records have a two-stage lifecycle: announcement (results fields null)",
    "→ post-auction (full results populated). Idempotent saves on cusip +",
    "auction_date overwrite cleanly when results publish.",
    "",
    "Security types: 'Bill', 'Note', 'Bond', 'TIPS', 'FRN', 'CMB' (cash-",
    "management bill). Use security_type filter to focus on one term group.",
    "Note: Treasury reports TIPS and FRNs under security_type Note/Bond with an",
    "inflation-indexed / floating-rate flag (not as their own type); filtering",
    "security_type:'TIPS' or 'FRN' here resolves to those flags for convenience.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      cusip: {
        type: "string",
        description: "Filter to one specific CUSIP issuance.",
      },
      security_type: {
        type: "string",
        description: "e.g. 'Bill', 'Note', 'Bond', 'TIPS', 'FRN', 'CMB'.",
      },
      reopening: {
        type: "boolean",
        description: "Filter to reopenings (new tranches of an existing CUSIP) only when true.",
      },
      min_offering_amount: {
        type: "number",
        description: "Filter to auctions with offering_amount >= this dollar amount.",
      },
      min_bid_to_cover: {
        type: "number",
        description: "Filter to auctions with bid_to_cover_ratio >= this value (e.g. 2.5 for strong-demand auctions only).",
      },
      since: {
        type: "string",
        description: "ISO date YYYY-MM-DD. Applied to sort_by field.",
      },
      until: {
        type: "string",
        description: "ISO date YYYY-MM-DD.",
      },
      sort_by: {
        type: "string",
        enum: [
          "auction_date",
          "issue_date",
          "maturity_date",
          "offering_amount",
          "bid_to_cover_ratio",
        ],
        description: "Default auction_date.",
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
): Promise<ResultEnvelope<TreasuryAuction>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryTreasuryAuctions(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): TreasuryAuctionsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: TreasuryAuctionsQuery = {};

  if (args.cusip !== undefined) {
    if (typeof args.cusip !== "string") {
      throw new Error("cusip must be a string");
    }
    out.cusip = args.cusip.toUpperCase();
  }
  if (args.security_type !== undefined) {
    if (typeof args.security_type !== "string") {
      throw new Error("security_type must be a string");
    }
    out.security_type = args.security_type;
  }
  if (args.reopening !== undefined) {
    out.reopening = parseBooleanArg(args.reopening, "reopening");
  }
  if (args.min_offering_amount !== undefined) {
    if (
      typeof args.min_offering_amount !== "number" ||
      args.min_offering_amount < 0
    ) {
      throw new Error("min_offering_amount must be a non-negative number");
    }
    out.min_offering_amount = args.min_offering_amount;
  }
  if (args.min_bid_to_cover !== undefined) {
    if (
      typeof args.min_bid_to_cover !== "number" ||
      args.min_bid_to_cover < 0
    ) {
      throw new Error("min_bid_to_cover must be a non-negative number");
    }
    out.min_bid_to_cover = args.min_bid_to_cover;
  }
  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");
  if (args.sort_by !== undefined) {
    const valid: TreasuryAuctionsQuery["sort_by"][] = [
      "auction_date",
      "issue_date",
      "maturity_date",
      "offering_amount",
      "bid_to_cover_ratio",
    ];
    if (!valid.includes(args.sort_by as TreasuryAuctionsQuery["sort_by"])) {
      throw new Error(`INVALID sort_by: '${String(args.sort_by)}'`);
    }
    out.sort_by = args.sort_by as TreasuryAuctionsQuery["sort_by"];
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

function parseIsoDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`INVALID_DATE: ${fieldName} must be a string`);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(`INVALID_DATE: ${fieldName}='${value}'`);
  }
  return value;
}
