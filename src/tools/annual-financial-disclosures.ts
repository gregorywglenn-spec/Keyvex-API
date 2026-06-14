/**
 * MCP tool: get_annual_financial_disclosures
 *
 * Returns Form 278 (Public Financial Disclosure / Annual Financial Disclosure)
 * filings — the year-end snapshot members of Congress file each year showing
 * assets, income sources, liabilities, transactions, gifts, and outside
 * positions.
 *
 * Different from get_congressional_trades:
 *   - get_congressional_trades = real-time PTR transaction notices (per-trade)
 *   - get_annual_financial_disclosures = annual balance-sheet snapshot (per-filer)
 *
 * v1 scope: BOTH chambers (Senate eFD + House Clerk). Parsed records carry
 * structured `assets` (Schedule A) + `liabilities` with source-faithful
 * value RANGES (never collapsed to point estimates). When schedules can't be
 * parsed (Senate paper/scanned filings, parse skips), `content_parsed` is
 * false and `coverage_note` names the limitation — follow `report_url` to the
 * original. Net-worth roll-up is intentionally NOT provided: it would be a
 * KeyVex-derived aggregate, not a disclosed value (posture-gated).
 *
 * Composition pattern:
 *   1. get_annual_financial_disclosures(member_name:'Pelosi') —
 *      list every Form 278 Pelosi has filed
 *   2. Cross with get_congressional_trades(bioguide_id:'P000197') —
 *      her PTR-disclosed trades during the same period
 *   3. Cross with get_member_profile(bioguide_id:'P000197') —
 *      her party/state/committees for context
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryForm278Filings } from "../firestore.js";
import type {
  Form278Filing,
  Form278FilingsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_annual_financial_disclosures",
  annotations: {
    title: "Annual Financial Disclosures (Form 278)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns Form 278 (Public Financial Disclosure / Annual Financial",
    "Disclosure) filings — the annual snapshot members of Congress file",
    "each year showing assets, income sources, liabilities, transactions,",
    "gifts, outside positions, and (for spouse + dependent children) the",
    "same.",
    "",
    "SCOPE — v1 covers BOTH chambers: Senate (Senate eFD) and House",
    "(House Clerk). Filed by every senator and representative (and senior",
    "executive-branch officials, federal judges) by May 15 each year.",
    "",
    "Use this when the user asks about: a member's asset composition,",
    "outside income sources, board seats / outside positions, liabilities",
    "(mortgages, loans), or for compliance / news reporting on annual",
    "disclosures.",
    "",
    "CONTENT — when a filing's schedules were machine-parsed,",
    "`content_parsed` is true and the record carries structured `assets`",
    "(Schedule A) and `liabilities` arrays plus `asset_count` /",
    "`liability_count`. Values are SOURCE-FAITHFUL: `value_range` /",
    "`amount_range` are the disclosed RANGES verbatim (e.g.,",
    "'$50,001 - $100,000'), NOT point estimates — KeyVex does not collapse",
    "a range to a single number. Net-worth roll-up is intentionally NOT",
    "provided (it would be a KeyVex-derived aggregate, not a disclosed",
    "value). When schedules are unavailable — Senate PAPER (scanned-image)",
    "filings, which carry no machine-readable text, or the occasional",
    "parse skip — `content_parsed` is false and `coverage_note` names the",
    "limitation; follow `report_url` to read the original. This honest",
    "coverage boundary is never a silent omission.",
    "",
    "Different from get_congressional_trades: PTRs are per-trade real-time",
    "notices (filed within 30-45 days), while Form 278 is the year-end",
    "balance-sheet snapshot. Combine both for the full activity + position",
    "view of a member.",
    "",
    "Report types: 'Annual' (yearly filing covering prior calendar year),",
    "'New Filer' (initial disclosure on entering office), 'Termination'",
    "(final disclosure on leaving office), 'Combined' (annual+termination",
    "for filer who left mid-year), 'Amendment' (correction of a prior",
    "filing), 'Other' (rare).",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      bioguide_id: {
        type: "string",
        description:
          "Filer's bioguide_id (e.g., 'P000197' for Nancy Pelosi). Exact match. Most precise filter — BUT recently-filed records from new filers / candidates not yet in the member catalog have an empty bioguide_id until catalog back-fill runs (same as the party field below). So a bioguide_id query is not guaranteed exhaustive of a brand-new member's filings yet; cross-check with member_name for very recent filers.",
      },
      member_name: {
        type: "string",
        description:
          "Substring match against the filer's full name (case-insensitive). E.g., 'Pelosi', 'Mitch McConnell'. Use bioguide_id when possible for precision.",
      },
      chamber: {
        type: "string",
        enum: ["senate", "house"],
        description:
          "Filter to one chamber ('senate' or 'house'). v1 covers both.",
      },
      state: {
        type: "string",
        description:
          "Two-letter state code (e.g., 'CA', 'TX'). Exact match. Empty for candidate filings (the Senate eFD covers candidates too).",
      },
      party: {
        type: "string",
        description:
          "Party affiliation. Empty until back-fill from the member catalog runs; safer to filter by bioguide_id or member_name in the meantime.",
      },
      filing_year: {
        type: "integer",
        minimum: 1990,
        maximum: 2100,
        description:
          "The year of the FILING period being reported on (NOT the date filed). Most filers report the prior calendar year — e.g., a May 2026 Annual filing has filing_year=2025. New Filer reports cover the partial year up to filing.",
      },
      report_type: {
        type: "string",
        enum: [
          "Annual",
          "New Filer",
          "Termination",
          "Combined",
          "Amendment",
          "Periodic",
          "Other",
        ],
        description:
          "Filter to one filing flavor. Default is unfiltered (returns all types).",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Lower bound on the chosen sort_by field. Defaults to filtering by filing_date.",
      },
      until: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Upper bound on the chosen sort_by field.",
      },
      sort_by: {
        type: "string",
        enum: ["filing_date", "filing_year"],
        description:
          "Field to sort by. Default 'filing_date' (most recent filings first).",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Sort direction. Default 'desc'.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Max records to return (1-500). Default 50.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<Form278Filing>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryForm278Filings(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;
const STATE_RE = /^[A-Z]{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_REPORT_TYPES = new Set<Form278Filing["report_type"]>([
  "Annual",
  "New Filer",
  "Termination",
  "Combined",
  "Amendment",
  "Periodic",
  "Other",
]);

function validateAndNormalize(raw: unknown): Form278FilingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: Form278FilingsQuery = {};

  if (args.bioguide_id !== undefined) {
    if (
      typeof args.bioguide_id !== "string" ||
      !BIOGUIDE_RE.test(args.bioguide_id)
    ) {
      throw new Error(
        `INVALID bioguide_id: '${String(args.bioguide_id)}' — expected format like 'C001035' (one letter + 6 digits)`,
      );
    }
    out.bioguide_id = args.bioguide_id;
  }
  if (args.member_name !== undefined) {
    if (typeof args.member_name !== "string") {
      throw new Error("member_name must be a string");
    }
    out.member_name = args.member_name;
  }
  if (args.chamber !== undefined) {
    if (args.chamber !== "senate" && args.chamber !== "house") {
      throw new Error(`INVALID chamber: '${String(args.chamber)}' — expected 'senate' or 'house'`);
    }
    out.chamber = args.chamber;
  }
  if (args.state !== undefined) {
    if (typeof args.state !== "string" || !STATE_RE.test(args.state)) {
      throw new Error(
        `INVALID state: '${String(args.state)}' — expected two-letter code like 'CA'`,
      );
    }
    out.state = args.state;
  }
  if (args.party !== undefined) {
    if (typeof args.party !== "string") {
      throw new Error("party must be a string");
    }
    out.party = args.party;
  }
  if (args.filing_year !== undefined) {
    if (
      typeof args.filing_year !== "number" ||
      !Number.isInteger(args.filing_year) ||
      args.filing_year < 1990 ||
      args.filing_year > 2100
    ) {
      throw new Error(
        `INVALID filing_year: '${String(args.filing_year)}' — expected integer 1990..2100`,
      );
    }
    out.filing_year = args.filing_year;
  }
  if (args.report_type !== undefined) {
    if (
      typeof args.report_type !== "string" ||
      !VALID_REPORT_TYPES.has(args.report_type as Form278Filing["report_type"])
    ) {
      throw new Error(
        `INVALID report_type: '${String(args.report_type)}' — expected one of ${[...VALID_REPORT_TYPES].join(", ")}`,
      );
    }
    out.report_type = args.report_type as Form278Filing["report_type"];
  }
  if (args.since !== undefined) {
    if (typeof args.since !== "string" || !ISO_DATE_RE.test(args.since)) {
      throw new Error(
        `INVALID since: '${String(args.since)}' — expected ISO date YYYY-MM-DD`,
      );
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (typeof args.until !== "string" || !ISO_DATE_RE.test(args.until)) {
      throw new Error(
        `INVALID until: '${String(args.until)}' — expected ISO date YYYY-MM-DD`,
      );
    }
    out.until = args.until;
  }
  if (args.sort_by !== undefined) {
    if (args.sort_by !== "filing_date" && args.sort_by !== "filing_year") {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected 'filing_date' or 'filing_year'`,
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
