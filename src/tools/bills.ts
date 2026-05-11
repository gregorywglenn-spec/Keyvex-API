/**
 * MCP tool: get_bills
 *
 * Returns congressional bill metadata from api.congress.gov. The 13th MCP
 * tool. Pairs with get_roll_call_votes (votes on bills), get_member_profile
 * (members who sponsored or voted), and get_fec_candidate_profile (PACs
 * donating to those members) for the full "what's in flight in Congress
 * + who's paying whom" picture.
 *
 * v1A scope: metadata only — title, sponsors-via-api_url, latest action,
 * type, number, chamber. Full action history, cosponsors, bill text, and
 * summaries live at `api_url` (congress.gov detail endpoint) and
 * `congress_gov_url` (public-facing page).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryBills } from "../firestore.js";
import type { Bill, BillsQuery, ResultEnvelope } from "../types.js";

export const definition: Tool = {
  name: "get_bills",
  description: [
    "Returns congressional bill metadata from api.congress.gov. Use this",
    "when the user asks about: bills introduced this Congress, the status",
    "of a specific bill, House vs Senate bill volume, what bills mention",
    "a topic, or to bridge from a roll-call vote (legislation_type +",
    "legislation_number) to the underlying bill.",
    "",
    "Source: api.congress.gov v3 (Library of Congress). Covers ALL bill",
    "types: HR (House Bill), S (Senate Bill), HRES (House Simple",
    "Resolution), SRES (Senate Simple Resolution), HJRES (House Joint",
    "Resolution), SJRES (Senate Joint Resolution), HCONRES (House",
    "Concurrent Resolution), SCONRES (Senate Concurrent Resolution).",
    "",
    "v1A returns metadata only: title, type + number, originating chamber,",
    "latest action (date + text), and links. Sponsors, cosponsors, full",
    "action history, bill text, and CRS summaries live at `api_url`",
    "(structured JSON) and `congress_gov_url` (public HTML). Agents follow",
    "those for prose detail.",
    "",
    "Bill identifiers are stable composite keys formatted as",
    "{congress}-{TYPE}-{number}, e.g., '119-HR-134', '119-S-1234',",
    "'118-HJRES-5'. Use bill_id for the fastest direct lookup.",
    "",
    "Pure-publisher posture: KeyVex returns what's in the public record.",
    "No legislative outcome predictions, no 'likely to pass' signals.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      bill_id: {
        type: "string",
        description:
          "Composite bill identifier ('{congress}-{TYPE}-{number}', e.g., '119-HR-134'). Direct doc lookup, fastest path.",
      },
      congress: {
        type: "integer",
        description:
          "Congress number (e.g., 119 = January 2025 onward; 118 = January 2023 - January 2025).",
      },
      bill_type: {
        type: "string",
        enum: ["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"],
        description:
          "Type code. HR/S are bills; HRES/SRES are simple resolutions (single-chamber, non-binding); HJRES/SJRES are joint resolutions (both chambers, can become law); HCONRES/SCONRES are concurrent resolutions (both chambers, non-binding).",
      },
      title: {
        type: "string",
        description:
          "Case-insensitive substring against bill title. Useful for topic searches ('artificial intelligence', 'border security', etc.).",
      },
      origin_chamber: {
        type: "string",
        enum: ["House", "Senate"],
        description: "Filter to bills originating in one chamber.",
      },
      since: {
        type: "string",
        description:
          "Latest-action date lower bound (ISO YYYY-MM-DD inclusive). Useful for 'what's moved recently'.",
      },
      until: {
        type: "string",
        description: "Latest-action date upper bound (ISO YYYY-MM-DD inclusive).",
      },
      sort_by: {
        type: "string",
        enum: ["latest_action_date", "update_date"],
        description:
          "Sort key. Default: latest_action_date (most recently active first).",
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
        description: "Maximum bills to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<Bill>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryBills(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): BillsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: BillsQuery = {};

  if (args.bill_id !== undefined) {
    if (
      typeof args.bill_id !== "string" ||
      !/^\d{1,3}-(HR|S|HRES|SRES|HJRES|SJRES|HCONRES|SCONRES)-\d+$/i.test(
        args.bill_id,
      )
    ) {
      throw new Error(
        `INVALID_BILL_ID: '${String(args.bill_id)}' — expected format like '119-HR-134'`,
      );
    }
    out.bill_id = args.bill_id.toUpperCase();
  }

  if (args.congress !== undefined) {
    if (
      typeof args.congress !== "number" ||
      !Number.isInteger(args.congress) ||
      args.congress < 1 ||
      args.congress > 999
    ) {
      throw new Error(
        `INVALID congress: '${String(args.congress)}' — expected integer 1..999`,
      );
    }
    out.congress = args.congress;
  }

  if (args.bill_type !== undefined) {
    if (
      typeof args.bill_type !== "string" ||
      !["HR", "S", "HRES", "SRES", "HJRES", "SJRES", "HCONRES", "SCONRES"].includes(
        args.bill_type.toUpperCase(),
      )
    ) {
      throw new Error(`INVALID bill_type: '${String(args.bill_type)}'`);
    }
    out.bill_type = args.bill_type.toUpperCase();
  }

  if (args.title !== undefined) {
    if (typeof args.title !== "string") throw new Error("title must be a string");
    out.title = args.title;
  }

  if (args.origin_chamber !== undefined) {
    if (args.origin_chamber !== "House" && args.origin_chamber !== "Senate") {
      throw new Error(
        `INVALID origin_chamber: '${String(args.origin_chamber)}' — expected House | Senate`,
      );
    }
    out.origin_chamber = args.origin_chamber;
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
      !["latest_action_date", "update_date"].includes(args.sort_by)
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected latest_action_date | update_date`,
      );
    }
    out.sort_by = args.sort_by as BillsQuery["sort_by"];
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
