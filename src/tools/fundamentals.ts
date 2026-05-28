/**
 * MCP tool: get_fundamentals
 *
 * Returns XBRL-tagged financial fundamentals from public-company 10-K and
 * 10-Q filings. v1A curated 40-concept watchlist covering income statement
 * / balance sheet / cash flow / per-share metrics / entity-level info.
 *
 * Pairs naturally with get_material_events (8-K announcements), proxy
 * filings, insider transactions, and BLS macro context. This is the
 * "what's the actual financial state of this company?" tool.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryXbrlFundamentals } from "../firestore.js";
import { parseBooleanArg } from "./_validators.js";
import type {
  ResultEnvelope,
  XbrlFundamental,
  XbrlFundamentalsQuery,
} from "../types.js";

export const definition: Tool = {
  name: "get_fundamentals",
  annotations: {
    title: "Company Fundamentals (SEC XBRL)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns XBRL-tagged financial fundamentals from public-company 10-K",
    "and 10-Q filings, sourced from SEC EDGAR's company-facts API. Each",
    "record is one observation of one concept at one period end.",
    "",
    "Use this when the user asks about: revenue, profit, margins, cash",
    "position, debt, shareholder equity, EPS, share count, operating",
    "vs. financing cash flow, or any line-item-level financial state",
    "of a public company.",
    "",
    "v1A scope: a curated 40-concept watchlist covering:",
    "  - income_statement: Revenues / RevenueFromContractWithCustomer /",
    "    CostOfRevenue / GrossProfit / OperatingExpenses / R&D / SG&A /",
    "    OperatingIncomeLoss / InterestExpense / IncomeTaxExpenseBenefit /",
    "    NetIncomeLoss",
    "  - balance_sheet: Assets / AssetsCurrent / Cash / AccountsReceivable",
    "    / Inventory / PP&E / Goodwill / Liabilities / LongTermDebt /",
    "    StockholdersEquity / CommonStockSharesOutstanding",
    "  - cash_flow: NetCash{Operating/Investing/Financing}Activities /",
    "    PaymentsToAcquirePPE (capex) / PaymentsForRepurchaseOfCommonStock",
    "    / PaymentsOfDividends / DepreciationDepletionAndAmortization",
    "  - metrics: EarningsPerShareBasic/Diluted, weighted-avg share counts",
    "  - entity: EntityCommonStockSharesOutstanding (dei taxonomy)",
    "",
    "Key cautions on the data:",
    "  - The same concept can appear in multiple units (e.g., 'USD' and",
    "    'USD/shares' for EPS). Filter by unit if you need a specific shape.",
    "  - Many concepts have BOTH year-to-date cumulative observations AND",
    "    quarterly-period observations on 10-Q filings. The `frame` field",
    "    (e.g., 'CY2025Q3') marks the per-quarter point-period observation;",
    "    rows with empty `frame` are typically cumulative YTD.",
    "  - Older filings may use deprecated concept names; KeyVex catalog",
    "    includes both modern and legacy names where companies migrated",
    "    (e.g., Revenues AND RevenueFromContractWithCustomerExcludingAssessedTax).",
    "",
    "Set `latest_only=true` to get one record per (ticker × concept) — the",
    "most-recent observation. Useful for 'current state' snapshots.",
    "",
    "Pure-publisher posture: values are AS FILED. We do NOT compute derived",
    "ratios (P/E, ROE, ROIC), YoY/QoQ deltas, or 'real' vs nominal versions.",
    "Agents calculate those on top.",
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
        description: "SEC CIK number. Alternative to ticker.",
      },
      concept: {
        type: "string",
        description:
          "Exact XBRL tag name (e.g., 'NetIncomeLoss', 'Revenues', 'Assets', 'CashAndCashEquivalentsAtCarryingValue'). Case-sensitive.",
      },
      category: {
        type: "string",
        enum: [
          "income_statement",
          "balance_sheet",
          "cash_flow",
          "metrics",
          "entity",
        ],
        description: "Bucket filter when you don't know the exact concept name.",
      },
      fiscal_year: {
        type: "integer",
        description: "Filter to one fiscal year.",
      },
      fiscal_period: {
        type: "string",
        enum: ["Q1", "Q2", "Q3", "Q4", "FY"],
        description: "Filter to one fiscal period.",
      },
      form: {
        type: "string",
        enum: ["10-K", "10-Q", "10-K/A", "10-Q/A"],
        description: "Filter to one filing form.",
      },
      since: {
        type: "string",
        description: "ISO date YYYY-MM-DD. Applied to sort_by field.",
      },
      until: {
        type: "string",
        description: "ISO date YYYY-MM-DD.",
      },
      latest_only: {
        type: "boolean",
        description:
          "When true, return only the most-recent observation per (ticker × concept). Default false.",
      },
      sort_by: {
        type: "string",
        enum: ["period_end", "filed_date", "value"],
        description: "Default period_end.",
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
): Promise<ResultEnvelope<XbrlFundamental>> {
  const query = validateAndNormalize(args);
  const { results, has_more, coverage_warning } = await queryXbrlFundamentals(query);
  return {
    results,
    count: results.length,
    has_more,
    ...(coverage_warning && { coverage_warning }),
    query: query as Record<string, unknown>,
  };
}

function validateAndNormalize(raw: unknown): XbrlFundamentalsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: XbrlFundamentalsQuery = {};

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
  if (args.concept !== undefined) {
    if (typeof args.concept !== "string") {
      throw new Error("concept must be a string");
    }
    out.concept = args.concept;
  }
  if (args.category !== undefined) {
    const valid = [
      "income_statement",
      "balance_sheet",
      "cash_flow",
      "metrics",
      "entity",
    ];
    if (!valid.includes(args.category as string)) {
      throw new Error(`INVALID category: '${String(args.category)}'`);
    }
    out.category = args.category as string;
  }
  if (args.fiscal_year !== undefined) {
    if (
      typeof args.fiscal_year !== "number" ||
      !Number.isInteger(args.fiscal_year)
    ) {
      throw new Error(`INVALID fiscal_year: '${String(args.fiscal_year)}'`);
    }
    out.fiscal_year = args.fiscal_year;
  }
  if (args.fiscal_period !== undefined) {
    const valid = ["Q1", "Q2", "Q3", "Q4", "FY"];
    if (!valid.includes(args.fiscal_period as string)) {
      throw new Error(`INVALID fiscal_period: '${String(args.fiscal_period)}'`);
    }
    out.fiscal_period = args.fiscal_period as string;
  }
  if (args.form !== undefined) {
    const valid = ["10-K", "10-Q", "10-K/A", "10-Q/A"];
    if (!valid.includes(args.form as string)) {
      throw new Error(`INVALID form: '${String(args.form)}'`);
    }
    out.form = args.form as string;
  }
  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");
  if (args.latest_only !== undefined) {
    out.latest_only = parseBooleanArg(args.latest_only, "latest_only");
  }
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "period_end" &&
      args.sort_by !== "filed_date" &&
      args.sort_by !== "value"
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
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(`INVALID_DATE: ${fieldName}='${value}'`);
  }
  return value;
}
