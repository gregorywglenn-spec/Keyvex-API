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
  transaction_type: "buy" | "sell";
  transaction_code: string;
  security_title: string | null;
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
  data_source: "SEC_EDGAR_FORM4";
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
    | null;
  shares_change: number | null;
  shares_change_pct: number | null;
  accession_number: string;
  filing_url: string;
  data_source: "SEC_EDGAR_13F";
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
}

// ─── Form 278 (Annual Financial Disclosure) ─────────────────────────────────

/**
 * Form 278 / Public Financial Disclosure — annual disclosure filed by every
 * member of Congress (and senior executive-branch officials, federal judges).
 * Different from Periodic Transaction Reports (PTRs):
 *   - PTRs    = real-time trade notices, filed within 30-45 days
 *   - Form 278 = year-end snapshot of net worth, assets, income, liabilities
 *
 * v1A captures filing metadata only: who filed, when, and a URL to the actual
 * report PDF. Agents follow the URL to read the per-schedule detail. Net-worth
 * roll-up parsing (Schedule A assets + Schedule C liabilities) is v1.1.
 */
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
  /** When KeyVex scraped this record (ISO 8601). */
  scraped_at: string;
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
  sort_by?: "latest_action_date" | "update_date";
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
