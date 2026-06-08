# KeyVex Data Inventory & Coverage Status

Snapshot: 2026-06-08. **46 Firestore collections, 29,700,719 total records.**

## ⚠️ The honest headline
Record counts below are **exact** (queried live). **Coverage is NOT.**

**Datasets truly verified to the benchmark (G1+G2+G3, confirmed by Greg): 0 of 39.**

Congress-House has an *AI-produced coverage estimate* (~97–98%) and a few spot-checks.
That is **not** verification: it **fails G2** (exchanges entirely absent — a whole
transaction type reads zero), its **G1 unexplained-missing is not zero** (e.g. Kustoff
filing 20020875 was "missing" but had real trades), and **Greg has never confirmed it
himself**. So it counts as "looked at," not "verified." Corrected 2026-06-08 after Greg
rightly rejected the earlier "verified" claim.

Everywhere it says **"NOT MEASURED"** means: *we have data, we have NOT proven it's
complete or correct against the source.* Putting a guessed % there is the thing that
burned us, so I won't.

Per the benchmark (`KEYVEX-QUALITY-BENCHMARK.md`), each dataset needs a
completeness verifier (filing-census + per-transaction-type counts vs source)
before any % here can become real and Greg-verifiable.

---

## A. Customer-facing datasets (served by an MCP tool)

| Dataset (collection) | Records | Source of truth | Coverage vs source |
|---|---|---|---|
| insider_transactions_v2 | 9,923,755 | SEC EDGAR Form 3/4/5 (bulk) | NOT MEASURED |
| sec_fails_to_deliver | 3,930,920 | SEC FTD files | NOT MEASURED |
| insider_trades (legacy feed) | 2,763,493 | SEC EDGAR Form 4 | NOT MEASURED |
| lobbying_filings | 905,348 | LDA (lda.gov) | NOT MEASURED |
| institutional_holdings | 801,894 | SEC 13F | NOT MEASURED |
| private_placements | 526,221 | SEC Form D | NOT MEASURED |
| nport_holdings (get_fund_holdings) | 349,860 | SEC N-PORT | NOT MEASURED |
| xbrl_fundamentals (get_fundamentals) | 324,042 | SEC XBRL company-facts | NOT MEASURED |
| fec_independent_expenditures | 322,758 | FEC Schedule E | NOT MEASURED |
| federal_register_documents | 278,515 | Federal Register API | NOT MEASURED |
| cftc_cot_reports | 147,670 | CFTC COT | NOT MEASURED |
| **congressional_trades** | 145,860 | House Clerk + Senate eFD PTRs | **NOT VERIFIED. House: AI coverage estimate ~97–98% but FAILS G2 (no exchanges) + G1 unexplained-missing≠0 + not Greg-confirmed. Senate: not measured at all.** |
| registration_statements | 125,290 | SEC S-1/S-3/S-3ASR | NOT MEASURED |
| nport_filings | 102,005 | SEC N-PORT | NOT MEASURED |
| product_recalls | 95,545 | FDA + CPSC | NOT MEASURED |
| oig_exclusions | 83,030 | HHS-OIG LEIE | NOT MEASURED |
| fec_committees | 48,646 | FEC | NOT MEASURED |
| tender_offers | 44,641 | SEC SC TO | NOT MEASURED |
| consumer_complaints | 34,816 | CFPB | NOT MEASURED |
| federal_contracts | 27,289 | USAspending | NOT MEASURED |
| screening_list | 25,834 | US Consolidated Screening List | NOT MEASURED |
| fec_candidates | 25,616 | FEC | NOT MEASURED |
| ofac_sdn | 19,133 | Treasury OFAC SDN | NOT MEASURED |
| economic_indicators | 17,819 | BLS + FRED + EIA | NOT MEASURED |
| bills | 16,478 | api.congress.gov | NOT MEASURED |
| treasury_auctions | 10,998 | TreasuryDirect | NOT MEASURED |
| roll_call_votes | 9,913 | House Clerk + senate.gov | NOT MEASURED |
| activist_ownership | 8,626 | SEC 13D/13G | NOT MEASURED |
| material_events | 8,545 | SEC 8-K | NOT MEASURED |
| federal_grants | 5,889 | USAspending (grants) | NOT MEASURED |
| initial_ownership_baselines | 5,201 | SEC Form 3 | NOT MEASURED |
| fec_contributions | 5,022 | FEC Schedule A | NOT MEASURED |
| planned_insider_sales | 3,531 | SEC Form 144 | NOT MEASURED |
| executive_trades | 3,277 | OGE Form 278-T | NOT MEASURED |
| annual_financial_disclosures | 2,221 | Senate eFD Form 278 | NOT MEASURED |
| foreign_agents | 1,314 | DOJ FARA | NOT MEASURED |
| gov_documents (get_government_publications) | 1,108 | GovInfo (CRPT/PLAW/CHRG/GAO) | NOT MEASURED |
| proxy_filings | 758 | SEC DEF 14A | NOT MEASURED |
| legislators (get_member_profile) | 536 | unitedstates/congress-legislators | NOT MEASURED |
| enforcement_actions | 413 | SEC/DOJ/CFTC/OCC/FDIC/FTC | NOT MEASURED |

