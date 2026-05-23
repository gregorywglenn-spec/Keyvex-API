/**
 * MCP tool: get_insider_transactions
 *
 * Returns Form 4 open-market purchases and sales by corporate insiders.
 * Full design rationale, parameter semantics, and response shape live in
 * TOOL_DESIGN.md (Tool 2).
 *
 * Implementation pattern that the other four tools will follow:
 *   - export `definition` (Tool object — name, description, inputSchema)
 *   - export `handler` (validates input, calls firestore.ts, returns envelope)
 *
 * The MCP entry point in src/index.ts iterates a registry of these.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  queryForm3Holdings,
  queryInsiderTransactions,
  queryInsiderTransactionsV2,
} from "../firestore.js";
import type {
  Form3Holding,
  InsiderTransactionsEnvelope,
  InsiderTransactionsQuery,
  InsiderTransactionsV2Envelope,
  InsiderTransactionsV2Query,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "get_insider_transactions",
  annotations: {
    title: "Insider Transactions (SEC Form 4/5)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns executive insider transactions filed on SEC Form 4 — open-market",
    "purchases and sales by officers, directors, and 10%-owners of public",
    "companies. Each record is one transaction line item from one filing.",
    "",
    "Use this when the user asks about: insider buying or selling at a",
    "specific company, all recent insider activity across the market,",
    "transactions by a specific officer, or large insider trades by value.",
    "",
    "Form 4 is the fastest insider-trade signal in the public record — must",
    "be filed within 2 business days of the trade. The reporting_lag_days",
    "field tells you how stale a particular disclosure is.",
    "",
    "Returns BOTH non-derivative rows (direct common-stock buys/sells, RSU",
    "vests, grants, gifts, tax-withholding sales) AND derivative rows (option",
    "exercises, warrant conversions, RSU/PSU activity). Filter to one or the",
    "other with is_derivative; filter to specific transaction codes with",
    "transaction_codes.",
    "",
    "Common transaction codes:",
    "  P open-market purchase   |  S open-market sale",
    "  A grant / award / RSU vest  |  M exercise of derivative",
    "  X exercise of in/at-the-money derivative  |  C conversion of derivative",
    "  F payment of exercise price or tax with shares  |  G bona fide gift",
    "  D disposition to issuer (forced)  |  I 401(k)/ESPP  |  V voluntary",
    "",
    "Useful filter combos:",
    "  transaction_codes=['P']              open-market buys only (highest signal)",
    "  transaction_codes=['M','X']          option exercises (cash-out trigger)",
    "  transaction_codes=['A']              grants / RSU vests",
    "  is_derivative=true                   all option/RSU/warrant activity",
    "  is_derivative=false, transaction_type='sell', min_value=1000000",
    "                                       large open-market sells of common stock",
    "",
    "Optional include_baseline=true: also returns matching Form 3 initial-",
    "ownership records (the insider's *starting* position when they first",
    "became an insider) under a `baselines` field. Use this when you need",
    "to know how big a sale is relative to the insider's full position —",
    "Form 4 alone shows the delta, Form 3 anchors the baseline. Requires",
    "ticker or company_cik to be set.",
    "",
    "data_source SELECTS WHICH BACKING COLLECTION:",
    "  'legacy' (default) — `insider_trades` collection populated by KeyVex's",
    "    daily EDGAR scraper (limited history, no footnotes, no aff10b5one).",
    "    Filter set: ticker, company_cik, officer_name, transaction_type",
    "    (buy|sell), is_derivative, transaction_codes, min_value, since/until,",
    "    sort_by (disclosure_date|transaction_date|total_value).",
    "  'bulk_v2' — `insider_transactions_v2` collection populated by SEC bulk",
    "    Forms 3/4/5 quarterly TSV bundles (deeper history, INLINED FOOTNOTES,",
    "    aff10b5one 10b5-1 plan flag, full reporting_owners array, schema_era).",
    "    Filter set: ticker, company_cik, reporting_owner_cik,",
    "    reporting_owner_name (substring), row_type ('nonderiv'|'deriv'),",
    "    trans_codes, aff10b5one, schema_era ('pre_2023'|'2023_plus'),",
    "    since/until, sort_by ('transaction_date'|'filing_date').",
    "    Each row includes footnote_refs[] with resolved footnote text inlined.",
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
          "SEC CIK number (10-digit, padded with leading zeros). Alternative to ticker when known.",
      },
      officer_name: {
        type: "string",
        description:
          "Full or partial officer name; case-insensitive substring match.",
      },
      transaction_type: {
        type: "string",
        enum: ["buy", "sell"],
        description:
          "Filter by direction. For P/S rows this is the open-market direction; for other codes, derived from acquired_disposed (A→buy, D→sell).",
      },
      is_derivative: {
        type: "boolean",
        description:
          "Filter to derivative rows (options, RSUs, warrants, convertibles) when true, or non-derivative common-stock rows when false. Omit to see both.",
      },
      transaction_codes: {
        type: "array",
        items: { type: "string" },
        maxItems: 30,
        description:
          "OR-filter on raw SEC transaction codes. Common picks: ['P'] open-market buys; ['S','F'] sells + tax-withholding; ['M','X'] option exercises; ['A'] grants/RSU vests; ['G'] gifts. Max 30 codes.",
      },
      min_value: {
        type: "number",
        description:
          "Filter to trades with total_value >= this amount (USD). Use to focus on large trades.",
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
        enum: ["disclosure_date", "transaction_date", "total_value"],
        description:
          "Field used for ordering and for the since/until date filters. Default: disclosure_date.",
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
      include_baseline: {
        type: "boolean",
        description:
          "When true, the response includes matching Form 3 initial-ownership records under a `baselines` field — lets you anchor Form 4 deltas to the insider's starting position. Requires ticker or company_cik. Default false. (Legacy data_source only.)",
      },
      data_source: {
        type: "string",
        enum: ["legacy", "bulk_v2"],
        description:
          "Which backing collection to query. 'legacy' (default) = the daily EDGAR scraper output (no footnotes, no 10b5-1 flag). 'bulk_v2' = SEC quarterly bulk dataset output (footnote_refs[] inlined, aff10b5one present, full reporting_owners array). See main description for the per-source filter set.",
      },
      reporting_owner_cik: {
        type: "string",
        description:
          "Reporting owner CIK (10-digit, zero-padded). bulk_v2 only — legacy uses officer_name substring instead.",
      },
      reporting_owner_name: {
        type: "string",
        description:
          "Reporting owner name substring (case-insensitive). bulk_v2 only — legacy uses officer_name instead.",
      },
      row_type: {
        type: "string",
        enum: ["nonderiv", "deriv"],
        description:
          "bulk_v2 only. Source-table discriminator: 'nonderiv' for NONDERIV_TRANS rows (direct common-stock activity), 'deriv' for DERIV_TRANS rows (options/RSUs/warrants). For legacy data, use is_derivative instead.",
      },
      trans_codes: {
        type: "array",
        items: { type: "string" },
        maxItems: 30,
        description:
          "bulk_v2 only. OR-filter on raw SEC trans_code values (P, S, A, M, X, C, F, G, D, I, V, etc.). Same semantics as legacy transaction_codes but applied to the v2 field name. Max 30 codes.",
      },
      aff10b5one: {
        type: "string",
        enum: ["1", "0", "", "NOT_TRACKED"],
        description:
          "bulk_v2 only. 10b5-1 trading-plan flag. '1' = plan adopted, '0' = no plan, '' = filer left the box blank (most common in 2023q1+ era), 'NOT_TRACKED' = pre-2023 era where the column did not exist on the SEC form. Filers often leave the box blank but disclose the plan in narrative footnotes — check footnote_refs[] for trans_code annotations.",
      },
      schema_era: {
        type: "string",
        enum: ["pre_2023", "2023_plus"],
        description:
          "bulk_v2 only. Form-version era. 'pre_2023' = filings made 2006q1 through 2022q4 (no AFF10B5ONE column). '2023_plus' = filings made 2023q1 onward (AFF10B5ONE column present, matches SEC Rule 10b5-1 amendment compliance date). Driven by FILING-quarter, not transaction_date — a late 2024 filing of an old 2009 trade still gets schema_era=2023_plus.",
      },
    },
    additionalProperties: false,
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(
  args: unknown,
): Promise<InsiderTransactionsEnvelope | InsiderTransactionsV2Envelope> {
  // Two branches, fully separated by data_source. Default is "legacy" so
  // every existing caller behaves exactly as before; "bulk_v2" surfaces the
  // SEC Bulk Insider Dataset v2 collection (footnotes, aff10b5one,
  // reporting_owners). See tool description for filter-set differences.
  const dataSource = pickDataSource(args);

  if (dataSource === "bulk_v2") {
    return await handleV2(args);
  }
  return await handleLegacy(args);
}

function pickDataSource(args: unknown): "legacy" | "bulk_v2" {
  if (typeof args !== "object" || args === null) return "legacy";
  const ds = (args as Record<string, unknown>).data_source;
  if (ds === "bulk_v2") return "bulk_v2";
  if (ds === "legacy" || ds === undefined) return "legacy";
  throw new Error(
    `INVALID data_source: '${String(ds)}' — expected 'legacy' or 'bulk_v2'`,
  );
}

async function handleLegacy(
  args: unknown,
): Promise<InsiderTransactionsEnvelope> {
  const query = validateAndNormalize(args);

  // Run trades fetch and (optionally) baselines fetch in parallel.
  // Baselines lookup uses the same ticker / company_cik / officer_name
  // filters so the returned Form 3 rows align with the active query.
  const tradesPromise = queryInsiderTransactions(query);
  const baselinesPromise: Promise<Form3Holding[]> = query.include_baseline
    ? fetchMatchingBaselines(query)
    : Promise.resolve([]);

  const [{ results, has_more, coverage_warning }, baselines] = await Promise.all([
    tradesPromise,
    baselinesPromise,
  ]);

  const envelope: InsiderTransactionsEnvelope = {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };

  if (query.include_baseline) {
    envelope.baselines = baselines;
  }

  return envelope;
}

async function handleV2(
  args: unknown,
): Promise<InsiderTransactionsV2Envelope> {
  const query = validateAndNormalizeV2(args);
  const { results, has_more, coverage_warning } =
    await queryInsiderTransactionsV2(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: { ...query, data_source: "bulk_v2" } as Record<string, unknown>,
  };
}

/**
 * Pull Form 3 baseline rows that align with the active insider-trades
 * query. Matches by ticker or company_cik; if officer_name substring is
 * set, applies the same substring against filer_name (Form 3 doesn't have
 * an "officer_name" column — same person, different schema field).
 *
 * Capped at 100 baselines — agents don't typically need more, and bigger
 * pulls would dwarf the trades payload.
 */
