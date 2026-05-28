/**
 * MCP tool: get_federal_register_documents
 *
 * Returns Federal Register documents (Rules / Proposed Rules / Notices /
 * Presidential Documents) from federalregister.gov. The 21st MCP tool.
 *
 * Pairs with get_lobbying_filings: lobbyists frequently file comments on
 * Proposed Rules; cross-referencing reveals "who's pushing for which
 * regulation."
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryFederalRegisterDocuments } from "../firestore.js";
import type {
  FederalRegisterDocument,
  FederalRegisterDocumentsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_federal_register_documents",
  annotations: {
    title: "Federal Register Documents",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns Federal Register documents — the daily-published collection of",
    "US executive branch regulatory + administrative actions. Use this for:",
    "regulatory tracking (what's the SEC / EPA / FDA proposing this week?),",
    "executive order monitoring, public-comment-period tracking, lobbying",
    "tie-in (cross-reference with get_lobbying_filings for 'who's pushing",
    "which rule'), or compliance forward-look on proposed regulations.",
    "",
    "Source: federalregister.gov public REST API. Comprehensive — every",
    "Federal Register publication appears here.",
    "",
    "Document types (document_type field):",
    "  'Rule'                  — final regulation (in effect)",
    "  'Proposed Rule'         — agency rule open for public comment",
    "  'Notice'                — formal notice (sunshine acts, hearings,",
    "                            authorizations, determinations, etc.)",
    "  'Presidential Document' — executive orders, proclamations, memoranda",
    "",
    "Agency filtering: agency_slug uses URL-safe identifiers like",
    "'securities-and-exchange-commission', 'environmental-protection-agency',",
    "'food-and-drug-administration', 'federal-trade-commission'. Filter via",
    "agency_slug for exact-match; agency_name does case-insensitive substring",
    "for fuzzier 'I know the name but not the slug' lookups.",
    "",
    "Composite document numbers (e.g., '2026-09385') are GPO-assigned and",
    "stable. Direct document_number lookup is fastest.",
    "",
    "Pure-publisher posture: KeyVex returns the daily publication record",
    "as-is. No 'regulatory risk score' or 'likely-to-finalize' signals.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      document_number: {
        type: "string",
        description:
          "GPO-assigned document number (e.g., '2026-09385'). Direct doc lookup, fastest.",
      },
      title: {
        type: "string",
        description: "Case-insensitive substring against the document title.",
      },
      document_type: {
        type: "string",
        enum: ["Rule", "Proposed Rule", "Notice", "Presidential Document"],
        description:
          "Exact filter to one document type. 'Proposed Rule' is the high-value one for compliance forward-look.",
      },
      agency_slug: {
        type: "string",
        description:
          "Agency slug for exact filter (e.g., 'securities-and-exchange-commission', 'environmental-protection-agency').",
      },
      agency_name: {
        type: "string",
        description:
          "Case-insensitive substring against full agency names. Use when you don't know the slug.",
      },
      text: {
        type: "string",
        description:
          "Substring against title + abstract + excerpts combined. Use for topic searches ('climate', 'ai', 'cryptocurrency').",
      },
      since: {
        type: "string",
        description: "publication_date lower bound (YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "publication_date upper bound (YYYY-MM-DD inclusive).",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc (newest first).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum documents to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<FederalRegisterDocument>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryFederalRegisterDocuments(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): FederalRegisterDocumentsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: FederalRegisterDocumentsQuery = {};

  if (args.document_number !== undefined) {
    if (typeof args.document_number !== "string") {
      throw new Error("document_number must be a string");
    }
    out.document_number = args.document_number;
  }

  if (args.title !== undefined) {
    if (typeof args.title !== "string") throw new Error("title must be a string");
    out.title = args.title;
  }

  if (args.document_type !== undefined) {
    if (
      typeof args.document_type !== "string" ||
      !["Rule", "Proposed Rule", "Notice", "Presidential Document"].includes(
        args.document_type,
      )
    ) {
      throw new Error(`INVALID document_type: '${String(args.document_type)}'`);
    }
    out.document_type =
      args.document_type as FederalRegisterDocumentsQuery["document_type"];
  }

  if (args.agency_slug !== undefined) {
    if (typeof args.agency_slug !== "string") {
      throw new Error("agency_slug must be a string");
    }
    out.agency_slug = args.agency_slug;
  }

  if (args.agency_name !== undefined) {
    if (typeof args.agency_name !== "string") {
      throw new Error("agency_name must be a string");
    }
    out.agency_name = args.agency_name;
  }

  if (args.text !== undefined) {
    if (typeof args.text !== "string") throw new Error("text must be a string");
    out.text = args.text;
  }

  if (args.since !== undefined) {
    if (
      typeof args.since !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.since)
    ) {
      throw new Error(`INVALID since: '${String(args.since)}' — expected YYYY-MM-DD`);
    }
    out.since = args.since;
  }
  if (args.until !== undefined) {
    if (
      typeof args.until !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.until)
    ) {
      throw new Error(`INVALID until: '${String(args.until)}' — expected YYYY-MM-DD`);
    }
    out.until = args.until;
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
