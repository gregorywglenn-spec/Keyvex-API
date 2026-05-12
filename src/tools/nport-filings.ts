/**
 * MCP tool: get_nport_filings
 *
 * Returns SEC Form N-PORT filings — monthly portfolio reports from
 * registered investment companies (mutual funds, ETFs, closed-end funds).
 * The 18th MCP tool. Pairs with `get_institutional_holdings` (13F) for
 * fresher monthly holdings snapshots — 13F is quarterly + investment-
 * manager-keyed; N-PORT is monthly + fund-keyed.
 *
 * v1A scope: metadata only. Filer (fund trust name + CIK), reporting
 * period (month-end), SEC investment company file number, filing type
 * (NPORT-P or NPORT-P/A amendment), URLs. Full per-holding portfolio
 * detail lives at primary_document_url; agents follow that URL for
 * security-level views (XML extraction is v1.1 polish).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryNportFilings } from "../firestore.js";
import type {
  NportFiling,
  NportFilingsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_nport_filings",
  description: [
    "Returns SEC Form N-PORT filings — monthly portfolio reports from",
    "registered investment companies (mutual funds, ETFs, closed-end",
    "funds). Use this when the user asks about: recent fund portfolio",
    "filings, when a specific fund family last reported, monthly cadence",
    "of fund disclosures, or to bridge from a fund trust name to the",
    "primary_doc.xml that contains full per-holding portfolio detail.",
    "",
    "Source: SEC EDGAR full-text search. Covers both NPORT-P (original",
    "filing) and NPORT-P/A (amendments). N-PORT is filed within 60 days",
    "of each month-end; period_ending tells you which month the report",
    "covers.",
    "",
    "v1A returns metadata only: filer trust name + CIK, period_ending,",
    "filing type, SEC investment company file number (e.g., '811-21864'),",
    "filer state + state of incorporation, and the URL to the full",
    "primary_doc.xml. Per-holding portfolio detail (every security in the",
    "fund's portfolio with quantity, fair value, currency, etc.) lives in",
    "that XML — agents follow the URL when they need security-level data.",
    "",
    "Pairs with get_institutional_holdings (13F): 13F is quarterly,",
    "filed by INVESTMENT MANAGERS (Berkshire, Vanguard, BlackRock); N-PORT",
    "is monthly, filed by the FUND TRUST. Together = fresher snapshots",
    "across two complementary universes (manager-level vs fund-level).",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      filing_id: {
        type: "string",
        description: "EDGAR accession number. Direct doc lookup, fastest.",
      },
      filer_cik: {
        type: "string",
        description: "Fund trust's SEC CIK (1-10 digits; we zero-pad internally).",
      },
      filer_name: {
        type: "string",
        description:
          "Case-insensitive substring against the fund trust name (e.g., 'wisdomtree', 'vanguard', 'fidelity').",
      },
      period_ending: {
        type: "string",
        description:
          "Filter to a specific reporting period — the month-end the filing covers (YYYY-MM-DD).",
      },
      sec_file_number: {
        type: "string",
        description:
          "SEC Investment Company file number, e.g., '811-21864'. Each fund trust has a stable number.",
      },
      is_amendment: {
        type: "boolean",
        description:
          "When set, restricts to NPORT-P/A amendments (true) or original NPORT-P (false). Default: both.",
      },
      since: {
        type: "string",
        description: "file_date lower bound (YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "file_date upper bound (YYYY-MM-DD inclusive).",
      },
      sort_by: {
        type: "string",
        enum: ["file_date", "period_ending"],
        description:
          "Default: file_date (most recently filed first). period_ending sorts by the month the report covers.",
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
        description: "Maximum filings to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<NportFiling>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryNportFilings(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): NportFilingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: NportFilingsQuery = {};

  if (args.filing_id !== undefined) {
    if (typeof args.filing_id !== "string") {
      throw new Error("filing_id must be a string");
    }
    out.filing_id = args.filing_id;
  }

  if (args.filer_cik !== undefined) {
    if (
      typeof args.filer_cik !== "string" ||
      !/^\d{1,10}$/.test(args.filer_cik)
    ) {
      throw new Error(
        `INVALID_CIK: '${String(args.filer_cik)}' — expected 1-10 digit CIK`,
      );
    }
    out.filer_cik = args.filer_cik;
  }

  if (args.filer_name !== undefined) {
    if (typeof args.filer_name !== "string") {
      throw new Error("filer_name must be a string");
    }
    out.filer_name = args.filer_name;
  }

  if (args.period_ending !== undefined) {
    if (
      typeof args.period_ending !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(args.period_ending)
    ) {
      throw new Error(
        `INVALID period_ending: '${String(args.period_ending)}' — expected YYYY-MM-DD`,
      );
    }
    out.period_ending = args.period_ending;
  }

  if (args.sec_file_number !== undefined) {
    if (typeof args.sec_file_number !== "string") {
      throw new Error("sec_file_number must be a string");
    }
    out.sec_file_number = args.sec_file_number;
  }

  if (args.is_amendment !== undefined) {
    if (typeof args.is_amendment !== "boolean") {
      throw new Error("is_amendment must be a boolean");
    }
    out.is_amendment = args.is_amendment;
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

  if (args.sort_by !== undefined) {
    if (
      typeof args.sort_by !== "string" ||
      !["file_date", "period_ending"].includes(args.sort_by)
    ) {
      throw new Error(`INVALID sort_by: '${String(args.sort_by)}'`);
    }
    out.sort_by = args.sort_by as NportFilingsQuery["sort_by"];
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