## B. Internal / support collections (not directly customer-facing)

| Collection | Records | Purpose |
|---|---|---|
| insider_filings_v2 | 4,402,307 | Sub-table of bulk insider (filing metadata) |
| insider_holdings_v2 | 4,108,700 | Sub-table of bulk insider (holdings) |
| legislators_historical | 12,230 | Backfill data for bioguide matching (not queried directly) |
| cusip_map | 23,422 | CUSIP→ticker resolution cache |
| needs_ocr | 185 | OCR worklist (scanned filings to process) |
| meta | 45 | Cron job timestamps / health-check state |

---

## C. "Pass-through data points" — what each customer-facing dataset carries

KeyVex is pure-publisher: every field is passed through from the source, no derived
signals. Key data points per dataset (full field lists live in `src/types.ts`):

- **congressional_trades:** member name, bioguide_id, chamber, party, state, ticker, asset_name, asset_type, transaction_type (buy/sell — **exchange pending per benchmark**), transaction_date, disclosure_date, amount_range, amount_min/max, owner, report_url
- **insider_transactions (v2):** ticker, company_cik, insider name, role (officer/director/10%), transaction_code, shares, price_per_share, total_value, transaction_date, filing_date, is_derivative, underlying_security
- **institutional_holdings (13F):** cusip, ticker, fund_name, fund_cik, shares, market_value, position_change, shares_change, quarter
- **activist_ownership (13D/G):** ticker, cusip, filer_name, filer_type, percent_of_class, shares, sole/shared voting+dispositive, is_activist, event_date
- **planned_insider_sales (144):** ticker, filer_name, shares_to_be_sold, aggregate_market_value, approx_sale_date, is_10b5_1_plan, plan_adoption_date
- **federal_contracts / federal_grants:** recipient_name, recipient_uei, awarding_agency, amount, naics/psc or cfda, start/end dates
- **lobbying_filings:** registrant_name, client_name, filing_year, filing_period, general_issue_codes, government_entities, income, lobbyist_names
- **fec_candidates/committees/contributions/IE:** candidate/committee name + id, office, party, contributor (name/employer/amount), support_oppose (IE)
- **xbrl_fundamentals:** ticker, cik, concept (Revenues, NetIncome, Assets…), value, period_start/end, form, fiscal period
- **enforcement_actions:** source agency, respondent/text, date, url
- **economic_indicators:** series_id, category, value, period, source (BLS/FRED/EIA), source_url
- **material_events (8-K):** ticker, item_codes[], period_of_report, is_amendment, primary_document_url
- (…remaining datasets follow the same pattern: source identifiers + the disclosed values + a source URL for audit. See `src/types.ts` for the exact field list of any one.)

---

## C2. Fullness ESTIMATE (temporal signal — not source-verified coverage)

Built 2026-06-08 from the live data. This is **not** a coverage % (that needs the
source diff). It's the two signals that reveal thin/stale datasets: **date span**
(does it go back as far as the source exists?) and **staleness** (is it current?).
Deep + current = healthy signal. Shallow or stale = a real problem to investigate.

