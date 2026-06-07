/**
 * MCP tool: get_fund_holdings
 *
 * Returns per-security rows extracted from SEC Form N-PORT primary
 * documents. One row per `<invstOrSec>` element in the fund's monthly
 * portfolio report. Companion to `get_nport_filings` (the filing-level
 * tool) — N-PORT filings carry metadata, fund holdings carry the actual
 * portfolio detail.
 *
 * Covers equities, debt, derivatives (futures / forwards / swaps /
 * options / warrants / swaptions), repos, asset-backed securities, and
 * cash equivalents. The is_derivative + derivative_type fields make
 * fund-derivative exposure first-class queryable for the first time
 * outside Bloomberg / EDGAR XML parsing.
 *
 * Counterparty, strike, expiration, leg details, and other deep
 * derivative sub-block fields are NOT extracted in v1A — agents follow
 * the parent filing's primary_document_url for that level.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryNportHoldings } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  NportHolding,
  NportHoldingsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_fund_holdings",
  annotations: {
    title: "Fund Holdings (SEC Form N-PORT)",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Returns per-security holdings from SEC Form N-PORT primary documents",
    "— one row per investment-or-security line in a mutual fund / ETF /",
    "closed-end fund's monthly portfolio report. Use this when the user",
    "asks about: which funds hold a specific stock or bond, a fund's",
    "complete portfolio composition, fund-level derivative exposure",
    "(swaps, options, futures), repo positions, concentration by issuer,",
    "or to compose 'which ETFs added X this month' / 'which funds shorted",
    "Y' style queries.",
    "",
    "Source: parsed from each NportFiling's primary_doc.xml. Covers all",
    "asset categories N-PORT reports: equities (EC common, EP preferred),",
    "debt (DBT, ABS, MBS, UST, USTPS, STIV, SN, LT, MMF), derivatives",
    "(DCO commodity, DCR credit, DE equity, DFE fx, DIR rate, DR other),",
    "repos (REPO, RP), cash (CASH).",
    "",
    "Useful filter combos:",
    "  ticker='NVDA'                       all funds holding NVDA",
    "  cusip='037833100'                   AAPL by CUSIP (more reliable than ticker for N-PORT)",
    "  is_derivative=true, filer_name='BlackRock'",
    "                                       BlackRock's full derivative book",
    "  derivative_type='swap'              every swap position in the universe",
    "  asset_cat='REPO'                    repos and reverse-repo exposure",
    "  payoff_profile='Short'              short positions only",
    "  min_pct_of_portfolio=5              concentrated positions (>=5% of NAV)",
    "  filer_cik='0000884394'              one fund's complete portfolio",
    "",
    "Each holding ties to its parent NportFiling via filing_id. Read the",
    "parent for fund metadata (file_date, file_number, amendment flag);",
    "read the holding for security-level detail. is_derivative + derivative_type",
    "distinguish structured derivative rows from straight equity/debt holdings.",
    "",
    "Counterparty, strike, expiration, leg-level terms, and other deep",
    "derivative sub-block fields are NOT extracted in v1A — agents follow",
    "the parent filing's primary_document_url for that level of detail.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      filing_id: {
        type: "string",
        description:
          "EDGAR accession number — returns all holdings from one specific N-PORT filing (one fund-month).",
      },
      filer_cik: {
        type: "string",
        description:
          "Fund trust CIK (10-digit, padded with leading zeros). Returns the trust's holdings across all reporting months.",
      },
      filer_name: {
        type: "string",
        description:
          "Case-insensitive substring against fund trust name (e.g., 'iShares', 'Vanguard', 'SPDR').",
      },
      period_ending: {
        type: "string",
        description:
          "Reporting month-end (YYYY-MM-DD). Restricts results to one reporting period.",
      },
      name: {
        type: "string",
        description:
          "Case-insensitive substring against the holding issuer name (e.g., 'Apple', 'Treasury', 'Goldman Sachs').",
      },
      cusip: {
        type: "string",
        description:
          "Exact 9-character CUSIP. Most reliable identifier for equity and debt holdings in N-PORT.",
      },
      ticker: {
        type: "string",
        description:
          "Exact ticker symbol if filer included it in the identifiers block (less common than CUSIP).",
      },
      isin: {
        type: "string",
        description: "Exact ISIN if filer included it in the identifiers block.",
      },
      asset_cat: {
        type: "string",
        description:
          "Exact asset-category code. Examples: 'EC' common stock, 'DBT' debt, 'DE' equity derivative, 'DIR' rate derivative, 'REPO' repurchase agreement, 'UST' US Treasury, 'CASH' cash.",
      },
      is_derivative: {
        type: "boolean",
        description:
          "True returns only derivative rows (asset_cat starting with 'D'). False returns only non-derivative rows. Omit for both.",
      },
      derivative_type: {
        type: "string",
        enum: ["future", "forward", "swap", "option", "warrant", "swaption", "other"],
        description:
          "Structural derivative type, derived from which `<derivativeInfo>` child element is present in the filing.",
      },
      country: {
        type: "string",
        description: "ISO-2 country code of the holding (e.g., 'US', 'GB', 'JP').",
      },
      payoff_profile: {
        type: "string",
        enum: ["Long", "Short"],
        description:
          "Filter to long or short positions per N-PORT payoffProfile field.",
      },
      min_value_usd: {
        type: "number",
        description:
          "Minimum fair value in USD. Use to focus on large positions only.",
      },
      min_pct_of_portfolio: {
        type: "number",
        description:
          "Minimum percentage of fund net assets (0-100 scale). Use to focus on concentrated positions.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only holdings whose period_ending >= this date.",
      },
      until: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only holdings whose period_ending <= this date.",
      },
      sort_by: {
        type: "string",
        enum: ["value_usd", "pct_of_portfolio", "period_ending"],
        description: "Default: value_usd.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (largest / most recent first).",
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
): Promise<ResultEnvelope<NportHolding>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryNportHoldings(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): NportHoldingsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: NportHoldingsQuery = {};

  if (args.filing_id !== undefined) {
    if (typeof args.filing_id !== "string") {
      throw new Error("filing_id must be a string");
    }
    out.filing_id = args.filing_id;
  }
  if (args.filer_cik !== undefined) {
    if (typeof args.filer_cik !== "string") {
      throw new Error("filer_cik must be a string");
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
    out.period_ending = parseIsoDate(args.period_ending, "period_ending");
  }
  if (args.name !== undefined) {
    if (typeof args.name !== "string") throw new Error("name must be a string");
    out.name = args.name;
  }
  if (args.cusip !== undefined) {
    if (typeof args.cusip !== "string") {
      throw new Error("cusip must be a string");
    }
    out.cusip = args.cusip;
  }
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
  if (args.isin !== undefined) {
    if (typeof args.isin !== "string") throw new Error("isin must be a string");
    out.isin = args.isin;
  }
  if (args.asset_cat !== undefined) {
    if (typeof args.asset_cat !== "string") {
      throw new Error("asset_cat must be a string");
    }
    out.asset_cat = args.asset_cat;
  }
  if (args.is_derivative !== undefined) {
    out.is_derivative = parseBooleanArg(args.is_derivative, "is_derivative");
  }
  if (args.derivative_type !== undefined) {
    const allowed = new Set([
      "future",
      "forward",
      "swap",
      "option",
      "warrant",
      "swaption",
      "other",
    ]);
    if (
      typeof args.derivative_type !== "string" ||
      !allowed.has(args.derivative_type)
    ) {
      throw new Error(
        `INVALID derivative_type: '${String(args.derivative_type)}' — expected one of ${[...allowed].join(", ")}`,
      );
    }
    out.derivative_type = args.derivative_type;
  }
  if (args.country !== undefined) {
    if (typeof args.country !== "string") {
      throw new Error("country must be a string");
    }
    out.country = args.country;
  }
  if (args.payoff_profile !== undefined) {
    if (
      args.payoff_profile !== "Long" &&
      args.payoff_profile !== "Short"
    ) {
      throw new Error(
        `INVALID payoff_profile: '${String(args.payoff_profile)}' — expected 'Long' or 'Short'`,
      );
    }
    out.payoff_profile = args.payoff_profile;
  }
  if (args.min_value_usd !== undefined) {
    if (typeof args.min_value_usd !== "number" || args.min_value_usd < 0) {
      throw new Error("min_value_usd must be a non-negative number");
    }
    out.min_value_usd = args.min_value_usd;
  }
  if (args.min_pct_of_portfolio !== undefined) {
    if (
      typeof args.min_pct_of_portfolio !== "number" ||
      args.min_pct_of_portfolio < 0
    ) {
      throw new Error("min_pct_of_portfolio must be a non-negative number");
    }
    out.min_pct_of_portfolio = args.min_pct_of_portfolio;
  }
  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }
  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "value_usd" &&
      args.sort_by !== "pct_of_portfolio" &&
      args.sort_by !== "period_ending"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected value_usd | pct_of_portfolio | period_ending`,
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
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
