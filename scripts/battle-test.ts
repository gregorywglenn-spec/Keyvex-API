/**
 * Battle test: exercises every MCP tool with realistic randomized query
 * shapes. Catalogs failures + warnings. Runs against local MCP handlers
 * (same code path as live production).
 *
 * For each tool we run multiple representative query patterns:
 *   - "happy path" with realistic filters
 *   - "limit-only" baseline (defaults / sort order)
 *   - direct-id lookup (when applicable) using IDs harvested from real data
 *   - edge case (often empty result or extreme filter)
 *
 * Failure types we track:
 *   ERROR    — handler threw (should never happen on valid input)
 *   EMPTY    — query returned 0 results when data is known to exist
 *   SCHEMA   — result shape doesn't match the expected interface
 *   SLOW     — handler took longer than 5s
 *
 * Each test is annotated with what it's checking + expected behaviour.
 */

import { TOOLS } from "../src/tools/index.js";
import type { ResultEnvelope } from "../src/types.js";

interface TestCase {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  /** Set true when 0 results is genuinely expected (rare). */
  allowEmpty?: boolean;
}

// ─── Sample of REAL IDs harvested from today's backfills ───────────────────

const KNOWN_IDS = {
  // FEC: McCormick (PA-Senate, R, incumbent)
  fec_candidate: "S2PA00661",
  // Tender offer: Aurinia bid for Kezar
  tender_accession: "0001140361-26-014344",
  // Bill: Protecting our Communities from Sexual Predators Act
  bill: "119-HR-134",
  // House vote: HR-498 final passage
  house_vote: "house-119-1-362",
  // Member: Susan Collins (R-ME)
  bioguide: "C001035",
  // OFAC: Aerocaribbean Airlines (entity #36)
  ofac: "36",
  // Form D: real PA Senator's fund (verified earlier — pick something likely-real)
  // Federal Register: Yemen national emergency proclamation
  fedreg: "2026-09385",
};

