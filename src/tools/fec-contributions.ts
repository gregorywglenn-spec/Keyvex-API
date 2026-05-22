/**
 * MCP tool: get_fec_contributions
 *
 * Schedule A contributions — money flowing INTO a federal committee.
 * The "follow the money" half of the political-alpha play. Joins the
 * existing surface area in three load-bearing ways:
 *
 *   1. candidate_id → fec_candidates / fec_committees → bioguide_id (via
 *      name-match in get_member_profile) → ties the donor to a sitting
 *      member's committee assignments + roll-call votes + stock trades.
 *
 *   2. contributor_employer (substring) → lobbying_filings registrants
 *      → spots lobbyist-employee donations.
 *
 *   3. recipient_committee_id (designation=P) → ALL donations to one
 *      candidate's principal campaign committee, aggregable by donor.
 *
 * Default ingestion scope is $1,000+ contributions (signal-rich; filters
 * payroll-deduction memo noise that dominates raw FEC volume). Queries
 * can override with min_amount=200 (FEC itemization threshold) to see
 * smaller rows.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryFecContributions } from "../firestore.js";
import type {
  FecContribution,
  FecContributionQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_fec_contributions",
  annotations: {
    title: "FEC Campaign Contributions",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns FEC Schedule A contributions — itemized records of money",
    "flowing INTO a federal committee. This is the 'follow the money'",
    "data: who donated, how much, to which campaign / PAC / Super PAC,",
    "from which employer, in which cycle.",
    "",
    "Source: api.open.fec.gov/v1/schedules/schedule_a/ — the official",
    "FEC public-disclosure API. Itemization is required for ≥ $200 from",
    "an individual; PACs also report all PAC-to-PAC transfers. KeyVex's",
    "default ingestion floor is $1,000+ (filters payroll-deduction memo",
    "noise); set min_amount=200 to see itemized small donations too.",
    "",
    "Killer query patterns:",
    "  - Who funds Senator X? Pass recipient_committee_id (their principal",
    "    campaign committee from get_fec_candidate_profile). Sort by",
    "    amount DESC to see top donors.",
    "  - Did employee at company Y donate to candidate Z? Pass",
    "    contributor_employer='Y' + candidate_id='Z'.",
    "  - Show state-level fundraising patterns: contributor_state='CA'",
    "    + cycle=2026 + sort_by=contribution_receipt_amount DESC.",
    "  - Show big-dollar donors this week: min_amount=10000 +",
    "    since=YYYY-MM-DD (recent date) + sort_by=date DESC.",
    "",
    "Filter combinations note: server-side indexes support one equality",
    "filter (recipient_committee_id / candidate_id / entity_type /",
    "contributor_state) combined with date or amount sort + cycle. Other",
    "filters (contributor_name substring, contributor_employer substring,",
    "exclude_memos) are applied client-side after a wider pre-fetch.",
    "",
    "Entity types: IND (individual — most common), COM (committee),",
    "CCM (candidate committee), PAC (political action committee),",
    "PTY (party), CAN (candidate), ORG (organization), UNK (unknown).",
    "",
    "Memo rows: contribution_receipt_date may be null OR a sentinel future",
    "date on PAC payroll subtotal / aggregate rows (FEC's own data quirk).",
    "Those future-dated memos sort to the TOP under the default",
    "sort_by=contribution_receipt_date DESC, displacing real recent",
    "contributions. STRONGLY recommend exclude_memos=true for any 'recent",
    "contributions' or 'top contributions' query; the default is false",
    "only for backward-compat / debugging.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      sub_id: {
        type: "string",
        description:
          "FEC sub_id (globally unique row ID). Direct doc lookup, fastest.",
      },
      recipient_committee_id: {
        type: "string",
        description:
          "FEC committee ID receiving the contribution (e.g., 'C00580100' for Trump Make America Great Again Committee). Use get_fec_candidate_profile to find the principal committee for a candidate.",
      },
      candidate_id: {
        type: "string",
        description:
          "FEC candidate ID the recipient committee supports (e.g., 'S6PA00091' for Pat Toomey). Use this to find donations flowing toward a specific candidate via any of their committees.",
      },
      contributor_name: {
        type: "string",
        description:
          "Case-insensitive substring against the contributor's filed name. FEC names are typically LASTNAME, FIRSTNAME for individuals. Substring filter (client-side).",
      },
      contributor_employer: {
        type: "string",
        description:
          "Case-insensitive substring against the contributor's employer (free-text field). Useful for spotting concentrated donations from one company's workforce. Substring filter (client-side).",
      },
      contributor_state: {
        type: "string",
        description:
          "2-letter US state code of the contributor (e.g., 'CA', 'TX').",
      },
      entity_type: {
        type: "string",
        enum: ["IND", "COM", "CCM", "PAC", "PTY", "CAN", "ORG", "UNK"],
        description:
          "Entity type code: IND (individual — most common), COM (committee), CCM (candidate committee), PAC, PTY (party), CAN (candidate), ORG (organization), UNK (unknown).",
      },
      min_amount: {
        type: "number",
        description:
          "Inclusive lower bound on contribution_receipt_amount in dollars. KeyVex ingests $1,000+ by default; set 200 for FEC's itemization floor.",
      },
      max_amount: {
        type: "number",
        description: "Inclusive upper bound on contribution_receipt_amount.",
      },
      since: {
        type: "string",
        description:
          "Inclusive lower bound on contribution_receipt_date (YYYY-MM-DD).",
      },
      until: {
        type: "string",
        description:
          "Inclusive upper bound on contribution_receipt_date (YYYY-MM-DD).",
      },
      cycle: {
        type: "integer",
        description:
          "Election cycle year (2-year transaction period). Common values: 2026, 2024, 2022.",
      },
      exclude_memos: {
        type: "boolean",
        description:
          "When true, filters out rows flagged memoed_subtotal=true (PAC aggregate / payroll subtotal noise). Default false.",
      },
      sort_by: {
        type: "string",
        enum: ["contribution_receipt_date", "contribution_receipt_amount"],
        description: "Sort key. Default: contribution_receipt_date.",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc (most recent / largest first).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum contributions to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<FecContribution>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryFecContributions(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): FecContributionQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: FecContributionQuery = {};

  if (args.sub_id !== undefined) {
    if (typeof args.sub_id !== "string") {
      throw new Error("sub_id must be a string");
    }
    out.sub_id = args.sub_id;
  }

  if (args.recipient_committee_id !== undefined) {
    if (typeof args.recipient_committee_id !== "string") {
      throw new Error("recipient_committee_id must be a string");
    }
    out.recipient_committee_id = args.recipient_committee_id.toUpperCase();
  }

  if (args.candidate_id !== undefined) {
    if (typeof args.candidate_id !== "string") {
      throw new Error("candidate_id must be a string");
    }
    out.candidate_id = args.candidate_id.toUpperCase();
  }

  if (args.contributor_name !== undefined) {
    if (typeof args.contributor_name !== "string") {
      throw new Error("contributor_name must be a string");
    }
    out.contributor_name = args.contributor_name;
  }

  if (args.contributor_employer !== undefined) {
    if (typeof args.contributor_employer !== "string") {
      throw new Error("contributor_employer must be a string");
    }
    out.contributor_employer = args.contributor_employer;
  }

  if (args.contributor_state !== undefined) {
    if (
      typeof args.contributor_state !== "string" ||
      !/^[A-Z]{2}$/i.test(args.contributor_state)
    ) {
      throw new Error(
        `INVALID_STATE: '${String(args.contributor_state)}' — expected 2-letter abbreviation`,
      );
    }
    out.contributor_state = args.contributor_state.toUpperCase();
  }

  if (args.entity_type !== undefined) {
    if (
      typeof args.entity_type !== "string" ||
      !["IND", "COM", "CCM", "PAC", "PTY", "CAN", "ORG", "UNK"].includes(
        args.entity_type.toUpperCase(),
      )
    ) {
      throw new Error(
        `INVALID entity_type: '${String(args.entity_type)}' — expected IND | COM | CCM | PAC | PTY | CAN | ORG | UNK`,
      );
    }
    out.entity_type = args.entity_type.toUpperCase();
  }

  if (args.min_amount !== undefined) {
    if (typeof args.min_amount !== "number" || args.min_amount < 0) {
      throw new Error("min_amount must be a non-negative number");
    }
    out.min_amount = args.min_amount;
  }

  if (args.max_amount !== undefined) {
    if (typeof args.max_amount !== "number" || args.max_amount < 0) {
      throw new Error("max_amount must be a non-negative number");
    }
    out.max_amount = args.max_amount;
  }

  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    ) {
      throw new Error(`INVALID since: expected YYYY-MM-DD`);
    }
    out.since = args.since;
  }

  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    ) {
      throw new Error(`INVALID until: expected YYYY-MM-DD`);
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
      throw new Error(`INVALID cycle: expected integer year >= 1976`);
    }
    out.cycle = args.cycle;
  }

  if (args.exclude_memos !== undefined) {
    if (typeof args.exclude_memos !== "boolean") {
      throw new Error("exclude_memos must be a boolean");
    }
    out.exclude_memos = args.exclude_memos;
  }

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["contribution_receipt_date", "contribution_receipt_amount"].includes(
        args.sort_by,
      )
    ) {
      throw new Error(
        `INVALID sort_by: expected contribution_receipt_date | contribution_receipt_amount`,
      );
    }
    out.sort_by = args.sort_by as FecContributionQuery["sort_by"];
  }

  if (args.sort_order !== undefined) {
    if (
      typeof args.sort_order !== "string" ||
      !["asc", "desc"].includes(args.sort_order)
    ) {
      throw new Error(`INVALID sort_order: expected asc | desc`);
    }
    out.sort_order = args.sort_order as FecContributionQuery["sort_order"];
  }

  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    ) {
      throw new Error(`INVALID limit: expected integer 1..500`);
    }
    out.limit = args.limit;
  }

  return out;
}
