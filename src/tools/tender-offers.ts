/**
 * MCP tool: get_tender_offers
 *
 * Returns SEC Schedule TO filings — public tender offer disclosures.
 * The 12th MCP tool. Pairs with get_activist_stakes for the "stake →
 * bid" M&A cross-source story: an investor takes a 5%+ position
 * (Schedule 13D), then bids to acquire the rest of the company
 * (Schedule TO).
 *
 * v1A scope: metadata only. The full offer terms (price per share,
 * shares sought, expiration date, conditions) live inside the HTML
 * attachment at primary_document_url. Agents follow that URL when
 * they need offer-specific detail.
 *
 * Form codes:
 *   SC TO-T   — third-party tender offer (acquirer bidding for target)
 *   SC TO-T/A — amendment to a third-party offer (extension, revised price)
 *   SC TO-I   — issuer tender offer (company buying back its own shares)
 *   SC TO-I/A — issuer amendment
 *
 * Schedule TO is the FORMAL filing under SEC Rule 14d-1. Pre-commencement
 * press releases (SC TO-C) and target company recommendations (SC 14D9)
 * are deliberately excluded from v1A.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryTenderOffers } from "../firestore.js";
import type {
  ResultEnvelope,
  TenderOffer,
  TenderOffersQuery,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_tender_offers",
  description: [
    "Returns SEC Schedule TO filings — public tender offer disclosures.",
    "Use this when the user asks about: who's bidding to acquire company",
    "X, what M&A offers are in flight, share buyback announcements,",
    "amendments to existing tender offers (price increases / extensions),",
    "or to pair with 13D activist stakes for the 'stake → bid' story.",
    "",
    "Source: SEC EDGAR full-text search. Forms covered: SC TO-T (third-",
    "party tender offer — someone outside the company bidding for shares),",
    "SC TO-T/A (amendments), SC TO-I (issuer tender offer — company",
    "buying back its own shares), SC TO-I/A (issuer amendments).",
    "",
    "v1 returns filing metadata only — bidder + target + form type +",
    "filing date + URL. Offer price, shares sought, and expiration date",
    "live inside the HTML attachment at primary_document_url; agents",
    "follow that URL to read the substantive terms. Amendment filings",
    "share the same target/bidder/file_number as the original offer; use",
    "file_number to group an amendment chain.",
    "",
    "Pure-publisher posture: KeyVex does not derive 'likely to close' or",
    "'expected premium' signals. The data here is what was filed, no",
    "more.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      accession_number: {
        type: "string",
        description:
          "EDGAR accession number (e.g., '0001140361-26-020397'). Direct doc lookup, fastest path.",
      },
      target_ticker: {
        type: "string",
        description:
          "Target company ticker (e.g., 'KZR'). For SC TO-T this is the company being bid for; for SC TO-I this is the company buying back its own shares (target == bidder).",
      },
      target_cik: {
        type: "string",
        description:
          "Target's SEC CIK (10-digit zero-padded). Use when ticker is ambiguous (multiple share classes).",
      },
      target_name: {
        type: "string",
        description:
          "Case-insensitive substring against target_name. Useful when ticker isn't known (e.g., private companies in TO-T filings).",
      },
      bidder_cik: {
        type: "string",
        description:
          "Bidder's SEC CIK. Find all tender offers by a particular acquirer.",
      },
      bidder_name: {
        type: "string",
        description:
          "Case-insensitive substring against bidder_name. Bidders in SC TO-T are often private SPVs ('2025 Acquisition Company, LLC') — use this to find them by issuer / parent name.",
      },
      form_type: {
        type: "string",
        enum: ["SC TO-T", "SC TO-T/A", "SC TO-I", "SC TO-I/A"],
        description:
          "Exact form match. Useful for narrowing to amendments only ('SC TO-T/A') or original offers only ('SC TO-T').",
      },
      third_party_only: {
        type: "boolean",
        description:
          "When true, restricts to SC TO-T family (third-party offers). Default false.",
      },
      issuer_only: {
        type: "boolean",
        description:
          "When true, restricts to SC TO-I family (issuer buybacks). Default false.",
      },
      exclude_amendments: {
        type: "boolean",
        description:
          "When true, drops /A amendment filings. Default false (amendments included).",
      },
      since: {
        type: "string",
        description: "Filing date lower bound (ISO YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "Filing date upper bound (ISO YYYY-MM-DD inclusive).",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc (most recent filings first).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum filings to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<TenderOffer>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryTenderOffers(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): TenderOffersQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: TenderOffersQuery = {};

  if (args.accession_number !== undefined) {
    if (typeof args.accession_number !== "string") {
      throw new Error("accession_number must be a string");
    }
    out.accession_number = args.accession_number;
  }

  if (args.target_ticker !== undefined) {
    if (
      typeof args.target_ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.target_ticker)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.target_ticker)}' — expected stock ticker symbol`,
      );
    }
    out.target_ticker = args.target_ticker.toUpperCase();
  }

  if (args.target_cik !== undefined) {
    if (
      typeof args.target_cik !== "string" ||
      !/^\d{1,10}$/.test(args.target_cik)
    ) {
      throw new Error(
        `INVALID_CIK: '${String(args.target_cik)}' — expected 1-10 digit CIK`,
      );
    }
    out.target_cik = args.target_cik;
  }

  if (args.target_name !== undefined) {
    if (typeof args.target_name !== "string") {
      throw new Error("target_name must be a string");
    }
    out.target_name = args.target_name;
  }

  if (args.bidder_cik !== undefined) {
    if (
      typeof args.bidder_cik !== "string" ||
      !/^\d{1,10}$/.test(args.bidder_cik)
    ) {
      throw new Error(
        `INVALID_CIK: '${String(args.bidder_cik)}' — expected 1-10 digit CIK`,
      );
    }
    out.bidder_cik = args.bidder_cik;
  }

  if (args.bidder_name !== undefined) {
    if (typeof args.bidder_name !== "string") {
      throw new Error("bidder_name must be a string");
    }
    out.bidder_name = args.bidder_name;
  }

  if (args.form_type !== undefined) {
    if (
      typeof args.form_type !== "string" ||
      !["SC TO-T", "SC TO-T/A", "SC TO-I", "SC TO-I/A"].includes(args.form_type)
    ) {
      throw new Error(
        `INVALID form_type: '${String(args.form_type)}' — expected SC TO-T | SC TO-T/A | SC TO-I | SC TO-I/A`,
      );
    }
    out.form_type = args.form_type;
  }

  if (args.third_party_only !== undefined) {
    if (typeof args.third_party_only !== "boolean") {
      throw new Error("third_party_only must be a boolean");
    }
    out.third_party_only = args.third_party_only;
  }
  if (args.issuer_only !== undefined) {
    if (typeof args.issuer_only !== "boolean") {
      throw new Error("issuer_only must be a boolean");
    }
    out.issuer_only = args.issuer_only;
  }
  if (out.third_party_only && out.issuer_only) {
    throw new Error(
      "third_party_only and issuer_only are mutually exclusive — pick one",
    );
  }

  if (args.exclude_amendments !== undefined) {
    if (typeof args.exclude_amendments !== "boolean") {
      throw new Error("exclude_amendments must be a boolean");
    }
    out.exclude_amendments = args.exclude_amendments;
  }

  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    ) {
      throw new Error(`INVALID since: '${String(args.since)}' — expected YYYY-MM-DD`);
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    ) {
      throw new Error(`INVALID until: '${String(args.until)}' — expected YYYY-MM-DD`);
    }
    out.until = args.until;
  }

  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    ) {
      throw new Error(
        `INVALID sort_order: '${String(args.sort_order)}' — expected asc | desc`,
      );
    }
    out.sort_order = args.sort_order as "asc" | "desc";
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
