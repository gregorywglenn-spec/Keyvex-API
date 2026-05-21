/**
 * MCP tool: get_lobbying_filings
 *
 * Returns LDA quarterly filings — who's paying lobbyists, which firms are
 * lobbying for them, on what issues, contacting which government entities.
 * Public record under the Lobbying Disclosure Act.
 *
 * The political-money complement to get_congressional_trades and
 * get_federal_contracts. Composition pattern:
 *   1. get_lobbying_filings(client_name:'Pfizer', filing_year:2025) —
 *      what Pfizer is paying lobbyists to work on this year.
 *   2. Cross with get_congressional_trades on the same time window —
 *      which senators traded pharma stock during that lobbying push.
 *   3. Cross with get_federal_contracts(recipient_name:'Pfizer') —
 *      what federal contracts Pfizer is winning.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryLobbyingFilings } from "../firestore.js";
import type {
  LobbyingFiling,
  LobbyingFilingsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_lobbying_filings",
  annotations: {
    title: "Lobbying Filings (LDA)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns Lobbying Disclosure Act (LDA) filings — quarterly LD-2",
    "reports filed by registered lobbyist firms with the Senate Office",
    "of Public Records. Each record covers one (registrant, client,",
    "quarter) tuple, listing income paid, issues lobbied on, and",
    "government entities contacted.",
    "",
    "Use this when the user asks about: who's paying lobbyists, what",
    "issues a company is lobbying on, which senators or agencies a firm",
    "is contacting, lobbying spend by industry or sector, or to cross",
    "lobbying activity against congressional trades or federal contracts",
    "for political-influence analysis.",
    "",
    "Each filing has a `lobbying_activities` array (one entry per issue",
    "area worked on) plus three flattened summary arrays at top level:",
    "  - general_issue_codes: 3-char codes (DEF, HEA, TRA, ENV, FIN, ...)",
    "  - government_entities: agencies/branches contacted",
    "  - lobbyist_names: lobbyists who worked the issue",
    "Top-level arrays support indexed queries; the nested array carries",
    "issue-level descriptions and lobbyist position info.",
    "",
    "`general_issue_codes` filter is OR-semantic — pass an array, match",
    "any filing containing AT LEAST ONE of those codes (max 30, per",
    "Firestore array-contains-any). Examples: ['DEF'] for defense,",
    "['HEA','MMM'] for health + Medicare/Medicaid, ['TAX','FIN'] for",
    "tax + financial services.",
    "",
    "Income/expenses are reported in USD per the registrant's filing.",
    "Income is null on registrations and on in-house lobbyist filings",
    "(those report expenses instead). client_is_government is true when",
    "the client is a government body (US states often hire lobbyists).",
    "",
    "Activity descriptions are truncated at 5000 chars during ingestion",
    "to stay under Firestore's per-doc cap; agents can fetch the full",
    "filing via filing_document_url for the unbounded prose.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      registrant_name: {
        type: "string",
        description:
          "Substring match against the lobbying firm's name (case-insensitive). E.g., 'Akin Gump', 'Brownstein'.",
      },
      client_name: {
        type: "string",
        description:
          "Substring match against the paying client's name (case-insensitive). E.g., 'Pfizer', 'Lockheed Martin', 'STATE OF CALIFORNIA'.",
      },
      filing_year: {
        type: "integer",
        minimum: 1999,
        maximum: 2100,
        description:
          "Calendar year of the reporting period (NOT the filing date).",
      },
      filing_period: {
        type: "string",
        enum: [
          "first_quarter",
          "second_quarter",
          "third_quarter",
          "fourth_quarter",
          "mid_year",
          "year_end",
        ],
        description:
          "Reporting period within filing_year. Quarters for LD-2; mid_year/year_end for LD-203 contributions windows.",
      },
      general_issue_codes: {
        type: "array",
        items: { type: "string" },
        description:
          "Array of 3-char issue codes (OR semantics). E.g., ['DEF'] for defense, ['HEA','MMM'] for health+Medicare. Max 30 codes per query.",
      },
      government_entity: {
        type: "string",
        description:
          "Substring match against any government entity contacted. E.g., 'SENATE', 'Treasury', 'FDA', 'Defense, Dept of'.",
      },
      min_income: {
        type: "number",
        description:
          "Filter to filings with income >= this amount (USD). Use to focus on big-dollar lobbying spend.",
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
      sort_by: {
        type: "string",
        enum: ["dt_posted", "filing_year", "income"],
        description:
          "Field used for ordering and for since/until filters. Default: dt_posted (when the filing was submitted).",
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
): Promise<ResultEnvelope<LobbyingFiling>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryLobbyingFilings(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

const ISSUE_CODE_RE = /^[A-Z]{2,4}$/;
const VALID_PERIODS = new Set([
  "first_quarter",
  "second_quarter",
  "third_quarter",
  "fourth_quarter",
  "mid_year",
  "year_end",
]);

function validateAndNormalize(raw: unknown): LobbyingFilingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: LobbyingFilingsQuery = {};

  if (args.registrant_name !== undefined) {
    if (typeof args.registrant_name !== "string") {
      throw new Error("registrant_name must be a string");
    }
    out.registrant_name = args.registrant_name;
  }
  if (args.client_name !== undefined) {
    if (typeof args.client_name !== "string") {
      throw new Error("client_name must be a string");
    }
    out.client_name = args.client_name;
  }

  if (args.filing_year !== undefined) {
    if (
      typeof args.filing_year !== "number" ||
      !Number.isInteger(args.filing_year) ||
      args.filing_year < 1999 ||
      args.filing_year > 2100
    ) {
      throw new Error(
        `INVALID filing_year: '${String(args.filing_year)}' — expected integer 1999..2100`,
      );
    }
    out.filing_year = args.filing_year;
  }

  if (args.filing_period !== undefined) {
    if (
      typeof args.filing_period !== "string" ||
      !VALID_PERIODS.has(args.filing_period)
    ) {
      throw new Error(
        `INVALID filing_period: '${String(args.filing_period)}' — expected ${[...VALID_PERIODS].join(" | ")}`,
      );
    }
    out.filing_period = args.filing_period;
  }

  if (args.general_issue_codes !== undefined) {
    if (!Array.isArray(args.general_issue_codes)) {
      throw new Error("general_issue_codes must be an array of strings");
    }
    if (args.general_issue_codes.length === 0) {
      throw new Error("general_issue_codes must be non-empty when provided");
    }
    if (args.general_issue_codes.length > 30) {
      throw new Error(
        `INVALID general_issue_codes: ${args.general_issue_codes.length} codes — max 30 per Firestore array-contains-any`,
      );
    }
    const codes: string[] = [];
    for (const code of args.general_issue_codes) {
      if (typeof code !== "string" || !ISSUE_CODE_RE.test(code.toUpperCase())) {
        throw new Error(
          `INVALID general_issue_code: '${String(code)}' — expected 2-4 uppercase letters (e.g., DEF, HEA)`,
        );
      }
      codes.push(code.toUpperCase());
    }
    out.general_issue_codes = codes;
  }

  if (args.government_entity !== undefined) {
    if (typeof args.government_entity !== "string") {
      throw new Error("government_entity must be a string");
    }
    out.government_entity = args.government_entity;
  }

  if (args.min_income !== undefined) {
    if (typeof args.min_income !== "number" || args.min_income < 0) {
      throw new Error("min_income must be a non-negative number");
    }
    out.min_income = args.min_income;
  }

  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");

  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "dt_posted" &&
      args.sort_by !== "filing_year" &&
      args.sort_by !== "income"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected dt_posted | filing_year | income`,
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
