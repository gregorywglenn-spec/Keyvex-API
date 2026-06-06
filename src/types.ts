/**
 * Shared types across the MCP server.
 *
 * Two layers of types:
 *   1. Data shapes — what's actually stored in Firestore (or the stub)
 *   2. Tool envelopes — what tool responses look like over the wire
 */

// ─── Tool response envelope ──────────────────────────────────────────────────

/**
 * Every list-returning tool wraps its results in this envelope so agents get
 * pagination signals and an echo of the query that was run.
 */
export interface ResultEnvelope<T> {
  results: T[];
  count: number;
  has_more: boolean;
  /**
   * Bug #6 fix (2026-05-22): when results is empty AND a date filter was
   * passed (since/until), this carries a friendly message explaining that
   * KeyVex's data depth varies by collection. Absent when not applicable
   * (results came back, or no date filter was set). The fix prevents the
   * "silent empty = no data" misinterpretation that bit the Wells Fargo
   * CFPB query during the bug-hunt — agents now see explicit guidance
   * instead of a quiet zero.
   */
  coverage_warning?: string;
  /**
   * Phase A v0.52.0 (2026-05-24): when the result set contains rows whose
   * `transaction_nature` is INSUFFICIENT_DATA, this counter surfaces how
   * many such rows are present. Crucial under "honest by default" semantics
   * — INSUFFICIENT_DATA rows are NEVER silently dropped by the directional
   * filter (silently dropping them would re-create the Tourniquet bug), so
   * they pass through even when `include_non_open_market: false` strictly
   * filters EQUITY_COMP and NON_OPEN_MARKET_TRANSFER out. The counter tells
   * the agent: "N rows in your result couldn't be classified by trans_code
   * — they're here for transparency, not because they're confirmed market
   * trades."
   *
   * Absent when zero (avoids unnecessary noise on clean result sets).
   * Present whenever > 0, regardless of filter state.
   */
  unclassifiable_records_retained?: number;
  query: Record<string, unknown>;
}

/**
 * Every single-result tool wraps its result like this. `result` is null when no
 * record matched.
 */
export interface SingleResultEnvelope<T> {
  result: T | null;
  query: Record<string, unknown>;
}

// ─── Insider transactions (Form 4) ──────────────────────────────────────────

/**
 * One open-market insider transaction line item from a Form 4 filing.
 *
 * Field set is what the MCP server returns to customers — a subset of the raw
 * Firestore document, which may also contain dashboard-only fields like
 * signal_weight that we deliberately do not expose.
 */
export interface InsiderTransaction {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  officer_name: string;
  officer_title: string;
  is_director: boolean | null;
  /**
   * Direction of the transaction. For codes P/S this is the open-market
   * direction. For codes A/M/X/C the insider acquired shares (→ "buy").
   * For codes S/F/G/D the insider disposed shares (→ "sell"). Derived from
   * acquired_disposed where present, otherwise from code semantics.
   */
  transaction_type: "buy" | "sell";
  /**
   * Raw SEC code for the underlying transaction. Common values:
   *   P open-market purchase | S open-market sale | A grant/award/RSU vest
   *   M exercise of derivative | X exercise in/at-the-money derivative
   *   C conversion of derivative | F payment of exercise price with shares
   *     (or tax-withholding) | G bona fide gift | D disposition to issuer
   */
  transaction_code: string;
  security_title: string | null;
  /**
   * True when the row came from the `derivativeTable` (option, RSU, warrant,
   * convertible). When true, the derivative-specific fields below are
   * populated and `shares` refers to the count of *derivative* units; check
   * `underlying_security_shares` for the count of underlying common shares.
   * False for `nonDerivativeTable` rows (direct common-stock transactions).
   */
  is_derivative: boolean;
  underlying_security_title: string | null;
  underlying_security_shares: number | null;
  conversion_or_exercise_price: number | null;
  transaction_date: string;
  disclosure_date: string;
  reporting_lag_days: number | null;
  shares: number;
  price_per_share: number;
  total_value: number;
  shares_owned_after: number | null;
  acquired_disposed: "A" | "D" | null;
  accession_number: string;
  sec_filing_url: string;
  /** "SEC_EDGAR_FORM4" — open-market + derivative transactions filed within
   *  2 business days. "SEC_EDGAR_FORM5" — the annual catch-up filing for
   *  transactions exempt from or missed on Form 4. Both share this schema
   *  and the same `insider_trades` collection. */
  data_source: "SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5";
  /** Phase A (2026-05-24): event-kind classification. Optional because of
   *  forward-write-only backfill — historical rows omit this; the MCP read
   *  shim derives it on-the-fly. New ingestion writes it directly. */
  transaction_nature?: TransactionNature;
  /** Phase A (2026-05-24): parse-integrity. INSUFFICIENT_DATA when any
   *  internal relational reference (footnote ID) failed to resolve at
   *  ingestion. Absent on historical rows (forward-write only). */
  verification_status?: VerificationStatus;
  /**
   * Phase 2b (read-time): SEC-source quirk flags applied by the
   * annotateRowsSourceMetadata shim at response time. Present ONLY when
   * at least one field on the row matches a detection rule (the 2050
   * perpetual-instrument sentinel; the anomalous-year filer-entry
   * pattern). Absence indicates "no SEC source quirks detected" — NOT
   * "certified clean by audit." See src/source-metadata.ts.
   */
  source_metadata?: import("./source-metadata.js").SourceMetadataFlags;
}

/**
 * Validated query parameters for get_insider_transactions.
 * Matches the inputSchema declared in tools/insider-transactions.ts.
 */
export interface InsiderTransactionsQuery {
  ticker?: string;
  company_cik?: string;
  officer_name?: string;
  transaction_type?: "buy" | "sell";
  min_value?: number;
  since?: string;
  until?: string;
  /**
   * Filter to derivative rows (options, RSUs, warrants) or non-derivative rows
   * (direct common-stock transactions). Omit to see both. Pair with
   * transaction_codes=["M","X"] for "option exercises only," or with
   * transaction_codes=["A"] for "RSU grants only."
   */
  is_derivative?: boolean;
  /**
   * OR-filter on raw SEC transaction codes. Common picks:
   *   ["P"]      open-market buys only
   *   ["S","F"]  open-market sells + tax-withholding (the executive "net cash" view)
   *   ["M","X"]  option exercises
   *   ["A"]      grants / RSU vests
   *   ["G"]      gifts
   * Max 30 codes per query (Firestore array-contains-any cap).
   */
  transaction_codes?: string[];
  sort_by?: "disclosure_date" | "transaction_date" | "total_value";
  sort_order?: "desc" | "asc";
  limit?: number;
  /**
   * When true, the response includes matching Form 3 baseline records under
   * a `baselines` field. Lets agents stitch initial-ownership context onto
   * Form 4 deltas without a second tool call. Requires ticker or company_cik
   * to be set (otherwise the baseline lookup would be unbounded).
   */
  include_baseline?: boolean;
  /**
   * Phase A (2026-05-24): controls whether NON_OPEN_MARKET_TRANSFER rows
   * (gifts, tax withholding, dispositions to issuer) appear in the result.
   *
   * Honest-by-default semantic:
   *   - When `transaction_type: "buy"|"sell"` is set:
   *       default = false → EXCLUDE transfers (a gift isn't a trade).
   *       Pass `true` to opt back in (include transfers in your direction filter).
   *   - When `transaction_type` is NOT set:
   *       default = true → return all rows, honestly tagged via transaction_nature.
   *       Pass `false` to opt OUT (clean view excluding transfers).
   *
   * The legacy `transaction_type` string ("buy"/"sell") on each returned
   * record is NEVER mutated by this filter — only whether the row appears
   * at all in the result set.
   */
  include_non_open_market?: boolean;
}

/**
 * Extended response envelope for get_insider_transactions when
 * include_baseline=true. Standard ResultEnvelope shape plus an optional
 * baselines array of Form 3 rows matching the active ticker/officer filters.
 *
 * Form 3 baselines snapshot the insider's *starting* position (filed when
 * they first became an insider). Agents pair them with Form 4 deltas to
 * reconstruct full ownership history without a second tool call.
 */
export interface InsiderTransactionsEnvelope
  extends ResultEnvelope<InsiderTransaction> {
  baselines?: Form3Holding[];
}

/**
 * Query parameters for the v2-aware data_source="bulk_v2" branch of
 * get_insider_transactions. Smaller filter surface than the legacy
 * InsiderTransactionsQuery — the v2 schema uses `transaction_type`
 * for the nonderiv/deriv discriminator (different meaning from legacy's
 * buy/sell), so we expose it as `row_type` to avoid name collision in
 * the tool's input shape.
 *
 * Field semantics map to InsiderTransactionV2:
 *   row_type ↔ transaction_type ("nonderiv" | "deriv")
 *   trans_codes ↔ trans_code OR-filter (P, S, A, M, X, C, F, G, D, I, V, ...)
 *   reporting_owner_cik ↔ reporting_owner_cik (CIK; pad to 10 digits)
 *   aff10b5one ↔ aff10b5one ("1" | "0" | "" | "NOT_TRACKED")
 *   schema_era ↔ schema_era ("pre_2023" | "2023_plus")
 *   since/until ↔ applied to sort_by field (default transaction_date)
 */
export interface InsiderTransactionsV2Query {
  ticker?: string;
  company_cik?: string;
  reporting_owner_cik?: string;
  reporting_owner_name?: string; // substring filter (client-side)
  row_type?: "nonderiv" | "deriv";
  trans_codes?: string[];
  aff10b5one?: "1" | "0" | "" | "NOT_TRACKED";
  schema_era?: SchemaEra;
  /**
   * Legacy buy/sell direction filter. v2 doesn't STORE buy/sell — it's
   * derived from `trans_code` + `trans_acquired_disp_cd` at response time
   * via deriveLegacyBuyOrSell (form4.ts:174 port). Implemented as a
   * post-fetch filter with proper pagination in queryInsiderTransactionsV2
   * so has_more reflects post-filter matches.
   */
  transaction_type?: "buy" | "sell";
  /**
   * Phase A (2026-05-24): controls whether NON_OPEN_MARKET_TRANSFER rows
   * (gifts, tax withholding, dispositions to issuer) appear in the result.
   * Context-driven default — see InsiderTransactionsQuery for the same
   * field's semantics, identical here.
   */
  include_non_open_market?: boolean;
  since?: string;
  until?: string;
  sort_by?: "transaction_date" | "filing_date";
  sort_order?: "desc" | "asc";
  limit?: number;
}

export interface InsiderTransactionsV2Envelope
  extends ResultEnvelope<InsiderTransactionV2> {}

// ─── Planned insider sales (Form 144) ──────────────────────────────────────

/**
 * One Form 144 filing — a notice of proposed sale filed under Rule 144 of the
 * Securities Act. Insiders (officers, directors, 10%+ holders) must file
 * Form 144 BEFORE selling restricted or control stock blocks of ≥5,000 shares
 * OR ≥$50,000 aggregate value. The actual sale later lands as a Form 4.
 *
 * Form 144 is *forward-looking* — it tells you what's about to happen, not
 * what already did. The aggregate_market_value is the insider's estimate at
 * filing time; the actual sale price/value can differ. The approximate_sale_date
 * is also an estimate — the real Form 4 transaction_date may be days later.
 *
 * Field set deliberately mirrors what raw EDGAR exposes — no derived signals,
 * no convergence scores. Pure-publisher posture per TOOL_DESIGN.md.
 *
 * Almost no aggregator exposes Form 144 cleanly — Bloomberg buries it, Capitol
 * Trades doesn't carry it, Quiver doesn't either. This is a real differentiator
 * for the hub.
 */
export interface Form144Filing {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  filer_name: string;
  filer_relationship: string;
  security_title: string | null;
  shares_to_be_sold: number;
  aggregate_market_value: number;
  approximate_sale_date: string;
  shares_outstanding: number | null;
  pct_of_outstanding: number | null;
  broker_name: string | null;
  exchange: string | null;
  acquisition_date: string | null;
  nature_of_acquisition: string | null;
  /**
   * Date a 10b5-1 trading plan was adopted, if this sale falls under one.
   * Non-null means the sale is pre-arranged (not discretionary). Significant
   * agent signal — distinguishes "this was scheduled months ago" from "this
   * is a tactical decision to sell now."
   */
  plan_adoption_date: string | null;
  is_10b5_1_plan: boolean;
  notice_date: string | null;
  filing_date: string;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_FORM144";
}

/**
 * Validated query parameters for get_planned_insider_sales.
 * Matches the inputSchema declared in tools/planned-insider-sales.ts.
 */
export interface Form144FilingsQuery {
  ticker?: string;
  company_cik?: string;
  filer_name?: string;
  min_value?: number;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "approximate_sale_date" | "aggregate_market_value";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── 8-K material events ───────────────────────────────────────────────────

/**
 * One Form 8-K filing — the SEC's "current report" form, filed within 4
 * business days of any *material* event at a publicly-traded company. The
 * closest thing the public gets to a real-time corporate-disclosure stream.
 *
 * Each 8-K is structured as a checklist. The company ticks one or more
 * "item code" boxes to declare WHAT the filing is about. We index by these
 * item codes — the prose body is left out of v1 entirely. Agents who need
 * the prose follow `primary_document_url` to fetch the document directly.
 *
 * Common item codes:
 *   - 1.01  Entry into a Material Definitive Agreement (M&A LOI, big deal)
 *   - 2.01  Completion of Acquisition or Disposition of Assets
 *   - 2.02  Results of Operations and Financial Condition (earnings)
 *   - 5.02  Departure / Election / Appointment of Officers + Directors
 *   - 7.01  Regulation FD Disclosure
 *   - 8.01  Other Events (catch-all)
 *   - 9.01  Financial Statements and Exhibits — NOTE: this is a "paperwork"
 *           box ticked by ~95% of 8-Ks. Faithfully kept in `item_codes` per
 *           pure-publisher posture, but agents searching JUST for 9.01 will
 *           get the firehose. Combine with another item code to focus.
 *
 * Amendments (8-K/A) get their own MaterialEvent row with `is_amendment: true`
 * — the original 8-K's row stays in place. v1 does NOT populate
 * `original_accession_number` (no reliable structured pointer in EDGAR's
 * metadata); agents can find candidates by matching ticker + period_of_report.
 */
export interface MaterialEvent {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  accession_number: string;
  /** ISO YYYY-MM-DD when filed with the SEC. */
  filing_date: string;
  /**
   * ISO YYYY-MM-DD of the underlying event being reported. Often differs from
   * filing_date by 1-4 business days (the SEC mandate). Empty string when the
   * filing doesn't declare one (rare).
   */
  period_of_report: string;
  /**
   * Array of item-code strings declared in this filing — e.g., ["5.02", "9.01"].
   * One filing can declare many items in one shot. OR-style filters
   * (`array-contains-any`) are the natural query pattern.
   */
  item_codes: string[];
  /** True for 8-K/A (amendment) filings. Original 8-K stays as its own row. */
  is_amendment: boolean;
  /**
   * v1 always null. v1.1 polish would parse the amendment's body to extract
   * the accession number it amends. Today, find candidates by matching
   * (ticker, period_of_report) across rows.
   */
  original_accession_number: string | null;
  /** Direct URL to the filing's primary HTML/text document (the prose body). */
  primary_document_url: string;
  /** URL to the filing's archive folder (index of all attachments). */
  sec_filing_url: string;
  data_source: "SEC_EDGAR_8K";
}

/**
 * Validated query parameters for the get_material_events MCP tool.
 */
export interface MaterialEventsQuery {
  ticker?: string;
  company_cik?: string;
  /**
   * Array of item codes — OR semantics. Match any filing whose item_codes
   * array contains AT LEAST ONE of these codes. Use to ask "show me anything
   * that's a 5.02 OR a 1.01" in one query. Maps to Firestore
   * `array-contains-any` (limited to 30 values per call by Firestore).
   */
  item_codes?: string[];
  is_amendment?: boolean;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "period_of_report";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Lobbying disclosures (LDA, Senate Office of Public Records) ─────────

/**
 * One "lobbying activity" inside a single LDA filing. A filing typically
 * lists 1-30 of these — each one represents a distinct issue area that
 * the registrant lobbied on for the client during the reporting quarter.
 *
 * `description` is free-text and can run very long (we've seen 30KB+
 * sovereign-citizen manifestos in real data). Truncated at 5000 chars
 * during ingestion to stay well under Firestore's 1MB doc-size cap;
 * agents can fetch the full filing via the parent's `filing_document_url`
 * if they need the prose past the truncation point.
 */
export interface LobbyingActivity {
  /** 3-char issue area code: "DEF", "HEA", "TRA", "ENV", "FIN", etc. */
  general_issue_code: string;
  general_issue_code_display: string;
  /** Free-text issue description. Truncated at 5000 chars during ingestion. */
  description: string;
  description_truncated: boolean;
  /** Free-text on foreign-entity involvement (rare). */
  foreign_entity_issues: string;
  /** Names of lobbyists who worked on this issue (e.g., "John Q Smith"). */
  lobbyist_names: string[];
  /** Government bodies contacted (e.g., "SENATE", "HOUSE OF REPRESENTATIVES", "Treasury, Dept of"). */
  government_entities: string[];
}

/**
 * One LDA filing — quarterly LD-2 report (registrants reporting lobbying
 * activity for clients), or related LD-1 registrations / amendments.
 *
 * Source: Senate Office of Public Records via the LDA REST API. Both
 * `lda.gov` and `lda.senate.gov` proxy the same backend; we point at
 * `lda.gov` since the senate.gov URL retires June 30, 2026.
 *
 * The `lobbying_activities` array is the political-money gold — issues
 * worked on, lobbyists involved, and government entities contacted. The
 * top-level `general_issue_codes`, `government_entities`, and
 * `lobbyist_names` fields are flattened summaries of the array so
 * Firestore can index them directly (`array-contains-any` queries).
 *
 * Pure-publisher posture per TOOL_DESIGN.md — no derived signals, just
 * normalized facts from LDA. Public record by statute (LDA § 1605).
 */
export interface LobbyingFiling {
  /** filing_uuid from LDA — globally unique, stable across edits. */
  id: string;
  filing_uuid: string;
  /** "Q1" | "Q2" | "Q3" | "Q4" | "MA" | "MA-A" | "RR" | "RA" | etc. */
  filing_type: string;
  filing_type_display: string;
  /** Calendar year of the reporting period (NOT the filing date). */
  filing_year: number;
  /** "first_quarter" | "second_quarter" | "third_quarter" | "fourth_quarter" | "mid_year" | "year_end". */
  filing_period: string;
  filing_period_display: string;
  /** Public link to the human-readable filing document (HTML or PDF). */
  filing_document_url: string;
  /** Reported income (USD) the registrant earned from this client this period. Null on registrations. */
  income: number | null;
  /** Reported expenses (USD) — alternative to income for in-house lobbyists. Null when income is reported. */
  expenses: number | null;
  /** When the filing was submitted to the SOPR (NOT the activity period). ISO 8601. */
  dt_posted: string;
  /** Termination date if the registrant ended the engagement. ISO date or empty. */
  termination_date: string;