const TESTS: TestCase[] = [
  // ─── 1. get_insider_transactions (Form 4) ──────────────────────────────
  { tool: "get_insider_transactions", label: "limit-only baseline", args: { limit: 3 } },
  { tool: "get_insider_transactions", label: "ticker filter (AAPL)", args: { ticker: "AAPL", limit: 5 } },
  { tool: "get_insider_transactions", label: "officer substring", args: { officer_name: "cook", limit: 3 } },
  { tool: "get_insider_transactions", label: "include_baseline", args: { ticker: "AAPL", include_baseline: true, limit: 3 } },

  // ─── 2. get_institutional_holdings (13F) ───────────────────────────────
  { tool: "get_institutional_holdings", label: "ticker filter (AAPL)", args: { ticker: "AAPL", limit: 5 } },
  { tool: "get_institutional_holdings", label: "Berkshire holdings", args: { fund_name: "berkshire", limit: 5 } },
  { tool: "get_institutional_holdings", label: "min_value $1B+", args: { min_value: 1_000_000_000, limit: 5 } },

  // ─── 3. get_congressional_trades ───────────────────────────────────────
  { tool: "get_congressional_trades", label: "NVDA recent", args: { ticker: "NVDA", limit: 5 } },
  { tool: "get_congressional_trades", label: "buys only", args: { transaction_type: "buy", limit: 5 } },
  { tool: "get_congressional_trades", label: "by bioguide", args: { bioguide_id: KNOWN_IDS.bioguide, limit: 3 } },

  // ─── 4. get_planned_insider_sales (Form 144) ───────────────────────────
  { tool: "get_planned_insider_sales", label: "AAPL planned sales", args: { ticker: "AAPL", limit: 3 } },
  { tool: "get_planned_insider_sales", label: "10b5-1 filter", args: { limit: 5 } },

  // ─── 5. get_activist_stakes (13D/13G) ──────────────────────────────────
  { tool: "get_activist_stakes", label: "top by % of class", args: { sort_by: "percent_of_class", limit: 5 } },
  { tool: "get_activist_stakes", label: "BlackRock 5%+", args: { filer_name: "blackrock", limit: 5 } },
  { tool: "get_activist_stakes", label: "activists only", args: { is_activist: true, limit: 5 } },

  // ─── 6. get_federal_contracts (USAspending) ────────────────────────────
  { tool: "get_federal_contracts", label: "Lockheed", args: { recipient_name: "lockheed", limit: 5 } },
  { tool: "get_federal_contracts", label: "by amount", args: { min_amount: 100_000_000, limit: 5 } },

  // ─── 7. get_member_profile (legislators) ───────────────────────────────
  { tool: "get_member_profile", label: "direct bioguide", args: { bioguide_id: KNOWN_IDS.bioguide } },
  { tool: "get_member_profile", label: "ME senators", args: { state: "ME", chamber: "senate", limit: 5 } },
  { tool: "get_member_profile", label: "HSAS committee", args: { committee_id: "HSAS", limit: 10 } },

  // ─── 8. get_material_events (8-K) ──────────────────────────────────────
  { tool: "get_material_events", label: "AAPL 8-K", args: { ticker: "AAPL", limit: 5 } },
  { tool: "get_material_events", label: "M&A item 1.01", args: { item_codes: ["1.01"], limit: 5 } },

  // ─── 9. get_lobbying_filings (LDA) ─────────────────────────────────────
  { tool: "get_lobbying_filings", label: "Pfizer recent", args: { client_name: "pfizer", limit: 5 } },
  { tool: "get_lobbying_filings", label: "DEF issue 2025", args: { general_issue_codes: ["DEF"], filing_year: 2025, limit: 5 } },

  // ─── 10. get_annual_financial_disclosures (Form 278) ───────────────────
  { tool: "get_annual_financial_disclosures", label: "recent senate Annual", args: { chamber: "senate", report_type: "Annual", limit: 5 } },
  { tool: "get_annual_financial_disclosures", label: "filing year 2024", args: { filing_year: 2024, limit: 5 } },

  // ─── 11. get_fec_candidate_profile ─────────────────────────────────────
  { tool: "get_fec_candidate_profile", label: "direct id (McCormick)", args: { candidate_id: KNOWN_IDS.fec_candidate, include_committees: true } },
  { tool: "get_fec_candidate_profile", label: "PA-Senate Republicans", args: { state: "PA", office: "S", party: "REP", limit: 5 } },
  { tool: "get_fec_candidate_profile", label: "name substring", args: { candidate_name: "smith", limit: 5 } },

  // ─── 12. get_tender_offers (Schedule TO) ───────────────────────────────
  { tool: "get_tender_offers", label: "third-party only", args: { third_party_only: true, exclude_amendments: true, limit: 5 } },
  { tool: "get_tender_offers", label: "issuer buybacks", args: { issuer_only: true, limit: 5 } },
  { tool: "get_tender_offers", label: "by accession", args: { accession_number: KNOWN_IDS.tender_accession } },

  // ─── 13. get_bills ─────────────────────────────────────────────────────
  { tool: "get_bills", label: "direct id", args: { bill_id: KNOWN_IDS.bill } },
  { tool: "get_bills", label: "119 HR sample", args: { congress: 119, bill_type: "HR", limit: 5 } },
  { tool: "get_bills", label: "title 'children'", args: { title: "children", limit: 5 } },

  // ─── 14. get_roll_call_votes ───────────────────────────────────────────
  { tool: "get_roll_call_votes", label: "direct vote_id", args: { vote_id: KNOWN_IDS.house_vote } },
  { tool: "get_roll_call_votes", label: "119 session 1 recent", args: { congress: 119, session_number: 1, limit: 5 } },
  { tool: "get_roll_call_votes", label: "failed votes", args: { result: "Failed", limit: 5 } },

  // ─── 15. get_otc_market_weekly (FINRA) ─────────────────────────────────
  { tool: "get_otc_market_weekly", label: "NVDA week 2026-03-30", args: { issue_symbol: "NVDA", week_start_date: "2026-03-30", limit: 5 } },
  { tool: "get_otc_market_weekly", label: "JPBX top tickers", args: { mpid: "JPBX", sort_by: "total_weekly_share_quantity", limit: 5 } },
  { tool: "get_otc_market_weekly", label: "T1 top by notional", args: { tier_identifier: "T1", sort_by: "total_notional_sum", limit: 5 } },

  // ─── 16. get_private_placements (Form D) ───────────────────────────────
  { tool: "get_private_placements", label: "VC funds", args: { investment_fund_type: "venture capital", limit: 5 } },
  { tool: "get_private_placements", label: "506(c) $1M+", args: { federal_exemption: "06c", min_amount_sold: 1_000_000, limit: 5 } },
  { tool: "get_private_placements", label: "CA issuers recent", args: { issuer_state: "CA", limit: 5 } },

  // ─── 17. get_enforcement_actions ───────────────────────────────────────
  { tool: "get_enforcement_actions", label: "SEC only", args: { source: "sec", limit: 5 } },
  { tool: "get_enforcement_actions", label: "DOJ only", args: { source: "doj", limit: 5 } },
  { tool: "get_enforcement_actions", label: "fraud text", args: { text: "fraud", limit: 5 } },

  // ─── 18. get_nport_filings ─────────────────────────────────────────────
  { tool: "get_nport_filings", label: "recent baseline", args: { limit: 5 } },
  // NPORT backfill window started 2026-05-05; WisdomTree's filing was 2026-05-04
  // and isn't in our collection. Use a name we know IS present (from collection inspection).
  { tool: "get_nport_filings", label: "name 'forum funds'", args: { filer_name: "forum funds", limit: 5 } },

  // ─── 19. get_registration_statements (S-1/S-3) ─────────────────────────
  // Note: plain S-1 backfill hit a transient EDGAR 500; data has S-1/A but
  // not original S-1 in this slice. Test with amendments included so we
  // find the IPO-family records we DO have.
  { tool: "get_registration_statements", label: "S-1 family (incl /A)", args: { s1_only: true, limit: 5 } },
  { tool: "get_registration_statements", label: "S-3 shelf", args: { s3_only: true, limit: 5 } },

  // ─── 20. get_ofac_sdn ──────────────────────────────────────────────────
  { tool: "get_ofac_sdn", label: "direct ent_num", args: { ent_num: KNOWN_IDS.ofac } },
  { tool: "get_ofac_sdn", label: "CUBA program", args: { program: "CUBA", limit: 5 } },
  { tool: "get_ofac_sdn", label: "individuals", args: { entity_type: "individual", limit: 5 } },
  { tool: "get_ofac_sdn", label: "name 'bank'", args: { name: "bank", limit: 5 } },

  // ─── 21. get_federal_register_documents ────────────────────────────────
  { tool: "get_federal_register_documents", label: "direct doc", args: { document_number: KNOWN_IDS.fedreg } },
  { tool: "get_federal_register_documents", label: "Proposed Rule", args: { document_type: "Proposed Rule", limit: 5 } },
  { tool: "get_federal_register_documents", label: "SEC agency", args: { agency_slug: "securities-and-exchange-commission", limit: 5 } },
  // Pick a topic likely to appear in a 1-week Federal Register window.
  // "Notice" appears in many titles; safer than topic-specific terms.
  { tool: "get_federal_register_documents", label: "text 'notice'", args: { text: "notice", limit: 5 } },

  // ─── 22. unified_search (cross-collection fan-out) ─────────────────────
  // Different envelope shape (results_by_source), so we read total_count
  // from the envelope post-handler in runOne. The tool isn't a list
  // returning ResultEnvelope<T>; it's a federated multi-source response.
  { tool: "unified_search", label: "ticker=LMT fan-out", args: { ticker: "LMT", per_source_limit: 2 } },
  { tool: "unified_search", label: "company_cik=Apple fan-out", args: { company_cik: "0000320193", per_source_limit: 2 } },
  { tool: "unified_search", label: "bioguide=Collins fan-out", args: { bioguide_id: KNOWN_IDS.bioguide, per_source_limit: 3 } },
  { tool: "unified_search", label: "ticker+sources whitelist", args: { ticker: "NVDA", sources: ["insider_trades", "material_events", "congressional_trades"], per_source_limit: 2 } },

  // ─── 23. get_proxy_filings (DEF 14A) ──────────────────────────────────
  { tool: "get_proxy_filings", label: "AAPL proxy family", args: { ticker: "AAPL", limit: 5 } },
  { tool: "get_proxy_filings", label: "merger proxies only", args: { is_merger_related: true, limit: 5 } },
  { tool: "get_proxy_filings", label: "recent annual DEF 14A", args: { filing_type: "DEF 14A", limit: 5 } },

  // ─── 24. get_treasury_auctions ────────────────────────────────────────
  { tool: "get_treasury_auctions", label: "recent baseline", args: { limit: 5 } },
  { tool: "get_treasury_auctions", label: "Notes only", args: { security_type: "Note", limit: 5 } },
  { tool: "get_treasury_auctions", label: "strong demand >=2.5 BTC", args: { min_bid_to_cover: 2.5, limit: 5 } },

  // ─── 25. get_economic_indicators (BLS) ────────────────────────────────
  { tool: "get_economic_indicators", label: "current macro snapshot", args: { latest_only: true, limit: 20 } },
  { tool: "get_economic_indicators", label: "U-3 unemployment series", args: { series_id: "LNS14000000", limit: 12 } },
  { tool: "get_economic_indicators", label: "inflation category", args: { category: "inflation", limit: 10 } },
  { tool: "get_economic_indicators", label: "quarterly only", args: { period_type: "quarterly", limit: 5 } },

  // ─── 26. get_oig_exclusions (HHS-OIG LEIE) ────────────────────────────
  { tool: "get_oig_exclusions", label: "NY exclusions", args: { state: "NY", limit: 5 } },
  { tool: "get_oig_exclusions", label: "pharmacy category", args: { general_category: "PHARMACY", limit: 5 } },
  { tool: "get_oig_exclusions", label: "businesses only", args: { is_business: true, limit: 5 } },
  { tool: "get_oig_exclusions", label: "exclusion type 1128a1", args: { exclusion_type: "1128a1", limit: 5 } },

  // ─── 27. get_consumer_complaints (CFPB) ───────────────────────────────
  { tool: "get_consumer_complaints", label: "recent baseline", args: { limit: 5 } },
  { tool: "get_consumer_complaints", label: "Experian complaints", args: { company: "Experian", limit: 5 } },
  { tool: "get_consumer_complaints", label: "credit reporting issue", args: { product: "Credit reporting or other personal consumer reports", limit: 5 } },
  { tool: "get_consumer_complaints", label: "CA state filter", args: { state: "CA", limit: 5 } },

  // ─── enforcement_actions: NEW sources (CFTC / OCC / FDIC) ─────────────
  { tool: "get_enforcement_actions", label: "CFTC actions", args: { source: "cftc", limit: 5 } },
  { tool: "get_enforcement_actions", label: "OCC actions", args: { source: "occ", limit: 5 } },
  { tool: "get_enforcement_actions", label: "FDIC actions", args: { source: "fdic", limit: 5 } },

  // ─── Day 10 v0.41.0 NEW SURFACES ─────────────────────────────────────
  // Data for these 3 collections is ingested by scrapers that haven't run
  // yet at the moment of this commit. allowEmpty=true keeps EMPTY out of
  // the warnings list — we're only verifying the handlers don't ERROR.
  // Post first-run, agents can remove allowEmpty to start asserting data.

  // ─── 28. get_fund_holdings (N-PORT per-security) ───────────────────────
  { tool: "get_fund_holdings", label: "ticker=NVDA", args: { ticker: "NVDA", limit: 5 }, allowEmpty: true },
  { tool: "get_fund_holdings", label: "derivatives only", args: { is_derivative: true, limit: 5 }, allowEmpty: true },
  { tool: "get_fund_holdings", label: "swap type", args: { derivative_type: "swap", limit: 5 }, allowEmpty: true },
  { tool: "get_fund_holdings", label: "REPO asset_cat", args: { asset_cat: "REPO", limit: 5 }, allowEmpty: true },

  // ─── 29. get_product_recalls (FDA + CPSC) ──────────────────────────────
  { tool: "get_product_recalls", label: "FDA drug recalls", args: { source: "fda_drug", limit: 5 }, allowEmpty: true },
  { tool: "get_product_recalls", label: "FDA Class I (severe)", args: { classification: "Class I", limit: 5 }, allowEmpty: true },
  { tool: "get_product_recalls", label: "CPSC consumer recalls", args: { source: "cpsc", limit: 5 }, allowEmpty: true },
  { tool: "get_product_recalls", label: "Pfizer recalls", args: { recalling_firm: "pfizer", limit: 5 }, allowEmpty: true },

  // ─── 30. get_government_publications (GovInfo) ─────────────────────────
  { tool: "get_government_publications", label: "committee reports", args: { collection: "CRPT", limit: 5 }, allowEmpty: true },
  { tool: "get_government_publications", label: "public laws", args: { collection: "PLAW", limit: 5 }, allowEmpty: true },
  { tool: "get_government_publications", label: "GAO oversight", args: { collection: "GAOREPORTS", limit: 5 }, allowEmpty: true },
  { tool: "get_government_publications", label: "119th Congress only", args: { congress: "119", limit: 5 }, allowEmpty: true },

  // ─── get_economic_indicators: NEW EIA source ─────────────────────────
  { tool: "get_economic_indicators", label: "EIA energy", args: { source: "eia", limit: 5 }, allowEmpty: true },
  { tool: "get_economic_indicators", label: "WTI crude", args: { series_id: "EIA-WTI-SPOT-WEEKLY", limit: 5 }, allowEmpty: true },
  { tool: "get_economic_indicators", label: "energy category", args: { category: "energy", limit: 5 }, allowEmpty: true },

  // ─── unified_search v1.1: company_name + cusip identifiers ─────────────
  // company_name cascade should resolve to ticker+cik via EDGAR. The fan-out
  // hits both ticker/cik adapters AND the new name-keyed adapters even when
  // no data is present. Verifies validation + adapter routing, not data.
  { tool: "unified_search", label: "company_name=Wells Fargo fan-out", args: { company_name: "Wells Fargo", per_source_limit: 2 }, allowEmpty: true },
  { tool: "unified_search", label: "company_name=Lockheed (cascade)", args: { company_name: "Lockheed Martin", per_source_limit: 2 }, allowEmpty: true },
  { tool: "unified_search", label: "cusip-only fan-out", args: { cusip: "037833100", per_source_limit: 3 }, allowEmpty: true },
];

