/**
 * MCP tool: get_registration_statements
 *
 * Returns SEC Form S-1 / S-3 registration statements — securities offering
 * registrations. The 19th MCP tool. Pairs with: get_tender_offers
 * (post-bid registrations), get_private_placements (transition from
 * private to public), get_insider_transactions (insider activity around
 * registration filings).
 *
 * v1A scope: metadata. Agents follow primary_document_url for offering
 * size, share counts, use of proceeds, risk factors, etc.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryRegistrationStatements } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  RegistrationStatement,
  RegistrationStatementsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_registration_statements",
  annotations: {
    title: "Registration Statements (SEC S-1/S-3/S-3ASR)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns SEC Form S-1 / S-3 / S-3ASR registration statements —",
    "securities offering registrations filed with the SEC. Use this when",
    "the user asks about: which companies are going public (IPO pipeline",
    "via S-1), shelf registrations (S-3 / S-3ASR — company registers",
    "securities to sell over multiple offerings without re-registering;",
    "large established issuers use the automatic S-3ASR variant),",
    "recent secondary offerings, registration amendments updating prior",
    "filings, or to bridge from a company name / ticker to the prospectus prose.",
    "",
    "Forms covered:",
    "  S-1    — Initial registration (IPO + first-time registrants)",
    "  S-1/A  — Amendment to an S-1",
    "  S-3    — Shelf registration (issuers meeting reporting / market-cap",
    "           criteria; lets them issue securities over time without",
    "           re-registering each time)",
    "  S-3/A  — Amendment to an S-3",
    "  S-3ASR — Automatic shelf registration. The shelf form used by",
    "           Well-Known Seasoned Issuers (large established companies",
    "           like Apple, Ford, most of the S&P 500). Effective on",
    "           filing. These issuers file S-3ASR, NOT plain S-3.",
    "",
    "Source: SEC EDGAR full-text search. Returns one record per filing,",
    "deduped by accession. Exhibit attachments (EX-10, opinion letters,",
    "fee tables, etc.) are filtered out — only the canonical form types",
    "are returned.",
    "",
    "v1A is metadata only. Each record has filer name + CIK + optional",
    "ticker + SEC file_number, state, SIC code(s), and URLs. Substantive",
    "prospectus content (offering size, share counts, use of proceeds,",
    "risk factors, financial statements) lives at primary_document_url —",
    "agents follow for the prose.",
    "",
    "SCOPE — covers S-1 (IPO), S-3 + S-3ASR (shelf, including WKSI auto",
    "shelves), plus /A amendments. S-8 employee-benefit-plan registrations,",
    "S-4 merger/acquisition registrations, and F-series foreign-issuer forms",
    "are NOT ingested. 424B prospectus supplements (offering takedowns off an",
    "existing shelf) are out of scope — query the shelf registration itself.",
    "",
    "Amendment chains: all amendments share the same sec_file_number as",
    "the original. Use sec_file_number filter to fetch an entire amendment",
    "chain.",
    "",
    "Pure-publisher posture: KeyVex doesn't derive 'likely-to-IPO' or",
    "'price-target' signals from registration filings.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      filing_id: {
        type: "string",
        description: "EDGAR accession number. Direct doc lookup.",
      },
      filer_name: {
        type: "string",
        description:
          "Case-insensitive substring against the filer's entity name (e.g., 'kraneshares', 'karyopharm'). NOTE: matched over a recent-filing window, so it reliably finds CURRENT filers but can miss an issuer whose registrations are older than that window. To pull a specific issuer's full registration history regardless of date, use filer_cik (most reliable) — e.g. Circle Internet Group is filer_cik 0001876042.",
      },
      filer_cik: {
        type: "string",
        description: "Filer's SEC CIK (1-10 digits).",
      },
      filer_ticker: {
        type: "string",
        description:
          "Ticker symbol (e.g., 'KPTI'). Often empty for IPO-stage S-1 filers (they don't have a ticker yet).",
      },
      filing_type: {
        type: "string",
        enum: ["S-1", "S-1/A", "S-3", "S-3/A", "S-3ASR"],
        description: "Exact filing-type match.",
      },
      s1_only: {
        type: "boolean",
        description:
          "When true, restricts to S-1 family (S-1 + S-1/A) — the IPO / first-time pool.",
      },
      s3_only: {
        type: "boolean",
        description:
          "When true, restricts to S-3 family (S-3 + S-3/A + S-3ASR) — the shelf pool, including automatic shelf registrations filed by Well-Known Seasoned Issuers.",
      },
      exclude_amendments: {
        type: "boolean",
        description: "When true, drops /A amendments. Default false.",
      },
      sec_file_number: {
        type: "string",
        description:
          "SEC-assigned registration file number ('333-XXXXXX'). Stable across amendments — use to fetch a full amendment chain.",
      },
      since: {
        type: "string",
        description: "file_date lower bound (YYYY-MM-DD inclusive).",
      },
      until: {
        type: "string",
        description: "file_date upper bound (YYYY-MM-DD inclusive).",
      },
      sort_order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Default: desc (most recently filed first).",
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
): Promise<ResultEnvelope<RegistrationStatement>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryRegistrationStatements(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): RegistrationStatementsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: RegistrationStatementsQuery = {};

  if (args.filing_id !== undefined) {
    if (typeof args.filing_id !== "string") {
      throw new Error("filing_id must be a string");
    }
    out.filing_id = args.filing_id;
  }

  if (args.filer_name !== undefined) {
    if (typeof args.filer_name !== "string") {
      throw new Error("filer_name must be a string");
    }
    out.filer_name = args.filer_name;
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

  if (args.filer_ticker !== undefined) {
    if (
      typeof args.filer_ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.filer_ticker)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.filer_ticker)}' — expected stock ticker`,
      );
    }
    out.filer_ticker = args.filer_ticker.toUpperCase();
  }

  if (args.filing_type !== undefined) {
    if (
      typeof args.filing_type !== "string" ||
      !["S-1", "S-1/A", "S-3", "S-3/A", "S-3ASR"].includes(
        args.filing_type,
      )
    ) {
      throw new Error(`INVALID filing_type: '${String(args.filing_type)}'`);
    }
    out.filing_type = args.filing_type as RegistrationStatementsQuery["filing_type"];
  }

  if (args.s1_only !== undefined) {
    out.s1_only = parseBooleanArg(args.s1_only, "s1_only");
  }
  if (args.s3_only !== undefined) {
    out.s3_only = parseBooleanArg(args.s3_only, "s3_only");
  }
  if (out.s1_only && out.s3_only) {
    throw new Error("s1_only and s3_only are mutually exclusive");
  }
  if (args.exclude_amendments !== undefined) {
    out.exclude_amendments = parseBooleanArg(args.exclude_amendments, "exclude_amendments");
  }

  if (args.sec_file_number !== undefined) {
    if (typeof args.sec_file_number !== "string") {
      throw new Error("sec_file_number must be a string");
    }
    out.sec_file_number = args.sec_file_number;
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