  // Registrant — the lobbying firm filing the report.
  registrant_id: number;
  registrant_name: string;
  registrant_state: string;
  registrant_country: string;

  // Client — the entity paying the registrant.
  client_id: number;
  client_name: string;
  client_description: string;
  client_state: string;
  client_country: string;
  /** True when the client is a US state, federal agency, or other government body. */
  client_is_government: boolean;

  // Flattened summaries (top-level) for indexed Firestore queries.
  /** All unique general_issue_code values across this filing's activities. */
  general_issue_codes: string[];
  /** All unique government_entity names across this filing's activities. */
  government_entities: string[];
  /** All unique lobbyist names ("First Last") across this filing's activities. */
  lobbyist_names: string[];

  /** The full nested array — agents who want activity-level granularity. */
  lobbying_activities: LobbyingActivity[];

  data_source: "SENATE_LDA";
}

/**
 * Validated query parameters for the get_lobbying_filings MCP tool.
 */
export interface LobbyingFilingsQuery {
  registrant_name?: string;
  client_name?: string;
  filing_year?: number;
  filing_period?: string;
  /** OR semantics — match any filing whose codes include at least one of these. Max 30. */
  general_issue_codes?: string[];
  /** Substring match against the flattened `government_entities` array. */
  government_entity?: string;
  min_income?: number;
  since?: string;
  until?: string;
  sort_by?: "dt_posted" | "filing_year" | "income";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Legislators (unitedstates/congress-legislators catalog) ──────────────

/**
 * One row in the committee_assignments[] array on a Legislator. A
 * legislator can sit on a full committee (e.g., "HSAG") AND its
 * subcommittees (e.g., "HSAG15") simultaneously — each is its own row.
 *
 * party_role is the legislator's caucus on this committee — typically
 * tracks their party but the YAML uses "majority"/"minority" to capture
 * floor-control state. leadership_title is empty for rank-and-file.
 */
export interface CommitteeAssignment {
  committee_id: string; // e.g., "HSAG" (full) or "HSAG15" (subcommittee)
  committee_name: string;
  /** "house" | "senate" | "joint". Inherited from parent committee. */
  committee_type: string;
  /** True for subcommittee rows; in that case parent_committee_id is set. */
  is_subcommittee: boolean;
  parent_committee_id: string | null;
  /** "majority" | "minority". Filer's caucus on the committee. */
  party_role: string;
  /** Numeric rank within their caucus (1 = chair / ranking member). */
  rank: number | null;
  /** "Chairman" | "Ranking Member" | "Vice Chairman" | etc. Empty for rank-and-file. */
  leadership_title: string;
}

/**
 * One legislator (House Representative or Senator) record from the
 * unitedstates/congress-legislators catalog. Keyed by bioguide_id —
 * the permanent member identifier (e.g., "C001035" for Susan Collins).
 *
 * The join key for every congressional_trades record once bioguide_id
 * gets backfilled there. The committee_assignments field is the
 * load-bearing enrichment — without it, "Defense Committee member buys
 * defense stock" can't be expressed as a query.
 *
 * Source: github.com/unitedstates/congress-legislators (public domain).
 * Three YAMLs combined: legislators-current.yaml +
 * committees-current.yaml + committee-membership-current.yaml.
 *
 * Photos available at theunitedstates.io/images/congress/{size}/{bioguide_id}.jpg
 * (Cloudflare-protected per CLAUDE.md — we construct the URL but don't
 * fetch in v1; agents/clients fetch directly).
 */
export interface Legislator {
  bioguide_id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  middle_name: string;
  nickname: string;
  /** "house" | "senate". From the most-recent term in terms[]. */
  chamber: string;
  state: string;
  /** "1", "2", ..., "AL" (at-large). House only — empty string for Senate. */
  state_district: string;
  /** "Democrat" | "Republican" | "Independent" | etc. */
  party: string;
  /** Senate class 1/2/3 (cycle the seat is up). Null for House members. */
  senate_class: number | null;
  /** ISO date — start of the current term. */
  current_term_start: string;
  /** ISO date — end of the current term (when they're up for re-election). */
  current_term_end: string;
  /** Total number of terms served (1-indexed; their first term is 1). */
  terms_count: number;
  birthday: string; // ISO YYYY-MM-DD
  gender: string; // "M" | "F"
  /**
   * Constructed photo URL. theunitedstates.io serves these at multiple
   * sizes (225x275, 450x550, original). We default to original; clients
   * can swap the path segment.
   */
  photo_url: string;
  /** Direct link to the canonical bioguide.congress.gov entry for this
   *  member. Audit-grade provenance — agents can follow to verify the
   *  biographical record against the Library of Congress official source. */
  bioguide_url: string;
  /** All committees + subcommittees this legislator currently sits on. */
  committee_assignments: CommitteeAssignment[];
}

/**
 * One term served by a historical legislator. Members typically have 1-N
 * terms in chronological order. The matcher's Tier-4 historical fallback
 * uses (start, end) to filter candidates by service-window overlap with a
 * trade's filing date.
 */
export interface HistoricalTerm {
  /** "house" | "senate". Mapped from YAML's "rep" / "sen" type. */
  chamber: string;
  /** ISO YYYY-MM-DD when this term started. */
  start: string;
  /** ISO YYYY-MM-DD when this term ended. */
  end: string;
  state: string;
  /** House only — empty string for Senate. May be "AL" (at-large) or "-1" (early-Congress). */
  state_district: string;
  party: string;
  /** Senate class 1/2/3. Null for House terms. */
  senate_class: number | null;
}

/**
 * One historical legislator from `legislators-historical.yaml` — every
 * person who has ever served in Congress (1789→present, ~12,000 entries).
 * The corresponding `Legislator` interface only covers currently-serving
 * members.
 *
 * Stored in the `legislators_historical` Firestore collection, separate
 * from the `legislators` collection so the small current catalog (~540
 * records) stays fast for queries that don't care about former members.
 *
 * No committee_assignments — those only make sense for current members.
 * No photo_url — historical photos are inconsistently available; we can
 * synthesize the URL on demand if a tool ever needs it.
 *
 * The matcher's Tier-4 fallback in backfillBioguideIds() loads every
 * record and indexes by (chamber, state, last_name); when a trade comes
 * in for a former member (e.g., Markwayne Mullin trades from before he
 * resigned), the matcher filters historical candidates by date overlap
 * with the trade's filing_date.
 */
export interface LegislatorHistorical {
  bioguide_id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  middle_name: string;
  nickname: string;
  birthday: string;
  gender: string;
  /** Chronological list of every term served. */
  terms: HistoricalTerm[];
}

/**
 * Validated query parameters for the get_member_profile MCP tool.
 */
export interface LegislatorQuery {
  bioguide_id?: string;
  member_name?: string;
  state?: string;
  chamber?: "house" | "senate";
  party?: string;
  /** Match against any committee_assignments[].committee_id. */
  committee_id?: string;
  limit?: number;
}

// ─── Federal contract awards (USAspending.gov) ─────────────────────────────

/**
 * One federal contract award row from USAspending.gov. Each record represents
 * a single award (A/B/C/D type — BPA Call, Purchase Order, Delivery Order,
 * Definitive Contract). Modifications appear as separate awards in the API
 * — this is the prime award snapshot, not action-level granularity.
 *
 * The killer political-alpha query: join `congressional_trades` to this
 * collection by recipient_name (substring) and timing — "Senator buys LMT
 * on Mar 15, defense contract awarded to Lockheed Martin on Mar 17."
 *
 * Pure-publisher posture per TOOL_DESIGN.md — no derived signal columns,
 * just normalized facts from USAspending's API.
 *
 * Source: api.usaspending.gov /api/v2/search/spending_by_award/. Public,
 * no auth, returns JSON. First non-SEC scraper in the project.
 */
export interface FederalContractAward {
  /** USAspending generated_internal_id (CONT_AWD_xxx_yyy). Stable across modifications. */
  id: string;
  /** Human-readable contract number (e.g., "NNJ06TA25C"). */
  award_id: string;
  /** Recipient legal name as filed (e.g., "LOCKHEED MARTIN CORP"). */
  recipient_name: string;
  /** Recipient Unique Entity ID — replaced DUNS in 2022. 12-char alphanumeric. */
  recipient_uei: string;
  /** USAspending's UUID-style internal recipient ID (used for deep-linking). */
  recipient_id: string;
  /**
   * Total contract value currently obligated (USD). Includes all
   * modifications-to-date. Often much larger than `total_outlays`.
   */
  award_amount: number;
  /** Actual disbursements to date (USD). What's been paid out so far. */
  total_outlays: number;
  /**
   * Free-text description of the work. Often ALL CAPS in source data.
   * Sometimes includes Treasury Account Symbol ("TAS::80 0124::") prefix
   * — kept as-is for fidelity; agents can strip if needed.
   */
  description: string;
  /** "DEFINITIVE CONTRACT", "PURCHASE ORDER", "BPA CALL", "DELIVERY ORDER". */
  contract_award_type: string;
  /** "Department of Defense", "National Aeronautics and Space Administration", etc. */
  awarding_agency: string;
  /** Sub-agency within the awarding agency (e.g., "Department of the Air Force"). */
  awarding_subagency: string;
  /** North American Industry Classification System code (6 digits). */
  naics_code: string;
  naics_description: string;
  /** Product or Service Code (4 chars). Defense-style codes: AR33, R425, etc. */
  psc_code: string;
  psc_description: string;
  /**
   * Disaster Emergency Fund codes from supplemental appropriations.
   * "L" / "M" / "N" / "O" / "P" / "Q" tagging COVID-19 Recovery Act funds, etc.
   */
  def_codes: string[];
  /** Period of performance start, ISO YYYY-MM-DD. */
  start_date: string;
  /** Period of performance current end, ISO YYYY-MM-DD. */
  end_date: string;
  /**
   * Last action date — when this award was last modified or signed.
   * The most useful "happened recently" signal. ISO YYYY-MM-DDTHH:MM:SS.
   */
  last_modified_date: string;
  /** 2-letter US state where the work is performed. */
  place_of_performance_state: string;
  /** Direct link to USAspending's award page. */
  award_url: string;
  data_source: "USASPENDING";
}

/**
 * Validated query parameters for the (eventual) get_federal_contracts MCP tool.
 */
export interface FederalContractAwardsQuery {
  recipient_name?: string;
  recipient_uei?: string;
  awarding_agency?: string;
  naics_code?: string;
  psc_code?: string;
  min_amount?: number;
  since?: string;
  until?: string;
  sort_by?: "last_modified_date" | "start_date" | "award_amount" | "total_outlays";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Federal Grants (USAspending assistance awards) ────────────────────────

/**
 * One federal GRANT or cooperative agreement award. Sibling collection to
 * federal_contracts but a completely different recipient universe —
 * universities, non-profits, state & local agencies, healthcare research
 * institutions, public-private partnerships.
 *
 * Award type codes covered (USAspending):
 *   02 = Block Grant
 *   03 = Formula Grant
 *   04 = Project Grant (most common)
 *   05 = Cooperative Agreement
 *
 * Grant-specific fields vs. contracts: cfda_number (Catalog of Federal
 * Domestic Assistance program ID), no NAICS / PSC (those are contract-only).
 */
export interface FederalGrant {
  /** USAspending generated_internal_id. Stable across modifications. */
  id: string;
  /** Award ID (typically a grant number assigned by the awarding agency). */
  award_id: string;
  recipient_name: string;
  recipient_uei: string;
  recipient_id: string;
  /** Total obligated amount. */
  award_amount: number;
  /** Cumulative outlays disbursed against the grant. */
  total_outlays: number;
  description: string;
  /** Award Type (e.g., "PROJECT GRANT (B)", "COOPERATIVE AGREEMENT"). */
  award_type: string;
  awarding_agency: string;
  awarding_subagency: string;
  /** CFDA program number (e.g., "89.003" = NHPRC discretionary grants). */
  cfda_number: string;
  /** COVID/IIJA "Disaster Emergency Fund" codes. */
  def_codes: string[];
  start_date: string;
  end_date: string;
  last_modified_date: string;
  place_of_performance_state: string;
  award_url: string;
  source_url: string;
  data_source: "USASPENDING";
}

export interface FederalGrantsQuery {
  recipient_name?: string;
  recipient_uei?: string;
  awarding_agency?: string;
  cfda_number?: string;
  min_amount?: number;
  since?: string;
  until?: string;
  sort_by?: "last_modified_date" | "start_date" | "award_amount" | "total_outlays";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── CFTC Commitments of Traders (COT) ─────────────────────────────────────

/**
 * One row from the CFTC weekly Commitments of Traders report. Each row is
 * one contract market on one Tuesday close. Captures aggregated positioning
 * by trader class for every regulated U.S. futures + options-on-futures
 * contract — agricultural commodities, metals, energy, financials, FX,
 * crypto.
 *
 * Trader classes (legacy futures-only report):
 *   - Non-commercial: large speculators (hedge funds, CTAs, money managers)
 *   - Commercial: hedgers (producers, merchants, swap dealers)
 *   - Non-reportable: small speculators below the reporting threshold
 *
 * Killer-use case: identify positioning extremes that historically lead
 * major turning points. E.g., "commercials net-short S&P at a multi-year
 * extreme" precedes index corrections.
 *
 * Released every Friday 3:30 PM ET, for the prior Tuesday close.
 */
export interface CftcCotReport {
  /** Composite doc ID: {contract_market_code}-{report_date YYYY-MM-DD}. */
  id: string;
  /** CFTC's stable code for the contract market (e.g., "13874A" = E-mini S&P 500). */
  cftc_contract_market_code: string;
  /** Human-readable contract name ("E-MINI S&P 500"). */
  contract_market_name: string;
  /** Full market + exchange string ("E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE"). */
  market_and_exchange_names: string;
  /** Commodity name (e.g., "S&P 500 STOCK INDEX", "GOLD", "CRUDE OIL"). */
  commodity_name: string;
  /** Commodity code (3 digits). */
  commodity_code: string;
  /** Exchange code (e.g., "CME ", "ICE ", "NYM "). */
  market_code: string;
  region_code: string;
  /** ISO date of the report (Tuesday close — published Friday). */
  report_date: string;
  /** "YYYY Report Week WW" string from CFTC. */
  report_week: string;
  open_interest: number;
  /** Non-commercial (large speculators) — long/short/net/spread. */
  noncomm_long: number;
  noncomm_short: number;
  noncomm_net: number;
  noncomm_spread: number;
  /** Commercial (hedgers) — long/short/net. */
  comm_long: number;
  comm_short: number;
  comm_net: number;
  /** Non-reportable (small speculators) — long/short/net. */
  nonrept_long: number;
  nonrept_short: number;
  nonrept_net: number;
  /** Week-over-week changes. */
  change_open_interest: number;
  change_noncomm_long: number;
  change_noncomm_short: number;
  change_comm_long: number;
  change_comm_short: number;
  change_nonrept_long: number;
  change_nonrept_short: number;
  /** Percent of open interest by trader class. */
  pct_noncomm_long: number;
  pct_noncomm_short: number;
  pct_comm_long: number;
  pct_comm_short: number;
  pct_nonrept_long: number;
  pct_nonrept_short: number;
  /** Total trader counts. */
  traders_total: number;
  traders_noncomm_long: number;
  traders_noncomm_short: number;
  traders_comm_long: number;
  traders_comm_short: number;
  /** Concentration: net positions held by top 4 / top 8 traders. */
  conc_net_le_4_long: number;
  conc_net_le_4_short: number;
  conc_net_le_8_long: number;
  conc_net_le_8_short: number;
  source_url: string;
  scraped_at: string;
}

export interface CftcCotReportQuery {
  /** Direct doc lookup. */
  id?: string;
  /** Exact contract_market_code. */
  cftc_contract_market_code?: string;
  /** Substring on contract_market_name (client-side). */
  contract_market_name?: string;
  /** Exact commodity_name. */
  commodity_name?: string;
  /** Inclusive lower bound on report_date (YYYY-MM-DD). */
  since?: string;
  /** Inclusive upper bound. */
  until?: string;
  /** When true, returns only the most recent week per contract. */
  latest_only?: boolean;
  sort_by?: "report_date" | "open_interest" | "noncomm_net" | "comm_net";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── SEC Fails-to-Deliver (FTD) ────────────────────────────────────────────

/**
 * One Fails-to-Deliver row from SEC's bi-monthly cnsfails<YYYYMM><a|b>.zip
 * dataset. Each row = one ticker / one settlement date where a clearing
 * member's short sale FAILED to deliver shares.
 *
 * Signal: persistent FTDs are a contrarian short-squeeze leading indicator
 * — naked short pressure exceeds locate supply, or settlement / locate
 * mechanism is breaking down on the ticker. The Reg SHO threshold list
 * (FTDs > 0.5% of issued shares for 5+ days) is a derived view; this is
 * the underlying daily data.
 *
 * Released bi-monthly, ~1 week behind the settlement period.
 */
export interface SecFailToDeliver {
  /** Composite doc ID: {YYYY-MM-DD}-{cusip}. */
  id: string;
  /** ISO settlement date the failure occurred. */
  settlement_date: string;
  /** CUSIP of the security. */
  cusip: string;
  /** Ticker symbol (uppercase). */
  ticker: string;
  /** Issuer / security description from the SEC file. */
  description: string;
  /** Number of shares failed to deliver. */
  quantity_fails: number;
  /** Reference price on the settlement date. */
  price: number;
  /** Derived: quantity_fails * price = dollar value of the failure. */
  fail_value: number;
  /** YYYY-MM string for time-bucket queries. */
  year_month: string;
  source_url: string;
  scraped_at: string;
}

export interface SecFailsToDeliverQuery {
  id?: string;
  ticker?: string;
  cusip?: string;
  /** Inclusive lower bound on settlement_date (YYYY-MM-DD). */
  since?: string;
  /** Inclusive upper bound. */
  until?: string;
  /** Inclusive lower bound on quantity_fails. */
  min_quantity?: number;
  /** Inclusive lower bound on fail_value (dollars). */
  min_value?: number;
  sort_by?: "settlement_date" | "quantity_fails" | "fail_value";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── Activist / 5%+ ownership disclosures (Schedule 13D / 13G) ─────────────

/**
 * One row from a Schedule 13D or 13G filing — beneficial-ownership disclosure
 * by anyone holding ≥5% of a registered class of equity securities. Reveals
 * activist campaigns, takeover targets, hostile bids, large institutional
 * accumulations.
 *
 * Two flavors with the same conceptual data but **structurally different
 * XML schemas** (captured as a Hard Lesson):
 *
 *   - **13D**: filer signals intent to influence control. Activist filing.
 *     namespace=schedule13D, fields under `reportingPersons.reportingPersonInfo.*`,
 *     `aggregateAmountOwned`, `percentOfClass`, `dateOfEvent`.
 *
 *   - **13G**: filer is passive (institutional, no intent to influence).
 *     namespace=schedule13g, fields under `coverPageHeaderReportingPersonDetails.*`,
 *     `reportingPersonBeneficiallyOwnedAggregateNumberOfShares`,
 *     `classPercent`, `eventDateRequiresFilingThisStatement`.
 *
 * Both populate this single output type; the parser branches on submissionType.
 *
 * `is_activist` is the structural signal — true for any SCHEDULE 13D variant,
 * false for any 13G. The full "Item 4: Purpose of Transaction" narrative is
 * NOT in the structured XML — it's on the HTML side. v1.1 polish to extract.
 *
 * One filing can have multiple reporting persons (joint filers). Each emits
 * its own ActivistOwnership row.
 */
export interface ActivistOwnership {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  cusip: string;
  filer_name: string;
  /**
   * Filer CIK (zero-padded). Empty string when filer doesn't have a CIK
   * (rare — `<reportingPersonNoCIK>` flag in 13D schema; some individuals).
   */
  filer_cik: string;
  /**
   * Type-of-reporting-person code from the form: "IN" individual, "CO"
   * corporation, "OO" other, "PN" partnership, "BD" broker-dealer,
   * "IA" investment adviser, "EP" employee benefit plan, etc.
   */
  filer_type: string;
  /**
   * Free-text country/state of citizenship (for individuals) or place of
   * organization (for entities). Examples: "USA", "Delaware", "Cayman Islands".
   */
  citizenship_or_organization: string;
  filing_type: "SCHEDULE 13D" | "SCHEDULE 13D/A" | "SCHEDULE 13G" | "SCHEDULE 13G/A";
  /** True for any 13D variant, false for any 13G. Structural activist signal. */
  is_activist: boolean;
  /** Aggregate beneficial ownership (shares). */
  shares_owned: number;
  /** Percent of class beneficially owned. From form's percentOfClass / classPercent field. */
  percent_of_class: number;
  sole_voting_power: number;
  shared_voting_power: number;
  sole_dispositive_power: number;
  shared_dispositive_power: number;
  /** ISO date of the event triggering the filing (acquisition crossing 5%, material change, etc.). */
  event_date: string;
  filing_date: string;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_13D" | "SEC_EDGAR_13G";
}

/**
 * Validated query parameters for the (eventual) get_activist_stakes MCP tool.
 */
export interface ActivistOwnershipQuery {
  ticker?: string;
  company_cik?: string;
  cusip?: string;
  filer_name?: string;
  filer_cik?: string;
  is_activist?: boolean;
  filing_type?: "SCHEDULE 13D" | "SCHEDULE 13D/A" | "SCHEDULE 13G" | "SCHEDULE 13G/A";
  min_percent_of_class?: number;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "event_date" | "percent_of_class" | "shares_owned";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Initial ownership baselines (Form 3) ──────────────────────────────────

/**
 * One row from a Form 3 filing — the *initial* statement of beneficial
 * ownership filed when someone first becomes an insider (officer, director,
 * 10%+ holder, or other qualifying person). One filing produces one record
 * per security class held: typically common stock plus any derivatives
 * (options, RSUs, warrants).
 *
 * Form 3 is the *baseline* that gives Form 4 deltas meaning. Without it,
 * "Tim Cook sold 50,000 shares" floats with no anchor — you don't know if
 * that's 1% or 50% of his position. With Form 3, the agent can stitch
 * together: "filed Form 3 in 2011 with 1.0M shares, then years of Form 4
 * grants/sales net to current holdings of 3.3M."
 *
 * Unlike Form 4 (transactions only), Form 3 records have no transaction
 * shares/price/date — only `shares_owned` (the snapshot).
 *
 * Field set deliberately mirrors what raw EDGAR exposes — pure-publisher
 * posture per TOOL_DESIGN.md. No derived intelligence.
 */
export interface Form3Holding {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  /** Insider's full name (multiple owners joined with " / " — same as Form 4). */
  filer_name: string;
  /** Insider's CIK. Persistent across Form 3 / Form 4 filings — useful join key. */
  filer_cik: string;
  /** Officer title at issuer (empty when filer is purely a director or 10%+ holder). */
  officer_title: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  /** True when reportingOwnerRelationship.isOther is set; describes the relationship in `other_text`. */
  is_other: boolean;
  other_text: string;
  filing_date: string;
  /** "Common Stock", "Restricted Stock Unit", "Stock Option", etc. */
  security_title: string;
  /**
   * True for derivative securities (options, warrants, convertibles).
   * False for non-derivative (common stock, RSUs in some forms, preferred).
   */
  is_derivative: boolean;
  /**
   * Total shares owned of this security at the time of filing — the BASELINE.
   * For derivative rows this is the count of underlying contracts/units, not
   * the underlying share equivalent (which is in `underlying_security_shares`).
   */
  shares_owned: number;
  /** "D" (direct, in own name) or "I" (indirect, e.g., via trust/spouse). */
  direct_or_indirect: "D" | "I" | null;
  /** Free-text describing the indirect ownership ("By Trust", "By Spouse", etc.). Empty for direct. */
  nature_of_indirect_ownership: string;
  /** Strike price for an option, conversion price for a convertible. Null for non-derivative. */
  conversion_or_exercise_price: number | null;
  /** ISO date the derivative becomes exercisable. Null for non-derivative or immediate. */
  exercise_date: string | null;
  /** ISO date the derivative expires. Null for non-derivative. */
  expiration_date: string | null;
  /** For derivatives: title of the security the derivative converts into (usually "Common Stock"). */
  underlying_security_title: string | null;
  /** For derivatives: number of underlying shares the derivative represents. */
  underlying_security_shares: number | null;
  accession_number: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_FORM3";
}

/**
 * Validated query parameters for the (eventual) Form 3 baseline query path.
 * No dedicated MCP tool yet — Form 3 data may be exposed by extending
 * get_insider_transactions with an `include_baseline` flag, or rolled into
 * get_company_filings_summary when that aggregator tool ships.
 */
export interface Form3HoldingsQuery {
  ticker?: string;
  company_cik?: string;
  filer_name?: string;
  filer_cik?: string;
  is_derivative?: boolean;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "shares_owned";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Institutional holdings (13F) ───────────────────────────────────────────

/**
 * One position held by an institutional investment manager, sourced from a
 * Form 13F-HR filing. Each record represents (fund, security, quarter).
 *
 * `position_change`, `shares_change`, and `shares_change_pct` are computed
 * during ingestion by comparing this quarter's holding to the same fund's
 * prior-quarter holding for the same CUSIP. On first ingestion (no prior
 * data in Firestore), all positions show position_change="new".
 *
 * `ticker` is enriched via OpenFIGI CUSIP→ticker lookup. Empty string when
 * no mapping is available (private securities, foreign issuers without a
 * US ticker, etc).
 */
export interface InstitutionalHolding {
  id: string;
  fund_name: string;
  fund_cik: string;
  issuer_name: string;
  cusip: string;
  ticker: string;
  share_type: string;
  investment_discretion: string | null;
  shares_held: number;
  market_value: number;
  market_value_thousands: number;
  quarter: string;
  filing_date: string;
  position_change:
    | "new"
    | "increased"
    | "decreased"
    | "closed"
    | "unchanged"
    | "INSUFFICIENT_DATA"     // Phase A: prior-quarter lookup empty OR current
                              //   filing failed its infoTableEntryTotal check
    | null;
  shares_change: number | null;
  shares_change_pct: number | null;
  accession_number: string;
  filing_url: string;
  data_source: "SEC_EDGAR_13F";
  /** Phase A (2026-05-24, fixed 2026-05-25): parse-integrity per filing.
   *  VERIFIED iff the RAW <infoTable> element count (every row the filer
   *  wrote — including options and sub-account dupes, BEFORE any filtering
   *  or aggregation) equals primary_doc.xml's <tableEntryTotal>.
   *  INSUFFICIENT_DATA otherwise (incl. case where the canonical count
   *  cannot be extracted — per The Tourniquet, "no count" defaults to
   *  INSUFFICIENT_DATA, never to VERIFIED). The original implementation
   *  compared the aggregated-by-CUSIP storage shape against the raw
   *  declared count; that was apples-to-oranges and false-positive'd
   *  every aggregating filer (BlackRock combination reports, Berkshire,
   *  Vanguard, the multi-manager pods) until corrected. Optional because
   *  of forward-write-only backfill; historical rows omit this and
   *  downstream consumers treat missing as "unknown". */
  verification_status?: VerificationStatus;
  /** Phase A: row-count gate — what the verification check expected
   *  (SEC's declared <tableEntryTotal> from primary_doc.xml). */
  verification_expected?: number;
  /** Phase A: row-count gate — what the verification check actually saw
   *  (RAW <infoTable> element count, BEFORE option filtering or CUSIP
   *  aggregation). */
  verification_actual?: number;
  /** Phase A: value-sum gate (added 2026-05-25) — what the verification
   *  check expected (SEC's declared <tableValueTotal> from primary_doc.xml).
   *  The dollar aggregate at the filing's raw-row scope (includes options
   *  + sub-account dupes). AND'd with the row-count gate. */
  verification_value_expected?: number;
  /** Phase A: value-sum gate — what the verification check actually saw
   *  (Σ raw <value> across every <infoTable> element, no filter, no
   *  aggregation). A voting-authority-split filing (same shares replicated
   *  across SOLE/SHARED/NONE rows) would inflate this sum above the
   *  declared aggregate even when the row count matches — that's what this
   *  independent gate catches. */
  verification_value_actual?: number;
}

/**
 * Validated query parameters for get_institutional_holdings.
 * Matches the inputSchema declared in tools/institutional-holdings.ts (TBD).
 */
export interface InstitutionalHoldingsQuery {
  ticker?: string;
  cusip?: string;
  fund_name?: string;
  fund_cik?: string;
  quarter?: string;
  position_change?:
    | "new"
    | "increased"
    | "decreased"
    | "closed"
    | "unchanged";
  min_value?: number;
  sort_by?: "market_value" | "shares_held" | "shares_change_pct";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Congressional trades (STOCK Act PTRs) ──────────────────────────────────

/**
 * One disclosed congressional trade — a single line item from a Periodic
 * Transaction Report filed under the STOCK Act. Each record is one
 * (member, asset, transaction date) tuple.
 *
 * Senate PTRs come from the Senate eFD portal as HTML tables. House PTRs
 * come from the House Clerk as PDFs (parser TBD). Both normalize to this
 * shape so the MCP tool surface is uniform.
 *
 * STOCK Act mandates filing within 30 days of trade awareness or 45 days
 * of the transaction itself, whichever is earlier. `reporting_lag_days`
 * is computed against business days for clarity.
 *
 * `bioguide_id` is the permanent member identifier (e.g., "C001035" for
 * Susan Collins). Populated from the unitedstates/congress-legislators
 * catalog when that ingestion lands; empty for now.
 */
export interface CongressionalTrade {
  id: string;
  ticker: string;
  asset_name: string;
  asset_type: string;
  member_name: string;
  member_first: string;
  member_last: string;
  bioguide_id: string;
  chamber: "senate" | "house";
  party: string;
  state: string;
  state_district: string;
  office: string;
  transaction_type: "buy" | "sell";
  transaction_date: string;
  disclosure_date: string;
  reporting_lag_days: number | null;
  amount_range: string;
  amount_min: number;
  amount_max: number;
  owner: string;
  comment: string;
  ptr_id: string;
  report_url: string;
  data_source: "SENATE_EFD_PTR" | "HOUSE_CLERK_PTR";
  /** Phase A (2026-05-24): event-kind classification derived from the
   *  `comment` field via deriveCongressionalNature(). NEVER overwrites
   *  `transaction_type` ("buy"|"sell") which stays as-stored for back-compat.
   *  When comment contains contribution/gift/donation/charitable language →
   *  NON_OPEN_MARKET_TRANSFER. When transaction_type is "buy"/"sell" and no
   *  transfer language detected → OPEN_MARKET. When transaction_type is
   *  empty/unrecognized AND no transfer signal in comment → INSUFFICIENT_DATA.
   *  Optional because of forward-write-only backfill; the MCP read shim
   *  derives on-the-fly for historical rows. */
  transaction_nature?: TransactionNature;
}

/**
 * Validated query parameters for get_congressional_trades.
 * Matches the inputSchema declared in tools/congressional-trades.ts (TBD).
 */
export interface CongressionalTradesQuery {
  ticker?: string;
  member_name?: string;
  bioguide_id?: string;
  chamber?: "senate" | "house";
  transaction_type?: "buy" | "sell";
  owner?: "Self" | "Spouse" | "Joint" | "Dependent";
  since?: string;
  until?: string;
  min_amount?: number;
  sort_by?: "disclosure_date" | "transaction_date";
  sort_order?: "desc" | "asc";
  limit?: number;
  /**
   * Phase A (2026-05-24): controls whether NON_OPEN_MARKET_TRANSFER rows
   * (charitable contributions, gifts, donations detected in the comment
   * field) appear in the result. Honest-by-default semantic identical to
   * InsiderTransactionsQuery.include_non_open_market — see that field for
   * the full rule. Critical for the Pelosi-Trinity-contribution case:
   * a `transaction_type: "sell"` query for Pelosi must NOT return the
   * Trinity charitable contribution by default.
   */
  include_non_open_market?: boolean;
}

// ─── OGE Form 278-T (Executive-Branch Periodic Transaction Report) ───────────

/**
 * One disclosed securities transaction from an OGE Form 278-T — the
 * executive-branch sibling of the congressional STOCK Act PTR. Filed by
 * Cabinet secretaries and Senate-confirmed appointees for transactions over
 * $1,000, within 30-45 days. Federal public record (Ethics in Government Act;
 * 5 C.F.R. Part 2634) — "Note: This is a public form" on every filing.
 *
 * v1 covers Cabinet/appointee filings discovered via the OGE PAS Index (clean
 * born-digital PDFs via Integrity.gov). President/VP filings (separate
 * collection, corrupted text layer requiring OCR) are deferred to v1.1.
 *
 * Source-faithful: asset names and amount ranges verbatim; amount_max is
 * undefined for open-ended "Over $X" ranges (never collapsed). `owner` defaults
 * to "self" — the 278-T transaction table carries no per-row owner column, so
 * spouse/dependent is only set when the filing text explicitly says so.
 */
export interface ExecutiveTrade {
  /** Deterministic: "oge-278t-{filer_slug}-{filing_date}-{idx}". */
  filing_id: string;
  filer_name: string;
  /** Best-effort from the PDF header; may be "". */
  filer_position: string;
  filer_type: "cabinet" | "appointee" | "other";
  transaction_date: string; // ISO (YYYY-MM-DD)
  asset_name: string; // verbatim
  ticker?: string; // extracted from trailing parens if present
  transaction_type: "purchase" | "sale" | "exchange";
  amount_range: string; // verbatim, e.g. "$1,000,001 - $5,000,000"
  amount_min: number;
  amount_max?: number; // undefined for open-ended "Over $X"
  owner: "self" | "spouse" | "dependent";
  /** The "Notification received over 30 days ago" column (Yes/No). */
  notified: boolean;
  filing_date: string; // ISO — date the filing was made (disclosure date)
  report_url: string; // source PDF — provenance on every record
  source: "OGE_278T";
  scraped_at: string; // ISO timestamp
}

/** Validated query params for get_executive_trades. */
export interface ExecutiveTradesQuery {
  ticker?: string;
  filer_name?: string;
  filer_type?: "cabinet" | "appointee" | "other";
  transaction_type?: "purchase" | "sale" | "exchange";
  since?: string;
  until?: string;
  min_amount?: number;
  sort_by?: "filing_date" | "transaction_date";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Form 278 (Annual Financial Disclosure) ─────────────────────────────────

/**
 * Form 278 / Public Financial Disclosure — annual disclosure filed by every
 * member of Congress (and senior executive-branch officials, federal judges).
 * Different from Periodic Transaction Reports (PTRs):
 *   - PTRs    = real-time trade notices, filed within 30-45 days
 *   - Form 278 = year-end snapshot of net worth, assets, income, liabilities
 *
 * v1A captured filing metadata only: who filed, when, and a URL to the actual
 * report. v1 (2026-06-01) adds parsed Schedule A (assets) + Schedule C
 * (liabilities) contents on the `assets[]` / `liabilities[]` arrays for the
 * ~93-94% of annual 278s that ship as structured electronic filings. The
 * ~6.5% Senate paper (scanned-image) filings stay metadata + link-out only
 * (NO OCR) and carry `is_paper: true` + a `coverage_note`.
 *
 * Posture note: every parsed field is source-faithful. Value/amount/income
 * ranges are stored VERBATIM as disclosed (e.g. "$50,001 - $100,000"); they
 * are NEVER collapsed to a point estimate and carry NO numeric min/max. A
 * net-worth roll-up is deliberately NOT in v1 — when it ships it will be an
 * explicitly-labeled KeyVex aggregation in source_metadata, never a source
 * field. This keeps the pure-publisher line intact.
 */

/**
 * One Schedule A (assets) row from a Form 278 annual disclosure. Source-faithful:
 * names, type codes, owner codes, and value/income RANGES are stored exactly as
 * the filer disclosed them. No derived numerics.
 */
export interface Form278Asset {
  /** Source row number, verbatim — "1", "2.1" (sub-holding within an account). */
  row_number: string;
  /** Asset name exactly as disclosed. */
  asset_name: string;
  /** Asset type as disclosed — Senate "Corporate Securities"; House bracket code
   *  "OL"/"OT"/"BA"/"FA" expanded when the source provides it. */
  asset_type: string;
  /** Asset sub-type/category detail (Senate muted "Stock"/"IRA"); "" if none. */
  asset_subtype: string;
  /** Owner as disclosed: Self / Spouse / Joint / Child / Dependent / "". */
  owner: string;
  /** Value RANGE verbatim — "$50,001 - $100,000", "Over $1,000,000",
   *  "Unascertainable", "--", "". NEVER a point estimate; NO numeric min/max. */
  value_range: string;
  /** Income type(s) as disclosed: "Dividends" / "None" / "". */
  income_type: string;
  /** Income RANGE verbatim: "$2,501 - $5,000" / "None (or less than $201)" / "". */
  income_range: string;
  /** Location parenthetical when disclosed (Senate "(New York, NY)", House "L:"). */
  location: string;
  /** Free-text description when disclosed (Senate "Description: …", House "D:"). */
  description: string;
  /** Ticker symbol when the source embeds one in the asset name; "" if none. */
  ticker: string;
}

/**
 * One Schedule C (liabilities) row from a Form 278 annual disclosure.
 * Source-faithful; amount stored as the disclosed RANGE, no numeric min/max.
 */
export interface Form278Liability {
  /** Source row number, verbatim. */
  row_number: string;
  /** Year incurred, verbatim ("2021"); "" if none. */
  incurred: string;
  /** Debtor/owner as disclosed: Self / Spouse / Joint / …. */
  debtor: string;
  /** Liability type as disclosed: "Mortgage" / "Loan" / …. */
  liability_type: string;
  /** Interest rate + term verbatim: "2.5% (30 years)"; "" if none. */
  rate_term: string;
  /** Amount RANGE verbatim: "$250,001 - $500,000"; NO numeric min/max. */
  amount_range: string;
  /** Creditor name as disclosed: "Homepoint". */
  creditor: string;
  /** Creditor location when disclosed (muted "Dallas, TX"); "" if none. */
  location: string;
  /** Free-text comment; "" if none. */
  comment: string;
}

export interface Form278Filing {
  /** Stable doc ID — Senate report UUID or House DocID + year */
  filing_id: string;

