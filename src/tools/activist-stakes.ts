/**
 * MCP tool: get_activist_stakes
 *
 * Exposes Schedule 13D / 13G beneficial-ownership disclosures (≥5%) from the
 * activist_ownership collection. Different signal than get_institutional_
 * holdings (which is 13F portfolio snapshots) — 13D/G is event-triggered
 * stake disclosure, with the activist-vs-passive flag (`is_activist`) as
 * the load-bearing differentiator.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryActivistOwnership } from "../firestore.js";
import type {
  ActivistOwnership,
  ActivistOwnershipQuery,
  ResultEnvelope,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_activist_stakes",
  annotations: {
    title: "Activist Stakes (SEC Schedule 13D/13G)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns Schedule 13D / 13G beneficial-ownership disclosures —",
    "filings made by anyone holding ≥5% of a class of registered equity",
    "securities. Each record is one reporting person on one filing (joint",
    "filings emit multiple rows under the same accession_number).",
    "",
    "Use this when the user asks about: who's accumulating large stakes,",
    "activist campaigns, takeover targets, hostile bids, or institutional",
    "concentration in a name. Also for 'who owns this company at the 5%+",
    "level?' questions.",
    "",
    "Two flavors, distinguished by `is_activist`:",
    "  - **13D (is_activist=true)**: filer signals INTENT TO INFLUENCE",
    "    control. Activist campaigns, takeover stakes, hostile bidders.",
    "  - **13G (is_activist=false)**: filer is PASSIVE. Mutual funds,",
    "    advisers, banks, insurers, qualified institutional holders.",
    "",
    "Filter `is_activist: true` to see only the takeover-style filings —",
    "much higher signal-to-noise than the 13G firehose, which is dominated",
    "by routine quarterly disclosures from Vanguard, BlackRock, etc.",
    "",
    "Filings since October 2023 ship structured XML and parse cleanly.",
    "Pre-2023 paper-style filings produce 0 records (silently skipped).",
    "The full 'Item 4: Purpose of Transaction' narrative on a 13D lives",
    "on the HTML side of the filing — not exposed by this tool. Follow",
    "the sec_filing_url for that.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "Issuer stock symbol filter, e.g. 'AAPL'. Case-insensitive.",
      },
      company_cik: {
        type: "string",
        description:
          "Issuer SEC CIK (10-digit, padded with leading zeros). Alternative to ticker.",
      },
      cusip: {
        type: "string",
        description:
          "9-character CUSIP of the security being reported on. Useful for cross-class filings (preferred vs common).",
      },
      filer_name: {
        type: "string",
        description:
          "Full or partial filer name; case-insensitive substring match. Example: 'BlackRock' matches all BlackRock entities.",
      },
      filer_cik: {
        type: "string",
        description: "Filer (reporting person) CIK. Exact match.",
      },
      is_activist: {
        type: "boolean",
        description:
          "Filter to 13D filings only (true) or 13G only (false). Omit to include both. Use is_activist=true to surface takeover/activist signal.",
      },
      filing_type: {
        type: "string",
        enum: [
          "SCHEDULE 13D",
          "SCHEDULE 13D/A",
          "SCHEDULE 13G",
          "SCHEDULE 13G/A",
        ],
        description:
          "Exact filing type. /A variants are amendments. Original 13D/G filings (no /A) signal a fresh crossing of the 5% threshold.",
      },
      min_percent_of_class: {
        type: "number",
        description:
          "Filter to filings where percent_of_class >= this value. Use to focus on large/concentrated stakes.",
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
        enum: ["filing_date", "event_date", "percent_of_class", "shares_owned"],
        description:
          "Field used for ordering and for the since/until date filters. Default: filing_date.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (most recent / largest first).",
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
): Promise<ResultEnvelope<ActivistOwnership>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryActivistOwnership(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

// ─── Input validation ───────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): ActivistOwnershipQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ActivistOwnershipQuery = {};

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

  if (args.cusip !== undefined) {
    if (typeof args.cusip !== "string" || !/^[A-Z0-9]{9}$/i.test(args.cusip)) {
      throw new Error(
        `INVALID_CUSIP: '${String(args.cusip)}' — expected 9 alphanumeric characters`,
      );
    }
    out.cusip = args.cusip.toUpperCase();
  }

  if (args.filer_name !== undefined) {
    if (typeof args.filer_name !== "string") {
      throw new Error("filer_name must be a string");
    }
    out.filer_name = args.filer_name;
  }

  if (args.filer_cik !== undefined) {
    if (typeof args.filer_cik !== "string") {
      throw new Error("filer_cik must be a string");
    }
    out.filer_cik = args.filer_cik;
  }

  if (args.is_activist !== undefined) {
    if (typeof args.is_activist !== "boolean") {
      throw new Error("is_activist must be a boolean");
    }
    out.is_activist = args.is_activist;
  }

  if (args.filing_type !== undefined) {
    if (
      args.filing_type !== "SCHEDULE 13D" &&
      args.filing_type !== "SCHEDULE 13D/A" &&
      args.filing_type !== "SCHEDULE 13G" &&
      args.filing_type !== "SCHEDULE 13G/A"
    ) {
      throw new Error(
        `INVALID filing_type: '${String(args.filing_type)}' — expected SCHEDULE 13D | SCHEDULE 13D/A | SCHEDULE 13G | SCHEDULE 13G/A`,
      );
    }
    out.filing_type = args.filing_type;
  }

  if (args.min_percent_of_class !== undefined) {
    if (
      typeof args.min_percent_of_class !== "number" ||
      args.min_percent_of_class < 0 ||
      args.min_percent_of_class > 100
    ) {
      throw new Error(
        "min_percent_of_class must be a number between 0 and 100",
      );
    }
    out.min_percent_of_class = args.min_percent_of_class;
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
      args.sort_by !== "event_date" &&
      args.sort_by !== "percent_of_class" &&
      args.sort_by !== "shares_owned"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected filing_date | event_date | percent_of_class | shares_owned`,
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
