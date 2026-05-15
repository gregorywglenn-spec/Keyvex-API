/**
 * MCP tool: get_roll_call_votes
 *
 * Returns congressional roll-call vote metadata from api.congress.gov.
 * The 14th MCP tool. The "what they DID with their seat" piece — closes
 * the political-alpha killer combo with FEC ("who paid them") and
 * congressional_trades ("what they bought").
 *
 * v1A scope: vote-level metadata (chamber, roll call number, vote type,
 * result, linked bill). Per-member positions (yea/nay/present per
 * bioguide_id) live at `source_data_url` (Clerk's XML for the House,
 * Senate XML for the Senate) and are NOT extracted in v1A. v1.1 adds
 * a `roll_call_member_votes` collection with one row per (vote, member).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryRollCallVotes } from "../firestore.js";
import type {
  ResultEnvelope,
  RollCallVote,
  RollCallVotesQuery,
} from "../types.js";

export const definition: Tool = {
  name: "get_roll_call_votes",
  description: [
    "Returns congressional roll-call vote metadata (House + Senate) from",
    "api.congress.gov. Use this when the user asks about: recent votes",
    "in either chamber, votes on a specific bill, votes by date range,",
    "or to chain to per-member positions via the source_data_url.",
    "",
    "Sources: api.congress.gov v3 for House votes; senate.gov XML",
    "(legislative/LIS/roll_call_lists/) for Senate votes — joined into",
    "one collection. Captures roll-call (recorded) votes only — voice votes",
    "and unanimous-consent passages aren't roll calls and don't appear here.",
    "",
    "v1A returns vote-level metadata: chamber, roll call number, vote",
    "type, result, the legislation being voted on (linked via bill_id),",
    "and links to the Clerk's authoritative XML data. Per-member positions",
    "(yea/nay/present/not voting per bioguide_id) live in the XML at",
    "source_data_url; agents fetch that directly when they need member",
    "detail. v1.1 will add a separate roll_call_member_votes tool/",
    "collection for queryable per-member positions.",
    "",
    "Vote identifiers are stable composite keys: '{chamber}-{congress}-",
    "{session}-{rcNumber}', e.g., 'house-119-1-240' or 'senate-119-1-15'.",
    "",
    "Common vote_type values: 'Yea-And-Nay' (regular recorded vote),",
    "'2/3 Yea-And-Nay' (suspension of rules, requires 2/3 majority),",
    "'Recorded Vote', 'Quorum'. Common result values: 'Passed', 'Failed',",
    "'Agreed to', 'Rejected', 'Motion Agreed To', 'Motion Failed'.",
    "",
    "When a vote is on a bill, legislation_type + legislation_number are",
    "populated and bill_id is set to the composite key — use that to",
    "join to get_bills. For procedural votes (motion to recommit, motion",
    "to adjourn, etc.), those fields may be empty.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      vote_id: {
        type: "string",
        description:
          "Composite vote identifier ('{chamber}-{congress}-{session}-{rcNumber}', e.g., 'house-119-1-240'). Direct doc lookup, fastest path.",
      },
      congress: {
        type: "integer",
        description: "Congress number (e.g., 119).",
      },
      session_number: {
        type: "integer",
        enum: [1, 2],
        description:
          "Session within the Congress. Session 1 = first calendar year of the Congress; Session 2 = second year.",
      },
      chamber: {
        type: "string",
        enum: ["house", "senate"],
        description: "Filter to House or Senate roll calls.",
      },
      bill_id: {
        type: "string",
        description:
          "Filter to votes on a specific bill (composite key like '119-HR-134'). Use to chain a bill lookup → votes on that bill.",
      },
      legislation_type: {
        type: "string",
        enum: ["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"],
        description: "Filter to votes on a specific legislation type.",
      },
      result: {
        type: "string",
        description:
          "Substring match against result text (e.g., 'passed', 'failed', 'agreed').",
      },
      since: {
        type: "string",
        description: "Vote-start date lower bound (ISO YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "Vote-start date upper bound (ISO YYYY-MM-DD inclusive).",
      },
      sort_by: {
        type: "string",
        enum: ["start_date", "update_date"],
        description: "Default: start_date (most recent votes first).",
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
        description: "Maximum votes to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<RollCallVote>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryRollCallVotes(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): RollCallVotesQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: RollCallVotesQuery = {};

  if (args.vote_id !== undefined) {
    if (
      typeof args.vote_id !== "string" ||
      !/^(house|senate)-\d{1,3}-[12]-\d+$/i.test(args.vote_id)
    ) {
      throw new Error(
        `INVALID_VOTE_ID: '${String(args.vote_id)}' — expected '{house|senate}-{congress}-{1|2}-{rcNum}', e.g., 'house-119-1-240'`,
      );
    }
    out.vote_id = args.vote_id.toLowerCase();
  }

  if (args.congress !== undefined) {
    if (
      typeof args.congress !== "number" ||
      !Number.isInteger(args.congress) ||
      args.congress < 1 ||
      args.congress > 999
    ) {
      throw new Error(`INVALID congress: '${String(args.congress)}'`);
    }
    out.congress = args.congress;
  }

  if (args.session_number !== undefined) {
    if (args.session_number !== 1 && args.session_number !== 2) {
      throw new Error(
        `INVALID session_number: '${String(args.session_number)}' — expected 1 or 2`,
      );
    }
    out.session_number = args.session_number;
  }

  if (args.chamber !== undefined) {
    if (args.chamber !== "house" && args.chamber !== "senate") {
      throw new Error(
        `INVALID chamber: '${String(args.chamber)}' — expected 'house' or 'senate'`,
      );
    }
    out.chamber = args.chamber;
  }

  if (args.bill_id !== undefined) {
    if (
      typeof args.bill_id !== "string" ||
      !/^\d{1,3}-(HR|S|HRES|SRES|HJRES|SJRES|HCONRES|SCONRES)-\d+$/i.test(
        args.bill_id,
      )
    ) {
      throw new Error(
        `INVALID_BILL_ID: '${String(args.bill_id)}' — expected '{congress}-{TYPE}-{number}'`,
      );
    }
    out.bill_id = args.bill_id.toUpperCase();
  }

  if (args.legislation_type !== undefined) {
    if (
      typeof args.legislation_type !== "string" ||
      !["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"].includes(
        args.legislation_type.toUpperCase(),
      )
    ) {
      throw new Error(`INVALID legislation_type: '${String(args.legislation_type)}'`);
    }
    out.legislation_type = args.legislation_type.toUpperCase();
  }

  if (args.result !== undefined) {
    if (typeof args.result !== "string") throw new Error("result must be a string");
    out.result = args.result;
  }

  if (args.since !== undefined) {
    if (typeof args.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
      throw new Error(`INVALID since: '${String(args.since)}' — expected YYYY-MM-DD`);
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (typeof args.until !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.until)) {
      throw new Error(`INVALID until: '${String(args.until)}' — expected YYYY-MM-DD`);
    }
    out.until = args.until;
  }

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["start_date", "update_date"].includes(args.sort_by)
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected start_date | update_date`,
      );
    }
    out.sort_by = args.sort_by as RollCallVotesQuery["sort_by"];
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