  /** Where the filing came from */
  source: "SENATE_EFD_AFD" | "HOUSE_CLERK_FD";
  chamber: "senate" | "house";

  /** Filer identity */
  member_name: string;
  member_first: string;
  member_last: string;
  /** Empty until back-fill from member catalog */
  bioguide_id: string;
  office: string;
  state: string;
  /** Empty for Senate; "12", "AL" (at-large), etc. for House */
  state_district: string;
  /** Empty until back-fill from member catalog */
  party: string;

  /** Filing details */
  filing_year: number;
  filing_date: string;
  /** Human-readable filing flavor */
  report_type:
    | "Annual"
    | "New Filer"
    | "Termination"
    | "Combined"
    | "Periodic"
    | "Amendment"
    | "Other";
  /** URL path subtype (e.g., "annual", "paper", "amendment") — preserves the
   *  raw eFD/clerk identifier for diagnostics. */
  report_subtype: string;
  /** Direct URL to the Form 278 filing — agents follow this to read the
   *  actual asset/liability/transaction schedules in v1A. */
  report_url: string;

  /** ISO timestamp of when our scraper ingested the metadata */
  scraped_at: string;

  // ── v1 (2026-06-01) parsed-content fields. All OPTIONAL so v1A
  //    metadata-only docs already in Firestore stay valid. ──────────────

