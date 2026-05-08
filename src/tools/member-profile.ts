/**
 * MCP tool: get_member_profile
 *
 * Returns one or more legislator records from the unitedstates/congress-
 * legislators catalog. The 6th v1 tool — finally unblocked now that the
 * bioguide ingestion has landed.
 *
 * Every congressional_trades record carries a bioguide_id; this tool is
 * how an agent looks up the rich member metadata (party, state, chamber,
 * district, committee assignments) keyed off that id.
 *
 * Cross-source pattern (the political-alpha play, fully wired now):
 *   1. get_congressional_trades(ticker:'LMT') — returns trades, each
 *      with bioguide_id.
 *   2. get_member_profile(bioguide_id:'<id>') OR
 *      get_member_profile(committee_id:'HSAS') for House Armed Services
 *      members — fetch the trader's committee context.
 *   3. get_federal_contracts(recipient_name:'Lockheed Martin') — find
 *      the contracts that follow the trade.
 *   4. Triangulate.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryLegislators } from "../firestore.js";
import type {
  Legislator,
  LegislatorQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_member_profile",
  description: [
    "Returns Congressional member profiles from the unitedstates/",
    "congress-legislators catalog. Each record is one current House",
    "Representative or Senator, keyed by bioguide_id (the permanent",
    "member identifier — e.g., 'C001035' for Susan Collins).",
    "",
    "Use this when the user asks about: which committees a member sits",
    "on, who chairs the Senate Banking Committee, all Republicans on",
    "House Armed Services, party/state/district lookup for a specific",
    "member, or to enrich congressional_trades records with member",
    "context (party + state + committee assignments).",
    "",
    "Filter by bioguide_id for a direct fetch; by member_name for a",
    "case-insensitive substring search; by committee_id (e.g., 'HSAS'",
    "for House Armed Services, 'SSAF' for Senate Agriculture, 'HSAG15'",
    "for the Forestry & Horticulture subcommittee under House Ag) to",
    "find all members of a committee. Combine state + chamber + party",
    "for caucus-level queries.",
    "",
    "Committee codes follow the Library of Congress 'Thomas' convention:",
    "  House full committees: HSAG (Agriculture), HSAS (Armed Services),",
    "    HSAP (Appropriations), HSBA (Financial Services), HSED",
    "    (Education), HSEN (Energy & Commerce), HSII (Natural Resources),",
    "    HSJU (Judiciary), HSWM (Ways and Means), etc.",
    "  Senate full committees: SSAF (Ag), SSAS (Armed Services), SSAP",
    "    (Appropriations), SSBK (Banking), SSCM (Commerce), SSEG",
    "    (Energy), SSFI (Finance), SSHR (HELP), SSJU (Judiciary), etc.",
    "  Subcommittees append the subcommittee thomas_id: HSAG15, HSBA00.",
    "",
    "Photo URLs are constructed (theunitedstates.io/images/congress/",
    "original/{bioguide_id}.jpg) but Cloudflare-protected — clients",
    "fetch directly. Senate class field (1/2/3) on senators only.",
    "",
    "Each record also carries: cross_reference_ids{ICPSR, FEC, OpenSecrets,",
    "GovTrack, Wikipedia, Wikidata, etc.} for joining to external datasets;",
    "social{twitter, facebook, youtube, instagram} handles when published;",
    "and contact{office, address, phone, url, contact_form} for the",
    "current-term DC office. All sourced from the same daily-updated YAML.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      bioguide_id: {
        type: "string",
        description:
          "Permanent member identifier — letter + 6 digits (e.g., 'C001035' for Susan Collins, 'P000197' for Nancy Pelosi). Direct doc lookup, fastest path.",
      },
      member_name: {
        type: "string",
        description:
          "Case-insensitive substring against full_name. Example: 'Pelosi' returns Nancy Pelosi.",
      },
      state: {
        type: "string",
        description:
          "2-letter state abbreviation (e.g., 'ME', 'CA'). Filters to members from that state — useful with chamber=senate to get the 2 senators from a state.",
      },
      chamber: {
        type: "string",
        enum: ["house", "senate"],
        description: "Filter to House Representatives or Senators.",
      },
      party: {
        type: "string",
        description:
          "'Democrat' | 'Republican' | 'Independent' | etc. Exact match — uses the YAML's spelling.",
      },
      committee_id: {
        type: "string",
        description:
          "Thomas committee code (full committee like 'HSAS' or subcommittee like 'HSAG15'). Returns all members of that committee.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 600,
        description: "Maximum records to return. Default 50, max 600 (~current Congress size).",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<Legislator>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryLegislators(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): LegislatorQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: LegislatorQuery = {};

  if (args.bioguide_id !== undefined) {
    if (
      typeof args.bioguide_id !== "string" ||
      !/^[A-Z]\d{6}$/.test(args.bioguide_id)
    ) {
      throw new Error(
        `INVALID_BIOGUIDE_ID: '${String(args.bioguide_id)}' — expected letter + 6 digits (e.g., 'C001035')`,
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

  if (args.state !== undefined) {
    if (
      typeof args.state !== "string" ||
      !/^[A-Z]{2}$/i.test(args.state)
    ) {
      throw new Error(
        `INVALID_STATE: '${String(args.state)}' — expected 2-letter abbreviation (e.g., 'ME', 'CA')`,
      );
    }
    out.state = args.state.toUpperCase();
  }

  if (args.chamber !== undefined) {
    if (args.chamber !== "house" && args.chamber !== "senate") {
      throw new Error(
        `INVALID chamber: '${String(args.chamber)}' — expected 'house' or 'senate'`,
      );
    }
    out.chamber = args.chamber;
  }

  if (args.party !== undefined) {
    if (typeof args.party !== "string") {
      throw new Error("party must be a string");
    }
    out.party = args.party;
  }

  if (args.committee_id !== undefined) {
    if (typeof args.committee_id !== "string") {
      throw new Error("committee_id must be a string");
    }
    // Thomas codes are 4-7 alphanumeric (HSAG, HSAG15, JSPR, etc.).
    if (!/^[A-Z0-9]{4,7}$/i.test(args.committee_id)) {
      throw new Error(
        `INVALID_COMMITTEE_ID: '${String(args.committee_id)}' — expected 4-7 alphanumeric Thomas code`,
      );
    }
    out.committee_id = args.committee_id;
  }

  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 600
    ) {
      throw new Error(
        `INVALID limit: '${String(args.limit)}' — expected integer 1..600`,
      );
    }
    out.limit = args.limit;
  }

  return out;
}
