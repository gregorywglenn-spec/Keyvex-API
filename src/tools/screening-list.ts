/**
 * MCP tool: get_screening_list
 *
 * Returns entries from the US Consolidated Screening List (CSL) — the
 * unified feed of twelve export-screening lists maintained by the
 * Departments of Commerce (BIS), State, and Treasury (OFAC). An entity on
 * any of these is a hard trade-compliance flag.
 *
 * Broader than get_ofac_sdn: the OFAC SDN list is one of the twelve sources
 * here. The CSL adds the BIS Entity List, Denied Persons, Military End User,
 * Unverified List, State Department debarred / nonproliferation lists, and
 * several non-SDN Treasury lists. Use get_ofac_sdn for the OFAC-SDN deep
 * view; use this for "is X on ANY US screening list, and which one."
 *
 * Source: api.trade.gov bulk CSL file. ~25K entries, refreshed daily.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryScreeningList } from "../firestore.js";
import type {
  ResultEnvelope,
  ScreeningListEntry,
  ScreeningListQuery,
} from "../types.js";

export const definition: Tool = {
  name: "get_screening_list",
  annotations: {
    title: "Consolidated Screening List",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns entries from the US Consolidated Screening List (CSL) — the",
    "combined feed of twelve federal export-screening lists. Use this when",
    "the user asks about: whether a company or person is on a US screening /",
    "sanctions / denied-party list, trade-compliance screening of a",
    "counterparty, BIS Entity List members, Military End User designations,",
    "or to add a 'restricted party' flag to a federal contractor or foreign",
    "agent.",
    "",
    "The CSL unifies twelve lists (filter via source_short):",
    "  SDN  — Specially Designated Nationals (Treasury/OFAC)",
    "  EL   — Entity List (Commerce/BIS)",
    "  DPL  — Denied Persons List (Commerce/BIS)",
    "  MEU  — Military End User List (Commerce/BIS)",
    "  UVL  — Unverified List (Commerce/BIS)",
    "  CMIC — Non-SDN Chinese Military-Industrial Complex Companies (Treasury)",
    "  CAP  — Capta List (Treasury)",
    "  DTC  — ITAR Debarred (State)",
    "  ISN  — Nonproliferation Sanctions (State)",
    "  MBS  — Non-SDN Menu-Based Sanctions List (Treasury)",
    "  PLC  — Palestinian Legislative Council List (Treasury)",
    "  SSI  — Sectoral Sanctions Identifications List (Treasury)",
    "",
    "Broader than get_ofac_sdn — the SDN list is just one source here.",
    "For the OFAC-SDN deep view use get_ofac_sdn; for 'on ANY US list'",
    "screening use this tool.",
    "",
    "Cross-source pairing: pair with get_federal_contracts to flag a",
    "contractor that also appears on a screening list, and with",
    "get_foreign_agents for the foreign-entity overlay.",
    "",
    "Each record carries name + alt_names, the source list, sanctions",
    "programs, addresses, distinct countries, and identification documents.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Case-insensitive substring matched against the entry name AND its alternate names / aliases.",
      },
      source_short: {
        type: "string",
        description:
          "Filter to one source list by short code: SDN, EL, DPL, MEU, UVL, CMIC, CAP, DTC, ISN, MBS, PLC, SSI.",
      },
      type: {
        type: "string",
        enum: ["Entity", "Individual", "Vessel", "Aircraft"],
        description: "Filter by entry type.",
      },
      country: {
        type: "string",
        description:
          "ISO-2 country code (e.g. 'CN', 'RU', 'IR'). Matches entries with an address in that country.",
      },
      program: {
        type: "string",
        description:
          "Case-insensitive substring against the entry's sanctions / control programs.",
      },
      sort_by: {
        type: "string",
        enum: ["name"],
        description: "Default: name.",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: asc (alphabetical by name).",
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

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<ScreeningListEntry>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryScreeningList(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): ScreeningListQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ScreeningListQuery = {};

  if (args.name !== undefined) {
    if (typeof args.name !== "string") throw new Error("name must be a string");
    out.name = args.name;
  }
  if (args.source_short !== undefined) {
    if (typeof args.source_short !== "string") {
      throw new Error("source_short must be a string");
    }
    out.source_short = args.source_short.toUpperCase();
  }
  if (args.type !== undefined) {
    const allowed = new Set(["Entity", "Individual", "Vessel", "Aircraft"]);
    if (typeof args.type !== "string" || !allowed.has(args.type)) {
      throw new Error(
        `INVALID type: '${String(args.type)}' — expected Entity | Individual | Vessel | Aircraft`,
      );
    }
    out.type = args.type;
  }
  if (args.country !== undefined) {
    if (typeof args.country !== "string") {
      throw new Error("country must be a string");
    }
    out.country = args.country.toUpperCase();
  }
  if (args.program !== undefined) {
    if (typeof args.program !== "string") {
      throw new Error("program must be a string");
    }
    out.program = args.program;
  }
  if (args.sort_by !== undefined) {
    if (args.sort_by !== "name") {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected 'name'`,
      );
    }
    out.sort_by = args.sort_by;
  }
  if (args.sort_order !== undefined) {
    if (args.sort_order !== "asc" && args.sort_order !== "desc") {
      throw new Error(
        `INVALID sort_order: '${String(args.sort_order)}' — expected 'asc' or 'desc'`,
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
