/**
 * MCP tool: get_federal_grants
 *
 * Federal GRANTS and cooperative agreements (separate universe from
 * federal_contracts). Recipients are universities, non-profits, state &
 * local agencies, research institutions, healthcare orgs, civil-society
 * groups — totally distinct from the defense / tech / IT contractor base
 * that dominates the contracts collection.
 *
 * Source: api.usaspending.gov /api/v2/search/spending_by_award/ with
 * award_type_codes ['02','03','04','05'].
 *
 * Cross-source value: agents asking "who got federal money this quarter"
 * now see both legs — contracts via get_federal_contracts, grants via
 * get_federal_grants. CFDA number provides the program-level join key
 * (e.g., all NIH R01 awards via CFDA 93.847).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryFederalGrants } from "../firestore.js";
import type {
  FederalGrant,
  FederalGrantsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_federal_grants",
  annotations: {
    title: "Federal Grants (USAspending)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns federal GRANTS and cooperative agreements from USAspending.",
    "Distinct universe from get_federal_contracts — recipients here are",
    "universities, non-profits, state and local agencies, research labs,",
    "healthcare institutions, public-private partnerships.",
    "",
    "Award type codes covered: 02 (Block Grant), 03 (Formula Grant),",
    "04 (Project Grant — most common), 05 (Cooperative Agreement).",
    "",
    "Killer query patterns:",
    "  - All NIH R01 grants this quarter: cfda_number='93.847' + since=...",
    "  - State and local infrastructure funding: awarding_agency='Department of Transportation' + min_amount=1000000",
    "  - Recipient-specific grant history: recipient_name='Stanford'",
    "  - Recipient by federal UEI: recipient_uei='ABC123XYZ' (most precise)",
    "",
    "Source: api.usaspending.gov — official Treasury federal-spending data.",
    "Awards covering both COVID/IIJA emergency-funding codes and routine",
    "appropriations. Pure-publisher posture: raw award data, no derived",
    "rankings or performance scores.",
    "",
    "Filter combinations note: server-side indexes support one equality",
    "filter (recipient_uei / awarding_agency / cfda_number) plus a date or",
    "amount sort. Substring on recipient_name applied client-side after a",
    "wider pre-fetch window.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      recipient_name: {
        type: "string",
        description:
          "Case-insensitive substring on recipient_name (e.g., 'Stanford', 'Mayo Clinic'). Substring filter; client-side.",
      },
      recipient_uei: {
        type: "string",
        description: "Exact federal UEI (Unique Entity ID) — most precise.",
      },
      awarding_agency: {
        type: "string",
        description:
          "Exact awarding-agency name (e.g., 'National Science Foundation', 'Department of Energy').",
      },
      cfda_number: {
        type: "string",
        description:
          "Catalog of Federal Domestic Assistance program number (e.g., '93.847' = NIH R01 research grants, '20.939' = highway safety improvement). Filter to one program.",
      },
      min_amount: {
        type: "number",
        description: "Inclusive lower bound on award_amount in dollars.",
      },
      since: {
        type: "string",
        description:
          "Inclusive lower bound on last_modified_date (YYYY-MM-DD).",
      },
      until: {
        type: "string",
        description:
          "Inclusive upper bound on last_modified_date (YYYY-MM-DD).",
      },
      sort_by: {
        type: "string",
        enum: ["last_modified_date", "start_date", "award_amount", "total_outlays"],
        description: "Sort key. Default: last_modified_date.",
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
): Promise<ResultEnvelope<FederalGrant>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryFederalGrants(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): FederalGrantsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: FederalGrantsQuery = {};

  if (args.recipient_name !== undefined) {
    if (typeof args.recipient_name !== "string")
      throw new Error("recipient_name must be string");
    out.recipient_name = args.recipient_name;
  }
  if (args.recipient_uei !== undefined) {
    if (typeof args.recipient_uei !== "string")
      throw new Error("recipient_uei must be string");
    out.recipient_uei = args.recipient_uei;
  }
  if (args.awarding_agency !== undefined) {
    if (typeof args.awarding_agency !== "string")
      throw new Error("awarding_agency must be string");
    out.awarding_agency = args.awarding_agency;
  }
  if (args.cfda_number !== undefined) {
    if (typeof args.cfda_number !== "string")
      throw new Error("cfda_number must be string");
    out.cfda_number = args.cfda_number;
  }
  if (args.min_amount !== undefined) {
    if (typeof args.min_amount !== "number" || args.min_amount < 0)
      throw new Error("min_amount must be a non-negative number");
    out.min_amount = args.min_amount;
  }
  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    )
      throw new Error("INVALID since: expected YYYY-MM-DD");
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    )
      throw new Error("INVALID until: expected YYYY-MM-DD");
    out.until = args.until;
  }
  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["last_modified_date", "start_date", "award_amount", "total_outlays"].includes(
        args.sort_by,
      )
    ) {
      throw new Error(
        "INVALID sort_by: expected last_modified_date | start_date | award_amount | total_outlays",
      );
    }
    out.sort_by = args.sort_by as FederalGrantsQuery["sort_by"];
  }
  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    )
      throw new Error("INVALID sort_order: expected asc | desc");
    out.sort_order = args.sort_order as FederalGrantsQuery["sort_order"];
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    )
      throw new Error("INVALID limit: expected integer 1..500");
    out.limit = args.limit;
  }

  return out;
}
