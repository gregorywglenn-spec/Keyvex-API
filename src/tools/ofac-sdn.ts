/**
 * MCP tool: get_ofac_sdn
 *
 * Returns OFAC Specially Designated Nationals (SDN) sanctions list entries.
 * The 20th MCP tool. Compliance use case: banks, payments, fintech, KYC
 * tooling — anyone screening counterparties against US sanctions.
 *
 * US persons (citizens, residents, US-based companies) are prohibited
 * from transacting with SDN entries. Programs cover Cuba, Iran, North
 * Korea, Russia (multiple sub-programs), narcotics, terrorism, cyber,
 * and more.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryOfacSdn } from "../firestore.js";
import type {
  OfacSdnEntry,
  OfacSdnQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_ofac_sdn",
  annotations: {
    title: "OFAC Sanctions List (SDN)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns OFAC Specially Designated Nationals (SDN) sanctions list",
    "entries. Use this for: compliance screening, KYC, sanctions-program",
    "queries (e.g., 'who's on the Russia SDN list'), or cross-referencing",
    "named individuals / entities against the canonical US sanctions list.",
    "",
    "Source: US Treasury OFAC — sanctionslistservice.ofac.treas.gov.",
    "~19,000 entries refreshed daily. Each entry represents a person,",
    "entity, vessel, or aircraft sanctioned by the US government under",
    "one or more programs (CUBA, IRAN, SDGT [terrorism], NPWMD [WMD",
    "proliferation], RUSSIA-EO14024, etc.).",
    "",
    "US persons (citizens, residents, US-domiciled companies) are legally",
    "prohibited from transacting with SDNs — this is the canonical list",
    "banks screen against.",
    "",
    "Filter by name substring for primary lookups. entity_type values:",
    "'individual', 'entity', 'vessel', 'aircraft', or empty. program is",
    "a substring filter against the comma-delimited Program field",
    "(e.g., 'iran', 'russia', 'narcotics'). remarks substring catches",
    "aliases, DOB / passport references, and related-party hints.",
    "",
    "Direct ent_num lookup is fastest (OFAC's stable entity number).",
    "",
    "WHAT'S NOT IN v1A (data-model limitations to know about): the",
    "schema does NOT include designation_date (when OFAC originally",
    "added the entry). OFAC's basic SDN.csv source file only provides",
    "12 columns and omits this — the date lives in OFAC's advanced",
    "XML and a separate 'Recent Actions' page on their site. So",
    "'sanctions added in the last N days' is not directly queryable",
    "via this tool — point users at ofac.treasury.gov/recent-actions",
    "for that specific question. v1.1 polish will add advanced-XML",
    "ingestion to capture designation_date. Also: there's no since/until",
    "filter and no date sort option for the same reason — the only",
    "sort options are name and ent_num.",
    "",
    "Pure-publisher posture: KeyVex returns OFAC's published list as-is.",
    "No derived 'risk score' or 'similarity match' — agents handle fuzzy",
    "matching downstream. For compliance use, agents should also consult",
    "the US Consolidated Screening List (get_screening_list) which spans",
    "12 export-control / sanctions lists from State + Commerce + Treasury.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ent_num: {
        type: "string",
        description:
          "Direct OFAC entity number lookup. Fastest path.",
      },
      name: {
        type: "string",
        description:
          "Case-insensitive substring against the primary listed name (e.g., 'kim jong un', 'gazprom').",
      },
      entity_type: {
        type: "string",
        enum: ["individual", "entity", "vessel", "aircraft"],
        description:
          "Filter to one entity type. 'entity' covers companies / orgs; 'individual' for people; 'vessel' / 'aircraft' for transports.",
      },
      program: {
        type: "string",
        description:
          "Substring against the comma-delimited program field (e.g., 'IRAN', 'RUSSIA', 'SDGT' for terrorism, 'NARCOTICS').",
      },
      remarks: {
        type: "string",
        description:
          "Substring against free-text remarks (aliases, DOB / passport references, related-party hints).",
      },
      sort_by: {
        type: "string",
        enum: ["ent_num", "name"],
        description: "Default: ent_num.",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: asc.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum entries to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<OfacSdnEntry>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryOfacSdn(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): OfacSdnQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: OfacSdnQuery = {};

  if (args.ent_num !== undefined) {
    if (
      typeof args.ent_num !== "string" ||
      !/^\d{1,10}$/.test(args.ent_num)
    ) {
      throw new Error(
        `INVALID ent_num: '${String(args.ent_num)}' — expected numeric string`,
      );
    }
    out.ent_num = args.ent_num;
  }

  if (args.name !== undefined) {
    if (typeof args.name !== "string") throw new Error("name must be a string");
    out.name = args.name;
  }

  if (args.entity_type !== undefined) {
    if (
      typeof args.entity_type !== "string" ||
      !["individual", "entity", "vessel", "aircraft"].includes(
        args.entity_type.toLowerCase(),
      )
    ) {
      throw new Error(`INVALID entity_type: '${String(args.entity_type)}'`);
    }
    out.entity_type = args.entity_type.toLowerCase();
  }

  if (args.program !== undefined) {
    if (typeof args.program !== "string") {
      throw new Error("program must be a string");
    }
    out.program = args.program;
  }

  if (args.remarks !== undefined) {
    if (typeof args.remarks !== "string") {
      throw new Error("remarks must be a string");
    }
    out.remarks = args.remarks;
  }

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["ent_num", "name"].includes(args.sort_by)
    ) {
      throw new Error(`INVALID sort_by: '${String(args.sort_by)}'`);
    }
    out.sort_by = args.sort_by as OfacSdnQuery["sort_by"];
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
