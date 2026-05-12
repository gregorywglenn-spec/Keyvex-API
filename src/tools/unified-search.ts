/**
 * MCP tool: unified_search
 *
 * Identifier-driven cross-collection fan-out. Pass a single entity
 * identifier — ticker, bioguide_id, company_cik, or recipient_uei — and
 * the tool fans out to every collection where that field is indexed,
 * returning per-source result blocks in one envelope.
 *
 * Replaces 6-10 tool calls for "tell me everything about X" questions.
 * One slow source doesn't block the rest — uses Promise.allSettled so
 * a failing or timed-out collection degrades to an error block in the
 * response rather than a tool-level failure.
 *
 * Per-source limit defaults to 5 so the envelope stays small enough
 * for chained tool calls to fit comfortably in an agent's context.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  queryActivistOwnership,
  queryCongressionalTrades,
  queryFederalContractAwards,
  queryForm144Filings,
  queryForm278Filings,
  queryForm3Holdings,
  queryInsiderTransactions,
  queryInstitutionalHoldings,
  queryMaterialEvents,
  queryNportFilings,
  queryOtcMarketWeekly,
  queryPrivatePlacements,
  queryProxyFilings,
  queryRegistrationStatements,
  queryTenderOffers,
} from "../firestore.js";
import type {
  UnifiedSearchEnvelope,
  UnifiedSearchQuery,
  UnifiedSearchSourceBlock,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "unified_search",
  description: [
    "Identifier-driven cross-collection fan-out search. Pass one or more entity",
    "identifiers — ticker, bioguide_id, company_cik, or recipient_uei — and",
    "this tool queries every collection where that field is indexed, returning",
    "results grouped by source in one envelope.",
    "",
    "Use this for high-level 'tell me everything about X' questions before",
    "drilling into specific source tools. Replaces 6-10 sequential tool calls",
    "with a single fan-out.",
    "",
    "Identifier coverage:",
    "  - ticker → 11 collections (insider_trades, institutional_holdings,",
    "    congressional_trades, planned_insider_sales, initial_ownership_baselines,",
    "    activist_ownership, material_events, proxy_filings, tender_offers,",
    "    registration_statements, otc_market_weekly)",
    "  - bioguide_id → 2 collections (congressional_trades, annual_financial_disclosures)",
    "  - company_cik → 9 collections (insider_trades, planned_insider_sales,",
    "    initial_ownership_baselines, activist_ownership, material_events,",
    "    proxy_filings, private_placements, registration_statements, nport_filings)",
    "  - recipient_uei → 1 collection (federal_contracts)",
    "",
    "Multiple identifiers can be combined to narrow each source's query (e.g.,",
    "ticker + bioguide_id will filter congressional_trades by both).",
    "",
    "Per-source result count is capped via per_source_limit (default 5,",
    "max 50). One slow or failing source returns an error block instead of",
    "blocking the rest — check sources_queried vs sources_with_results to",
    "see what landed.",
    "",
    "When you need full result counts and richer filters on one specific",
    "collection, call that collection's dedicated tool directly afterward.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      ticker: {
        type: "string",
        description: "Stock symbol. Case-insensitive. Fans out to 10 collections.",
      },
      bioguide_id: {
        type: "string",
        description:
          "Congressional bioguide ID (e.g. P000197 for Pelosi). Fans out to 2 collections.",
      },
      company_cik: {
        type: "string",
        description:
          "SEC CIK number for an issuer (10-digit, leading zeros). Fans out to 8 SEC collections.",
      },
      recipient_uei: {
        type: "string",
        description:
          "USAspending recipient UEI. Fans out to federal_contracts only.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Applied to each collection's primary date field.",
      },
      until: {
        type: "string",
        description: "ISO date (YYYY-MM-DD). Inclusive upper bound.",
      },
      per_source_limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max records per source. Default 5, max 50.",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional whitelist of source names. Default: all collections that index the provided identifier(s).",
      },
    },
    additionalProperties: false,
  },
};

// ─── Source adapter pattern ────────────────────────────────────────────────

/**
 * Each adapter knows which identifier(s) it supports and how to translate
 * the unified query into its collection's native query shape. Returns null
 * when the unified query doesn't include any field this source can filter on.
 */
interface SourceAdapter {
  name: string;
  call: (q: UnifiedSearchQuery, limit: number) => Promise<{
    results: unknown[];
    has_more: boolean;
  }> | null;
}