🔴 = likely problem · 🟡 = watch · ⚪ = couldn't assess (no recognized date field)

| Dataset | Records | Span | Stale | Flag |
|---|---|---|---|---|
| insider_transactions_v2 (FLAGSHIP) | 9.92M | 2006→**2026-03-31** | **69d** | 🔴 stale — stopped updating Mar 31 |
| insider_filings_v2 | 4.40M | 2006→2026-03-31 | 69d | 🔴 stale |
| insider_holdings_v2 | 4.11M | 2006→2026-03-31 | 69d | 🔴 stale |
| federal_contracts | 27K | **2026-04-29**→2026-06-06 | 2d | 🔴 only ~5 weeks of history (USAspending goes back decades) |
| federal_grants | 5.9K | **2026-05-08**→2026-06-05 | 3d | 🔴 only ~1 month of history |
| institutional_holdings (13F) | 802K | 2014→2026-05-15 | 24d | 🟡 24d stale (quarterly, some lag normal) |
| executive_trades | 3.3K | (no earliest)→2026-05-12 | 27d | 🟡 27d stale + missing earliest date |
| insider_trades (legacy) | 2.76M | 2016→2026-06-08 | 0d | ✅ current |
| congressional_trades | 146K | 2014→2026-06-07 | 1d | ✅ current+deep (coverage still unverified) |
| lobbying_filings | 905K | 2016→2026-06-06 | 2d | ✅ |
| cftc_cot_reports | 148K | 2016→2026-06-02 | 6d | ✅ |
| xbrl_fundamentals | 324K | 2009→2026-06-03 | 5d | ✅ |
| federal_register_documents | 279K | 2016→2026-06-08 | 0d | ✅ |
| product_recalls | 96K | 1975→2026-06-05 | 3d | ✅ deep |
| tender_offers | 45K | 2001→2026-06-05 | 3d | ✅ |
| treasury_auctions | 11K | 1979→2026-06-11 | current | ✅ deep |
| activist_ownership | 8.6K | 2024→2026-06-08 | 0d | ✅ |
| material_events | 8.5K | 2020→2026-06-08 | 0d | ✅ |
| roll_call_votes | 9.9K | 2013→2026-06-05 | 3d | ✅ |
| annual_financial_disclosures | 2.2K | 2016→2026-06-04 | 4d | ✅ |
| planned_insider_sales | 3.5K | 2023→2026-06-08 | 0d | ✅ |
| proxy_filings | 758 | 2016→2026-06-08 | 0d | ✅ |
| initial_ownership_baselines | 5.2K | 2015→2026-06-08 | 0d | ✅ |
| **⚪ couldn't temporally assess** (no recognized date field — needs a closer look): | | | | bills, consumer_complaints, economic_indicators, enforcement_actions, fec_candidates, fec_committees, fec_contributions, fec_independent_expenditures, foreign_agents, gov_documents, nport_filings, nport_holdings, ofac_sdn, oig_exclusions, private_placements, registration_statements, screening_list, sec_fails_to_deliver |

**Reminder:** "current + deep" is a *good sign*, not proof of completeness. A dataset
can be current and still be missing 30% of filings (Congress looked fine on these two
signals while actually missing exchanges + filings). Only the reconciler proves coverage.

## D. What this means / where we actually are

- We hold **~29.7M records across 46 collections** — that part is real and large.
- **Datasets verified to the benchmark: 0 of 39.** Not one has passed G1+G2+G3 with
  Greg confirming it. Congress-House is the closest and it still fails (no exchanges,
  unexplained gaps, never independently checked).
- So the true answer to "how complete is KeyVex?" today is: **we don't know for any
  dataset.** We have a lot of data and zero proven completeness.
- Until each dataset runs through the reconciliation system (per the benchmark),
  "how full is it?" is honestly **unknown** — everywhere.

**This document's value is that it stops pretending.** The next work is to replace each
"NOT MEASURED" with a real, Greg-verifiable % — one dataset at a time, Congress first.
