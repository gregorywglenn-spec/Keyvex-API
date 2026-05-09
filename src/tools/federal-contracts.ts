/**
 * MCP tool: get_federal_contracts
 *
 * Exposes federal contract awards from USAspending.gov via the
 * federal_contracts Firestore collection. The political-alpha bridge
 * outside the SEC vertical — joins to congressional_trades by
 * recipient_name (substring) + date for "Senator buys defense stock,
 * defense contract awarded" cross-source queries.
 *
 * Standalone tool, not a param extension on get_congressional_trades or
 * get_institutional_holdings. Federal contracts are structurally a
 * different signal than anything else in the v1 surface — they're
 * government spending events, not positions or transactions or ownership
 * disclosures.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryFederalContractAwards } from "../firestore.js";
import type {
  FederalContractAward,
  FederalContractAwardsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_federal_contracts",
  description: [
    "Returns federal contract awards from USAspending.gov — government",
    "spending data sourced from Treasury/GSA. Each record is one prime",
    "contract award (BPA Call, Purchase Order, Delivery Order, or",
    "Definitive Contract). Modifications appear as separate records.",
    "",
    "Use this when the user asks about: who's getting federal contracts,",
    "how much a specific recipient (Lockheed Martin, RTX, Raytheon,",
    "Booz Allen, etc.) won this year/quarter, contracts by industry",
    "(NAICS code) or product type (PSC code), or to cross-reference",
    "congressional trading with contract awards.",
    "",
    "Cross-source pattern (the political-alpha play):",
    "  1. get_congressional_trades(ticker:'LMT', since:'2026-01-01') —",
    "     find LMT trades by members of Congress.",
    "  2. get_federal_contracts(recipient_name:'Lockheed Martin',",
    "     since:'2026-01-01') — find LMT contract awards.",
    "  3. Compare timing — trades within 30 days before a major contract",
    "     are the high-signal cases.",
    "",
    "recipient_name is a case-insensitive substring match — use the",
    "parent name ('Lockheed Martin') to catch all subsidiaries.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      recipient_name: {
        type: "string",
        description:
          "Recipient name substring; case-insensitive match. Example: 'Lockheed Martin' matches 'LOCKHEED MARTIN CORP', 'LOCKHEED MARTIN MISSILES AND FIRE CONTROL', etc.",
      },
      recipient_uei: {
        type: "string",
        description:
          "Unique Entity Identifier (replaced DUNS in 2022). 12-character alphanumeric. Exact match.",
      },
      awarding_agency: {
        type: "string",
        description:
          "Awarding agency exact name. Examples: 'Department of Defense', 'National Aeronautics and Space Administration', 'Department of Health and Human Services'.",
      },
      naics_code: {
        type: "string",
        description:
          "6-digit North American Industry Classification System code. Example: '541710' (R&D in Physical/Engineering/Life Sciences). Exact match.",
      },
      psc_code: {
        type: "string",
        description:
          "Product or Service Code (4-character). Example: 'AR33' (R&D Space Flight Advanced Development). Exact match.",
      },
      min_amount: {
        type: "number",
        description:
          "Filter to awards with award_amount >= this value (USD). Use to focus on large contracts.",
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
          "last_modified_date",
          "start_date",
          "award_amount",
          "total_outlays",
        ],
        description:
          "Field used for ordering and for the since/until filters. last_modified_date = most recent modification on USAspending; start_date = period of performance start; award_amount = obligated dollars; total_outlays = dollars actually paid out. Default: last_modified_date.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc.",
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
): Promise<ResultEnvelope<FederalContractAward>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryFederalContractAwards(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): FederalContractAwardsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: FederalContractAwardsQuery = {};

  if (args.recipient_name !== undefined) {
    if (typeof args.recipient_name !== "string") {
      throw new Error("recipient_name must be a string");
    }
    out.recipient_name = args.recipient_name;
  }

  if (args.recipient_uei !== undefined) {
    if (
      typeof args.recipient_uei !== "string" ||
      !/^[A-Z0-9]{12}$/i.test(args.recipient_uei)
    ) {
      throw new Error(
        `INVALID_UEI: '${String(args.recipient_uei)}' — expected 12 alphanumeric characters`,
      );
    }
    out.recipient_uei = args.recipient_uei.toUpperCase();
  }

  if (args.awarding_agency !== undefined) {
    if (typeof args.awarding_agency !== "string") {
      throw new Error("awarding_agency must be a string");
    }
    out.awarding_agency = args.awarding_agency;
  }

  if (args.naics_code !== undefined) {
    if (
      typeof args.naics_code !== "string" ||
      !/^\d{6}$/.test(args.naics_code)
    ) {
      throw new Error(
        `INVALID_NAICS: '${String(args.naics_code)}' — expected 6 digits`,
      );
    }
    out.naics_code = args.naics_code;
  }

  if (args.psc_code !== undefined) {
    if (
      typeof args.psc_code !== "string" ||
      !/^[A-Z0-9]{4}$/i.test(args.psc_code)
    ) {
      throw new Error(
        `INVALID_PSC: '${String(args.psc_code)}' — expected 4 alphanumeric characters`,
      );
    }
    out.psc_code = args.psc_code.toUpperCase();
  }

  if (args.min_amount !== undefined) {
    if (typeof args.min_amount !== "number" || args.min_amount < 0) {
      throw new Error("min_amount must be a non-negative number");
    }
    out.min_amount = args.min_amount;
  }

  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }

  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }

  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "last_modified_date" &&
      args.sort_by !== "start_date" &&
      args.sort_by !== "award_amount" &&
      args.sort_by !== "total_outlays"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected last_modified_date | start_date | award_amount | total_outlays`,
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
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