async function fetchMatchingBaselines(
  query: InsiderTransactionsQuery,
): Promise<Form3Holding[]> {
  const { results } = await queryForm3Holdings({
    ticker: query.ticker,
    company_cik: query.company_cik,
    filer_name: query.officer_name,
    sort_by: "filing_date",
    sort_order: "desc",
    limit: 100,
  });
  return results;
}

// ─── Input validation ───────────────────────────────────────────────────────

/**
 * Validates and normalizes raw tool-call arguments into a typed query.
 *
 * MCP clients are supposed to honor inputSchema, but defense-in-depth says
 * validate at the handler boundary anyway. Bad input throws an error that
 * the MCP server returns as an isError content block.
 */
function validateAndNormalize(raw: unknown): InsiderTransactionsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: InsiderTransactionsQuery = {};

  if (args.ticker !== undefined) {
    // Permissive — accepts AAPL, BRK.A, BRK-B, HEI/A, LEN/B, BF.B, etc.
    // Letters first, then up to 9 more chars including digits, period, slash,
    // hyphen for share-class designators.
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

  if (args.officer_name !== undefined) {
    if (typeof args.officer_name !== "string") {
      throw new Error("officer_name must be a string");
    }
    out.officer_name = args.officer_name;
  }

  if (args.transaction_type !== undefined) {
    if (args.transaction_type !== "buy" && args.transaction_type !== "sell") {
      throw new Error(
        `INVALID transaction_type: '${String(args.transaction_type)}' — expected 'buy' or 'sell'`,
      );
    }
    out.transaction_type = args.transaction_type;
  }

  if (args.is_derivative !== undefined) {
    if (typeof args.is_derivative !== "boolean") {
      throw new Error("is_derivative must be a boolean");
    }
    out.is_derivative = args.is_derivative;
  }

  if (args.transaction_codes !== undefined) {
    if (
      !Array.isArray(args.transaction_codes) ||
      args.transaction_codes.length === 0 ||
      args.transaction_codes.length > 30 ||
      args.transaction_codes.some(
        (c) => typeof c !== "string" || !/^[A-Z]$/.test(c),
      )
    ) {
      throw new Error(
        "INVALID transaction_codes — expected non-empty array of single-letter uppercase SEC codes (max 30)",
      );
    }
    out.transaction_codes = args.transaction_codes as string[];
  }

  if (args.min_value !== undefined) {
    if (typeof args.min_value !== "number" || args.min_value < 0) {
      throw new Error("min_value must be a non-negative number");
    }
    out.min_value = args.min_value;
  }

  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }

  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }

  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "disclosure_date" &&
      args.sort_by !== "transaction_date" &&
      args.sort_by !== "total_value"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected disclosure_date | transaction_date | total_value`,
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

  if (args.include_baseline !== undefined) {
    if (typeof args.include_baseline !== "boolean") {
      throw new Error("include_baseline must be a boolean");
    }
    if (args.include_baseline && !out.ticker && !out.company_cik) {
      throw new Error(
        "INVALID_BASELINE_QUERY: include_baseline=true requires ticker or company_cik to be set",
      );
    }
    out.include_baseline = args.include_baseline;
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

// ─── v2 input validation (data_source="bulk_v2" branch) ─────────────────────

function validateAndNormalizeV2(raw: unknown): InsiderTransactionsV2Query {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: InsiderTransactionsV2Query = {};

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
    out.company_cik = args.company_cik.padStart(10, "0");
  }

  if (args.reporting_owner_cik !== undefined) {
    if (typeof args.reporting_owner_cik !== "string") {
      throw new Error("reporting_owner_cik must be a string");
    }
    out.reporting_owner_cik = args.reporting_owner_cik.padStart(10, "0");
  }

  if (args.reporting_owner_name !== undefined) {
    if (typeof args.reporting_owner_name !== "string") {
      throw new Error("reporting_owner_name must be a string");
    }
    out.reporting_owner_name = args.reporting_owner_name;
  }

  if (args.row_type !== undefined) {
    if (args.row_type !== "nonderiv" && args.row_type !== "deriv") {
      throw new Error(
        `INVALID row_type: '${String(args.row_type)}' — expected 'nonderiv' or 'deriv'`,
      );
    }
    out.row_type = args.row_type;
  }

  if (args.trans_codes !== undefined) {
    if (
      !Array.isArray(args.trans_codes) ||
      args.trans_codes.length === 0 ||
      args.trans_codes.length > 30 ||
      args.trans_codes.some(
        (c) => typeof c !== "string" || !/^[A-Z]$/.test(c),
      )
    ) {
      throw new Error(
        "INVALID trans_codes — expected non-empty array of single-letter uppercase SEC codes (max 30)",
      );
    }
    out.trans_codes = args.trans_codes as string[];
  }

  if (args.aff10b5one !== undefined) {
    if (
      args.aff10b5one !== "1" &&
      args.aff10b5one !== "0" &&
      args.aff10b5one !== "" &&
      args.aff10b5one !== "NOT_TRACKED"
    ) {
      throw new Error(
        `INVALID aff10b5one: '${String(args.aff10b5one)}' — expected '1', '0', '', or 'NOT_TRACKED'`,
      );
    }
    out.aff10b5one = args.aff10b5one;
  }

  if (args.schema_era !== undefined) {
    if (args.schema_era !== "pre_2023" && args.schema_era !== "2023_plus") {
      throw new Error(
        `INVALID schema_era: '${String(args.schema_era)}' — expected 'pre_2023' or '2023_plus'`,
      );
    }
    out.schema_era = args.schema_era;
  }

  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }

  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }

  if (args.sort_by !== undefined) {
    // v2 sort_by is a different (smaller) enum than legacy. If a caller passes
    // a legacy-only sort field (e.g. "disclosure_date" or "total_value") with
    // data_source="bulk_v2", reject early with a clear error rather than
    // silently re-mapping — neither field exists on the v2 schema.
    if (args.sort_by !== "transaction_date" && args.sort_by !== "filing_date") {
      throw new Error(
        `INVALID sort_by for data_source='bulk_v2': '${String(args.sort_by)}' — expected 'transaction_date' or 'filing_date'. Legacy-only values (disclosure_date, total_value) are not available on the v2 schema.`,
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