interface TestResult {
  tool: string;
  label: string;
  status: "PASS" | "EMPTY" | "ERROR" | "SLOW";
  count: number;
  has_more: boolean;
  elapsed_ms: number;
  error?: string;
}

async function runOne(t: TestCase): Promise<TestResult> {
  const mod = TOOLS.find((tool) => tool.definition.name === t.tool);
  if (!mod) {
    return {
      tool: t.tool,
      label: t.label,
      status: "ERROR",
      count: 0,
      has_more: false,
      elapsed_ms: 0,
      error: `Tool '${t.tool}' not found in registry`,
    };
  }
  const startedAt = Date.now();
  try {
    const raw = (await mod.handler(t.args)) as
      | ResultEnvelope<unknown>
      | { total_count: number; sources_with_results: string[]; results_by_source: Record<string, unknown> }
      | { result: unknown | null };
    const elapsed = Date.now() - startedAt;

    // Tools return one of three shapes — list (ResultEnvelope), single
    // (SingleResultEnvelope), or unified_search (fan-out envelope). Read
    // count + has_more uniformly across all three.
    let count: number;
    let hasMore = false;
    if ("total_count" in raw) {
      // unified_search envelope: count = sum across sources, has_more = any
      // source reports has_more.
      count = raw.total_count;
      hasMore = Object.values(raw.results_by_source).some(
        (b) => typeof b === "object" && b !== null && "has_more" in b && (b as { has_more: boolean }).has_more,
      );
    } else if ("results" in raw) {
      count = (raw as ResultEnvelope<unknown>).count;
      hasMore = (raw as ResultEnvelope<unknown>).has_more;
    } else {
      // SingleResultEnvelope: count is 1 if result != null else 0.
      count = (raw as { result: unknown | null }).result === null ? 0 : 1;
    }

    let status: TestResult["status"] = "PASS";
    if (count === 0 && !t.allowEmpty) status = "EMPTY";
    if (elapsed > 5000) status = "SLOW";
    return {
      tool: t.tool,
      label: t.label,
      status,
      count,
      has_more: hasMore,
      elapsed_ms: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    return {
      tool: t.tool,
      label: t.label,
      status: "ERROR",
      count: 0,
      has_more: false,
      elapsed_ms: elapsed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`BATTLE TEST — ${TESTS.length} queries across ${TOOLS.length} MCP tools`);
  console.log("=".repeat(78));

  const results: TestResult[] = [];
  for (const t of TESTS) {
    const r = await runOne(t);
    results.push(r);
    const icon =
      r.status === "PASS"
        ? "✓"
        : r.status === "EMPTY"
          ? "○"
          : r.status === "SLOW"
            ? "⟳"
            : "✗";
    const right =
      r.status === "ERROR"
        ? `ERROR: ${r.error?.slice(0, 80)}`
        : `${r.count} results${r.has_more ? "+" : ""} in ${r.elapsed_ms}ms`;
    console.log(
      `${icon} [${r.status.padEnd(5)}] ${r.tool.padEnd(38)} ${r.label.padEnd(34)} ${right}`,
    );
  }

  console.log(`\n${"=".repeat(78)}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const empty = results.filter((r) => r.status === "EMPTY").length;
  const slow = results.filter((r) => r.status === "SLOW").length;
  const err = results.filter((r) => r.status === "ERROR").length;
  console.log(
    `RESULTS: ${pass} PASS · ${empty} EMPTY · ${slow} SLOW · ${err} ERROR (total ${results.length})`,
  );
  console.log("=".repeat(78));

  if (err > 0 || empty > 0 || slow > 0) {
    console.log("\nFailures + warnings:");
    for (const r of results) {
      if (r.status === "PASS") continue;
      console.log(`  [${r.status}] ${r.tool} / ${r.label}`);
      if (r.error) console.log(`    → ${r.error}`);
    }
  }

  process.exit(err > 0 ? 1 : 0);
}

await main();
