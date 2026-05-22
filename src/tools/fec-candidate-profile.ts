/**
 * MCP tool: get_fec_candidate_profile
 *
 * The first FEC tool — returns FEC-registered candidate profiles and
 * (optionally, default true) their associated committees. The join key
 * that unlocks the "follow the money" leg of the political-alpha play:
 *
 *   1. get_congressional_trades(ticker:'LMT') → bioguide_id of the trader.
 *   2. get_member_profile(bioguide_id:'<id>') → full name / state / party.
 *   3. get_fec_candidate_profile(candidate_name:'<surname>', state:'PA', office:'S')
 *      → FEC candidate_id + their principal campaign committee ID.
 *   4. (v1.1) get_fec_contributions(committee_id:'<id>') → all donations
 *      flowing into that campaign.
 *
 * Why a separate FEC tool instead of folding into get_member_profile?
 *   - FEC and bioguide use independent ID schemes (FEC: 'S6PA00091';
 *     bioguide: 'M001212') with no native cross-walk. Name+office+state
 *     is the only reliable join.
 *   - FEC tracks every candidate, not just sitting members — includes
 *     primary challengers, defeated candidates, future-cycle candidates,
 *     presidential candidates outside Congress. Different universe.
 *   - Committee structure is FEC-specific and dense (principal vs.
 *     authorized vs. leadership PAC). Keeps the surface focused.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryFecCandidates, queryFecCommittees } from "../firestore.js";
import type {
  FecCandidate,
  FecCandidateProfile,
  FecCandidateQuery,
  FecCommittee,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_fec_candidate_profile",
  annotations: {
    title: "FEC Candidate Profile",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns FEC-registered candidate profiles (House, Senate, President)",
    "and — when include_committees=true (default) — each candidate's",
    "associated FEC committees in the same response. Use this when the",
    "user asks about: who's running in race X, the campaign finance ID",
    "for a member, what PAC is sponsoring a candidate, or to bridge from",
    "a Congressional member name to their FEC committee_id before",
    "looking up contributions (v1.1 tool).",
    "",
    "Source: api.open.fec.gov — the official Federal Election Commission",
    "public-disclosure API. Records include current sitting members,",
    "primary challengers, defeated candidates, future-cycle registrants,",
    "and presidential candidates. Cycles tracked: 2022, 2024, 2026.",
    "",
    "Filter by candidate_id for the fastest direct lookup. Otherwise use",
    "candidate_name (case-insensitive substring) optionally narrowed by",
    "office + state + cycle. FEC names are typically filed as LASTNAME,",
    "FIRSTNAME (e.g., 'MCCORMICK, DAVE' for Dave McCormick).",
    "",
    "Office codes: H (House), S (Senate), P (President). Party codes:",
    "DEM (Democratic), REP (Republican), LIB (Libertarian), GRE (Green),",
    "IND (Independent), OTH (Other). Incumbent_challenge: I (Incumbent),",
    "C (Challenger), O (Open seat). When active_only=true, only candidates",
    "with candidate_status='C' (currently filing) are returned.",
    "",
    "Committee designations on returned committees: P (Principal campaign",
    "committee — the primary donation recipient), A (Authorized — accepts",
    "donations on candidate's behalf), B (Lobbyist), D (Leadership PAC),",
    "J (Joint fundraiser), U (Unauthorized). The Principal (P) committee",
    "is the one you want for 'donations to X's campaign'.",
    "",
    "Committee types: H (House campaign), S (Senate campaign), P",
    "(Presidential campaign), Q (PAC qualified), N (PAC non-qualified),",
    "O (Super PAC), I (Independent expenditure non-PAC), X/Y/Z (Party),",
    "V/W (Carey/hybrid). For 'follow the money to Senator X', look for",
    "designation=P, committee_type=S among the returned committees.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      candidate_id: {
        type: "string",
        description:
          "FEC-assigned candidate ID (immutable across cycles), e.g., 'S6PA00091' for Pat Toomey, 'P80003338' for Mitt Romney's 2008 presidential bid. Direct doc lookup, fastest path.",
      },
      candidate_name: {
        type: "string",
        description:
          "Case-insensitive substring against the FEC-filed candidate name (typically LASTNAME, FIRSTNAME format). Example: 'mccormick' or 'collins'.",
      },
      office: {
        type: "string",
        enum: ["H", "S", "P"],
        description:
          "Office code: H=House, S=Senate, P=President. Narrows ambiguous name matches.",
      },
      state: {
        type: "string",
        description:
          "2-letter state abbreviation (e.g., 'PA', 'CA'). Empty for President. Combine with office=S to find the senators from a state.",
      },
      district: {
        type: "string",
        description:
          "House district as 2-digit string ('01'-'53') or 'AL' for at-large. Senate/President leave blank.",
      },
      party: {
        type: "string",
        description: "Party code: DEM | REP | LIB | GRE | IND | OTH.",
      },
      cycle: {
        type: "integer",
        description:
          "Election cycle year (e.g., 2026). Returns candidates whose cycles[] includes this value. Common cycles: 2022, 2024, 2026.",
      },
      active_only: {
        type: "boolean",
        description:
          "When true, restricts to candidate_inactive=false (currently active filers). Default false (includes withdrawn / defeated / inactive).",
      },
      include_committees: {
        type: "boolean",
        description:
          "When true (default), each returned candidate is enriched with a `committees` array containing all FEC committees linked via candidate_ids[]. The principal campaign committee (designation='P') is listed first. Set false to skip the committee fetch for faster responses when you only need candidate profile fields.",
      },
      sort_by: {
        type: "string",
        enum: ["name", "last_file_date", "active_through"],
        description: "Sort key. Default: last_file_date (most recent first).",
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
        description: "Maximum candidates to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<FecCandidateProfile>> {
  const { query, includeCommittees } = validateAndNormalize(args);
  const { results: candidates, has_more } = await queryFecCandidates(query);

  if (!includeCommittees || candidates.length === 0) {
    return {
      results: candidates,
      count: candidates.length,
      has_more,
      query: query as Record<string, unknown>,
    };
  }

  // Fetch committees for each candidate in parallel.
  // For each candidate we look up committees linked via the
  // candidate_ids[] array — which is what FEC uses to track which
  // candidate(s) a committee supports. Principal (P) committees come
  // first so agents reading the response see the most-load-bearing
  // record without scanning the list.
  const enriched: FecCandidateProfile[] = await Promise.all(
    candidates.map(async (c) => {
      const cmtResult = await queryFecCommittees({
        candidate_id: c.candidate_id,
        limit: 50,
      });
      const sorted = sortCommitteesPrincipalFirst(cmtResult.results);
      return { ...c, committees: sorted };
    }),
  );

  return {
    results: enriched,
    count: enriched.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function sortCommitteesPrincipalFirst(committees: FecCommittee[]): FecCommittee[] {
  return [...committees].sort((a, b) => {
    const aPrincipal = a.designation === "P" ? 0 : 1;
    const bPrincipal = b.designation === "P" ? 0 : 1;
    if (aPrincipal !== bPrincipal) return aPrincipal - bPrincipal;
    // Within same designation rank, most-recent filing first.
    return (b.last_file_date ?? "").localeCompare(a.last_file_date ?? "");
  });
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): {
  query: FecCandidateQuery;
  includeCommittees: boolean;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: FecCandidateQuery = {};

  if (args.candidate_id !== undefined) {
    if (
      typeof args.candidate_id !== "string" ||
      !/^[HSP][0-9A-Z]{8}$/i.test(args.candidate_id)
    ) {
      throw new Error(
        `INVALID_CANDIDATE_ID: '${String(args.candidate_id)}' — expected office letter + 8 alphanumeric (e.g., 'S6PA00091')`,
      );
    }
    out.candidate_id = args.candidate_id.toUpperCase();
  }

  if (args.candidate_name !== undefined) {
    if (typeof args.candidate_name !== "string") {
      throw new Error("candidate_name must be a string");
    }
    out.candidate_name = args.candidate_name;
  }

  if (args.office !== undefined) {
    if (
      typeof args.office !== "string" ||
      !["H", "S", "P"].includes(args.office.toUpperCase())
    ) {
      throw new Error(
        `INVALID office: '${String(args.office)}' — expected H | S | P`,
      );
    }
    out.office = args.office.toUpperCase();
  }

  if (args.state !== undefined) {
    if (
      typeof args.state !== "string" ||
      !/^[A-Z]{2}$/i.test(args.state)
    ) {
      throw new Error(
        `INVALID_STATE: '${String(args.state)}' — expected 2-letter abbreviation`,
      );
    }
    out.state = args.state.toUpperCase();
  }

  if (args.district !== undefined) {
    if (typeof args.district !== "string") {
      throw new Error("district must be a string");
    }
    out.district = args.district;
  }

  if (args.party !== undefined) {
    if (typeof args.party !== "string") {
      throw new Error("party must be a string");
    }
    out.party = args.party.toUpperCase();
  }

  if (args.cycle !== undefined) {
    if (
      typeof args.cycle !== "number" ||
      !Number.isInteger(args.cycle) ||
      args.cycle < 1976 ||
      args.cycle > 2100
    ) {
      throw new Error(
        `INVALID cycle: '${String(args.cycle)}' — expected integer year >= 1976`,
      );
    }
    out.cycle = args.cycle;
  }

  if (args.active_only !== undefined) {
    if (typeof args.active_only !== "boolean") {
      throw new Error("active_only must be a boolean");
    }
    out.active_only = args.active_only;
  }

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["name", "last_file_date", "active_through"].includes(args.sort_by)
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected name | last_file_date | active_through`,
      );
    }
    out.sort_by = args.sort_by as FecCandidateQuery["sort_by"];
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
    out.sort_order = args.sort_order as FecCandidateQuery["sort_order"];
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

  const includeCommittees =
    args.include_committees === undefined
      ? true
      : args.include_committees === true;
  if (
    args.include_committees !== undefined &&
    typeof args.include_committees !== "boolean"
  ) {
    throw new Error("include_committees must be a boolean");
  }

  // Suppress unused warning — FecCandidate is exported in the response type.
  void (null as unknown as FecCandidate);

  return { query: out, includeCommittees };
}
