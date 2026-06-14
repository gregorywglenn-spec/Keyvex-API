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
  queryConsumerComplaints,
  queryCongressionalTrades,
  queryEnforcementActions,
  queryExecutiveTrades,
  queryFederalContractAwards,
  queryForm144Filings,
  queryForm278Filings,
  queryForm3Holdings,
  queryInsiderTransactions,
  queryInstitutionalHoldings,
  queryMaterialEvents,
  queryNportFilings,
  queryNportHoldings,
  queryPrivatePlacements,
  queryProductRecalls,
  queryProxyFilings,
  queryRegistrationStatements,
  queryTenderOffers,
  queryTreasuryAuctions,
  queryXbrlFundamentals,
} from "../firestore.js";
import { resolveCompanyByName } from "../sec-tickers.js";
import type {
  UnifiedSearchEnvelope,
  UnifiedSearchQuery,
  UnifiedSearchSourceBlock,
} from "../types.js";

// ─── Tool definition ────────────────────────────────────────────────────────

export const definition: Tool = {
  name: "unified_search",
  annotations: {
    title: "Unified Cross-Source Search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  description: [
    "Identifier-driven cross-collection fan-out search. Pass one or more entity",
    "identifiers — ticker, bioguide_id, company_cik, recipient_uei, company_name,",
    "or cusip — and this tool queries every collection where that field is",
    "indexed, returning results grouped by source in one envelope.",
    "",
    "Use this for high-level 'tell me everything about X' questions before",
    "drilling into specific source tools. Replaces 6-10 sequential tool calls",
    "with a single fan-out.",
    "",
    "Identifier coverage:",
    "  - ticker → 13 collections (insider_trades, institutional_holdings,",
    "    congressional_trades, executive_trades, planned_insider_sales,",
    "    initial_ownership_baselines, activist_ownership, material_events,",
    "    proxy_filings, xbrl_fundamentals, tender_offers, registration_statements,",
    "    nport_holdings)",
    "  - bioguide_id → 2 collections (congressional_trades, annual_financial_disclosures)",
    "  - company_cik → 10 collections (insider_trades, planned_insider_sales,",
    "    initial_ownership_baselines, activist_ownership, material_events,",
    "    proxy_filings, xbrl_fundamentals, private_placements, registration_statements,",
    "    nport_filings)",
    "  - recipient_uei → 1 collection (federal_contracts)",
    "  - company_name → 4 name-keyed collections (federal_contracts,",
    "    enforcement_actions, consumer_complaints, product_recalls) AND auto-",
    "    resolves to ticker + company_cik via EDGAR's catalog, cascading into",
    "    every ticker/CIK adapter above. The unlock for 'tell me everything about",
    "    Wells Fargo' hitting 17+ collections in one call. (lobbying_filings is",
    "    excluded from the fan-out — its 51K-record substring scan is too slow",
    "    for parallel federation; call get_lobbying_filings directly instead.)",
    "  - cusip → 4 collections (institutional_holdings, activist_ownership,",
    "    nport_holdings, treasury_auctions)",
    "",
    "Multiple identifiers can be combined to narrow each source's query (e.g.,",
    "ticker + bioguide_id will filter congressional_trades by both).",
    "",
    "Name resolution: when only company_name is supplied, the resolved ticker",
    "and CIK come from EDGAR's company_tickers_exchange.json (US-listed names",
    "only). Foreign-only or private companies won't resolve to a ticker, but",
    "name-keyed collections (CFPB, lobbying, etc.) still receive the substring",
    "filter directly.",
    "",
    "Performance note: company_name fan-out includes substring-filtered",
    "collections (lobbying_filings 51K+, federal_contracts) which scan a 5K-",
    "record window per source. The full cascade can take 10-40s depending on",
    "Firestore region. When latency matters more than coverage, pass `sources`",
    "to whitelist only the ticker/CIK-keyed adapters (typically <1s total).",
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
        description: "Stock symbol. Case-insensitive. Fans out to 13 collections.",
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
      company_name: {
        type: "string",
        description:
          "Issuer name (e.g., 'Lockheed Martin', 'Wells Fargo'). Resolves to ticker + CIK via EDGAR catalog (if US-listed) AND substring-filters name-keyed collections (federal_contracts, enforcement_actions, consumer_complaints, product_recalls). For a company's lobbying activity, call get_lobbying_filings directly — it is excluded here for fan-out latency.",
      },
      cusip: {
        type: "string",
        description:
          "9-character CUSIP security identifier. Fans out to institutional_holdings, activist_ownership, nport_holdings, treasury_auctions.",
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
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description:
          "Alias for per_source_limit (this is a fan-out, so the cap is per source). Default 5, max 50.",
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
  // The underlying query functions return QueryResult<T>, which carries an
  // optional coverage_warning. Capture it here so the handler can propagate
  // it into the per-source block (Finding B fix, 2026-05-29) — otherwise an
  // empty rolling-window slice looks like a definitive "no data" answer
  // instead of "outside this collection's coverage window."
  call: (q: UnifiedSearchQuery, limit: number) => Promise<{
    results: unknown[];
    has_more: boolean;
    coverage_warning?: string;
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
      if (!q.ticker && !q.cusip) return null;
      // 13F has no since/until — the natural date is `quarter`. Skip date filter.
      return queryInstitutionalHoldings({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.cusip !== undefined && { cusip: q.cusip }),
        limit,
      });
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
    name: "executive_trades",
    call: (q, limit) => {
      // OGE 278-T is keyed by ticker (no company_cik field). The company_name
      // cascade resolves to a ticker upstream, so this adapter covers both the
      // ticker and company_name entry points. filer_name is the OFFICIAL's
      // name, not the issuer — so company_name is NOT a substring match here.
      if (!q.ticker) return null;
      return queryExecutiveTrades({
        ticker: q.ticker,
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
      if (!q.ticker && !q.company_cik && !q.cusip) return null;
      return queryActivistOwnership({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.cusip !== undefined && { cusip: q.cusip }),
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
    name: "xbrl_fundamentals",
    call: (q, limit) => {
      if (!q.ticker && !q.company_cik) return null;
      // For unified-search context, agents typically want the most-recent
      // observation per concept. latest_only:true is the cleanest default.
      return queryXbrlFundamentals({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.company_cik !== undefined && { company_cik: q.company_cik }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        latest_only: true,
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
      if (!q.recipient_uei && !q.company_name) return null;
      // Live-first (same as the dedicated tool). The cached subset returns 0
      // for most specific companies, which misleads "everything about X". The
      // 8s-bounded live call + cache fallback is worth the completeness; the
      // fan-out runs in parallel, so it's bounded by the slowest source.
      return queryFederalContractAwards({
        ...(q.recipient_uei !== undefined && { recipient_uei: q.recipient_uei }),
        ...(q.company_name !== undefined && { recipient_name: q.company_name }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  // NOTE: lobbying_filings is deliberately NOT a unified_search adapter.
  // The lobbying_filings collection is ~51K records and its only company
  // filter is a client_name / registrant_name SUBSTRING — which Firestore
  // can't index, so a match requires pulling a 20K-record window and
  // filtering client-side (~30-40s). That's fine as a dedicated-tool call
  // but far too slow for a parallel fan-out. Agents wanting a company's
  // lobbying activity should call get_lobbying_filings directly.
  // Revisit once lobbying_filings gets a normalized-name + array-contains
  // index (tracked as a v1.1 perf item).
  {
    name: "enforcement_actions",
    call: (q, limit) => {
      if (!q.company_name) return null;
      return queryEnforcementActions({
        // `text` searches title + description+teaser — broader than `title`
        // alone, which is what an agent looking up a company expects.
        text: q.company_name,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "consumer_complaints",
    call: (q, limit) => {
      if (!q.company_name) return null;
      // Live-first — see federal_contracts note above. Cache returned 0 for
      // even Wells Fargo; live (now bounded ~1s via search_term) returns real
      // complaints.
      return queryConsumerComplaints({
        company: q.company_name,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "product_recalls",
    call: (q, limit) => {
      if (!q.company_name) return null;
      return queryProductRecalls({
        recalling_firm: q.company_name,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
        limit,
      });
    },
  },
  {
    name: "nport_holdings",
    call: (q, limit) => {
      if (!q.ticker && !q.cusip) return null;
      return queryNportHoldings({
        ...(q.ticker !== undefined && { ticker: q.ticker }),
        ...(q.cusip !== undefined && { cusip: q.cusip }),
        limit,
      });
    },
  },
  {
    name: "treasury_auctions",
    call: (q, limit) => {
      if (!q.cusip) return null;
      return queryTreasuryAuctions({
        cusip: q.cusip,
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

  // Name-resolution cascade: if company_name is supplied and the caller
  // didn't pass an explicit ticker or company_cik, try to resolve the name
  // against EDGAR's catalog and back-fill the identifiers. Resolved
  // identifiers feed every ticker/CIK adapter automatically — that's the
  // unlock for "tell me everything about Wells Fargo" hitting 17+
  // collections in one call. If resolution fails (foreign-only / private
  // company), name-keyed adapters still run on the raw company_name.
  if (query.company_name && !query.ticker && !query.company_cik) {
    try {
      const resolved = await resolveCompanyByName(query.company_name);
      if (resolved) {
        query.ticker = resolved.ticker;
        query.company_cik = resolved.cik;
      }
    } catch {
      // EDGAR catalog load failure is non-fatal — name-keyed adapters
      // still run with the substring fallback. Surface no error since
      // partial results are still useful.
    }
  }

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
    .filter((x): x is { adapter: SourceAdapter; promise: Promise<{ results: unknown[]; has_more: boolean; coverage_warning?: string }> } => x !== null);

  const sourcesQueried = applicable.map((x) => x.adapter.name);

  // Fan out. allSettled so one failure doesn't block the others.
  const settled = await Promise.allSettled(applicable.map((x) => x.promise));

  const resultsBySource: Record<string, UnifiedSearchSourceBlock> = {};
  const sourcesWithResults: string[] = [];
  let totalCount = 0;

  settled.forEach((outcome, idx) => {
    const sourceName = applicable[idx]!.adapter.name;
    if (outcome.status === "fulfilled") {
      const { results, has_more, coverage_warning } = outcome.value;
      const block: UnifiedSearchSourceBlock = {
        count: results.length,
        has_more,
        results,
        // Propagate the upstream coverage_warning (Finding B fix). Same string
        // the standalone source tool would return — keeps the empty-slice
        // honest about whether 0 rows means "no data" or "outside coverage."
        ...(coverage_warning && { coverage_warning }),
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

  if (args.company_name !== undefined) {
    if (typeof args.company_name !== "string" || args.company_name.length < 2) {
      throw new Error(
        "company_name must be a string of at least 2 characters",
      );
    }
    out.company_name = args.company_name;
  }

  if (args.cusip !== undefined) {
    if (
      typeof args.cusip !== "string" ||
      !/^[A-Za-z0-9]{8,9}$/.test(args.cusip)
    ) {
      throw new Error(
        `INVALID_CUSIP: '${String(args.cusip)}' — expected 8-9 alphanumeric chars`,
      );
    }
    out.cusip = args.cusip.toUpperCase();
  }

  // At least one identifier required.
  if (
    !out.ticker &&
    !out.bioguide_id &&
    !out.company_cik &&
    !out.recipient_uei &&
    !out.company_name &&
    !out.cusip
  ) {
    throw new Error(
      "MISSING_IDENTIFIER: at least one of ticker, bioguide_id, company_cik, recipient_uei, company_name, or cusip is required",
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
  } else if (args.limit !== undefined) {
    // `limit` is a near-universal convention; accept it as an alias for
    // per_source_limit on this fan-out tool (per_source_limit wins if both set).
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 50
    ) {
      throw new Error(
        `INVALID limit: '${String(args.limit)}' — expected integer 1..50`,
      );
    }
    out.per_source_limit = args.limit;
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
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
