/**
 * MCP tool: get_fec_independent_expenditures
 *
 * Super PAC ad spending FOR or AGAINST federal candidates. Captures the
 * uncoordinated-spending vehicle that defined post-Citizens-United political
 * advertising. Separate from get_fec_contributions (money INTO a committee).
 *
 * Killer queries:
 *   - "Who's running attack ads against Senator X?"
 *     candidate_id + support_oppose="O" + sort by amount
 *   - "Which super PACs spent the most this cycle?"
 *     cycle=2026 + sort by amount + group by committee_id (agent-side)
 *   - "Top vendors getting paid by political super PACs"
 *     min_amount=10000 + sort by amount (then group by payee_name)
 *   - "Negative ad spend in PA Senate race"
 *     candidate_office_state="PA" + support_oppose="O"
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryFecIndependentExpenditures } from "../firestore.js";
import type {
  FecIndependentExpenditure,
  FecIndependentExpenditureQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_fec_independent_expenditures",
  description: [
    "Returns FEC Schedule E independent expenditures — money spent BY a",
    "super PAC (or IE-only PAC) uncoordinatedly FOR or AGAINST a federal",
    "candidate. Hallmark vehicle for political ad spending since Citizens",
    "United (2010).",
    "",
    "Critical signal: support_oppose_indicator — 'S' = support, 'O' = oppose.",
    "A single candidate often has dozens of S and O entries across many",
    "super PACs in one cycle. Filter by support_oppose='O' to find attack",
    "ads; 'S' to find positive ads.",
    "",
    "Source: api.open.fec.gov/v1/schedules/schedule_e/. F24 filings (24-hour",
    "notices within 20 days of an election) and F5 (quarterly IE reports)",
    "both flow through this endpoint.",
    "",
    "Killer query patterns:",
    "  - Attack ads on Senator X: candidate_id='S6PA00091' + support_oppose='O'",
    "  - Top super PAC spenders this cycle: cycle=2026 + min_amount=100000",
    "  - Top political ad vendors: payee_name='AXIOM' (substring)",
    "  - Negative spend in a race: candidate_office_state='PA' + support_oppose='O'",
    "",
    "Filter combinations note: server-side indexes support one equality",
    "filter (candidate_id / committee_id / support_oppose / candidate_office_state)",
    "+ cycle + a date / amount sort. Other filters (payee_name, description,",
    "exclude_memos) are applied client-side.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      sub_id: {
        type: "string",
        description: "FEC sub_id (globally unique row ID). Direct doc lookup.",
      },
      committee_id: {
        type: "string",
        description:
          "FEC committee that spent the money (typically a super PAC).",
      },
      candidate_id: {
        type: "string",
        description: "Target candidate being supported or opposed.",
      },
      support_oppose: {
        type: "string",
        enum: ["S", "O"],
        description:
          "'S' = filter to ads supporting the target; 'O' = filter to ads opposing. Omit for both.",
      },
      payee_name: {
        type: "string",
        description:
          "Case-insensitive substring on the payee_name (ad agency, media buyer, vendor). Client-side filter.",
      },
      description: {
        type: "string",
        description:
          "Case-insensitive substring on disbursement_description (free-text purpose of the spend, e.g., 'tv ad', 'mailer', 'digital advertising'). Client-side filter.",
      },
      candidate_office: {
        type: "string",
        enum: ["H", "S", "P"],
        description: "Office of the target candidate: H/S/P.",
      },
      candidate_office_state: {
        type: "string",
        description:
          "2-letter state code of the target candidate (e.g., 'PA', 'TX').",
      },
      min_amount: {
        type: "number",
        description: "Inclusive lower bound on expenditure_amount in dollars.",
      },
      max_amount: {
        type: "number",
        description: "Inclusive upper bound on expenditure_amount.",
      },
      since: {
        type: "string",
        description:
          "Inclusive lower bound on expenditure_date (YYYY-MM-DD).",
      },
      until: {
        type: "string",
        description:
          "Inclusive upper bound on expenditure_date (YYYY-MM-DD).",
      },
      cycle: {
        type: "integer",
        description: "Election cycle (2-year transaction period). 2026/2024/2022.",
      },
      exclude_memos: {
        type: "boolean",
        description: "When true, filters out memoed_subtotal rows. Default false.",
      },
      sort_by: {
        type: "string",
        enum: ["expenditure_date", "expenditure_amount"],
        description: "Sort key. Default: expenditure_date.",
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
        description: "Max records. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<FecIndependentExpenditure>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryFecIndependentExpenditures(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): FecIndependentExpenditureQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: FecIndependentExpenditureQuery = {};

  if (args.sub_id !== undefined) {
    if (typeof args.sub_id !== "string") throw new Error("sub_id must be string");
    out.sub_id = args.sub_id;
  }
  if (args.committee_id !== undefined) {
    if (typeof args.committee_id !== "string")
      throw new Error("committee_id must be string");
    out.committee_id = args.committee_id.toUpperCase();
  }
  if (args.candidate_id !== undefined) {
    if (typeof args.candidate_id !== "string")
      throw new Error("candidate_id must be string");
    out.candidate_id = args.candidate_id.toUpperCase();
  }
  if (args.support_oppose !== undefined) {
    if (
      typeof args.support_oppose !== "string" ||
      !["S", "O"].includes(args.support_oppose.toUpperCase())
    ) {
      throw new Error(`INVALID support_oppose: expected 'S' | 'O'`);
    }
    out.support_oppose = args.support_oppose.toUpperCase() as "S" | "O";
  }
  if (args.payee_name !== undefined) {
    if (typeof args.payee_name !== "string")
      throw new Error("payee_name must be string");
    out.payee_name = args.payee_name;
  }
  if (args.description !== undefined) {
    if (typeof args.description !== "string")
      throw new Error("description must be string");
    out.description = args.description;
  }
  if (args.candidate_office !== undefined) {
    if (
      typeof args.candidate_office !== "string" ||
      !["H", "S", "P"].includes(args.candidate_office.toUpperCase())
    ) {
      throw new Error(`INVALID candidate_office: expected H | S | P`);
    }
    out.candidate_office = args.candidate_office.toUpperCase();
  }
  if (args.candidate_office_state !== undefined) {
    if (
      typeof args.candidate_office_state !== "string" ||
      !/^[A-Z]{2}$/i.test(args.candidate_office_state)
    ) {
      throw new Error(
        `INVALID candidate_office_state: expected 2-letter abbreviation`,
      );
    }
    out.candidate_office_state = args.candidate_office_state.toUpperCase();
  }
  if (args.min_amount !== undefined) {
    if (typeof args.min_amount !== "number" || args.min_amount < 0)
      throw new Error("min_amount must be a non-negative number");
    out.min_amount = args.min_amount;
  }
  if (args.max_amount !== undefined) {
    if (typeof args.max_amount !== "number" || args.max_amount < 0)
      throw new Error("max_amount must be a non-negative number");
    out.max_amount = args.max_amount;
  }
  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    ) {
      throw new Error("INVALID since: expected YYYY-MM-DD");
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    ) {
      throw new Error("INVALID until: expected YYYY-MM-DD");
    }
    out.until = args.until;
  }
  if (args.cycle !== undefined) {
    if (
      typeof args.cycle !== "number" ||
      !Number.isInteger(args.cycle) ||
      args.cycle < 1976 ||
      args.cycle > 2100
    ) {
      throw new Error("INVALID cycle: expected integer year >= 1976");
    }
    out.cycle = args.cycle;
  }
  if (args.exclude_memos !== undefined) {
    if (typeof args.exclude_memos !== "boolean")
      throw new Error("exclude_memos must be boolean");
    out.exclude_memos = args.exclude_memos;
  }
  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["expenditure_date", "expenditure_amount"].includes(args.sort_by)
    ) {
      throw new Error(
        "INVALID sort_by: expected expenditure_date | expenditure_amount",
      );
    }
    out.sort_by = args.sort_by as FecIndependentExpenditureQuery["sort_by"];
  }
  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    ) {
      throw new Error("INVALID sort_order: expected asc | desc");
    }
    out.sort_order = args.sort_order as FecIndependentExpenditureQuery["sort_order"];
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    ) {
      throw new Error("INVALID limit: expected integer 1..500");
    }
    out.limit = args.limit;
  }

  return out;
}
