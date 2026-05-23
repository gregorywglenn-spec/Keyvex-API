/**
 * MCP tool: get_material_events
 *
 * Returns Form 8-K filings — the SEC's "current report" form, filed within
 * 4 business days of any material event at a publicly-traded company. The
 * highest-volume real-time disclosure stream the public can access.
 *
 * Indexed by item code (the structured part of the filing). Body prose is
 * NOT extracted in v1 — agents follow `primary_document_url` for the prose.
 *
 * Composition pattern (one of many):
 *   1. get_material_events(ticker:'AAPL', item_codes:['5.02']) — find recent
 *      exec changes at Apple.
 *   2. get_insider_transactions(ticker:'AAPL', since:'<5.02 filing date>')
 *      — see how the new exec / departing exec is trading post-event.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryMaterialEvents } from "../firestore.js";
import type {
  MaterialEvent,
  MaterialEventsQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_material_events",
  annotations: {
    title: "Material Events (SEC Form 8-K)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns Form 8-K filings — the SEC's 'current report' form, filed",
    "within 4 business days of any material event at a publicly-traded",
    "company. Each record is one filing, with `item_codes` declaring WHAT",
    "kind of event(s) it covers.",
    "",
    "Use this when the user asks about: recent CEO/CFO departures or",
    "appointments, M&A announcements, earnings releases, big contract",
    "wins, restructurings, going-concern warnings, exec compensation",
    "changes, or any 'what just happened at this company' question.",
    "",
    "Item codes (most-used; many more exist):",
    "  1.01  Entry into a Material Definitive Agreement",
    "  1.02  Termination of a Material Definitive Agreement",
    "  2.01  Completion of Acquisition or Disposition of Assets",
    "  2.02  Results of Operations (earnings releases live here)",
    "  2.03  Creation of a Material Direct Financial Obligation",
    "  3.01  Notice of Delisting / Failure to Satisfy Listing Rule",
    "  3.02  Unregistered Sales of Equity Securities",
    "  4.01  Changes in Registrant's Certifying Accountant",
    "  5.02  Departure / Election / Appointment of Officers + Directors",
    "  5.07  Submission of Matters to a Vote of Security Holders",
    "  7.01  Regulation FD Disclosure",
    "  8.01  Other Events (catch-all)",
    "  9.01  Financial Statements and Exhibits — NOTE: nearly every 8-K",
    "        ticks this 'paperwork box.' Searching JUST for 9.01 returns",
    "        the firehose; combine it with another item_code to focus.",
    "",
    "`item_codes` filter is OR-semantic: pass an array, match any filing",
    "containing AT LEAST ONE of those codes. Capped at 30 codes per query",
    "(Firestore array-contains-any limit). Examples: ['5.02'] for exec",
    "changes; ['1.01','2.01'] for any deal activity (LOI or close);",
    "['2.02'] for earnings.",
    "",
    "Amendments (8-K/A) get their own row with `is_amendment: true`. The",
    "original 8-K stays in place. v1 does NOT populate",
    "`original_accession_number`; agents can find candidates by matching",
    "(ticker, period_of_report) across rows. Filter `is_amendment: false`",
    "for clean original-only views.",
    "",
    "v1 does not extract the prose body — `primary_document_url` points",
    "agents at the source HTML for direct fetch. The structured items are",
    "what's queryable here.",
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
        description:
          "SEC CIK number (10-digit, padded with leading zeros). Alternative to ticker.",
      },
      item_codes: {
        type: "array",
        items: { type: "string" },
        description:
          "Array of item codes to filter on (OR semantics). E.g., ['5.02'] for exec changes, ['1.01','2.01'] for any deal activity. Max 30 codes per query.",
      },
      is_amendment: {
        type: "boolean",
        description:
          "Filter to only original 8-Ks (false) or only amendments / 8-K/A filings (true). Omit to include both.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only records on or after this date, using sort_by as the date field.",
      },
      until: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only records on or before this date.",
      },
      sort_by: {
        type: "string",
        enum: ["filing_date", "period_of_report"],
        description:
          "Field used for ordering and for since/until filters. filing_date = when filed with SEC; period_of_report = when the underlying event occurred. Default: filing_date. NOTE: a small number of 8-Ks (Reg-FD-only filings, item-7.01 disclosures) lack period_of_report at the SEC source — those rows fall back to filing_date ordering automatically, so sort_by='period_of_report' won't bury them.",
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

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<MaterialEvent>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryMaterialEvents(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

const ITEM_CODE_RE = /^\d+\.\d+$/;

function validateAndNormalize(raw: unknown): MaterialEventsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: MaterialEventsQuery = {};

  if (args.ticker !== undefined) {
    if (
      typeof args.ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.ticker)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.ticker)}' — expected 1-10 chars, letters first, optional . / - for share classes`,
      );
    }
    out.ticker = args.ticker.toUpperCase();
  }

  if (args.company_cik !== undefined) {
    if (typeof args.company_cik !== "string") {
      throw new Error("company_cik must be a string");
    }
    out.company_cik = args.company_cik;
  }

  if (args.item_codes !== undefined) {
    if (!Array.isArray(args.item_codes)) {
      throw new Error("item_codes must be an array of strings");
    }
    if (args.item_codes.length === 0) {
      throw new Error(
        "item_codes must be non-empty when provided (omit the field to skip the filter)",
      );
    }
    if (args.item_codes.length > 30) {
      throw new Error(
        `INVALID item_codes: ${args.item_codes.length} codes provided — Firestore array-contains-any caps at 30`,
      );
    }
    const codes: string[] = [];
    for (const code of args.item_codes) {
      if (typeof code !== "string" || !ITEM_CODE_RE.test(code)) {
        throw new Error(
          `INVALID item_code: '${String(code)}' — expected format 'N.NN' (digits, dot, digits)`,
        );
      }
      codes.push(code);
    }
    out.item_codes = codes;
  }

  if (args.is_amendment !== undefined) {
    if (typeof args.is_amendment !== "boolean") {
      throw new Error("is_amendment must be a boolean");
    }
    out.is_amendment = args.is_amendment;
  }

  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }
  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }

  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "filing_date" &&
      args.sort_by !== "period_of_report"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected filing_date | period_of_report`,
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
