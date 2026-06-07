/**
 * MCP tool: get_consumer_complaints
 *
 * Returns consumer complaints filed with the CFPB. Pairs naturally with
 * get_enforcement_actions (complaints often precede enforcement actions
 * by CFPB / OCC / FDIC against the same company) and any financial-
 * services due-diligence workflow.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryConsumerComplaints } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  ConsumerComplaint,
  ConsumerComplaintsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_consumer_complaints",
  annotations: {
    title: "CFPB Consumer Complaints",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns consumer complaints filed with the Consumer Financial Protection",
    "Bureau (CFPB). Each record is one filing against a bank, credit reporting",
    "agency, mortgage servicer, debt collector, fintech, or crypto firm —",
    "with company response status, timeliness flag, and (when consented)",
    "consumer narrative.",
    "",
    "Use this when the user asks about: complaint volume against a specific",
    "company, top issues at a credit reporting agency, regional complaint",
    "patterns, untimely responses by a financial institution, or as a leading",
    "indicator of upcoming CFPB/OCC/FDIC enforcement action.",
    "",
    "v1A scope: rolling N-most-recent window (~2000 records/day on cron).",
    "The full historical dataset is 5M+ rows; agents follow `cfpb_source_url`",
    "for older records.",
    "",
    "Product taxonomy (the top categories):",
    "  - 'Credit reporting or other personal consumer reports' — Equifax,",
    "    Experian, TransUnion. ~80% of recent complaint volume.",
    "  - 'Debt collection'",
    "  - 'Mortgage'",
    "  - 'Credit card or prepaid card'",
    "  - 'Checking or savings account'",
    "  - 'Payday loan, title loan, or personal loan'",
    "  - 'Money transfer, virtual currency, or money service'",
    "  - 'Vehicle loan or lease'",
    "  - 'Student loan'",
    "",
    "Company-response values: 'Closed with explanation', 'Closed with",
    "non-monetary relief', 'Closed with monetary relief', 'In progress',",
    "'Untimely response', 'Closed without relief'.",
    "",
    "Cross-source tip: pair with get_enforcement_actions(source:'cftc'|'occ'|",
    "'fdic'|'sec'|'doj', text:'<company>') to see if complaint volume preceded",
    "a formal enforcement action.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Direct lookup by CFPB complaint_id.",
      },
      company: {
        type: "string",
        description:
          "Case-insensitive substring against company name (e.g., 'experian', 'jpmorgan', 'capital one').",
      },
      product: {
        type: "string",
        description:
          "Exact product match (e.g., 'Mortgage', 'Debt collection', 'Credit reporting or other personal consumer reports').",
      },
      sub_product: {
        type: "string",
        description: "Exact sub-product match.",
      },
      issue: {
        type: "string",
        description:
          "Case-insensitive substring against the issue field (e.g., 'incorrect information', 'fraud', 'debt is not yours').",
      },
      state: {
        type: "string",
        description: "Two-letter state code (e.g., 'CA', 'NY'). Case-insensitive.",
      },
      submitted_via: {
        type: "string",
        enum: ["Web", "Phone", "Postal mail", "Fax", "Referral", "Email"],
        description: "Channel filter.",
      },
      timely_response: {
        type: "boolean",
        description:
          "Filter to complaints with timely company response (within CFPB's 15-day window) or not.",
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
        enum: ["date_received", "date_sent_to_company"],
        description: "Default date_received.",
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
): Promise<ResultEnvelope<ConsumerComplaint>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning, source } = await queryConsumerComplaints(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    ...(source && { source }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): ConsumerComplaintsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ConsumerComplaintsQuery = {};

  for (const f of [
    "id",
    "company",
    "product",
    "sub_product",
    "issue",
    "submitted_via",
  ] as const) {
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
  if (args.timely_response !== undefined) {
    out.timely_response = parseBooleanArg(args.timely_response, "timely_response");
  }
  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "date_received" &&
      args.sort_by !== "date_sent_to_company"
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
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(value)) {
    throw new Error(`INVALID_DATE: ${fieldName}='${value}'`);
  }
  return value;
}
