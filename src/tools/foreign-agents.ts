/**
 * MCP tool: get_foreign_agents
 *
 * Returns FARA (Foreign Agents Registration Act) registrations — US-based
 * agents who have registered with the DOJ to act on behalf of a foreign
 * principal (government, party, company, or individual).
 *
 * Each record is one registrant ↔ foreign-principal relationship. The
 * marquee filter is `foreign_principal_country` — "which US agents are
 * registered to act for Chinese / Russian / Saudi principals."
 *
 * Pairs with get_lobbying_filings (LDA domestic lobbying — FARA is the
 * foreign-principal counterpart), get_fec_contributions, and
 * get_congressional_trades for the full foreign-influence picture.
 *
 * v1A scope: active registrations only. The registrant ↔ foreign-principal
 * linkage IS captured (registrant name + foreign principal + its country).
 * Document-level filings and compensation detail are not extracted —
 * agents follow source_url to FARA eFile for those.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryForeignAgents } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  ForeignAgent,
  ForeignAgentsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_foreign_agents",
  annotations: {
    title: "Foreign Agents (FARA)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns FARA registrations — US persons and firms registered with the",
    "DOJ as agents of a foreign principal under the Foreign Agents",
    "Registration Act. Use this when the user asks about: who is a",
    "registered foreign agent, which US firms work for a particular foreign",
    "government, recently-registered foreign agents, or to add a 'foreign-",
    "influence' flag to a lobbying firm, law firm, or PR firm.",
    "",
    "Each record is one registrant ↔ foreign-principal relationship — a",
    "registrant representing three foreign principals appears as three",
    "records. The single highest-signal filter is foreign_principal_country:",
    "  foreign_principal_country='CHINA'  → every US agent acting for a",
    "                                       Chinese principal",
    "",
    "Source: efile.fara.gov (DOJ National Security Division). v1A covers",
    "ACTIVE registrations. The registrant↔principal linkage is included;",
    "per-document filing detail and compensation figures are not — follow",
    "source_url to FARA eFile for those.",
    "",
    "Cross-source pairing pattern:",
    "  FARA + get_lobbying_filings  — FARA is foreign-principal representation;",
    "      LDA is domestic lobbying. A firm in both is lobbying Congress on",
    "      behalf of a foreign government.",
    "  FARA + get_fec_contributions — foreign-agent firms whose people also",
    "      make political contributions.",
    "  FARA + get_congressional_trades — influence-and-trades overlay.",
    "",
    "Identifier: registration_number is the FARA registration number.",
    "has_foreign_principal=false records are registrants with no currently-",
    "active foreign principal (still queryable as registered agents).",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      registration_number: {
        type: "string",
        description: "Exact FARA registration number. Fastest lookup.",
      },
      registrant_name: {
        type: "string",
        description:
          "Case-insensitive substring against the US registrant (agent) name.",
      },
      foreign_principal_name: {
        type: "string",
        description:
          "Case-insensitive substring against the foreign principal's name.",
      },
      foreign_principal_country: {
        type: "string",
        description:
          "Country of the foreign principal, matched uppercase (e.g. 'CHINA', 'RUSSIA', 'SAUDI ARABIA'). The key foreign-influence filter.",
      },
      has_foreign_principal: {
        type: "boolean",
        description:
          "Filter to records that carry a foreign-principal relationship (true) or registrants with no active foreign principal (false).",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only records on or after this date, by sort_by.",
      },
      until: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Only records on or before this date.",
      },
      sort_by: {
        type: "string",
        enum: ["registration_date", "foreign_principal_reg_date"],
        description: "Default: registration_date.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (most recent first).",
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
): Promise<ResultEnvelope<ForeignAgent>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryForeignAgents(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): ForeignAgentsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ForeignAgentsQuery = {};

  if (args.registration_number !== undefined) {
    if (typeof args.registration_number !== "string") {
      throw new Error("registration_number must be a string");
    }
    out.registration_number = args.registration_number;
  }
  if (args.registrant_name !== undefined) {
    if (typeof args.registrant_name !== "string") {
      throw new Error("registrant_name must be a string");
    }
    out.registrant_name = args.registrant_name;
  }
  if (args.foreign_principal_name !== undefined) {
    if (typeof args.foreign_principal_name !== "string") {
      throw new Error("foreign_principal_name must be a string");
    }
    out.foreign_principal_name = args.foreign_principal_name;
  }
  if (args.foreign_principal_country !== undefined) {
    if (typeof args.foreign_principal_country !== "string") {
      throw new Error("foreign_principal_country must be a string");
    }
    out.foreign_principal_country = args.foreign_principal_country.toUpperCase();
  }
  if (args.has_foreign_principal !== undefined) {
    out.has_foreign_principal = parseBooleanArg(
      args.has_foreign_principal,
      "has_foreign_principal",
    );
  }
  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }
  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "registration_date" &&
      args.sort_by !== "foreign_principal_reg_date"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected registration_date | foreign_principal_reg_date`,
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

function parseIsoDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`INVALID_DATE: ${fieldName} must be a string`);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
