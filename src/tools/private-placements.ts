/**
 * MCP tool: get_private_placements
 *
 * Returns SEC Form D filings — exempt private placement / Reg D offering
 * notices. The 16th MCP tool. Surfaces the canonical "who's raising
 * private capital, when, in which industry, under which exemption, and
 * how much" disclosure stream.
 *
 * Use cases:
 *   - VC / PE / startup tracking ("who's raising right now")
 *   - Detect new fund formations (LP / LLC vehicle creation)
 *   - Industry-rotation analysis (which sectors are attracting capital)
 *   - Identify directors + executive officers of newly-formed entities
 *
 * Pure-publisher posture: returns as filed. No "round velocity",
 * "deal quality", or "investor enthusiasm" derived signals.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryPrivatePlacements } from "../firestore.js";
import type {
  PrivatePlacement,
  PrivatePlacementsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_private_placements",
  annotations: {
    title: "Private Placements (SEC Form D)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns SEC Form D filings — Reg D / Rule 506 private placement",
    "offering notices. Use this when the user asks about: who's raising",
    "private capital right now, new VC fund formations, private equity",
    "raises, real-estate syndicates, hedge fund launches, who's claiming",
    "Rule 506(b) vs 506(c) exemption, or to identify directors / executive",
    "officers of newly-formed entities.",
    "",
    "Source: SEC EDGAR full-text search + per-filing primary_doc.xml. All",
    "Reg D filings (504 / 506(b) / 506(c)) plus Section 4(a) exempt",
    "offerings flow through here. Form D must be filed within 15 days of",
    "the first sale.",
    "",
    "Each record carries: issuer entity (name, CIK, address, jurisdiction",
    "of incorporation, entity type), offering data (industry group,",
    "investment fund type for pooled funds, total offering / sold /",
    "remaining, minimum investment, federal_exemptions claimed), filing",
    "metadata (file_date, date_of_first_sale, is_amendment), and a",
    "related_persons[] array of directors / executive officers / promoters.",
    "",
    "Federal exemption codes (federal_exemptions array):",
    "  06b   — Rule 506(b) (no general solicitation; up to 35 non-accredited)",
    "  06c   — Rule 506(c) (general solicitation OK; all accredited)",
    "  04(2) — Section 4(a)(2) (statutory private placement)",
    "  3C    — ICA Section 3(c) (3(c)(1), 3(c)(5), 3(c)(7) etc. — common for funds)",
    "  3C.1  — ICA 3(c)(1) (up to 100 investors)",
    "  3C.7  — ICA 3(c)(7) (qualified purchasers only)",
    "",
    "Common industry_group_type values:",
    "  'Pooled Investment Fund' (with investment_fund_type='Venture Capital",
    "  Fund' | 'Private Equity Fund' | 'Hedge Fund' | 'Other Investment Fund')",
    "  'Technology', 'Real Estate', 'Health Care', 'Energy', 'Financial",
    "  Services', 'Manufacturing', 'Other'.",
    "",
    "Direct filing_id lookup is fastest (accession number). Substring",
    "filters on issuer_name, industry_group_type, investment_fund_type,",
    "and jurisdiction_of_inc enable topic-style queries. Combine",
    "federal_exemption + min_amount_sold for 'who's raising real money",
    "under 506(c)' analyses.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      filing_id: {
        type: "string",
        description:
          "EDGAR accession number (e.g., '0002131143-26-000001'). Direct doc lookup, fastest.",
      },
      issuer_cik: {
        type: "string",
        description: "Issuer's SEC CIK (1-10 digits; we zero-pad internally).",
      },
      issuer_name: {
        type: "string",
        description:
          "Case-insensitive substring against the issuer's filed entity name.",
      },
      issuer_state: {
        type: "string",
        description:
          "Issuer's state (2-letter code, e.g., 'CA', 'NY', 'DE'). Note many funds incorporate in DE while operating elsewhere.",
      },
      jurisdiction_of_inc: {
        type: "string",
        description:
          "Substring against state of incorporation (e.g., 'delaware', 'cayman').",
      },
      industry_group_type: {
        type: "string",
        description:
          "Substring against the top-level industry classification (e.g., 'technology', 'real estate', 'pooled investment').",
      },
      investment_fund_type: {
        type: "string",
        description:
          "Substring against the fund subtype, populated when industry_group_type is 'Pooled Investment Fund' (e.g., 'venture capital', 'private equity', 'hedge').",
      },
      federal_exemption: {
        type: "string",
        description:
          "Filter to filings claiming a specific exemption code via array-contains. Common: '06b' (506(b)), '06c' (506(c)), '3C.1', '3C.7'.",
      },
      is_amendment: {
        type: "boolean",
        description:
          "When set, restricts to D/A amendments (true) or original D filings (false). Default: both.",
      },
      min_amount_sold: {
        type: "number",
        description:
          "Minimum total_amount_sold (USD). Filters out trivial offerings — use 1000000 for 'real raises'.",
      },
      since: {
        type: "string",
        description: "date_of_first_sale lower bound (YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "date_of_first_sale upper bound (YYYY-MM-DD inclusive).",
      },
      sort_by: {
        type: "string",
        enum: ["file_date", "date_of_first_sale", "total_amount_sold"],
        description: "Default: file_date (most recently filed first).",
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
        description: "Maximum filings to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<PrivatePlacement>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryPrivatePlacements(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): PrivatePlacementsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: PrivatePlacementsQuery = {};

  if (args.filing_id !== undefined) {
    if (typeof args.filing_id !== "string") {
      throw new Error("filing_id must be a string");
    }
    out.filing_id = args.filing_id;
  }

  if (args.issuer_cik !== undefined) {
    if (
      typeof args.issuer_cik !== "string" ||
      !/^\d{1,10}$/.test(args.issuer_cik)
    ) {
      throw new Error(
        `INVALID_CIK: '${String(args.issuer_cik)}' — expected 1-10 digit CIK`,
      );
    }
    out.issuer_cik = args.issuer_cik;
  }

  if (args.issuer_name !== undefined) {
    if (typeof args.issuer_name !== "string") {
      throw new Error("issuer_name must be a string");
    }
    out.issuer_name = args.issuer_name;
  }

  if (args.issuer_state !== undefined) {
    if (
      typeof args.issuer_state !== "string" ||
      !/^[A-Z]{2}$/i.test(args.issuer_state)
    ) {
      throw new Error(
        `INVALID issuer_state: '${String(args.issuer_state)}' — expected 2-letter abbreviation`,
      );
    }
    out.issuer_state = args.issuer_state.toUpperCase();
  }

  if (args.jurisdiction_of_inc !== undefined) {
    if (typeof args.jurisdiction_of_inc !== "string") {
      throw new Error("jurisdiction_of_inc must be a string");
    }
    out.jurisdiction_of_inc = args.jurisdiction_of_inc;
  }

  if (args.industry_group_type !== undefined) {
    if (typeof args.industry_group_type !== "string") {
      throw new Error("industry_group_type must be a string");
    }
    out.industry_group_type = args.industry_group_type;
  }

  if (args.investment_fund_type !== undefined) {
    if (typeof args.investment_fund_type !== "string") {
      throw new Error("investment_fund_type must be a string");
    }
    out.investment_fund_type = args.investment_fund_type;
  }

  if (args.federal_exemption !== undefined) {
    if (typeof args.federal_exemption !== "string") {
      throw new Error("federal_exemption must be a string");
    }
    out.federal_exemption = args.federal_exemption;
  }

  if (args.is_amendment !== undefined) {
    if (typeof args.is_amendment !== "boolean") {
      throw new Error("is_amendment must be a boolean");
    }
    out.is_amendment = args.is_amendment;
  }

  if (args.min_amount_sold !== undefined) {
    if (
      typeof args.min_amount_sold !== "number" ||
      !Number.isFinite(args.min_amount_sold) ||
      args.min_amount_sold < 0
    ) {
      throw new Error(
        `INVALID min_amount_sold: '${String(args.min_amount_sold)}' — expected non-negative number`,
      );
    }
    out.min_amount_sold = args.min_amount_sold;
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

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["file_date", "date_of_first_sale", "total_amount_sold"].includes(
        args.sort_by,
      )
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected file_date | date_of_first_sale | total_amount_sold`,
      );
    }
    out.sort_by = args.sort_by as PrivatePlacementsQuery["sort_by"];
  }

  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    ) {
      throw new Error(`INVALID sort_order: '${String(args.sort_order)}'`);
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
