/**
 * MCP tool: get_government_publications
 *
 * Returns recent packages from the GovInfo API across four high-signal
 * legislative + oversight collections: Congressional Reports (CRPT),
 * Public Laws (PLAW), Congressional Hearings (CHRG), and GAO Reports
 * (GAOREPORTS — accessed via GovInfo to route around gao.gov's WAF).
 *
 * Pairs with get_bills + get_roll_call_votes (committee reports
 * accompany bills; public laws are the "did it pass" signal),
 * get_congressional_trades (hearing dates against trades nearby),
 * get_lobbying_filings (hearings often host registered-lobbyist
 * testimony), and get_enforcement_actions (GAO reports often precede
 * SEC / DOJ actions on the same agencies).
 *
 * v1A scope: metadata only (title, collection, doc class, date,
 * congress). Full document body lives at package_link — agents follow
 * for PDF / HTML / XML content. Pure-publisher posture: no derived
 * summary, sentiment, or impact prediction.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryGovDocuments } from "../firestore.js";
import type {
  GovDocument,
  GovDocumentsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_government_publications",
  annotations: {
    title: "Government Publications (GovInfo)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns recent congressional + oversight publications from GovInfo",
    "across four collections. Use this when the user asks about:",
    "  - Committee reports on a specific bill or topic",
    "  - Recently signed public laws (the 'did it become law' signal)",
    "  - Congressional hearing transcripts (testimony from regulators,",
    "    CEOs, expert witnesses)",
    "  - GAO oversight reports (independent reviews of federal agencies",
    "    + programs, often precede SEC/DOJ enforcement on the same target)",
    "",
    "Collections (filter via the `collection` enum):",
    "  CRPT       — Congressional Reports. Includes committee reports",
    "               accompanying bills (House hrpt / Senate srpt). Real-",
    "               time signal on what's about to move on the floor.",
    "  PLAW       — Public + Private Laws. Bills that were signed into",
    "               law. The 'what actually got done' record.",
    "  CHRG       — Congressional Hearings. Transcripts of House +",
    "               Senate committee hearings — testimony from agency",
    "               heads, executives, expert witnesses. Hearings often",
    "               PRECEDE enforcement actions (the public 'why did",
    "               this happen' conversation).",
    "  GAOREPORTS — GAO oversight reports. Independent congressional",
    "               oversight. NOTE: GovInfo's GAO collection is a",
    "               historical archive (~16.5K reports) that is not",
    "               receiving recent updates — GAO now publishes current",
    "               reports on gao.gov directly. Use this for historical",
    "               GAO research; recent reports won't appear here.",
    "",
    "Identifier format: each `package_id` is GovInfo's globally-unique ID",
    "(e.g., 'CRPT-119hrpt27' for House Report 27 of the 119th Congress,",
    "'PLAW-119publ12' for Public Law 12, 'CHRG-119hhrg54321' for House",
    "hearing 54321). Direct doc lookup by package_id is fastest.",
    "",
    "Cross-source pairing pattern:",
    "  Hearing → trade by attending member: get_congressional_trades(",
    "      bioguide_id:'...', since:'<hearing date>')",
    "  GAO report on agency → SEC follow-on: get_enforcement_actions(",
    "      text:'<agency name>', since:'<GAO report date>')",
    "  Committee report → bill passage: get_bills + get_roll_call_votes",
    "",
    "Full document body (PDF / HTML / XML) lives at `package_link`; v1A",
    "returns only metadata — agents follow the link for content.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      package_id: {
        type: "string",
        description:
          "GovInfo packageId. Direct doc lookup, fastest. Example: 'CRPT-119hrpt27'.",
      },
      collection: {
        type: "string",
        enum: ["CRPT", "PLAW", "CHRG", "GAOREPORTS"],
        description:
          "Filter to one collection: CRPT (committee reports), PLAW (public laws), CHRG (hearings), GAOREPORTS (GAO).",
      },
      doc_class: {
        type: "string",
        description:
          "Sub-class within the collection. Examples: 'hrpt' (House report), 'srpt' (Senate report), 'pub' (public law), 'pvt' (private law), 'hr' (House hearing), 's' (Senate hearing).",
      },
      congress: {
        type: "string",
        description: "Congress number as string (e.g., '119').",
      },
      title: {
        type: "string",
        description: "Case-insensitive substring against the package title.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only documents whose date_issued is on or after this date.",
      },
      until: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only documents whose date_issued is on or before this date.",
      },
      sort_by: {
        type: "string",
        enum: ["date_issued", "last_modified"],
        description: "Default: date_issued.",
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
): Promise<ResultEnvelope<GovDocument>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryGovDocuments(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

const COLLECTION_ALLOWED = new Set([
  "CRPT",
  "PLAW",
  "CHRG",
  "GAOREPORTS",
]);

function validateAndNormalize(raw: unknown): GovDocumentsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: GovDocumentsQuery = {};

  if (args.package_id !== undefined) {
    if (typeof args.package_id !== "string") {
      throw new Error("package_id must be a string");
    }
    out.package_id = args.package_id;
  }
  if (args.collection !== undefined) {
    if (
      typeof args.collection !== "string" ||
      !COLLECTION_ALLOWED.has(args.collection)
    ) {
      throw new Error(
        `INVALID collection: '${String(args.collection)}' — expected one of ${[...COLLECTION_ALLOWED].join(", ")}`,
      );
    }
    out.collection = args.collection as GovDocumentsQuery["collection"];
  }
  if (args.doc_class !== undefined) {
    if (typeof args.doc_class !== "string") {
      throw new Error("doc_class must be a string");
    }
    out.doc_class = args.doc_class;
  }
  if (args.congress !== undefined) {
    if (typeof args.congress !== "string") {
      throw new Error("congress must be a string");
    }
    out.congress = args.congress;
  }
  if (args.title !== undefined) {
    if (typeof args.title !== "string") {
      throw new Error("title must be a string");
    }
    out.title = args.title;
  }
  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }
  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }
  if (args.sort_by !== undefined) {
    if (args.sort_by !== "date_issued" && args.sort_by !== "last_modified") {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected date_issued | last_modified`,
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
