/**
 * MCP tool: get_proxy_filings
 *
 * Returns DEF 14A (Schedule 14A) proxy filings — the document a company
 * sends shareholders ahead of an annual or special meeting. Carries
 * executive compensation tables, board nominations, shareholder
 * proposals, auditor info, and voting matters.
 *
 * v1A scope: METADATA ONLY. The proxy body is 50-200 pages of complex
 * HTML tables; body extraction (named exec officers, comp totals, vote
 * outcomes) is v1.1 territory. Agents follow `primary_document_url` for
 * the prose.
 *
 * Composition pattern:
 *   1. get_proxy_filings(ticker:'TSLA', filing_type:'DEFM14A')
 *      — find Tesla's merger-vote proxy filings
 *   2. get_activist_stakes(ticker:'TSLA', is_activist:true)
 *      — who's pushing for the change of control
 *   3. get_insider_transactions(ticker:'TSLA', since:'<proxy filing date>')
 *      — how insiders are trading ahead of the vote
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryProxyFilings } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  ProxyFiling,
  ProxyFilingsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_proxy_filings",
  annotations: {
    title: "Proxy Filings (SEC DEF 14A)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns Schedule 14A proxy filings — the document public companies",
    "send shareholders ahead of annual or special meetings. Each record is",
    "one filing carrying executive compensation tables, board nominations,",
    "shareholder proposals, auditor info, and voting matters.",
    "",
    "Use this when the user asks about: executive compensation, board",
    "elections, shareholder proposals, M&A votes, proxy contests, auditor",
    "changes, say-on-pay outcomes, or upcoming annual meetings.",
    "",
    "Filing types (the four-form DEF 14A family):",
    "  DEF 14A   — Definitive proxy (the annual-meeting filing)",
    "  DEFA14A   — Additional materials (supplements to a prior DEF 14A)",
    "  DEFM14A   — Merger-related proxy (filed when shareholders vote on M&A)",
    "  DEFR14A   — Revised definitive proxy (amendments to a prior DEF 14A)",
    "",
    "Convenience flags derived from filing_type:",
    "  is_merger_related   — true for DEFM14A",
    "  is_amendment        — true for DEFR14A",
    "  is_additional_materials — true for DEFA14A",
    "",
    "period_of_report population (IMPORTANT for filtering / sorting):",
    "  - DEF 14A primaries: ~100% populated (the meeting/record date).",
    "  - DEFA14A / DEFM14A / DEFR14A: typically EMPTY. These are",
    "    supplements / merger materials / revisions that reference a",
    "    prior DEF 14A's period rather than declaring their own. The",
    "    blank is correct-as-filed (SEC's own submissions API leaves",
    "    these reportDate fields empty), not a parse miss. Don't rely on",
    "    period_of_report being present for these forms; filter by",
    "    filing_date instead for chronological queries.",
    "",
    "v1A is metadata-only: ticker, company name, CIK, filing type, dates,",
    "primary document URL. The proxy body is not extracted in v1.",
    "`primary_document_url` points agents at the source HTML for direct",
    "fetch when they need exec comp tables or proposal text.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "Stock symbol filter, e.g. 'AAPL'. Case-insensitive.",
      },
      company_cik: {
        type: "string",
        description: "SEC CIK number (10-digit, padded). Alternative to ticker.",
      },
      filing_type: {
        type: "string",
        enum: ["DEF 14A", "DEFA14A", "DEFM14A", "DEFR14A"],
        description:
          "Exact filing-type filter. Use 'DEFM14A' for M&A-vote proxies only, 'DEF 14A' for annual proxies only.",
      },
      is_merger_related: {
        type: "boolean",
        description: "Convenience flag: filter to DEFM14A only.",
      },
      is_amendment: {
        type: "boolean",
        description: "Convenience flag: filter to DEFR14A (revised) only.",
      },
      since: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Only records on or after this date.",
      },
      until: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Only records on or before this date.",
      },
      sort_by: {
        type: "string",
        enum: ["filing_date", "period_of_report"],
        description: "Default filing_date.",
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

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<ProxyFiling>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryProxyFilings(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ──────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): ProxyFilingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ProxyFilingsQuery = {};

  if (args.ticker !== undefined) {
    if (
      typeof args.ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.ticker)
    ) {
      throw new Error(`INVALID_TICKER: '${String(args.ticker)}'`);
    }
    out.ticker = args.ticker.toUpperCase();
  }

  if (args.company_cik !== undefined) {
    if (typeof args.company_cik !== "string") {
      throw new Error("company_cik must be a string");
    }
    out.company_cik = args.company_cik;
  }

  if (args.filing_type !== undefined) {
    const valid: ProxyFilingsQuery["filing_type"][] = [
      "DEF 14A",
      "DEFA14A",
      "DEFM14A",
      "DEFR14A",
    ];
    if (!valid.includes(args.filing_type as ProxyFilingsQuery["filing_type"])) {
      throw new Error(
        `INVALID filing_type: '${String(args.filing_type)}' — expected one of ${valid.join(", ")}`,
      );
    }
    out.filing_type = args.filing_type as ProxyFilingsQuery["filing_type"];
  }

  if (args.is_merger_related !== undefined) {
    out.is_merger_related = parseBooleanArg(args.is_merger_related, "is_merger_related");
  }

  if (args.is_amendment !== undefined) {
    out.is_amendment = parseBooleanArg(args.is_amendment, "is_amendment");
  }

  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");

  if (args.sort_by !== undefined) {
    if (args.sort_by !== "filing_date" && args.sort_by !== "period_of_report") {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected filing_date | period_of_report`,
      );
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
      throw new Error(`INVALID limit: '${String(args.limit)}' — expected integer 1..500`);
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
    throw new Error(`INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`);
  }
  return value;
}
