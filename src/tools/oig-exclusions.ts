/**
 * MCP tool: get_oig_exclusions
 *
 * Returns entries on the HHS Office of Inspector General "List of Excluded
 * Individuals/Entities" (LEIE). Anyone on this list is barred from billing
 * Medicare, Medicaid, or any federal healthcare program.
 *
 * Pairs naturally with get_federal_contracts ("does this contractor have an
 * exclusion?") and any healthcare-sector research.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryOigExclusions } from "../firestore.js";
import type {
  OigExclusion,
  OigExclusionsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_oig_exclusions",
  description: [
    "Returns entries on the HHS Office of Inspector General 'List of",
    "Excluded Individuals/Entities' (LEIE). Anyone on this list is barred",
    "from billing Medicare, Medicaid, or any federal healthcare program.",
    "Updated monthly by OIG; KeyVex re-scrapes monthly and overwrites.",
    "",
    "Use this when the user asks about: healthcare-fraud exclusions,",
    "Medicare/Medicaid program integrity, due-diligence on a healthcare",
    "contractor or provider, geographic concentration of exclusions,",
    "or a specific person/business listed on LEIE.",
    "",
    "Cross-source tip: pair with get_federal_contracts to flag contractors",
    "who appear on the exclusion list. A government contractor with an",
    "OIG exclusion is a real compliance red flag.",
    "",
    "Statutory exclusion types (the most common):",
    "  - 1128a1  Conviction of program-related crimes",
    "  - 1128a2  Conviction relating to patient abuse",
    "  - 1128a3  Felony conviction relating to healthcare fraud",
    "  - 1128a4  Felony conviction relating to controlled substances",
    "  - 1128b4  License revocation, suspension, surrender",
    "  - 1128b5  Exclusion or suspension under federal/state healthcare",
    "  - 1128b7  Fraud, kickbacks, and other prohibited activities",
    "  - 1128b8  Entities controlled by a sanctioned individual",
    "",
    "Pure-publisher posture: we surface the listing as-published. Some",
    "names match common-name individuals who aren't the excluded party —",
    "the agent / user is responsible for context disambiguation (DOB,",
    "address, NPI). Reinstatement_date populated means the exclusion has",
    "been lifted.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Case-insensitive substring against full_name (covers both individuals and businesses).",
      },
      business_name: {
        type: "string",
        description: "Case-insensitive substring against business_name only.",
      },
      state: {
        type: "string",
        description: "Two-letter state code (e.g. 'NY', 'CA'). Case-insensitive.",
      },
      city: {
        type: "string",
        description: "Case-insensitive substring against city.",
      },
      general_category: {
        type: "string",
        description:
          "Exact match (case-sensitive): 'PHARMACY', 'PHYSICIAN', 'OTHER BUSINESS', 'DME COMPANY', 'CLINIC', etc.",
      },
      specialty: {
        type: "string",
        description: "Case-insensitive substring against specialty.",
      },
      exclusion_type: {
        type: "string",
        description: "Statutory code (e.g. '1128a1', '1128b5').",
      },
      npi: {
        type: "string",
        description: "Exact 10-digit National Provider Identifier.",
      },
      is_business: {
        type: "boolean",
        description: "Filter to businesses only (true) or individuals only (false).",
      },
      is_reinstated: {
        type: "boolean",
        description:
          "Filter to entries whose exclusion has been lifted (true) or only currently-excluded (false).",
      },
      since: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Applied to sort_by field.",
      },
      until: {
        type: "string",
        description: "ISO date (YYYY-MM-DD).",
      },
      sort_by: {
        type: "string",
        enum: ["exclusion_date", "reinstatement_date"],
        description: "Default exclusion_date.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default desc.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<OigExclusion>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryOigExclusions(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): OigExclusionsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: OigExclusionsQuery = {};

  for (const f of ["name", "business_name", "city", "specialty"] as const) {
    if (args[f] !== undefined) {
      if (typeof args[f] !== "string") {
        throw new Error(`${f} must be a string`);
      }
      out[f] = args[f] as string;
    }
  }
  if (args.state !== undefined) {
    if (typeof args.state !== "string") throw new Error("state must be a string");
    out.state = args.state.toUpperCase();
  }
  if (args.general_category !== undefined) {
    if (typeof args.general_category !== "string") {
      throw new Error("general_category must be a string");
    }
    out.general_category = args.general_category;
  }
  if (args.exclusion_type !== undefined) {
    if (typeof args.exclusion_type !== "string") {
      throw new Error("exclusion_type must be a string");
    }
    out.exclusion_type = args.exclusion_type;
  }
  if (args.npi !== undefined) {
    if (typeof args.npi !== "string") throw new Error("npi must be a string");
    out.npi = args.npi;
  }
  if (args.is_business !== undefined) {
    if (typeof args.is_business !== "boolean") {
      throw new Error("is_business must be a boolean");
    }
    out.is_business = args.is_business;
  }
  if (args.is_reinstated !== undefined) {
    if (typeof args.is_reinstated !== "boolean") {
      throw new Error("is_reinstated must be a boolean");
    }
    out.is_reinstated = args.is_reinstated;
  }
  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "exclusion_date" &&
      args.sort_by !== "reinstatement_date"
    ) {
      throw new Error(`INVALID sort_by: '${String(args.sort_by)}'`);
    }
    out.sort_by = args.sort_by;
  }
  if (args.sort_order !== undefined) {
    if (args.sort_order !== "desc" && args.sort_order !== "asc") {
      throw new Error(`INVALID sort_order: '${String(args.sort_order)}'`);
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
      throw new Error(`INVALID limit: '${String(args.limit)}'`);
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
    throw new Error(`INVALID_DATE: ${fieldName}='${value}'`);
  }
  return value;
}