  /** Parsed Schedule A (assets) rows. Absent on metadata-only / paper docs. */
  assets?: Form278Asset[];
  /** Parsed Schedule C (liabilities) rows. Absent on metadata-only / paper docs. */
  liabilities?: Form278Liability[];
  /** True once the schedule contents were parsed (vs. metadata-only). */
  content_parsed?: boolean;
  /** True for Senate paper (scanned-image) filings — metadata + link-out only,
   *  NO OCR. Pairs with `coverage_note`. */
  is_paper?: boolean;
  /** Honest coverage note when content is unavailable (paper filings, parse
   *  skips) — names the limitation rather than silently omitting it. */
  coverage_note?: string;
  /** Count of parsed asset rows (cheap filter without reading the array). */
  asset_count?: number;
  /** Count of parsed liability rows. */
  liability_count?: number;
  /** True if asset/liability arrays were truncated to protect the 1MB doc cap. */
  schedules_truncated?: boolean;
}

export interface Form278FilingsQuery {
  bioguide_id?: string;
  member_name?: string;
  chamber?: "senate" | "house";
  state?: string;
  party?: string;
  filing_year?: number;
  report_type?: Form278Filing["report_type"];
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "filing_year";
  sort_order?: "desc" | "asc";
  limit?: number;
}

/**
 * FEC (Federal Election Commission) candidate record. One row per FEC-registered
 * candidate (House, Senate, President). Sourced from api.open.fec.gov/v1/candidates/.
 *
 * FEC candidate IDs follow the pattern <OFFICE><CYCLE_LAST_DIGIT><STATE><SEQUENCE>:
 *   - H6PA00091 = House, first-cycle 2026, Pennsylvania, sequence 91
 *   - S6PA00091 = Senate, first-cycle 2026, Pennsylvania, sequence 91
 *   - P80003338 = President, first-cycle 2008, no state, sequence 3338
 * The ID never changes once assigned — same person across cycles keeps their ID.
 */
export interface FecCandidate {
  /** FEC-assigned ID (immutable across cycles). Primary key. */
  candidate_id: string;
  /** Candidate's name as filed with the FEC, often LAST, FIRST format. */
  name: string;
  /** Three-letter party code: DEM / REP / LIB / GRE / IND / OTH / etc. */
  party: string;
  /** Full party name: "Democratic Party" / "Republican Party" / etc. */
  party_full: string;
  /** Office code: H (House) / S (Senate) / P (President). */
  office: string;
  /** Human-readable office: "House" / "Senate" / "President". */
  office_full: string;
  /** Two-letter state code; empty for President. */
  state: string;
  /** House district number as string ("01"-"53", "AL" for at-large); empty for Senate/President. */
  district: string;
  /** Numeric district when available; null otherwise. */
  district_number: number | null;
  /** Challenger status: I (Incumbent) / C (Challenger) / O (Open seat). */
  incumbent_challenge: string;
  /** Filing status: C (current/active) / F / N / P. */
  candidate_status: string;
  /** True if FEC has marked the candidate as inactive. */
  candidate_inactive: boolean;
  /** Election cycles the candidate has filed for, e.g., [2020, 2022, 2024, 2026]. */
  cycles: number[];
  /** All election years the candidate is/was running in. */
  election_years: number[];
  /** Last cycle through which the candidate is considered active. */
  active_through: number | null;
  /** ISO date of first FEC filing. */
  first_file_date: string;
  /** ISO date of most recent FEC filing. */
  last_file_date: string;
  /** ISO date FEC last loaded this record into their database. */
  load_date: string;
  /** Direct link to the canonical FEC candidate page on fec.gov.
   *  Audit-grade provenance — agents can follow to verify against the source. */
  fec_url: string;
  /** When KeyVex scraped this record (ISO 8601). */
  scraped_at: string;
}

export interface FecCandidateQuery {
  /** Exact FEC candidate ID lookup (fastest path). */
  candidate_id?: string;
  /** Substring match against the candidate's name (case-insensitive). */
  candidate_name?: string;
  /** Office filter: H / S / P. */
  office?: string;
  /** Two-letter state code. */
  state?: string;
  /** House district ("01"-"53"). */
  district?: string;
  /** Party code: DEM / REP / etc. */
  party?: string;
  /** Election cycle (e.g., 2026). When set, only candidates whose cycles[] includes this value. */
  cycle?: number;
  /** When true, filter to candidate_inactive=false AND candidate_status='C'. */
  active_only?: boolean;
  sort_by?: "name" | "last_file_date" | "active_through";
  sort_order?: "desc" | "asc";
  limit?: number;
}

/**
 * FEC committee record. Includes campaign committees, leadership PACs,
 * party committees, Super PACs (independent expenditure-only), and 527s.
 * Sourced from api.open.fec.gov/v1/committees/.
 *
 * Committee types (most useful for political-alpha):
 *   H = House campaign committee
 *   S = Senate campaign committee
 *   P = Presidential campaign committee
 *   Q = PAC (qualified, can give to multiple candidates)
 *   N = PAC (non-qualified)
 *   O = Super PAC (independent expenditure-only)
 *   I = Independent expenditure (non-PAC)
 *   X = Party committee (Republican)
 *   Y = Party committee (Democratic)
 *   Z = National party committee
 *   V / W = Carey/hybrid PAC
 *   D = Delegate committee
 *   E = Electioneering communication
 *   U = Single-candidate independent expenditure
 */
export interface FecCommittee {
  /** FEC-assigned committee ID (immutable). Primary key. */
  committee_id: string;
  /** Committee's filed name. */
  name: string;
  /** Treasurer-of-record's name. */
  treasurer_name: string;
  /** Committee type code (H/S/P/Q/N/O/X/Y/Z/etc. — see interface comment). */
  committee_type: string;
  /** Human-readable committee type. */
  committee_type_full: string;
  /** Designation: P (Principal campaign) / A (Authorized) / B (Lobbyist) / U (Unauthorized) / J (Joint fundraiser) / D (Leadership PAC). */
  designation: string;
  /** Human-readable designation. */
  designation_full: string;
  /** Organization type: C (Corporation) / L (Labor) / M (Membership) / T (Trade) / V (Cooperative) / W (Without capital stock). Often empty. */
  organization_type: string;
  organization_type_full: string;
  /** Party affiliation code. */
  party: string;
  party_full: string;
  /** Two-letter state code (for state-tied committees). */
  state: string;
  /** Filing frequency: Q (Quarterly) / M (Monthly) / A (Annual) / etc. */
  filing_frequency: string;
  /** FEC candidate IDs this committee is associated with (may be empty for PACs). */
  candidate_ids: string[];
  /** For Super PACs and similar: candidate IDs the committee primarily sponsors. */
  sponsor_candidate_ids: string[];
  /** Election cycles the committee has filed in. */
  cycles: number[];
  /** ISO date of first Form 1 (Statement of Organization) filing. */
  first_file_date: string;
  /** ISO date of most recent filing. */
  last_file_date: string;
  /** Direct link to the canonical FEC committee page on fec.gov.
   *  Audit-grade provenance — agents can follow to verify against the source. */
  fec_url: string;
  /** When KeyVex scraped this record (ISO 8601). */
  scraped_at: string;
}

/**
 * Federal Register document — a published item from the daily Federal
 * Register (executive orders, proposed rules, final rules, notices,
 * presidential proclamations). Sourced from federalregister.gov/api/v1.
 *
 * Document types ("type" field):
 *   "Rule"               — final regulation
 *   "Proposed Rule"      — agency rule open for public comment
 *   "Notice"             — formal notice (sunshine acts, hearings, etc.)
 *   "Presidential Document" — executive orders, proclamations, memos
 *
 * Use cases: regulatory tracking (what's the SEC / EPA / FDA proposing
 * this week?), lobbying tie-in (cross-reference with LDA filings to
 * spot lobbyists commenting on proposed rules), compliance forward-look
 * (proposed rules likely to affect business).
 */
export interface FederalRegisterDocument {
  /** Unique document number assigned by GPO (e.g., "2026-09385"). Primary key. */
  document_number: string;
  /** Document title / heading. */
  title: string;
  /** Type: "Rule" | "Proposed Rule" | "Notice" | "Presidential Document". */
  document_type: string;
  /** Abstract / summary; often null for short notices. */
  abstract: string;
  /** Publication date (ISO YYYY-MM-DD). */
  publication_date: string;
  /** HTML URL on federalregister.gov. */
  html_url: string;
  /** PDF URL (govinfo.gov). */
  pdf_url: string;
  /** Public-inspection PDF (pre-publication preview). */
  public_inspection_pdf_url: string;
  /** Issuing agency names (raw, as filed). */
  agency_names: string[];
  /** Agency slugs (URL-safe identifiers, e.g., "securities-and-exchange-commission"). */
  agency_slugs: string[];
  /** Excerpt(s) — sometimes a short preview of the document text. */
  excerpts: string;
  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface FederalRegisterDocumentsQuery {
  /** Direct lookup by document_number. */
  document_number?: string;
  /** Substring match against title (case-insensitive). */
  title?: string;
  /** Filter to a document type. */
  document_type?: "Rule" | "Proposed Rule" | "Notice" | "Presidential Document";
  /** Filter by agency slug (e.g., "securities-and-exchange-commission"). Uses array-contains. */
  agency_slug?: string;
  /** Substring against agency names (catches partial-name matches). */
  agency_name?: string;
  /** Substring against abstract + title + excerpts combined. */
  text?: string;
  /** Publication-date lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** Publication-date upper bound. */
  until?: string;
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * OFAC Specially Designated National (SDN) entry — a person, entity,
 * vessel, or aircraft sanctioned by the US Treasury OFAC under one or
 * more sanctions programs (Cuba, Iran, Russia/SDGT, NK, etc.).
 *
 * US persons (citizens, residents, companies) are prohibited from
 * transacting with SDNs. Banks screen against this list daily.
 *
 * Source: sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv
 *  (12-column CSV, ~19K records; OFAC uses '-0-' as the empty-field
 *  sentinel which we normalize to "").
 *
 * Companion files (alternate names, addresses) are available separately
 * — v1A keeps just the primary SDN.csv; aliases + addresses are v1.1.
 */
export interface OfacSdnEntry {
  /** OFAC-assigned entity number, primary key. */
  ent_num: string;
  /** Primary listed name. */
  name: string;
  /** "individual" | "entity" | "vessel" | "aircraft" | "" (when not surfaced). */
  entity_type: string;
  /** Sanctions program(s) the entry falls under (e.g., "CUBA", "IRAN",
   *  "SDGT", "UKRAINE-EO13662"). May be comma-delimited for multi-program. */
  program: string;
  /** For individuals: title / honorific (often empty). */
  title: string;
  /** Vessel: call sign. */
  call_sign: string;
  /** Vessel: type (e.g., "Cargo", "Tanker"). */
  vessel_type: string;
  /** Vessel: tonnage. */
  tonnage: string;
  /** Vessel: gross registered tonnage. */
  gross_registered_tonnage: string;
  /** Vessel: flag state. */
  vessel_flag: string;
  /** Vessel: owner. */
  vessel_owner: string;
  /** Free-text remarks (aliases, DOB / passport refs, address hints). */
  remarks: string;
  /** Direct link to the OFAC sanctions search detail page for this entry.
   *  Audit-grade provenance — agents can follow to verify the listing
   *  against Treasury's official sanctions search portal. */
  ofac_url: string;
  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface OfacSdnQuery {
  /** Direct ent_num lookup. */
  ent_num?: string;
  /** Substring match against name (case-insensitive). */
  name?: string;
  /** Filter to "individual" | "entity" | "vessel" | "aircraft". */
  entity_type?: string;
  /** Substring against program field (e.g., "RUSSIA", "IRAN", "CUBA"). */
  program?: string;
  /** Substring against remarks (aliases, DOB hints, etc.). */
  remarks?: string;
  sort_by?: "ent_num" | "name";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * SEC registration statement (Form S-1 / S-3 family) — securities offering
 * registration. One record per filing. Filed when a company is registering
 * new securities for public sale.
 *
 * Form S-1: Initial registration. Used by:
 *   - Companies going public (IPO)
 *   - Companies registering new securities for the first time
 *   - Companies that don't qualify for Form S-3
 *
 * Form S-3: Shelf registration (simpler / shorter). Available to companies
 * that meet reporting-history + market-cap criteria. Lets the issuer
 * register securities to be sold over multiple offerings ("off the
 * shelf") without re-registering each time.
 *
 * Amendments use the same names with /A suffix: S-1/A, S-3/A.
 *
 * v1A scope: metadata only. Filer (company name + CIK + ticker when
 * surfaced + state), file_number (the SEC-assigned registration tracking
 * number — useful for grouping amendment chains), filing type, URLs.
 * Substantive prospectus content lives in the primary document HTML —
 * agents follow primary_document_url for offering size, share counts,
 * use of proceeds, etc.
 */
export interface RegistrationStatement {
  /** EDGAR accession number, primary key. */
  filing_id: string;
  /** "S-1" | "S-1/A" | "S-3" | "S-3/A". */
  filing_type: string;
  /** True when filing_type ends in /A. */
  is_amendment: boolean;
  /** ISO date filed. */
  file_date: string;
  /** Company name as filed. */
  filer_name: string;
  /** Filer CIK (10-digit zero-padded). */
  filer_cik: string;
  /** Ticker symbol if surfaced by EDGAR's display_names; often empty for IPO-stage filers. */
  filer_ticker: string;
  /** SEC-assigned registration file number (e.g., "333-295535"). Stable across amendments. */
  sec_file_number: string;
  /** Business state. */
  filer_state: string;
  /** State of incorporation. */
  inc_state: string;
  /** SIC industry codes. */
  sic_codes: string[];
  /** Direct URL to the primary document (typically HTML prospectus). */
  primary_document_url: string;
  /** Direct URL to the EDGAR filing index. */
  filing_url: string;
  scraped_at: string;
}

export interface RegistrationStatementsQuery {
  filing_id?: string;
  /** Substring against filer_name (case-insensitive). */
  filer_name?: string;
  filer_cik?: string;
  /** Ticker filter (e.g., 'KPTI'). */
  filer_ticker?: string;
  /** Filter to exact filing_type. */
  filing_type?: "S-1" | "S-1/A" | "S-3" | "S-3/A";
  /** When true, only S-1 family (IPO-style). When false, only S-3 family (shelf). */
  s1_only?: boolean;
  s3_only?: boolean;
  /** When true, exclude amendments. Default false. */
  exclude_amendments?: boolean;
  /** SEC-assigned file number for amendment-chain grouping. */
  sec_file_number?: string;
  /** Filing-date lower bound. */
  since?: string;
  until?: string;
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * SEC Form N-PORT filing — registered-investment-company monthly portfolio
 * report. One record per (fund, reporting month, filing). Filed by mutual
 * funds, ETFs, and closed-end funds within 60 days of each month-end.
 *
 * Pairs with `get_institutional_holdings` (13F): 13F is quarterly + tied
 * to institutional investment managers; N-PORT is monthly + tied to the
 * fund's own portfolio. Together they give fresher snapshots of who-owns-
 * what across two complementary universes.
 *
 * v1A scope: metadata only — filer (fund trust name + CIK), reporting
 * period, filing type, file number, URLs. Per-holding portfolio detail
 * lives at primary_document_url; agents follow for security-level views.
 * Full holdings extraction is v1.1 polish (XML schema is rich but heavy —
 * a single S&P 500 ETF's NPORT can have 500+ holdings).
 */
export interface NportFiling {
  /** EDGAR accession number, primary key. */
  filing_id: string;
  /** Form variant: "NPORT-P" (filed) or "NPORT-P/A" (amendment). */
  filing_type: string;
  /** True when filing_type ends in /A. */
  is_amendment: boolean;
  /** ISO date the filing was submitted to EDGAR. */
  file_date: string;
  /** Period ending — the month-end the report covers (ISO YYYY-MM-DD). */
  period_ending: string;
  /** Fund trust name (e.g., "WisdomTree Trust"). */
  filer_name: string;
  /** Filer CIK (10-digit zero-padded). */
  filer_cik: string;
  /** SEC Investment Company file number (e.g., "811-21864"). */
  sec_file_number: string;
  /** Business location (state). */
  filer_state: string;
  /** State of incorporation. */
  inc_state: string;
  /** Direct URL to the primary_doc.xml (full portfolio holdings). */
  primary_document_url: string;
  /** Direct URL to the EDGAR filing index. */
  filing_url: string;
  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface NportFilingsQuery {
  filing_id?: string;
  filer_cik?: string;
  /** Case-insensitive substring against filer_name (fund trust name). */
  filer_name?: string;
  /** Filter to a specific reporting period (YYYY-MM-DD). */
  period_ending?: string;
  /** SEC investment company file number (e.g., "811-21864"). */
  sec_file_number?: string;
  /** When set, restricts to NPORT-P/A amendments (true) or original NPORT-P (false). */
  is_amendment?: boolean;
  /** file_date lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** file_date upper bound. */
  until?: string;
  sort_by?: "file_date" | "period_ending";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * One investment-or-security row from an N-PORT primary document
 * (`<invstOrSec>` element under `<formData><invstOrSecs>`). Each parent
 * NportFiling has 1-1000+ NportHolding rows. Captures common fields shared
 * across equities, debt, derivatives, and repos plus a derivative-type
 * discriminator. Deep derivative sub-blocks (counterparty, strike, leg
 * details, notional terms) are NOT extracted in v1A — agents follow the
 * parent filing's primary_document_url for that level of detail.
 *
 * Tied to NportFiling by `filing_id`; doc-ID format `{accession}-{idx}` keeps
 * re-scrapes idempotent and orderable within a filing.
 */
export interface NportHolding {
  /** Composite doc ID: `{filing_id}-{holding_index}`. */
  id: string;
  /** EDGAR accession number — foreign key to NportFiling.filing_id. */
  filing_id: string;
  /** "NPORT-P" or "NPORT-P/A". */
  filing_type: string;
  is_amendment: boolean;
  /** Reporting period end date (YYYY-MM-DD). */
  period_ending: string;
  /** Fund trust name (e.g., "iShares Trust"). */
  filer_name: string;
  /** Fund CIK (10-digit zero-padded). */
  filer_cik: string;
  sec_file_number: string;

  /** 0-based position inside the parent filing's invstOrSecs list. */
  holding_index: number;
  /** Issuer name as filed. */
  name: string;
  /** Legal Entity Identifier. */
  lei: string | null;
  /** Security title (e.g., "Common Stock", "Senior Note 5.5% 2030"). */
  title: string | null;
  /** 9-character CUSIP. May be "N/A" or empty for non-CUSIP holdings. */
  cusip: string | null;
  /** Ticker if present in `<identifiers><ticker value="..."/>` (rare). */
  ticker: string | null;
  /** ISIN if present in `<identifiers><isin value="..."/>`. */
  isin: string | null;

  /**
   * SEC asset-category code. Equities: EC (common), EP (preferred).
   * Debt: DBT, ABS, MBS, UST, USTPS, STIV, SN, LT, MMF. Cash: CASH.
   * Derivatives: DCO commodity, DCR credit, DE equity, DFE fx, DIR rate,
   * DR other. Repos: REPO, RP.
   */
  asset_cat: string | null;
  /** True iff asset_cat is a D* code (any derivative). */
  is_derivative: boolean;
  /**
   * When is_derivative=true, the structural type derived from which child
   * of `<derivativeInfo>` is present:
   *   "future" | "forward" | "swap" | "option" | "warrant" | "swaption" |
   *   "other" | null
   */
  derivative_type: string | null;
  /** Issuer category code (CORP, RF, MUN, FGS, ABS, etc.). */
  issuer_cat: string | null;
  /** ISO-2 country of investment (e.g., "US", "GB"). */
  country: string | null;

  /**
   * Balance / quantity. Sign convention per N-PORT spec: positive = long,
   * negative = short. For derivatives, units of contracts.
   */
  balance: number | null;
  /** "NS" number of shares, "PA" principal amount, "NC" notional contract. */
  units: string | null;
  /** Currency of the holding (ISO-3, e.g., "USD"). */
  currency: string | null;
  /** Fair value in USD. */
  value_usd: number | null;
  /** Percentage of fund total net assets (0-100 scale). */
  pct_of_portfolio: number | null;
  /** "Long" or "Short" per N-PORT spec. */
  payoff_profile: string | null;
  /** ASC 820 fair-value hierarchy level: 1, 2, or 3. */
  fair_val_level: number | null;
  is_restricted: boolean | null;
  is_non_cash_collateral: boolean | null;
  /** True iff this holding is on loan (security lending program). */
  is_loaned: boolean | null;

  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface NportHoldingsQuery {
  filing_id?: string;
  filer_cik?: string;
  /** Case-insensitive substring against filer_name. */
  filer_name?: string;
  period_ending?: string;
  /** Case-insensitive substring against issuer name. */
  name?: string;
  cusip?: string;
  ticker?: string;
  isin?: string;
  /** Exact match on asset category code (EC / DBT / DE / REPO / ...). */
  asset_cat?: string;
  is_derivative?: boolean;
  /** "future" | "forward" | "swap" | "option" | "warrant" | "swaption" | "other". */
  derivative_type?: string;
  country?: string;
  min_value_usd?: number;
  min_pct_of_portfolio?: number;
  payoff_profile?: "Long" | "Short";
  /** period_ending lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** period_ending upper bound. */
  until?: string;
  sort_by?: "value_usd" | "pct_of_portfolio" | "period_ending";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * Product recall — a unified record covering safety recalls across five
 * federal agencies. One row per recall, source field discriminates the
 * agency. Pure-publisher posture: severity classification is the agency's
 * own label (FDA Class I/II/III, NHTSA campaign severity), not a derived
 * KeyVex score.
 *
 * Sources:
 *   "fda_drug"   — openFDA /drug/enforcement.json (drug recalls)
 *   "fda_device" — openFDA /device/enforcement.json (medical device recalls)
 *   "fda_food"   — openFDA /food/enforcement.json (food + dietary supplements)
 *   "nhtsa"      — NHTSA recalls API (vehicles, equipment, tires, child seats)
 *   "cpsc"       — CPSC product recall RSS / API (consumer products)
 *
 * Cross-source pairing pattern: join to get_material_events (8-K Item 8.01)
 * for the company-disclosure overlay, to get_insider_transactions for any
 * insider activity around the recall date, and to get_enforcement_actions
 * for FDA / DOJ follow-through.
 */
export interface ProductRecall {
  /** Composite ID: `{source}-{recall_number}`. Stable across re-scrapes. */
  id: string;
  source: "fda_drug" | "fda_device" | "fda_food" | "nhtsa" | "cpsc";
  /** Recall identifier as filed (e.g., FDA "D-1234-2026", NHTSA "26V-001"). */
  recall_number: string;
  /** Date the recall was initiated (YYYY-MM-DD). Primary chronology field. */
  recall_initiation_date: string;
  /** Date the recall was posted to the agency's public registry (YYYY-MM-DD). */
  posted_date: string | null;
  /** Manufacturer / firm / company that issued the recall. */
  recalling_firm: string;
  /** Plain-text product description (size, packaging, SKU range). */
  product_description: string;
  /** Reason the recall was initiated (hazard, defect, contamination). */
  reason_for_recall: string;
  /**
   * Severity classification as filed by the agency.
   *   FDA: "Class I" (serious / death), "Class II" (reversible), "Class III" (unlikely harm)
   *   NHTSA: campaign severity flag or `null`
   *   CPSC: hazard category or `null`
   */
  classification: string | null;
  /** Status: "Ongoing", "Completed", "Terminated", "Recall Initiated", etc. */
  status: string | null;
  /** "Voluntary", "FDA Mandated", "Mandatory", or null. Source-dependent. */
  initiator: string | null;
  /** Geographic scope of distribution (e.g., "Nationwide", "California, Texas"). */
  distribution_pattern: string | null;
  /** Quantity / units affected ("10,000 bottles"). */
  product_quantity: string | null;
  /** Product family / category (FDA product_type, NHTSA component group, CPSC category). */
  product_category: string | null;
  /** Lot codes, UPC codes, NDC codes, batch numbers — free-form. */
  product_codes: string[] | null;
  /** NHTSA-only: vehicle make (e.g., "TOYOTA"). Null for other sources. */
  vehicle_make: string | null;
  /** NHTSA-only: vehicle model. */
  vehicle_model: string | null;
  /** NHTSA-only: affected model years as a range string ("2018-2020"). */
  model_year_range: string | null;
  /** NHTSA-only: affected component description ("AIR BAGS, FRONTAL"). */
  affected_component: string | null;
  /** Date the recall was terminated, if applicable (YYYY-MM-DD). */
  termination_date: string | null;
  /** URL to source-of-record recall page or API record. */
  source_url: string;
  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface ProductRecallsQuery {
  source?: "fda_drug" | "fda_device" | "fda_food" | "nhtsa" | "cpsc";
  recall_number?: string;
  /** Case-insensitive substring against recalling_firm. */
  recalling_firm?: string;
  /** Case-insensitive substring against product_description. */
  product_description?: string;
  /** Exact match (e.g., "Class I", "Class II", "Class III"). */
  classification?: string;
  /** Exact match (e.g., "Ongoing", "Completed", "Terminated"). */
  status?: string;
  /** NHTSA-only filter (exact, uppercase). */
  vehicle_make?: string;
  /** NHTSA-only filter (substring). */
  vehicle_model?: string;
  /** recall_initiation_date lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** recall_initiation_date upper bound. */
  until?: string;
  sort_by?: "recall_initiation_date" | "posted_date";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * "Needs OCR" reference — a scanned / image-only / corrupted PDF filing whose
 * text layer pdf-parse cannot extract usefully. We do NOT OCR here; we only
 * RECORD the reference so the documents can be OCR'd later in one batch and so
 * we get a hard count for pricing math.
 *
 * Detection lives in `needsOcr()` (a per-page real-word density heuristic) plus
 * the existing Senate `isPaperPtr()` HTML detector. A record lands here only
 * when a filing is determined to lack a usable digital text layer.
 *
 * Sources:
 *   "house"  — House Clerk PTR PDFs (rotated scans like Rep. Ro Khanna's
 *              2024/8220127.pdf extract near-nothing via pdf-parse).
 *   "senate" — Senate eFD "paper PTR" amendments (HTML wrapper around a PDF
 *              embed; caught by isPaperPtr()).
 *   "oge"    — OGE Form 278 filings whose text layer is corrupted (broken font
 *              encoding — e.g. President/VP filings noted in oge278t.ts).
 */
export interface NeedsOcr {
  /** Stable dedup key derived from filing_url (sanitized). Re-runs MERGE. */
  id: string;
  /** Which scraper surface this filing came from. */
  source: "house" | "senate" | "oge";
  /** Canonical URL of the PDF (or HTML paper-PTR wrapper) to OCR later. */
  filing_url: string;
  /** Best-known filer/member name (may be "" if not resolvable from the ref). */
  filer_name: string;
  /** Filing date as ISO YYYY-MM-DD (may be "" if unknown). */
  filing_date: string;
  /** Source doc identifier (House DocID, Senate ptrId, OGE filename). */
  doc_id: string;
  /** Pages reported by pdf-parse (undefined for HTML paper-PTRs). */
  page_count: number | null;
  /** Total characters pdf-parse extracted (0 for HTML paper-PTRs). */
  extracted_chars: number;
  /** Count of /[A-Za-z]{3,}/ matches in the extracted text (the density metric). */
  real_word_count: number;
  /** Why this filing was queued for OCR. */
  reason:
    | "scanned_no_text_layer"
    | "paper_ptr"
    | "corrupted_text_layer";
  /** When KeyVex detected this (ISO timestamp). */
  detected_at: string;
}

/**
 * Enforcement action — a public press release / litigation release from
 * the SEC or DOJ announcing charges, settlements, indictments, or other
 * enforcement activity. Unified schema for both sources via the `source`
 * field. Captures metadata + a short teaser/description; full prose lives
 * at `url` for agent follow-through.
 *
 * Sources:
 *   "sec" — SEC press releases RSS at sec.gov/news/pressreleases.rss
 *           (latest ~50-item rolling window; historical archive scrape
 *           is v1.1 polish via sec.gov/news/pressreleases.htm pages)
 *   "doj" — DOJ press release JSON API at
 *           justice.gov/api/v1/press_releases.json (266K+ historical
 *           records, paginated)
 *
 * v1A scope: metadata + teaser only. Agents read full prose at `url`.
 * Pure-publisher posture: no derived "severity score" or "outcome
 * prediction" signals — just the announcement as filed.
 */
export interface EnforcementAction {
  /** Composite key. SEC: "sec-{guid}" or "sec-{slug}"; DOJ: "doj-{uuid}";
   *  CFTC: "cftc-{releaseNumber}" (e.g., "cftc-9230-26"). */
  action_id: string;
  /** Issuing agency. */
  source: "sec" | "doj" | "cftc" | "occ" | "fdic" | "ftc";
  /** Title / headline of the press release. */
  title: string;
  /** Short summary (DOJ teaser field, or first sentence of SEC description). */
  teaser: string;
  /** Body / description. SEC: full description from RSS. DOJ: HTML-stripped body excerpt.
   *  CFTC v1A: empty (index-only scrape; full body fetch is v1.1). */
  description: string;
  /** ISO date the announcement was published. */
  published_date: string;
  /** Public URL of the full press release. */
  url: string;
  /** SEC: the issuing division (when surfaced; often empty in RSS).
   *  DOJ: the issuing component (e.g., "Criminal Division", "Office of Public Affairs").
   *  CFTC: the division when surfaced ("Division of Enforcement", etc.). */
  agency_component: string;
  /** DOJ-specific release number (e.g., "26-489"). CFTC: release number from URL slug
   *  (e.g., "9230-26"). Empty for SEC. */
  release_number: string;
  /** DOJ-specific topic tags. Empty for SEC + CFTC v1A. */
  topics: string[];
  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface EnforcementActionsQuery {
  /** Direct lookup by action_id. */
  action_id?: string;
  /** Filter to one source. */
  source?: "sec" | "doj" | "cftc" | "occ" | "fdic" | "ftc";
  /** Substring against title (case-insensitive). */
  title?: string;
  /** Substring against description + teaser concatenated (case-insensitive). */
  text?: string;
  /** Substring against agency_component (e.g., "criminal division", "fraud section"). */
  agency_component?: string;
  /** DOJ: array-contains match against topics. */
  topic?: string;
  /** Published date lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** Published date upper bound (YYYY-MM-DD inclusive). */
  until?: string;
  sort_by?: "published_date";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * SEC Form D — exempt private placement / Reg D offering notice.
 * One row per accession. Sourced from EDGAR FTS + per-filing
 * primary_doc.xml fetch.
 *
 * Form D is filed within 15 days of the first sale in a private offering
 * conducted under Reg D (Rules 504, 506(b), 506(c)) or Section 4(a) of
 * the Securities Act. The data captured is the canonical view of who's
 * raising private capital, when, in which industry, under which
 * exemption, and how much.
 *
 * Use cases:
 *   - VC / PE / startup tracking ("who's raising right now")
 *   - Detect new fund formations (LP / LLC vehicle creation)
 *   - Investor counts + minimum investment thresholds
 *   - Identify executive officers + directors of new entities
 *
 * Pure-publisher posture: returns data as filed. KeyVex doesn't compute
 * derived "deal quality" or "round velocity" signals — agents do.
 */
export interface PrivatePlacement {
  /** EDGAR accession number, primary key. */
  filing_id: string;
  /** "D" (new filing) | "D/A" (amendment). */
  filing_type: string;
  /** True when filing_type ends in /A. */
  is_amendment: boolean;
  /** ISO date filed with SEC (YYYY-MM-DD). */
  file_date: string;
  /** Filing's primary issuer's SEC CIK (10-digit zero-padded). */
  issuer_cik: string;
  /** Legal entity name of the issuer. */
  issuer_name: string;
  /** Issuer's street1 + street2 (concatenated). */
  issuer_street: string;
  /** Issuer's city. */
  issuer_city: string;
  /** Issuer's state or country (2-letter code if US). */
  issuer_state: string;
  /** Issuer's ZIP. */
  issuer_zip: string;
  /** Issuer's phone (if disclosed). */
  issuer_phone: string;
  /** Jurisdiction of incorporation (e.g., "DELAWARE", "CALIFORNIA"). */
  jurisdiction_of_inc: string;
  /** Entity type (e.g., "Limited Liability Company", "Limited Partnership"). */
  entity_type: string;
  /** Year of incorporation (as filed; empty if "Decline to Disclose"). */
  year_of_inc: string;
  /** True if issuer was incorporated within the 5 years prior to filing. */
  year_of_inc_within_five_years: boolean;
  /** Industry group at the top level (e.g., "Pooled Investment Fund",
   *  "Technology", "Real Estate", "Health Care"). */
  industry_group_type: string;
  /** For Pooled Investment Funds: subtype (e.g., "Venture Capital Fund",
   *  "Private Equity Fund", "Hedge Fund"). Empty for other industries. */
  investment_fund_type: string;
  /** True if registered under the Investment Company Act of 1940. */
  is_40_act: boolean;
  /** Disclosed annual revenue bucket ("$1M-$5M", "Decline to Disclose", etc.). */
  revenue_range: string;
  /** Reg D exemption claims (e.g., "06b" for Rule 506(b), "06c" for 506(c),
   *  "3C" / "3C.1" / "3C.7" for Investment Company Act exclusions). */
  federal_exemptions: string[];
  /** ISO date of first sale. */
  date_of_first_sale: string;
  /** True if offering expected to last more than one year. */
  duration_more_than_one_year: boolean;
  /** Total offering amount (string — can be "Indefinite" or a dollar amount). */
  total_offering_amount: string;
  /** Total amount sold to date (dollars). */
  total_amount_sold: number;
  /** Total remaining (string — same shape as total_offering_amount). */
  total_remaining: string;
  /** Minimum accepted investment (dollars; 0 if not specified). */
  min_investment_accepted: number;
  /** Number of investors who have already invested. */
  total_number_already_invested: number;
  /** Sales commissions paid (dollars). */
  sales_commissions: number;
  /** Finder fees paid (dollars). */
  finder_fees: number;
  /** Related persons (directors, executive officers, promoters, etc.). */
  related_persons: PrivatePlacementRelatedPerson[];
  /** Direct URL to the primary_doc.xml. */
  primary_document_url: string;
  /** Direct URL to the filing index on EDGAR. */
  filing_url: string;
  scraped_at: string;
}

export interface PrivatePlacementRelatedPerson {
  first_name: string;
  middle_name: string;
  last_name: string;
  city: string;
  state: string;
  /** Director / Executive Officer / Promoter / etc. */
  relationships: string[];
  /** Free-text clarification when filer disclosed one. */
  clarification: string;
}

export interface PrivatePlacementsQuery {
  /** Direct accession lookup. */
  filing_id?: string;
  /** Issuer CIK (10-digit zero-padded). */
  issuer_cik?: string;
  /** Substring match against issuer_name (case-insensitive). */
  issuer_name?: string;
  /** Filter to issuers in a specific state (2-letter code). */
  issuer_state?: string;
  /** Substring match against jurisdiction_of_inc. */
  jurisdiction_of_inc?: string;
  /** Substring match against industry_group_type ("technology", "real estate", etc.). */
  industry_group_type?: string;
  /** Substring match against investment_fund_type ("venture capital", "private equity"). */
  investment_fund_type?: string;
  /** Filter by federal exemption (array-contains, e.g., "06b" for Rule 506(b)). */
  federal_exemption?: string;
  /** When true, only D filings. When false, only D/A amendments. Default: both. */
  is_amendment?: boolean;
  /** Minimum total_amount_sold (filter for material raises). */
  min_amount_sold?: number;
  /** date_of_first_sale lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** date_of_first_sale upper bound (YYYY-MM-DD inclusive). */
  until?: string;
  sort_by?: "file_date" | "date_of_first_sale" | "total_amount_sold";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * Congressional bill — one row per (congress, billType, number) tuple.
 * Sourced from api.congress.gov/v3/bill. v1A is metadata only; full action
 * history, sponsor list, related bills, text, and summaries live behind
 * `api_url` and `congress_gov_url` — agents follow those for detail.
 *
 * Bill types we cover:
 *   HR        — House Bill
 *   S         — Senate Bill
 *   HRES      — House Simple Resolution
 *   SRES      — Senate Simple Resolution
 *   HJRES     — House Joint Resolution
 *   SJRES     — Senate Joint Resolution
 *   HCONRES   — House Concurrent Resolution
 *   SCONRES   — Senate Concurrent Resolution
 */
export interface Bill {
  /** Composite key, e.g., "119-HR-134". Primary key in Firestore. */
  bill_id: string;
  /** Numeric Congress (e.g., 119 = January 2025 → January 2027). */
  congress: number;
  /** Type code (HR | S | HRES | SRES | HJRES | SJRES | HCONRES | SCONRES). */
  bill_type: string;
  /** Bill number (string for stable formatting; numeric-only but kept as string). */
  number: string;
  /** Bill title as filed. */
  title: string;
  /** Originating chamber: "House" | "Senate". */
  origin_chamber: string;
  /** Originating chamber code: "H" | "S". */
  origin_chamber_code: string;
  /**
   * ISO date the bill was originally introduced (referred to first committee).
   * Distinct from `latest_action_date`, which moves with floor/committee
   * activity over time. Use this for "introduced in the last N months" queries.
   * Empty string if not yet populated (older scraper runs may not have it;
   * backfill via a re-scrape of the affected Congress).
   */
  introduction_date: string;
  /** ISO date of the most recent floor / committee / status action. */
  latest_action_date: string;
  /** Human-readable description of the latest action. */
  latest_action_text: string;
  /** ISO date this record was last updated server-side. */
  update_date: string;
  /** Public-facing URL on congress.gov. */
  congress_gov_url: string;
  /** API detail URL for sponsors, cosponsors, full history, etc. */
  api_url: string;
  scraped_at: string;
}

export interface BillsQuery {
  /** Composite key lookup ("119-HR-134"). Fastest path. */
  bill_id?: string;
  /** Congress number filter (e.g., 119). */
  congress?: number;
  /** Bill type filter (HR | S | HRES | etc.). */
  bill_type?: string;
  /** Substring match against title (case-insensitive). */
  title?: string;
  /** Origin chamber filter. */
  origin_chamber?: "House" | "Senate";
  /** Latest-action date lower bound (ISO YYYY-MM-DD inclusive). */
  since?: string;
  /** Latest-action date upper bound (ISO YYYY-MM-DD inclusive). */
  until?: string;
  /**
   * Introduction-date lower bound (ISO YYYY-MM-DD inclusive). Use this to
   * answer "bills introduced in the last N months" — `since`/`until` filter
   * the *most recent* action date, which can move with floor activity even
   * on bills introduced over a year ago.
   */
  introduced_since?: string;
  /** Introduction-date upper bound (ISO YYYY-MM-DD inclusive). */
  introduced_until?: string;
  sort_by?: "latest_action_date" | "update_date" | "introduction_date";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * Congressional roll-call vote — one row per (chamber, congress, session, rcNumber).
 * Sourced from api.congress.gov/v3/{house-vote,senate-vote}. v1A is metadata only;
 * per-member vote positions (yea/nay/present per bioguide_id) live in the per-vote
 * detail XML at `source_data_url` and are NOT extracted in v1A. v1.1 will add a
 * `roll_call_member_votes` collection keyed by (vote_id, bioguide_id).
 */
export interface RollCallVote {
  /** Composite key: "{chamber}-{congress}-{session}-{rcNumber}", e.g., "house-119-1-240". */
  vote_id: string;
  /** Numeric Congress. */
  congress: number;
  /** Session number within the Congress (1 or 2). */
  session_number: number;
  /** "house" | "senate". */
  chamber: "house" | "senate";
  /** Roll call number assigned within (congress, session, chamber). */
  roll_call_number: number;
  /** "2/3 Yea-And-Nay" | "Yea-And-Nay" | "Recorded Vote" | "Quorum" | etc. */
  vote_type: string;
  /** "Passed" | "Failed" | "Agreed to" | "Rejected" | etc. */
  result: string;
  /** Type code of the legislation voted on (HR | S | HRES | etc.); empty for procedural votes. */
  legislation_type: string;
  /** Bill number of the legislation voted on; empty for procedural votes. */
  legislation_number: string;
  /** Composite bill_id reference if this vote is on a bill ("119-HR-134"); empty otherwise. */
  bill_id: string;
  /** ISO 8601 datetime of vote start (with timezone). */
  start_date: string;
  /** ISO date the record was last updated server-side. */
  update_date: string;
  /** Chamber-Clerk XML URL with full per-member positions (House Clerk or Senate). */
  source_data_url: string;
  /** Public-facing URL on congress.gov. */
  congress_gov_url: string;
  /** API detail URL for member-level votes. */
  api_url: string;
  scraped_at: string;
}

export interface RollCallVotesQuery {
  /** Direct vote_id lookup. */
  vote_id?: string;
  /** Congress number (e.g., 119). */
  congress?: number;
  /** Session within the Congress (1 or 2). */
  session_number?: number;
  /** "house" | "senate". */
  chamber?: "house" | "senate";
  /** Filter to votes on a specific bill (composite, e.g., "119-HR-134"). */
  bill_id?: string;
  /** Filter to votes on a specific legislation type (HR | S | HJRES | etc.). */
  legislation_type?: string;
  /** Substring match against result (case-insensitive, e.g., "passed", "failed"). */
  result?: string;
  /** Vote-start lower bound (ISO YYYY-MM-DD inclusive). */
  since?: string;
  /** Vote-start upper bound (ISO YYYY-MM-DD inclusive). */
  until?: string;
  sort_by?: "start_date" | "update_date";
  sort_order?: "asc" | "desc";
  limit?: number;
}

/**
 * SEC Schedule TO filing — a tender offer disclosure. Pairs naturally with
 * 13D activist stake disclosures: "they took a 5% stake, then bid for the
 * rest." v1A scope is metadata only — bidder, target, form type, filing
 * date, URL. Offer price / shares sought / expiration date live inside
 * the HTML attachment and require parsing (v1.1).
 *
 * Form codes covered:
 *   SC TO-T — third-party tender offer (acquirer bidding for target's shares)
 *   SC TO-I — issuer tender offer (company buying back its own shares)
 *   SC TO-T/A, SC TO-I/A — amendments (revised terms, extension, results)
 *
 * Not covered in v1A: SC TO-C (pre-commencement communication / PR before
 * formal filing) and SC 14D9 (target company response & recommendation).
 * Both are companion filings whose informational value is in the prose.
 */
export interface TenderOffer {
  /** EDGAR accession number, the immutable filing identifier. Primary key. */
  accession_number: string;
  /** SC TO-T | SC TO-I | SC TO-T/A | SC TO-I/A */
  form_type: string;
  /** True for amendment filings (form_type ends in /A). */
  is_amendment: boolean;
  /** True for issuer self-tender (SC TO-I); false for third-party (SC TO-T). */
  is_issuer_tender: boolean;
  /** Filing date (ISO YYYY-MM-DD). */
  filing_date: string;
  /** Target company's name as filed. For SC TO-I this == bidder_name. */
  target_name: string;
  /** Target's CIK (zero-padded 10-digit). */
  target_cik: string;
  /** Target's ticker if surfaced by EDGAR's display_names; empty otherwise. */
  target_ticker: string;
  /** Bidder name (acquirer for SC TO-T; same as target for SC TO-I). */
  bidder_name: string;
  /** Bidder's CIK. */
  bidder_cik: string;
  /** Bidder's ticker if available; usually empty (bidders are often private SPVs). */
  bidder_ticker: string;
  /** All CIKs on the filing (target + bidder + any joint filers). */
  all_ciks: string[];
  /** File number assigned by EDGAR (used for amendment chains). */
  file_number: string;
  /** Direct URL to the filing index on EDGAR. */
  filing_url: string;
  /** Direct URL to the primary HTML/PDF attachment (offer terms prose). */
  primary_document_url: string;
  /** State(s) of incorporation of the parties (best-effort from EDGAR metadata). */
  inc_states: string[];
  /** SIC code(s) of the parties (industry classification). */
  sic_codes: string[];
  /** When KeyVex scraped this record (ISO 8601). */
  scraped_at: string;
}

export interface TenderOffersQuery {
  /** Direct accession lookup (fastest path). */
  accession_number?: string;
  /** Target company ticker (e.g., 'KZR'). */
  target_ticker?: string;
  /** Target's CIK (10-digit zero-padded). */
  target_cik?: string;
  /** Substring match against target_name (case-insensitive). */
  target_name?: string;
  /** Bidder's CIK. */
  bidder_cik?: string;
  /** Substring match against bidder_name (case-insensitive). */
  bidder_name?: string;
  /** Filter to specific form_type. */
  form_type?: string;
  /** When true, only third-party offers (SC TO-T family). */
  third_party_only?: boolean;
  /** When true, only issuer buybacks (SC TO-I family). */
  issuer_only?: boolean;
  /** When true, exclude amendments. Default false (include them). */
  exclude_amendments?: boolean;
  /** Filing date lower bound (ISO YYYY-MM-DD inclusive). */
  since?: string;
  /** Filing date upper bound (ISO YYYY-MM-DD inclusive). */
  until?: string;
  sort_by?: "filing_date";
  sort_order?: "desc" | "asc";
  limit?: number;
}

/**
 * Candidate profile enriched with their associated committees. Returned by
 * `get_fec_candidate_profile` when include_committees=true (default).
 * Lets agents read the full "candidate → committees" structure in one tool
 * call without a follow-up committee lookup.
 */
export interface FecCandidateProfile extends FecCandidate {
  /** Committees this candidate is linked to, ordered with principal first.
   *  Populated when include_committees=true; omitted otherwise. */
  committees?: FecCommittee[];
}

export interface FecCommitteeQuery {
  committee_id?: string;
  committee_name?: string;
  candidate_id?: string;
  committee_type?: string;
  designation?: string;
  state?: string;
  party?: string;
  cycle?: number;
  sort_by?: "name" | "last_file_date";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── FEC Schedule A — Contributions (v1A) ───────────────────────────────────

/**
 * One Schedule A contribution row from the FEC. Schedule A is the FEC's
 * record of money flowing INTO a committee — itemized when ≥ $200 from
 * an individual (PACs also report all PAC-to-PAC and CCM transfers).
 *
 * This is the "follow the money" half of the political-alpha play. Joins:
 *   - candidate_id → fec_candidates collection (FEC profile) and via
 *     name-match → legislators (bioguide_id) for trade/vote/committee
 *     cross-source queries.
 *   - recipient_committee_id → fec_committees collection (committee
 *     designation, type, party affiliation).
 *   - contributor_employer (substring) → cross-reference with
 *     lobbying_filings registrants / clients to spot lobbyist donors.
 *
 * Scope notes for v1A:
 *   - Default ingestion minimum: $1,000+ contributions (signal-rich;
 *     filters out payroll-deduction memos that dominate raw volume).
 *   - Cycle scope: 2026 (current). Backfilling 2024/2022 requires
 *     explicit cycle filter.
 *   - contribution_receipt_date can be null on memo / subtotal rows;
 *     agents using since/until filters should be aware.
 */
export interface FecContribution {
  /** FEC's globally unique row ID (sub_id from API). Primary key. */
  sub_id: string;
  /** Dollar amount of the contribution. */
  contribution_receipt_amount: number;
  /** ISO date the contribution was received. PRIMARY (indexed/queried) date —
   *  year-corrected when the filer typed an implausibly-future year (see
   *  contribution_receipt_date_source for the verbatim original). */
  contribution_receipt_date: string;
  /** Verbatim source value, set ONLY when contribution_receipt_date was
   *  year-corrected (filer typo). Null/absent otherwise. */
  contribution_receipt_date_source?: string | null;
  /** True when KeyVex corrected an implausibly-future year via a corroborating field. */
  date_corrected?: boolean;
  /** Which corroborating field justified the correction (e.g. "report_year"). */
  date_correction_basis?: string | null;
  /** FEC-assigned ID if the contributor is a committee (rare for SchA). */
  contributor_id: string;
  /** Filer-provided full name (typically "LAST, FIRST" for individuals). */
  contributor_name: string;
  contributor_first_name: string;
  contributor_last_name: string;
  /** Employer string (free-text; not normalized — see Hard Lessons). */
  contributor_employer: string;
  /** Occupation string (free-text). */
  contributor_occupation: string;
  contributor_city: string;
  /** 2-letter state code. */
  contributor_state: string;
  contributor_zip: string;
  /** Entity type code: IND (individual), COM (committee), CCM (candidate committee), PAC, PTY, CAN, ORG, UNK. */
  entity_type: string;
  entity_type_desc: string;
  /** Recipient (the committee that received the money). FK → fec_committees. */
  recipient_committee_id: string;
  recipient_committee_name: string;
  recipient_committee_type: string;
  recipient_committee_org_type: string;
  /** Designation code on recipient: P (Principal), A (Authorized), B (Lobbyist), D (Leadership PAC), J (Joint), U (Unauthorized). */
  recipient_committee_designation: string;
  /** Candidate the recipient committee supports (when committee is candidate-tied). FK → fec_candidates. */
  candidate_id: string;
  candidate_name: string;
  /** Office sought by the candidate: H/S/P. */
  candidate_office: string;
  candidate_office_state: string;
  candidate_office_district: string;
  /** Election cycle (2-year period; e.g. 2026 = 2025+2026). */
  two_year_transaction_period: number | null;
  /** Election type: P (Primary), G (General), R (Runoff), S (Special), C (Convention), O (Other). */
  election_type: string;
  /** Receipt type code; FEC schema-specific. */
  receipt_type: string;
  receipt_type_desc: string;
  /** Report type (M1-M12 monthly, Q1-Q3 quarterly, YE year-end, etc.). */
  report_type: string;
  report_year: number | null;
  file_number: number | null;
  transaction_id: string;
  /** FEC image number — links to the original filing scan. */
  image_number: string;
  /** Direct PDF URL on docquery.fec.gov. */
  pdf_url: string;
  /** Memo text (free-text comments from the filer). */
  memo_text: string;
  memo_code: string;
  /** True when this row is a memo subtotal (not a real new contribution). */
  memoed_subtotal: boolean;
  /** True when the contributor is an individual (entity_type = IND). */
  is_individual: boolean;
  /** Contributor's year-to-date cumulative giving to this committee. */
  contributor_aggregate_ytd: number | null;
  /** Date FEC loaded the row into their warehouse (NOT contribution date). */
  load_date: string;
  /** "A" = amended record; "N" = new (or null). */
  amendment_indicator: string;
  /** Filing form code (F3, F3X, F3P, F24, etc.). */
  filing_form: string;
  /** Provenance URL — agents can verify against the source. */
  source_url: string;
  /** When KeyVex scraped this record (ISO 8601). */
  scraped_at: string;
}

export interface FecContributionQuery {
  /** Direct doc lookup by FEC sub_id (fastest). */
  sub_id?: string;
  /** Filter by recipient committee. */
  recipient_committee_id?: string;
  /** Filter by candidate the recipient committee supports. */
  candidate_id?: string;
  /** Case-insensitive substring on contributor_name. */
  contributor_name?: string;
  /** Case-insensitive substring on contributor_employer. */
  contributor_employer?: string;
  /** Exact 2-letter state code. */
  contributor_state?: string;
  /** Entity type code (IND, COM, PAC, etc.). */
  entity_type?: string;
  /** Inclusive lower bound on contribution_receipt_amount. */
  min_amount?: number;
  /** Inclusive upper bound on contribution_receipt_amount. */
  max_amount?: number;
  /** Inclusive lower bound on contribution_receipt_date (YYYY-MM-DD). */
  since?: string;
  /** Inclusive upper bound on contribution_receipt_date (YYYY-MM-DD). */
  until?: string;
  /** Election cycle year (2026, 2024, 2022). */
  cycle?: number;
  /** Skip rows flagged as memo subtotals (FEC's noise rows). Default false. */
  exclude_memos?: boolean;
  sort_by?: "contribution_receipt_date" | "contribution_receipt_amount";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── FEC Schedule E — Independent Expenditures (v1A) ───────────────────────

/**
 * One Schedule E independent expenditure. Money spent BY a super PAC or
 * IE-only committee uncoordinatedly FOR or AGAINST a federal candidate
 * (the hallmark vehicle for political ad warfare since Citizens United).
 *
 * Distinct from Schedule A (money flowing INTO a committee). Same FEC
 * cursor-pagination quirks. F24 (24-hour notices within 20 days of an
 * election) and F5 (quarterly IE reports) both flow through schedule_e.
 *
 * Critical signal: support_oppose_indicator — "S" = support, "O" = oppose.
 * A single candidate can have dozens of S and O entries from different
 * super PACs across one cycle.
 */
export interface FecIndependentExpenditure {
  /** FEC's globally unique sub_id. Primary key. */
  sub_id: string;
  /** Committee that made the expenditure (super PAC / IE-only PAC). */
  committee_id: string;
  committee_name: string;
  committee_type: string;
  committee_designation: string;
  /** Target candidate (the politician being supported or opposed). */
  candidate_id: string;
  candidate_name: string;
  candidate_office: string;
  candidate_office_state: string;
  candidate_office_district: string;
  candidate_party: string;
  /** "S" = support, "O" = oppose. Empty when missing on row. */
  support_oppose_indicator: string;
  expenditure_amount: number;
  /** Date the expenditure was made (YYYY-MM-DD). PRIMARY (indexed/queried) date —
   *  year-corrected when the filer typed an implausibly-future year, using
   *  dissemination_date/report_year as the corroborator (see
   *  expenditure_date_source for the verbatim original). */
  expenditure_date: string;
  /** Verbatim source value, set ONLY when expenditure_date was year-corrected
   *  (filer typo). Null/absent otherwise. */
  expenditure_date_source?: string | null;
  /** True when KeyVex corrected an implausibly-future year via a corroborating field. */
  date_corrected?: boolean;
  /** Which corroborating field justified the correction (e.g. "dissemination_date"). */
  date_correction_basis?: string | null;
  /** Date the ad / mailer / phone bank was disseminated to the public. */
  dissemination_date: string;
  /** Free-text description of what the money was spent on. */
  disbursement_description: string;
  /** FEC category code (e.g., "001" = Media). */
  category_code: string;
  category_code_full: string;
  /** Vendor / contractor that received the payment (ad agency, media buyer, etc.). */
  payee_name: string;
  payee_city: string;
  payee_state: string;
  payee_zip: string;
  election_type: string;
  report_type: string;
  report_year: number | null;
  file_number: number | null;
  transaction_id: string;
  image_number: string;
  /** Filing form: F24 (24-hour notice) or F5 (quarterly). */
  filing_form: string;
  memoed_subtotal: boolean;
  amendment_indicator: string;
  two_year_transaction_period: number | null;
  source_url: string;
  scraped_at: string;
}

export interface FecIndependentExpenditureQuery {
  sub_id?: string;
  committee_id?: string;
  candidate_id?: string;
  /** "S" = support only, "O" = oppose only. */
  support_oppose?: "S" | "O";
  /** Substring on payee_name. */
  payee_name?: string;
  /** Substring on disbursement_description. */
  description?: string;
  candidate_office?: string;
  candidate_office_state?: string;
  min_amount?: number;
  max_amount?: number;
  since?: string;
  until?: string;
  cycle?: number;
  exclude_memos?: boolean;
  sort_by?: "expenditure_date" | "expenditure_amount";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── DEF 14A Proxy filings (v1A: metadata-only) ────────────────────────────

/**
 * One Schedule 14A proxy filing. Captures the SEC's "Definitive Proxy
 * Statement" family — DEF 14A (annual proxy), DEFA14A (additional materials),
 * DEFM14A (merger-related proxy), DEFR14A (revised). The proxy is the
 * document a company sends shareholders ahead of an annual meeting,
 * carrying executive compensation tables, board nominations, shareholder
 * proposals, auditor info, and voting matters.
 *
 * v1A scope is metadata-only — same posture as 8-K v1A. The full proxy
 * body is 50-200 pages of HTML tables; extracting it (named exec officers,
 * comp totals, vote outcomes, shareholder proposals) is v1.1 territory.
 *
 * Agents follow primary_document_url for the body. Filing type, merger
 * flag, amendment flag, period-of-report are all surfaced in metadata.
 */
export interface ProxyFiling {
  id: string;
  ticker: string;
  company_name: string | null;
  company_cik: string;
  accession_number: string;
  filing_type: "DEF 14A" | "DEFA14A" | "DEFM14A" | "DEFR14A";
  filing_date: string;
  period_of_report: string;
  is_merger_related: boolean;
  is_amendment: boolean;
  is_additional_materials: boolean;
  primary_document_url: string;
  sec_filing_url: string;
  data_source: "SEC_EDGAR_DEF14A";
  scraped_at: string;
}

export interface ProxyFilingsQuery {
  ticker?: string;
  company_cik?: string;
  filing_type?: "DEF 14A" | "DEFA14A" | "DEFM14A" | "DEFR14A";
  is_merger_related?: boolean;
  is_amendment?: boolean;
  since?: string;
  until?: string;
  sort_by?: "filing_date" | "period_of_report";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── XBRL Fundamentals (SEC EDGAR companyfacts) ───────────────────────────

/**
 * One observation of one XBRL-tagged financial concept for one company at
 * one period end. Pulled from SEC EDGAR's company-facts API
 * (data.sec.gov/api/xbrl/companyfacts/CIK<id>.json).
 *
 * Each 10-K and 10-Q filing tags its line items with concepts from the
 * US GAAP taxonomy. KeyVex captures a curated subset (~40 concepts) that
 * map to a standard income statement / balance sheet / cash flow set.
 *
 * Pairs naturally with get_material_events (8-K announcements about
 * specific line items), get_proxy_filings (exec comp tied to financial
 * performance), and get_insider_transactions (insiders trading ahead of
 * a quarterly print).
 *
 * v1A scope: curated concepts only, S&P 500 + Russell 1000 universe.
 * Full XBRL coverage (every concept, every public company) is v1.1.
 *
 * Pure-publisher posture: we surface the values as filed. We do NOT
 * compute derived ratios (P/E, ROE, etc.) or trend metrics — agents
 * compute those on top.
 */
export interface XbrlFundamental {
  /** Composite key: "{cik}-{concept}-{period_end}-{form}". */
  id: string;
  ticker: string;
  company_name: string;
  company_cik: string;
  /** Taxonomy: "us-gaap" (financial) or "dei" (document/entity info). */
  concept_taxonomy: string;
  /** XBRL tag name (e.g., "Revenues", "NetIncomeLoss", "Assets"). */
  concept: string;
  /** Human-readable label from the XBRL taxonomy. */
  concept_label: string;
  /** KeyVex bucket: income_statement | balance_sheet | cash_flow | metrics | entity. */
  category: string;
  /** ISO YYYY-MM-DD. Period end (always populated). */
  period_end: string;
  /** ISO YYYY-MM-DD. Period start (income statement + cash flow concepts; null for point-in-time balance sheet). */
  period_start: string | null;
  fiscal_year: number;
  /** "Q1" | "Q2" | "Q3" | "Q4" | "FY". */
  fiscal_period: string;
  /** "10-K" | "10-Q" | "10-K/A" | "10-Q/A". */
  form: string;
  filed_date: string;
  accession_number: string;
  /** Numeric value as reported. */
  value: number;
  /** Unit string: "USD" | "shares" | "USD/shares" | "pure" | "percent" | etc. */
  unit: string;
  /** Optional reporting frame (e.g., "CY2024Q3", "CY2024"). Used for cross-company comparison. */
  frame: string;
  /** Public EDGAR filing URL. */
  sec_source_url: string;
  scraped_at: string;
}

export interface XbrlFundamentalsQuery {
  ticker?: string;
  company_cik?: string;
  concept?: string;
  category?: string;
  fiscal_year?: number;
  fiscal_period?: string;
  form?: string;
  since?: string;
  until?: string;
  /** When true, return only the most-recent observation per (ticker, concept). */
  latest_only?: boolean;
  sort_by?: "period_end" | "filed_date" | "value";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── CFPB Consumer Complaints ──────────────────────────────────────────────

/**
 * One consumer complaint filed with the Consumer Financial Protection Bureau.
 * The CFPB receives ~10K complaints/day across banks, credit reporting,
 * mortgage servicers, debt collectors, fintech, and crypto. Each record is
 * one filing with disposition info (company response, timely-flag, dispute).
 *
 * v1A scope: rolling window (most-recent N records on daily cron). The full
 * historical dataset is 5M+ rows; v1A doesn't ingest history but agents can
 * follow `cfpb_source_url` for the underlying record.
 *
 * Pairs naturally with get_enforcement_actions (CFPB complaints often
 * precede CFPB/OCC/FDIC enforcement actions against the same company) and
 * with get_oig_exclusions for compliance/risk profiling.
 */
export interface ConsumerComplaint {
  /** CFPB-assigned complaint_id (stable across re-scrapes). */
  id: string;
  product: string;
  sub_product: string;
  issue: string;
  sub_issue: string;
  /** Financial-institution name as filed. */
  company: string;
  /** CFPB-categorized response status (e.g., "Closed with explanation"). */
  company_response: string;
  /** Optional public response statement from the company. */
  company_public_response: string;
  /** Whether the company responded within CFPB's 15-day timeline. */
  timely_response: boolean;
  state: string;
  zip_code: string;
  /** "Web" | "Phone" | "Postal mail" | "Fax" | "Referral" | "Email". */
  submitted_via: string;
  /** ISO YYYY-MM-DD. */
  date_received: string;
  /** ISO YYYY-MM-DD. Date the complaint reached the company. */
  date_sent_to_company: string;
  /** Consumer dispute status. Field is mostly "N/A" since CFPB stopped collecting in 2017. */
  consumer_disputed: string;
  /** Consumer narrative (when consent given). Often empty. */
  complaint_narrative: string;
  tags: string[];
  /** Public CFPB search-result URL for this complaint. */
  cfpb_source_url: string;
  scraped_at: string;
}

export interface ConsumerComplaintsQuery {
  id?: string;
  company?: string;
  product?: string;
  sub_product?: string;
  issue?: string;
  state?: string;
  submitted_via?: string;
  timely_response?: boolean;
  since?: string;
  until?: string;
  sort_by?: "date_received" | "date_sent_to_company";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── HHS-OIG Exclusions (federal healthcare excluded entities) ────────────

/**
 * One entry on the HHS Office of Inspector General "List of Excluded
 * Individuals/Entities" (LEIE). Anyone on this list is barred from billing
 * Medicare, Medicaid, or any federal healthcare program. Updated monthly
 * by OIG; we re-scrape monthly and overwrite.
 *
 * Pairs naturally with get_federal_contracts (don't trust a contractor on
 * this list) and any healthcare-sector research.
 *
 * Pure-publisher posture: we surface the listing as-published. Agents
 * decide whether a match is contextually meaningful (different person
 * with same name, expired/reinstated, etc.).
 */
export interface OigExclusion {
  id: string;
  last_name: string;
  first_name: string;
  middle_name: string;
  business_name: string;
  /** Computed display name — business_name for entities, "First Middle Last" otherwise. */
  full_name: string;
  /** True when the row represents a business entity (business_name populated). */
  is_business: boolean;
  general_category: string;
  specialty: string;
  /** UPIN (legacy provider ID). May be "0000000000" / empty. */
  upin: string;
  /** NPI (National Provider Identifier). May be "0000000000" / empty. */
  npi: string;
  date_of_birth: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  /** Statutory exclusion code (e.g., "1128a1", "1128b5"). Each prefix maps
   *  to a specific section of 42 USC § 1320a-7 / 7a / 7b. */
  exclusion_type: string;
  /** Date excluded. ISO YYYY-MM-DD. */
  exclusion_date: string;
  /** Date reinstated. Null when never reinstated (raw OIG sentinel "00000000"). */
  reinstatement_date: string | null;
  waiver_date: string | null;
  waiver_state: string;
  oig_source_url: string;
  scraped_at: string;
}

export interface OigExclusionsQuery {
  name?: string;
  business_name?: string;
  state?: string;
  city?: string;
  general_category?: string;
  specialty?: string;
  exclusion_type?: string;
  npi?: string;
  is_business?: boolean;
  /** When true, filter to entries that have been reinstated. Default: all. */
  is_reinstated?: boolean;
  since?: string;
  until?: string;
  sort_by?: "exclusion_date" | "reinstatement_date";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Economic Indicators (BLS, v1A) ────────────────────────────────────────

/**
 * One observation of one economic series. Pulled from BLS public API
 * (api.bls.gov/publicAPI/v2). Schema is generic enough to extend to FRED
 * and BEA later — same shape, different source.
 *
 * v1A scope: BLS monthly + quarterly series, curated watchlist of ~20
 * high-signal indicators (unemployment, payrolls, CPI, PPI, wages,
 * productivity). Each (series_id, period) is one record.
 */
export interface EconomicIndicator {
  /** Composite key: "{series_id}-{period}" (e.g., "LNS14000000-2026M04"). */
  id: string;
  /** Issuing agency. "bls" = Bureau of Labor Statistics. "fred" = Federal
   *  Reserve Economic Data (St. Louis Fed, republishes + adds many other
   *  series from Fed/BEA/Treasury/private sources). "eia" = Energy Information
   *  Administration (oil, natural gas, gasoline, electricity prices + output). */
  source: "bls" | "fred" | "eia";
  series_id: string;
  series_name: string;
  /** Coarse bucket: "employment" | "wages" | "inflation" | "productivity" | "hours" | "labor-force". */
  category: string;
  /** Period label in BLS's native shape: "2026M04" (monthly), "2026Q01" (quarterly), "2026A01" (annual). */
  period: string;
  /** "monthly" | "quarterly" | "semiannual" | "annual" | "weekly" | "daily". */
  period_type: string;
  /** Calendar year, integer. */
  year: number;
  /** Numeric value of the observation. Null when BLS reports "-" (unavailable). */
  value: number | null;
  /** Unit string ("percent" | "thousands" | "index 1982-84=100" | "dollars" | "ratio"). */
  unit: string;
  /** Series description text from BLS metadata. */
  series_description: string;
  /** Joined BLS footnote codes + text (e.g., "P=preliminary; 9=data unavailable due to..."). */
  notes: string;
  /** Public series page (BLS data.bls.gov/timeseries/... or FRED fred.stlouisfed.org/series/...). */
  source_url: string;
  /** When KeyVex scraped this. */
  scraped_at: string;
}

export interface EconomicIndicatorsQuery {
  source?: "bls" | "fred" | "eia";
  series_id?: string;
  category?: string;
  period_type?: "monthly" | "quarterly" | "semiannual" | "annual" | "weekly" | "daily";
  since_year?: number;
  until_year?: number;
  /** When true, only return the most-recent observation per series. */
  latest_only?: boolean;
  sort_by?: "period" | "value" | "year";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Government Publications (api.govinfo.gov) ────────────────────────────

/**
 * One package from the GovInfo API — a unified record covering four
 * legislative + oversight document classes that pair naturally with
 * congressional trades, lobbying, and enforcement signals:
 *
 *   "CRPT"       — Congressional Reports (committee reports on legislation,
 *                  investigations, oversight). Strong "what's coming next"
 *                  signal — committees draft + amend bills.
 *   "PLAW"       — Public Laws (signed bills that became law). The "what
 *                  actually got done" signal.
 *   "CHRG"       — Congressional Hearings (transcripts, testimony). Real-
 *                  time signal on what regulators / executives are being
 *                  asked under oath.
 *   "GAOREPORTS" — GAO reports (independent congressional oversight).
 *                  Routes around gao.gov's WAF block by reading the same
 *                  reports through GovInfo's API.
 *
 * Full text of each document lives at `package_link`. KeyVex v1A captures
 * metadata only (title, date, congress, doc class) — agents follow the
 * link for body content. Pure-publisher posture: no derived summaries.
 */
export interface GovDocument {
  /** GovInfo packageId — globally unique across collections. */
  id: string;
  collection: "CRPT" | "PLAW" | "CHRG" | "GAOREPORTS";
  /** Human-readable collection label ("Congressional Report", etc.). */
  collection_name: string;
  /** Same as id. Duplicated for explicit field naming. */
  package_id: string;
  /**
   * Sub-class within collection (e.g., "hrpt" House report, "srpt" Senate
   * report, "pub" public law, "pvt" private law, "hr" House hearing).
   * Empty when GovInfo doesn't return it.
   */
  doc_class: string;
  /** Congress number as string (e.g., "119"). May be null for non-legislative. */
  congress: string | null;
  /** Date issued (YYYY-MM-DD). */
  date_issued: string;
  /** Full ISO datetime of last modification at GovInfo. */
  last_modified: string;
  /** Document title as published. */
  title: string;
  /** GovInfo package metadata URL (api.govinfo.gov/packages/...). */
  source_url: string;
  /** Same URL as source_url, broken out for the package-link convention. */
  package_link: string;
  /** When KeyVex scraped this record. */
  scraped_at: string;
}

export interface GovDocumentsQuery {
  package_id?: string;
  collection?: "CRPT" | "PLAW" | "CHRG" | "GAOREPORTS";
  doc_class?: string;
  congress?: string;
  /** Case-insensitive substring against title. */
  title?: string;
  /** date_issued lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** date_issued upper bound. */
  until?: string;
  sort_by?: "date_issued" | "last_modified";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── FARA — Foreign Agents Registration Act (efile.fara.gov) ──────────────

/**
 * One registrant ↔ foreign-principal relationship from the FARA database.
 * FARA requires anyone in the US acting as an agent of a foreign principal
 * (government, party, company, or person) to register with the DOJ and
 * disclose the relationship.
 *
 * One ForeignAgent record = one (registrant, foreign principal) pair. A
 * registrant representing three foreign principals produces three records;
 * a registrant with no currently-active foreign principal produces one
 * record with the foreign-principal fields null and has_foreign_principal
 * false (so the registrant is still queryable).
 *
 * The marquee signal is `foreign_principal_country` — "which US agents are
 * registered to act for Chinese / Russian / Saudi principals." Pairs with
 * get_lobbying_filings (LDA — domestic lobbying), get_fec_contributions,
 * and get_congressional_trades for the full foreign-influence picture.
 *
 * Source: efile.fara.gov FARA API. The list endpoint for foreign principals
 * is unreliable, so the scraper pulls the Registrants list and then queries
 * each registration number's foreign principals individually.
 */
export interface ForeignAgent {
  /** `fara-{registration_number}-{fpIndex}`, or `fara-{n}-none` when the
   *  registrant has no active foreign principal. */
  id: string;
  /** FARA registration number (string for ID-safety; numeric in source). */
  registration_number: string;
  /** US-based registrant — the agent (person or firm). */
  registrant_name: string;
  /** Date the registrant registered under FARA (YYYY-MM-DD). */
  registration_date: string;
  registrant_address: string | null;
  registrant_city: string | null;
  registrant_state: string | null;
  registrant_zip: string | null;
  /** v1A scrapes the Active set. "active" | "terminated". */
  status: string;
  /** True when this record carries a foreign-principal relationship. */
  has_foreign_principal: boolean;
  /** Foreign principal the registrant acts for. Null when none active. */
  foreign_principal_name: string | null;
  /** Country of the foreign principal — the key influence signal. */
  foreign_principal_country: string | null;
  /** Date this foreign-principal relationship was registered (YYYY-MM-DD). */
  foreign_principal_reg_date: string | null;
  foreign_principal_address: string | null;
  foreign_principal_city: string | null;
  foreign_principal_state: string | null;
  /** FARA eFile quick-search URL for this registrant. */
  source_url: string;
  scraped_at: string;
}

export interface ForeignAgentsQuery {
  registration_number?: string;
  /** Case-insensitive substring against registrant_name. */
  registrant_name?: string;
  /** Case-insensitive substring against foreign_principal_name. */
  foreign_principal_name?: string;
  /** Exact match on foreign_principal_country (uppercase, e.g. "CHINA"). */
  foreign_principal_country?: string;
  /** Filter to records that do (true) / don't (false) carry a foreign principal. */
  has_foreign_principal?: boolean;
  /** registration_date lower bound (YYYY-MM-DD inclusive). */
  since?: string;
  /** registration_date upper bound. */
  until?: string;
  sort_by?: "registration_date" | "foreign_principal_reg_date";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── Consolidated Screening List (api.trade.gov) ──────────────────────────

/**
 * One entry on the US Consolidated Screening List — the unified feed of
 * twelve export-screening lists maintained by the Departments of Commerce,
 * State, and Treasury. US persons must screen counterparties against these
 * lists before exporting; an entity on any of them is a hard compliance
 * flag.
 *
 * The CSL is broader than OFAC's SDN list (which KeyVex also exposes via
 * get_ofac_sdn). The SDN list is one of the twelve sources here; the CSL
 * adds the BIS Entity List, Denied Persons, Military End User, Unverified
 * List, the State Department debarred / nonproliferation lists, and several
 * non-SDN Treasury lists. `source` / `source_short` disambiguate.
 *
 * Pairs with get_federal_contracts + get_ofac_sdn for trade-compliance
 * screening, and with get_foreign_agents for the foreign-entity overlay.
 */
export interface ScreeningListEntry {
  /** `csl-{source_short}-{source_id}` — unique across all twelve lists. */
  id: string;
  /** Raw id from the CSL feed. */
  source_id: string;
  /** Entity / case number from the originating list, when present. */
  entity_number: string | null;
  /** Primary listed name. */
  name: string;
  /** Alternate names / aliases. */
  alt_names: string[];
  /** "Entity" | "Individual" | "Vessel" | "Aircraft" | null. */
  type: string | null;
  /** Full source-list name (e.g. "Entity List (EL) - Bureau of Industry..."). */
  source: string;
  /** Short list code: SDN, EL, DPL, MEU, UVL, CMIC, CAP, DTC, ISN, MBS, PLC, SSI. */
  source_short: string;
  /** Sanctions / control programs the entry falls under. */
  programs: string[];
  /** Free-text remarks from the source list. */
  remarks: string | null;
  /** Distinct ISO country codes across all of the entry's addresses. */
  countries: string[];
  /** Full address list. */
  addresses: Array<{
    address: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  }>;
  /** Identification documents (passport, tax ID, SWIFT/BIC, etc.). */
  ids: Array<{ type: string | null; number: string | null }>;
  /** Individual-only: title / role. */
  title: string | null;
  /** Individual-only: nationalities. */
  nationalities: string[];
  /** URL to the source list. */
  source_list_url: string;
  /** URL to background information on the source list. */
  source_information_url: string;
  scraped_at: string;
}

export interface ScreeningListQuery {
  /** Case-insensitive substring against name + alt_names. */
  name?: string;
  /** Short list code (SDN, EL, DPL, MEU, UVL, CMIC, CAP, DTC, ISN, MBS, PLC, SSI). */
  source_short?: string;
  /** "Entity" | "Individual" | "Vessel" | "Aircraft". */
  type?: string;
  /** ISO-2 country code — matches against the entry's countries array. */
  country?: string;
  /** Case-insensitive substring against the programs list. */
  program?: string;
  sort_by?: "name";
  sort_order?: "asc" | "desc";
  limit?: number;
}

// ─── Treasury Auctions (api.fiscaldata.treasury.gov) ──────────────────────

/**
 * One Treasury security auction — Bills (≤1yr), Notes (2-10yr), Bonds (20-30yr),
 * TIPS (inflation-protected), or FRN (floating-rate notes). Pulled from
 * api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query.
 *
 * Key demand signal: bid_to_cover_ratio (tendered / accepted). Numbers above
 * 2.5 typically signal strong demand; below 2.0 weak. SOMA holdings show
 * the Federal Reserve's System Open Market Account allocation — a directly
 * observable measure of QE/QT activity on each issue.
 *
 * Pre-auction records exist (announcement-only — yields/ratios still null).
 * Post-auction the same record is updated with results. Idempotent saves
 * keyed by CUSIP + auction_date handle the two-stage lifecycle cleanly.
 */
export interface TreasuryAuction {
  id: string;
  cusip: string;
  security_type: string;
  security_term: string;
  auction_date: string;
  issue_date: string;
  maturity_date: string;
  announcement_date: string;
  offering_amount: number;
  total_tendered: number | null;
  total_accepted: number | null;
  bid_to_cover_ratio: number | null;
  high_yield: number | null;
  low_yield: number | null;
  average_yield: number | null;
  high_discount_rate: number | null;
  low_discount_rate: number | null;
  average_discount_rate: number | null;
  high_investment_rate: number | null;
  low_investment_rate: number | null;
  average_investment_rate: number | null;
  high_price: number | null;
  low_price: number | null;
  average_price: number | null;
  competitive_tendered: number | null;
  competitive_accepted: number | null;
  noncompetitive_accepted: number | null;
  primary_dealer_tendered: number | null;
  primary_dealer_accepted: number | null;
  direct_bidder_tendered: number | null;
  direct_bidder_accepted: number | null;
  indirect_bidder_tendered: number | null;
  indirect_bidder_accepted: number | null;
  soma_tendered: number | null;
  soma_accepted: number | null;
  soma_holdings: number | null;
  soma_included: boolean;
  fima_included: boolean;
  treas_retail_accepted: number | null;
  reopening: boolean;
  callable: boolean;
  inflation_indexed: boolean;
  auction_format: string;
  interest_rate: number | null;
  pdf_announcement_url: string | null;
  pdf_competitive_results_url: string | null;
  pdf_noncompetitive_results_url: string | null;
  treasury_source_url: string;
  scraped_at: string;
}

export interface TreasuryAuctionsQuery {
  cusip?: string;
  security_type?: string;
  since?: string;
  until?: string;
  min_offering_amount?: number;
  min_bid_to_cover?: number;
  reopening?: boolean;
  sort_by?: "auction_date" | "issue_date" | "maturity_date" | "offering_amount" | "bid_to_cover_ratio";
  sort_order?: "desc" | "asc";
  limit?: number;
}

// ─── Unified search ────────────────────────────────────────────────────────

/**
 * Identifier-driven cross-collection fan-out search. The agent passes a
 * single entity identifier (ticker, bioguide_id, company_cik, or
 * recipient_uei) and the tool queries every collection where that field
 * is indexed, returning results grouped by source. Replaces 6-10 tool
 * calls for the "tell me everything about X" question.
 *
 * Per-source results are capped via `per_source_limit` (default 5).
 * One slow collection doesn't block the rest — fan-out uses Promise.allSettled
 * so failures or timeouts on one source degrade gracefully.
 */
export interface UnifiedSearchQuery {
  ticker?: string;
  bioguide_id?: string;
  company_cik?: string;
  recipient_uei?: string;
  /**
   * Issuer name (e.g., "Lockheed Martin", "Wells Fargo"). When set, the
   * unified search resolves it against EDGAR's company catalog to populate
   * ticker + company_cik (if those aren't already supplied) AND fans out to
   * name-keyed collections that don't carry tickers (federal_contracts,
   * lobbying_filings, enforcement_actions, product_recalls, consumer_complaints).
   */
  company_name?: string;
  /**
   * CUSIP (9-character security identifier). Fans out to collections that
   * index by CUSIP: institutional_holdings, activist_ownership, nport_holdings,
   * treasury_auctions.
   */
  cusip?: string;
  since?: string;
  until?: string;
  per_source_limit?: number;
  /** Optional whitelist of source names. Default: all collections that
   *  index the provided identifier(s). */
  sources?: string[];
}

/**
 * Per-source result block in a UnifiedSearchEnvelope. `error` is set
 * when a collection's query threw or timed out — agents can decide
 * whether to retry that source directly or proceed with what landed.
 *
 * `coverage_warning` is propagated up from the underlying per-collection
 * query (same string the standalone source tool would return). It fires
 * when a slice comes back empty (or truncated) while a date filter was
 * active and the requested window falls outside the collection's actual
 * coverage — preventing the silent-empty-equals-no-data misread for
 * rolling-window sources (federal_contracts, consumer_complaints,
 * product_recalls, enforcement_actions, etc.).
 */
export interface UnifiedSearchSourceBlock {
  count: number;
  has_more: boolean;
  results: unknown[];
  error?: string;
  coverage_warning?: string;
}

export interface UnifiedSearchEnvelope {
  query: UnifiedSearchQuery;
  results_by_source: Record<string, UnifiedSearchSourceBlock>;
  total_count: number;
  sources_queried: string[];
  sources_with_results: string[];
}

// ─── SEC Bulk Insider Dataset v2 (Forms 3/4/5 quarterly TSV bundles) ──────
//
// Loaded from https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/YYYYqN_form345.zip
// Three collections: insider_transactions_v2, insider_holdings_v2, insider_filings_v2.
//
// Era boundary (verified Gate 1 + Gate 1.5 via inspect-form345-bulk.ts on
// 2008q1 / 2018q1 / 2022q4 / 2023q1):
//   pre_2023  = 2006q1 → 2022q4  (AFF10B5ONE column did NOT exist)
//   2023_plus = 2023q1 → present (AFF10B5ONE column added — matches SEC
//                                 Rule 10b5-1 amendment compliance date
//                                 of April 1, 2023)
//
// Per Greg's Gate 4 spec: pre-2023 records get aff10b5one = "NOT_TRACKED"
// — NEVER bare null — so agents can distinguish "field didn't exist in this
// era" from "field present but null/zero."
//
// Footnote inlining (per Greg's Gate 2 answer #3): each *_FN reference column
// is resolved against the FOOTNOTES table at load time, and the resolved text
// is inlined into footnote_refs[] on the row itself. A single Firestore read
// returns the transaction AND its caveats — no second lookup required.

export type SchemaEra = "pre_2023" | "2023_plus";

// ─── Phase A: Data-Integrity Engine vocabulary (2026-05-24) ────────────────
//
// One fixed vocabulary across every storage shape + the wire shim. NO variants,
// NO alternates. Source of truth: docs/architecture-data-integrity.md.
//
// Per Greg's gate rule: "Stop all confident false assertions immediately. If
// a pipeline lacks the historical context or parsing completeness to prove a
// calculation, it must emit an explicit uncertainty state."

/**
 * What KIND of insider/legislator event a row represents.
 *
 * Distinguishes open-market trades from compensation events from non-trade
 * transfers so naive "how much did X sell" queries can't silently count
 * gifts/grants as sales. Always exactly one of the four enum values — never
 * bare null, never invented variants.
 *
 * Derivation rules (locked 2026-05-24 against SEC 1474 (03-26),
 *                   OMB 3235-0287, page 11-12):
 *   - Form 4 / Form 5: deriveTransactionNature(trans_code). NEVER reads
 *     the acquired/disposed flag — only the trans_code XML node value.
 *   - Congressional PTRs: deriveCongressionalNature(comment) — separate
 *     code path that regexes the comment field for charitable/gift/donation
 *     language. No trans_code field exists for congressional.
 */
export type TransactionNature =
  | "OPEN_MARKET"               // Codes P, S (open-market or private trades)
  | "EQUITY_COMP"               // Codes A, M, I (Rule 16b-3 comp) + C, X, O
                                //   (derivative exercises/conversions — typically
                                //    comp-granted in insider context; see C/X/O
                                //    note in shim module)
  | "NON_OPEN_MARKET_TRANSFER"  // Codes D, F, G, W, Z, U + congressional
                                //   contribution/gift/donation language
  | "INSUFFICIENT_DATA";        // Codes V, E, H, L, J, K (standalone),
                                //   null, empty, unrecognized, or congressional
                                //   with no transaction_type signal

/**
 * Whether the row has passed its source-specific integrity check at ingestion.
 *
 * For 13F: pass means the parser successfully extracted N holding rows AND
 *   the SEC's `infoTableEntryTotal` field from primary_doc.xml equals N.
 * For Form 4 / Form 5: pass means every transaction line item successfully
 *   resolved its internal relational references (footnote IDs all resolve
 *   to known footnote text — no dangling `(footnote not found)` sentinels).
 * For congressional PTRs: not currently checked at ingestion (Phase A scope
 *   doesn't define a comparable canonical landmark for these); rows arrive
 *   with verification_status undefined.
 *
 * "INSUFFICIENT_DATA" is the explicit honesty signal that downstream
 * computations (position_change deltas in 13F, sell-totals in tools) must
 * RESPECT — withhold synthetic labels rather than fabricate from partial state.
 */
export type VerificationStatus =
  | "VERIFIED"
  | "INSUFFICIENT_DATA";
// Phase B will extend this with "PENDING_HEAL" / "FAILED_PERMANENT" once
// the sync_queue + heal-engine ships. Not in Phase A scope.

/**
 * A resolved footnote reference attached to a specific field on a row.
 * Inlined at load time so agents see human-readable prose instead of cryptic
 * "F11" tokens.
 */
export interface InlineFootnoteRef {
  /** The transaction/holding/filing field this footnote annotates. */
  field: string;
  /** Raw FOOTNOTE_ID from the SEC bulk dataset (e.g. "F1", "F11"). */
  ref: string;
  /** Resolved FOOTNOTE_TXT from the FOOTNOTES table, joined by accession + ref. */
  text: string;
}

/**
 * A reporting owner attached to a filing. Most filings have exactly one;
 * 10%-plus-holder filings + fund-family filings can have several.
 */
export interface BulkReportingOwner {
  cik: string;                          // zero-padded "0001234567"
  name: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  is_other: boolean;
  officer_title: string | null;
  other_relationship_text: string | null;
}

/**
 * One transaction row from the SEC bulk insider dataset's NONDERIV_TRANS or
 * DERIV_TRANS table, joined with its SUBMISSION envelope, all REPORTINGOWNER
 * rows for the filing, and any FOOTNOTES referenced by *_FN columns.
 *
 * Doc ID format: "{accession}-NT-{nonderiv_trans_sk}" or
 *                "{accession}-DT-{deriv_trans_sk}".
 * SK columns are SEC's stable surrogate keys — re-runs hit the same doc IDs,
 * Firestore merges, no duplicates ever.
 */
export interface InsiderTransactionV2 {
  // ─── Provenance + era ─────────────────────────────────────────────────────
  id: string;
  source: "sec_bulk";
  source_zip: string;                   // "2018q1_form345.zip"
  schema_era: SchemaEra;
  bulk_loaded_at: string;               // ISO 8601, when KeyVex wrote this row
  source_url: string;                   // EDGAR archive URL for the accession

  // ─── Filing envelope (from SUBMISSION) ────────────────────────────────────
  accession_number: string;
  filing_date: string;                  // ISO YYYY-MM-DD
  period_of_report: string;             // ISO YYYY-MM-DD
  date_of_orig_sub: string | null;
  document_type: string;                // "3" | "3/A" | "4" | "4/A" | "5" | "5/A"
  /** True for /A amendment filings (Form 4/A, Form 5/A, etc.). */
  is_amendment: boolean;
  company_cik: string;                  // ISSUERCIK — zero-padded
  company_name: string;                 // ISSUERNAME
  ticker: string;                       // ISSUERTRADINGSYMBOL — uppercased
  remarks: string | null;
  no_securities_owned: boolean;
  not_subject_sec16: boolean;
  form3_holdings_reported: boolean;
  form4_trans_reported: boolean;

  // ─── 10b5-1 plan flag (era-gated) ─────────────────────────────────────────
  /**
   * Raw AFF10B5ONE value from SUBMISSION (2023+) or "NOT_TRACKED" for
   * pre-2023 records where the column didn't exist. Never bare null.
   * SEC values: "1" = plan adopted, "0" = no plan, "" = blank/unknown.
   */
  aff10b5one: "1" | "0" | "" | "NOT_TRACKED";

  // ─── Reporting owner (primary, denormalized; full list under reporting_owners) ─
  reporting_owner_cik: string;
  reporting_owner_name: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  is_other: boolean;
  officer_title: string | null;
  other_relationship_text: string | null;
  reporting_owners: BulkReportingOwner[];

  // ─── Transaction row (the discriminator + payload) ────────────────────────
  /** Source table — "nonderiv" for NONDERIV_TRANS, "deriv" for DERIV_TRANS. */
  transaction_type: "nonderiv" | "deriv";
  /** SEC surrogate key for this row (NONDERIV_TRANS_SK or DERIV_TRANS_SK). */
  sk: number;
  security_title: string;               // "Common Stock", "Stock Option (right to buy)"
  transaction_date: string;             // ISO YYYY-MM-DD
  deemed_execution_date: string | null;
  trans_form_type: string;              // "3" | "4" | "5"
  trans_code: string;                   // P, S, A, M, X, C, F, G, D, I, V, etc.
  equity_swap_involved: boolean;
  trans_timeliness: string | null;      // "L" (late), "E" (early), etc.
  trans_shares: number | null;
  trans_price_per_share: number | null;
  /** Present on DERIV_TRANS rows; null on nonderiv (compute from shares × price). */
  trans_total_value: number | null;
  trans_acquired_disp_cd: "A" | "D" | null;
  direct_indirect_ownership: "D" | "I" | null;
  nature_of_ownership: string | null;
  shrs_owned_following_trans: number | null;
  valu_owned_following_trans: number | null;

  // ─── Derivative-only fields (null on nonderiv rows) ───────────────────────
  conv_exercise_price: number | null;
  exercise_date: string | null;
  expiration_date: string | null;
  underlying_security_title: string | null;
  underlying_security_shares: number | null;
  underlying_security_value: number | null;

  // ─── Footnote dereferencing ───────────────────────────────────────────────
  footnote_refs: InlineFootnoteRef[];

  // ─── Phase A: Data-Integrity Engine (2026-05-24) ─────────────────────────
  // transaction_nature is OPTIONAL on InsiderTransactionV2 because Option A
  // backfill = forward-write only. Historical rows (loaded before Phase A)
  // don't carry it in storage; the read shim derives it on-the-fly. Rows
  // ingested AFTER Phase A ship will carry it in Firestore directly.
  transaction_nature?: TransactionNature;
  // verification_status reflects parse-integrity at ingestion. For v2 bulk
  // loads, INSUFFICIENT_DATA iff any footnote ref on the row failed to
  // resolve against the FOOTNOTES table. Absent on historical rows
  // (forward-write only).
  verification_status?: VerificationStatus;
}

/**
 * One holding row from the SEC bulk insider dataset's NONDERIV_HOLDING or
 * DERIV_HOLDING table. No transaction date — position-only snapshot at the
 * time of filing. Same envelope + reporting-owner + footnote denormalization
 * as InsiderTransactionV2.
 *
 * Doc ID format: "{accession}-NH-{nonderiv_holding_sk}" or
 *                "{accession}-DH-{deriv_holding_sk}".
 */
export interface InsiderHoldingV2 {
  id: string;
  source: "sec_bulk";
  source_zip: string;
  schema_era: SchemaEra;
  bulk_loaded_at: string;
  source_url: string;

  // Filing envelope (same as transactions)
  accession_number: string;
  filing_date: string;
  period_of_report: string;
  date_of_orig_sub: string | null;
  document_type: string;
  is_amendment: boolean;
  company_cik: string;
  company_name: string;
  ticker: string;
  remarks: string | null;
  no_securities_owned: boolean;
  not_subject_sec16: boolean;
  form3_holdings_reported: boolean;
  form4_trans_reported: boolean;

  // Era-gated flag
  aff10b5one: "1" | "0" | "" | "NOT_TRACKED";

  // Primary reporting owner (denormalized) + full list
  reporting_owner_cik: string;
  reporting_owner_name: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  is_other: boolean;
  officer_title: string | null;
  other_relationship_text: string | null;
  reporting_owners: BulkReportingOwner[];

  // Holding row
  /** "nonderiv" for NONDERIV_HOLDING, "deriv" for DERIV_HOLDING. */
  holding_type: "nonderiv" | "deriv";
  sk: number;
  security_title: string;
  /** TRANS_FORM_TYPE on the HOLDING row — null when not annotated. */
  trans_form_type: string | null;
  shrs_owned_following_trans: number | null;
  valu_owned_following_trans: number | null;
  direct_indirect_ownership: "D" | "I" | null;
  nature_of_ownership: string | null;

  // Derivative-only
  conv_exercise_price: number | null;
  exercise_date: string | null;
  expiration_date: string | null;
  underlying_security_title: string | null;
  underlying_security_shares: number | null;
  underlying_security_value: number | null;

  footnote_refs: InlineFootnoteRef[];
}

/**
 * One filing-level envelope row from the SEC bulk insider dataset's
 * SUBMISSION table. Carries the SUBMISSION envelope, ALL reporting owners as
 * an array, and OWNER_SIGNATURE rows (signer name + date).
 *
 * Doc ID format: "{accession_number}" (accessions are already path-safe and
 * globally unique — no transformation needed).
 */
export interface InsiderFilingV2 {
  id: string;                           // = accession_number
  source: "sec_bulk";
  source_zip: string;
  schema_era: SchemaEra;
  bulk_loaded_at: string;
  source_url: string;

  // SUBMISSION envelope
  accession_number: string;
  filing_date: string;
  period_of_report: string;
  date_of_orig_sub: string | null;
  document_type: string;
  is_amendment: boolean;
  company_cik: string;
  company_name: string;
  ticker: string;
  remarks: string | null;
  no_securities_owned: boolean;
  not_subject_sec16: boolean;
  form3_holdings_reported: boolean;
  form4_trans_reported: boolean;

  // Era-gated flag
  aff10b5one: "1" | "0" | "" | "NOT_TRACKED";

  // Full reporting-owner list
  reporting_owners: BulkReportingOwner[];

  // OWNER_SIGNATURE rows attached to this accession
  signatures: Array<{
    signer_name: string;
    signature_date: string | null;      // ISO YYYY-MM-DD
  }>;

  // Row counts for the filing (so agents can size before pulling rows)
  nonderiv_trans_count: number;
  deriv_trans_count: number;
  nonderiv_holding_count: number;
  deriv_holding_count: number;
  footnote_count: number;
}