const ADAPTERS: SourceAdapter[] = [
  {
    name: "insider_trades",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryInsiderTransactions({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "institutional_holdings",
    call: (q, limit) => {
      if (!q.ticker) return null;
      // 13F has no since/until — the natural date is `quarter`. Skip date filter.
      return queryInstitutionalHoldings({ ticker: q.ticker, limit });
    },
  },
  {
    name: "congressional_trades",
    call: (q, limit) => {
      if (!q.ticker && !q.bioguide_id) return null;
      return queryCongressionalTrades({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.bioguide_id !== undefined && { bioguide_id: q.bioguide_id }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "planned_insider_sales",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryForm144Filings({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "initial_ownership_baselines",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryForm3Holdings({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "activist_ownership",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryActivistOwnership({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "material_events",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryMaterialEvents({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "proxy_filings",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryProxyFilings({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "tender_offers",
    call: (q, limit) => {
      if (!q.ticker) return null;
      return queryTenderOffers({
        target_ticker: q.ticker,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "registration_statements",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      return queryRegistrationStatements({
        ...(q.ticker !== undefined && { filer_ticker: q.ticker }),
        ...(q.company_cik !== undefined && { filer_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "otc_market_weekly",
    call: (q, limit) => {
      if (!q.ticker) return null;
      return queryOtcMarketWeekly({
        issue_symbol: q.ticker,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "annual_financial_disclosures",
    call: (q, limit) => {
      if (!q.bioguide_id) return null;
      return queryForm278Filings({
        bioguide_id: q.bioguide_id,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "private_placements",
    call: (q, limit) => {
      if (!q.company_cik) return null;
      return queryPrivatePlacements({
        issuer_cik: q.company_cik,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "nport_filings",
    call: (q, limit) => {
      if (!q.company_cik) return null;
      return queryNportFilings({
        filer_cik: q.company_cik,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "federal_contracts",
    call: (q, limit) => {
      if (!q.recipient_uei) return null;
      return queryFederalContractAwards({
        recipient_uei: q.recipient_uei,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
];

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(args: unknown): Promise<UnifiedSearchEnvelope> {
  const query = validateAndNormalize(args);
  const perSourceLimit = query.per_source_limit ?? 5;

  // Build the list of adapters whose collection actually responds to the
  // provided identifier(s). Apply `sources` whitelist if present.
  const whitelist = query.sources ? new Set(query.sources) : null;

  const applicable = ADAPTERS
    .map((adapter) => {
      if (whitelist && !whitelist.has(adapter.name)) return null;
      const promise = adapter.call(query, perSourceLimit);
      if (promise === null) return null;
      return { adapter, promise };
    })
    .filter((x): x is { adapter: SourceAdapter; promise: Promise<{ results: unknown[]; has_more: boolean }> } => x !== null);

  const sourcesQueried = applicable.map((x) => x.adapter.name);

  // Fan out. allSettled so one failure doesn't block the others.
  const settled = await Promise.allSettled(applicable.map((x) => x.promise));

  const resultsBySource: Record<string, UnifiedSearchSourceBlock> = {};
  const sourcesWithResults: string[] = [];
  let totalCount = 0;

  settled.forEach((outcome, idx) => {
    const sourceName = applicable[idx]!.adapter.name;
    if (outcome.status === "fulfilled") {
      const { results, has_more } = outcome.value;
      const block: UnifiedSearchSourceBlock = {
        count: results.length,
        has_more,
        results,
      };
      resultsBySource[sourceName] = block;
      if (results.length > 0) {
        sourcesWithResults.push(sourceName);
        totalCount += results.length;
      }
    } else {
      const message =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      resultsBySource[sourceName] = {
        count: 0,
        has_more: false,
        results: [],
        error: message,
      };
    }
  });

  return {
    query,
    results_by_source: resultsBySource,
    total_count: totalCount,
    sources_queried: sourcesQueried,
    sources_with_results: sourcesWithResults,
  };
}

// ─── Input validation ──────────────────────────────────────────────────────

function validateAndNormalize(raw: unknown): UnifiedSearchQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: UnifiedSearchQuery = {};

  if (args.ticker !== undefined) {
    if (
      typeof args.ticker !== "string" ||
      !/^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(args.ticker)
    ) {
      throw new Error(
        `INVALID_TICKER: '${String(args.ticker)}' — expected 1-10 chars, letters first`,
      );
    }
    out.ticker = args.ticker.toUpperCase();
  }

  if (args.bioguide_id !== undefined) {
    if (
      typeof args.bioguide_id !== "string" ||
      !/^[A-Z]\d{6}$/.test(args.bioguide_id)
    ) {
      throw new Error(
        `INVALID_BIOGUIDE_ID: '${String(args.bioguide_id)}' — expected letter + 6 digits (e.g. P000197)`,
      );
    }
    out.bioguide_id = args.bioguide_id;
  }

  if (args.company_cik !== undefined) {
    if (typeof args.company_cik !== "string") {
      throw new Error("company_cik must be a string");
    }
    out.company_cik = args.company_cik;
  }

  if (args.recipient_uei !== undefined) {
    if (typeof args.recipient_uei !== "string") {
      throw new Error("recipient_uei must be a string");
    }
    out.recipient_uei = args.recipient_uei;
  }

  // At least one identifier required.
  if (
    !out.ticker &&
    !out.bioguide_id &&
    !out.company_cik &&
    !out.recipient_uei
  ) {
    throw new Error(
      "MISSING_IDENTIFIER: at least one of ticker, bioguide_id, company_cik, or recipient_uei is required",
    );
  }

  if (args.since !== undefined) out.since = parseIsoDate(args.since, "since");
  if (args.until !== undefined) out.until = parseIsoDate(args.until, "until");

  if (args.per_source_limit !== undefined) {
    if (
      typeof args.per_source_limit !== "number" ||
      !Number.isInteger(args.per_source_limit) ||
      args.per_source_limit < 1 ||
      args.per_source_limit > 50
    ) {
      throw new Error(
        `INVALID per_source_limit: '${String(args.per_source_limit)}' — expected integer 1..50`,
      );
    }
    out.per_source_limit = args.per_source_limit;
  }

  if (args.sources !== undefined) {
    if (
      !Array.isArray(args.sources) ||
      !args.sources.every((s) => typeof s === "string")
    ) {
      throw new Error("sources must be an array of strings");
    }
    out.sources = args.sources as string[];
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
