# KeyVex Scrapers — Day 8 / 9 / 10 Additions (Port Handoff for Derek)

**Purpose:** This is the catalog of scrapers added to `gregorywglenn-spec/Keyvex-API` over the May 11–14, 2026 push (Day 8 + Day 9 + Day 10). It exists so Derek's Claude can port them into the `C:\CapitalEdge` codebase / `capital-edge-d5038` Firebase project without having to reverse-engineer each one.

**Day 10 added 5 new scrapers + 2 enhancements** (FEC Schedule A contributions, FEC Schedule E independent expenditures, USAspending grants, CFTC COT, SEC Fails-to-Deliver, plus FTC enforcement source and Senate roll-call votes). See the new `## DAY 10 ADDITIONS` section.

For each scraper this doc gives you:
- File path in the KeyVex repo (`src/scrapers/*.ts`)
- MCP tool name (the agent-facing surface)
- Source URL + auth requirements
- Cron schedule + cadence
- Output Firestore collection
- Idempotent doc-ID pattern (critical for re-run safety)
- Function summary
- Key Hard Lessons from the build (the non-obvious traps)

All scrapers are TypeScript on Node 20+. They share a few common patterns:
- HTTP via global `fetch` (no `axios`)
- User-Agent default: `"KeyVexMCP/0.1 contact@keyvex.com"` — change to match your project
- Rate-limit sleeps between requests (150-250ms typical)
- `merge: true` upserts on every Firestore write so re-runs are idempotent

The MCP-server side wires each scraper into:
1. `src/firestore.ts` — `save*` + `query*` functions
2. `src/tools/*.ts` — MCP tool definition + handler
3. `src/tools/index.ts` — tool registry
4. `src/scrape.ts` — CLI command for manual runs
5. `functions/src/index.ts` — `onSchedule` Cloud Function

If Derek's project just wants the SCRAPER part (no MCP surface), all 24 are independent modules that can be lifted into any TS codebase that has `firebase-admin` available.

---

## Quick-reference table

| # | Scraper | File | Source | Cadence | Collection |
|---|---|---|---|---|---|
| 1 | FEC Candidates | `fec.ts` | api.open.fec.gov | Weekly Sun | `fec_candidates` |
| 2 | FEC Committees | `fec.ts` | api.open.fec.gov | Weekly Sun | `fec_committees` |
| 3 | Schedule TO (Tender Offers) | `tender-offers.ts` | EDGAR FTS | Daily | `tender_offers` |
| 4 | Bills | `congress-legislation.ts` | api.congress.gov | Daily | `bills` |
| 5 | House + **Senate** Roll-Call Votes | `congress-legislation.ts` | api.congress.gov + senate.gov XML | Daily | `roll_call_votes` |
| ~~6~~ | ~~FINRA OTC Weekly~~ **— DROPPED 2026-06-01. Do NOT port.** FINRA is a self-regulatory organization, not a US-government source, and its data API requires a license agreement — out of scope for the pure-public-government-source posture. | — | — | — | — |
| 7 | Form D (Private Placements) | `form-d.ts` | EDGAR FTS | Daily | `private_placements` |
| 8 | SEC + DOJ + CFTC + OCC + FDIC + **FTC** Enforcement | `enforcement-actions.ts` | mixed | Daily | `enforcement_actions` |
| 9 | Form N-PORT (Mutual Funds) | `nport.ts` | EDGAR FTS | Daily | `nport_filings` |
| 10 | Form S-1 / S-3 (Registrations) | `registration-statements.ts` | EDGAR FTS | Daily | `registration_statements` |
| 11 | OFAC SDN | `ofac-sdn.ts` | sanctionslistservice.ofac.treas.gov | Daily | `ofac_sdn` |
| 12 | Federal Register | `federal-register.ts` | federalregister.gov | Daily | `federal_register_documents` |
| 13 | DEF 14A Proxy Filings | `proxy.ts` | EDGAR submissions + FTS | Daily 7:15 AM | `proxy_filings` |
| 14 | Treasury Auctions | `treasury-auctions.ts` | api.fiscaldata.treasury.gov | Daily 7:30 AM | `treasury_auctions` |
| 15 | BLS Economic Indicators | `bls.ts` | api.bls.gov | Daily 8:45 AM | `economic_indicators` |
| 16 | HHS-OIG Exclusions (LEIE) | `oig-exclusions.ts` | oig.hhs.gov | Monthly 5th | `oig_exclusions` |
| 17 | CFPB Consumer Complaints | `cfpb-complaints.ts` | consumerfinance.gov | Daily 8 AM | `consumer_complaints` |
| 18 | XBRL Fundamentals | `xbrl.ts` | data.sec.gov | Weekly Sun 4 AM | `xbrl_fundamentals` |
| 19 | FRED Economic Data | `fred.ts` | api.stlouisfed.org | Daily 9 AM | `economic_indicators` (shared w/ BLS) |
| 20 | **FEC Schedule A** (Contributions) | `fec-schedule-a.ts` | api.open.fec.gov | Daily 7:30 AM | `fec_contributions` |
| 21 | **FEC Schedule E** (Independent Expenditures) | `fec-schedule-e.ts` | api.open.fec.gov | Daily 7:45 AM | `fec_independent_expenditures` |
| 22 | **USAspending Grants** | `usaspending-grants.ts` | api.usaspending.gov | Daily 6:12 AM | `federal_grants` |
| 23 | **CFTC Commitments of Traders** | `cftc-cot.ts` | publicreporting.cftc.gov | Weekly Sat 7 AM | `cftc_cot_reports` |
| 24 | **SEC Fails-to-Deliver** | `sec-ftd.ts` | sec.gov bi-monthly zips | 1st + 16th 5 AM | `sec_fails_to_deliver` |

---

## DAY 8 ADDITIONS (May 11)

### 1. FEC Candidates — `src/scrapers/fec.ts` → `scrapeFecCandidates`

- **Function:** Pulls every federally-registered candidate (House, Senate, President) for the current 2-year cycle from FEC's bulk endpoint. ~30K active filings.
- **MCP tool:** `get_fec_candidate_profile`
- **Source:** `https://api.open.fec.gov/v1/candidates/` (FEC OpenFEC v1 API)
- **Auth:** REQUIRES API key. Free, register at `https://api.open.fec.gov/developers/` (the `DEMO_KEY` works for 1000 req/hr — sufficient for daily refresh). Set env var `FEC_API_KEY`. The api.data.gov gateway is shared across FEC + Congress.gov, so the 1000/hr limit is shared across both keys if you use the same one.
- **Cadence:** Weekly (Sundays). FEC candidate data doesn't change daily.
- **Idempotent key:** `candidate_id` (FEC's permanent identifier like `H8AZ02193`).
- **Hard lesson:** FEC API returns 502s under heavy load — bake retry-with-backoff into the fetch helper. The retry was added in v0.19.1.
- **Provenance:** `fec_url` field set to `https://www.fec.gov/data/candidate/{candidate_id}/`.

### 2. FEC Committees — same file → `scrapeFecCommittees`

- **Function:** Pulls every FEC-registered committee (PACs, principal campaign committees, super PACs, party committees, leadership PACs). The link table between candidates and money flow. Includes `candidate_ids[]` array for the committees that support specific candidates.
- **MCP tool:** Same as candidates (`get_fec_candidate_profile` with `include_committees: true`).
- **Source:** `https://api.open.fec.gov/v1/committees/`
- **Auth:** Same FEC_API_KEY.
- **Cadence:** Weekly Sundays.
- **Idempotent key:** `committee_id` (e.g., `C00603533`).
- **Provenance:** `fec_url` → `https://www.fec.gov/data/committee/{committee_id}/`.

### 3. Schedule TO (Tender Offers) — `src/scrapers/tender-offers.ts`

- **Function:** SEC Schedule TO filings — third-party tender offers (M&A bids) + issuer buybacks. Live-feed scrape via EDGAR full-text search. v1A is metadata-only (filing date, filer, target ticker, accession, URL); body parse is v1.1.
- **MCP tool:** `get_tender_offers`
- **Source:** `https://efts.sec.gov/LATEST/search-index?forms=SCHEDULE+TO`
- **Auth:** SEC requires a real User-Agent (`KeyVexMCP/0.1 contact@keyvex.com` works).
- **Cadence:** Daily.
- **Idempotent key:** `accession_number` (e.g., `0001193125-26-014344`).
- **Hard lesson:** Some Schedule TO filings ship with target_ticker omitted from the structured metadata; tool description warns agents.

### 4. Bills — `src/scrapers/congress-legislation.ts` → `scrapeBills`

- **Function:** Congressional bills + resolutions across all 8 types (HR, S, HJRES, SJRES, HCONRES, SCONRES, HRES, SRES). Pulls latest action date, sponsor, title, status, full text URL.
- **MCP tool:** `get_bills`
- **Source:** `https://api.congress.gov/v3/bill/`
- **Auth:** REQUIRES `CONGRESS_API_KEY` (free via api.congress.gov). Shared rate limit with api.data.gov gateway.
- **Cadence:** Daily.
- **Idempotent key:** `bill_id` like `119-HR-134`.

### 5. House + Senate Roll-Call Votes — same file → `scrapeRollCallVotes`

- **Function:** Every recorded roll-call vote in the US House AND Senate. **Updated Day 10 to add Senate via senate.gov XML feeds** (api.congress.gov has no Senate vote endpoint — confirmed 404). 782 Senate votes backfilled for the 119th Congress.
- **MCP tool:** `get_roll_call_votes`
- **Sources:**
  - House: `https://api.congress.gov/v3/house-vote/{congress}/{session}` (paginated list)
  - Senate: `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{congress}_{session}.xml` (XML menu)
- **Auth:** CONGRESS_API_KEY for House only. Senate XML is unauthenticated.
- **Cadence:** Daily. Both chambers in one cron pass.
- **Hard lesson:** Senate XML's `vote_date` is `DD-MMM` format with **no year** (e.g., "18-Dec"). The year lives in the parent `<congress_year>` element. Parse + assemble ISO date in the normalizer.
- **Idempotent key:** `vote_id` like `house-119-1-362`.

### 6. FINRA OTC Weekly — DROPPED 2026-06-01. Do NOT port.

Removed from KeyVex on 2026-06-01. FINRA is a self-regulatory organization
(SRO), **not** a US-government source, and its data API requires a license
agreement. That conflicts with KeyVex's pure-public-US-government-source
posture. The scraper, MCP tool (`get_otc_market_weekly`), Firestore collection
(`otc_market_weekly`), indexes, and health-check job were all removed. Do not
re-introduce it on either side.

### 7. Form D (Private Placements) — `src/scrapers/form-d.ts`

- **Function:** SEC Form D filings — Regulation D exempt-offering notices. VC raises, PE funds, real-estate syndicates. v1A metadata only.
- **MCP tool:** `get_private_placements`
- **Source:** `https://efts.sec.gov/LATEST/search-index?forms=D`
- **Auth:** SEC User-Agent.
- **Cadence:** Daily.
- **Idempotent key:** `filing_uuid` (composite of `accession_number` + filer CIK).

### 8. Enforcement Actions — `src/scrapers/enforcement-actions.ts`

- **Function:** Six-regulator press-release feed: SEC, DOJ, CFTC, OCC, FDIC, **FTC** (FTC added Day 10). v1A metadata + teaser (no full body extraction).
- **MCP tool:** `get_enforcement_actions` (single tool, `source` enum filter)
- **Sources & auth (each branch in the same module):**
  - **SEC** — RSS at `https://www.sec.gov/news/pressreleases.rss`. SEC User-Agent.
  - **DOJ** — JSON API at `https://www.justice.gov/api/v1/press_releases.json`. No auth. Default sort is OLDEST-FIRST (counterintuitive); set `sort=date&direction=DESC`.
  - **CFTC** — NO RSS / NO JSON API. HTML index scrape at `https://www.cftc.gov/PressRoom/PressReleases`. Each row has `<time datetime="ISO">` + `<a href="/PressRoom/PressReleases/{id}-{yr}">title</a>`. Use `cheerio` to parse. Browser-style User-Agent works fine.
  - **OCC** — NO RSS. HTML at `https://www.occ.treas.gov/news-issuances/news-releases/{year}/index-news-releases-{year}.html`. **Requires browser-style User-Agent (KeyVexMCP/0.1 gets 302-redirected).** Use `Mozilla/5.0 (compatible; KeyVexBot/1.0; +https://...)` or similar. Filter to news releases only (skip bulletins).
  - **FDIC** — NO RSS. HTML at `https://www.fdic.gov/news/press-releases`. Same Drupal-fronted CDN that needs browser-style User-Agent. Structure: `<article class="node--news">` with `<time datetime="ISO">` + `<p class="news-title"><a href="..." rel="bookmark">title</a></p>`.
  - **FTC** *(Day 10 addition)* — RSS at `https://www.ftc.gov/feeds/press-release.xml`. Standard RSS shape, SEC User-Agent works. ~10-15 items per week (antitrust, deceptive practices, merger reviews, consumer protection). Cross-source pair with `lobbying_filings` (HCR/MMM issue codes) and `proxy_filings` (M&A regulatory exposure).
- **Cadence:** Daily 6:35 AM ET (all 6 sources in one combined Cloud Function).
- **Idempotent keys:**
  - `sec-{guid-or-slug}` for SEC RSS items
  - `doj-{uuid}` for DOJ JSON items
  - `cftc-{release-number}` (e.g., `cftc-9230-26`)
  - `occ-{slug}` (e.g., `occ-nr-occ-2026-36`)
  - `fdic-{slug}` (slug from the URL path)
  - `ftc-{url-slug}` (slug from the URL path; the FTC press-release path is highly descriptive)
- **Hard lesson 1:** OCC + FDIC reject bare-bot User-Agent strings via CloudFront. Switching to browser-style UA fixes it.
- **Hard lesson 2:** CFTC has no RSS — the HTML scrape is brittle but cheerio + the documented row structure has held up reliably.

### 9. Form N-PORT — `src/scrapers/nport.ts`

- **Function:** Mutual fund / ETF / closed-end fund monthly portfolio holdings reports. v1A is filing METADATA — per-fund-per-month metadata only; holdings detail extraction is v1.1.
- **MCP tool:** `get_nport_filings`
- **Source:** EDGAR FTS `forms=NPORT-P`
- **Auth:** SEC User-Agent.
- **Cadence:** Daily.
- **Idempotent key:** `accession_number`.

### 10. Form S-1 / S-3 (Registration Statements) — `src/scrapers/registration-statements.ts`

- **Function:** IPO + shelf-registration filings. Covers S-1, S-1/A (amendments), S-3, S-3/A.
- **MCP tool:** `get_registration_statements`
- **Source:** EDGAR FTS with form-filter rotated across the 4 form codes.
- **Auth:** SEC User-Agent.
- **Cadence:** Daily.
- **Idempotent key:** `accession_number`.
- **Hard lesson:** Same XSL-prefix issue as other SEC form scrapers — strip `^xsl[A-Z0-9]+/` from `primaryDocument` before fetching, otherwise you get HTML-rendered output instead of raw XML.

### 11. OFAC SDN List — `src/scrapers/ofac-sdn.ts`

- **Function:** US Treasury Office of Foreign Assets Control "Specially Designated Nationals" sanctions list. Single-file CSV download. ~19K entries (~5.5 MB).
- **MCP tool:** `get_ofac_sdn`
- **Source:** `https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv`
- **Auth:** None.
- **Cadence:** Daily 6:50 AM ET.
- **Idempotent key:** `ent_num` (OFAC's permanent entity number).
- **Hard lesson 1:** OFAC uses `-0-` as the empty-field sentinel. Normalize to `""` on ingest.
- **Hard lesson 2:** CSV uses CRLF line endings + quoted-field state machine (commas inside `"…"` fields). Use the state-machine parser (already in `ofac-sdn.ts`), not naive `split(',')`.
- **Provenance:** `ofac_url` → `https://sanctionssearch.ofac.treas.gov/Details.aspx?id={ent_num}`.

### 12. Federal Register — `src/scrapers/federal-register.ts`

- **Function:** Federal Register documents — proposed rules, final rules, notices, presidential documents. The official daily publication of US federal regulatory actions.
- **MCP tool:** `get_federal_register_documents`
- **Source:** `https://www.federalregister.gov/api/v1/documents.json` (public API, no auth)
- **Cadence:** Daily.
- **Idempotent key:** `document_number` (federalregister.gov's permanent ID, e.g., `2026-09385`).

---

## DAY 9 ADDITIONS (May 12, today's marathon)

### 13. DEF 14A Proxy Filings — `src/scrapers/proxy.ts`

- **Function:** SEC Schedule 14A proxy statements — annual shareholder-meeting filings carrying exec compensation tables, board nominations, shareholder proposals, auditor info. Captures the full DEF 14A family: DEF 14A (annual), DEFA14A (additional materials), DEFM14A (merger-related), DEFR14A (revised).
- **MCP tool:** `get_proxy_filings`
- **Source:** EDGAR submissions API per-ticker + FTS for live-feed
- **Auth:** SEC User-Agent.
- **Cadence:** Daily 7:15 AM ET, 2-day lookback window.
- **Idempotent key:** `accession_number`.
- **Convenience fields derived from filing_type:** `is_merger_related` (DEFM14A), `is_amendment` (DEFR14A), `is_additional_materials` (DEFA14A).
- **Hard lesson:** FTS doesn't support wildcard form matching — must iterate each of the 4 form codes (`DEF+14A`, `DEFA14A`, `DEFM14A`, `DEFR14A`) and dedup by accession. Encode space as `+` or `%20`.

### 14. Treasury Auctions — `src/scrapers/treasury-auctions.ts`

- **Function:** US Treasury debt auction records — Bills (≤1yr), Notes (2-10yr), Bonds (20-30yr), TIPS (inflation-protected), FRNs (floating-rate). Captures pre-auction announcements AND post-auction results (bid-to-cover ratio, yields, bidder breakdowns, SOMA holdings).
- **MCP tool:** `get_treasury_auctions`
- **Source:** `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query` (REST JSON, no auth)
- **Cadence:** Daily 7:30 AM ET, 14-day lookback.
- **Idempotent key:** `{cusip}-{auction_date}`.
- **Key signal fields:** `bid_to_cover_ratio` (demand metric), `soma_holdings` + `soma_included` (Fed QE/QT activity), direct/indirect/primary-dealer bidder breakdowns.
- **Hard lesson:** Treasury's API serializes everything as STRINGS — coerce to number with `toNum()` and treat literal string `"null"` as null. Also: Records have a two-stage lifecycle (announcement → results); idempotent saves with `merge:true` overwrite cleanly when results publish.

### 15. BLS Economic Indicators — `src/scrapers/bls.ts`

- **Function:** Bureau of Labor Statistics curated 20-series watchlist covering employment (unemployment U-3/U-6, payrolls, labor force participation), wages (ECI, average hourly earnings), inflation (CPI all items / core / food / energy / housing + PPI), productivity (nonfarm productivity, unit labor costs).
- **MCP tool:** `get_economic_indicators` (with `source: "bls"`)
- **Source:** `https://api.bls.gov/publicAPI/v2/timeseries/data/` (POST JSON)
- **Auth:** Optional. Free tier without key = 50 req/day. With `BLS_API_KEY` env var = 500/day. One scheduler run is one POST, so the free tier is fine.
- **Cadence:** Daily 8:45 AM ET, 2-year lookback.
- **Idempotent key:** `{series_id}-{period}` (e.g., `LNS14000000-2026M04`).
- **Provenance:** `source_url` → `https://data.bls.gov/timeseries/{series_id}`.
- **Schema note:** v0.39.0 renamed `bls_source_url` → `source_url` for cross-source consistency with FRED (see #19).

### 16. HHS-OIG Exclusions (LEIE) — `src/scrapers/oig-exclusions.ts`

- **Function:** Federal healthcare "List of Excluded Individuals/Entities" — anyone barred from billing Medicare, Medicaid, or any federal healthcare program. ~83K entries (~15 MB CSV).
- **MCP tool:** `get_oig_exclusions`
- **Source:** `https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv` (single-file CSV download)
- **Auth:** None.
- **Cadence:** Monthly, 5th of month at 7 AM ET (OIG publishes monthly updates in the first few days).
- **Idempotent key:** `oig-{NPI}` when NPI is populated and valid 10-digit; else `oig-{SHA1(name+business+date+state+zip)}` 12-char truncated hash.
- **Schema:** 18 fixed columns from OIG (LASTNAME, FIRSTNAME, MIDNAME, BUSNAME, GENERAL category, SPECIALTY, UPIN, NPI, DOB, ADDRESS, CITY, STATE, ZIP, EXCLTYPE statute code, EXCLDATE, REINDATE, WAIVERDATE, WVRSTATE).
- **Hard lesson:** Date format is `YYYYMMDD` raw; sentinel `00000000` means empty. Always normalize to ISO `YYYY-MM-DD` or null. Also: OIG only ships CURRENTLY-excluded entries — reinstated providers are removed from the file. `is_reinstated=true` filter will return ~0 in v1A.

### 17. CFPB Consumer Complaints — `src/scrapers/cfpb-complaints.ts`

- **Function:** Consumer Financial Protection Bureau complaint database. ~10K complaints/day across banks, credit reporting, mortgage servicers, debt collectors, fintech, crypto. Complaint volume is a leading indicator of CFPB/OCC/FDIC enforcement.
- **MCP tool:** `get_consumer_complaints`
- **Source:** `https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/` (Elasticsearch-style)
- **Auth:** None, but requires browser-style User-Agent.
- **Cadence:** Daily 8 AM ET. v1A: rolling 2-day window, capped at 2000 most-recent records per run (full historical = 5M+ records, out of scope).
- **Idempotent key:** `complaint_id` (CFPB's primary key).
- **Pagination:** `frm` (from) + `size` parameters, flat JSON array return (no envelope), sort `created_date_desc`.

### 18. XBRL Fundamentals — `src/scrapers/xbrl.ts` ⭐ THE BIG ONE

- **Function:** SEC EDGAR XBRL-tagged financial fundamentals from 10-K + 10-Q filings. Income statement / balance sheet / cash flow line items per company per quarter. Curated 40-concept watchlist covering Revenues, NetIncomeLoss, Assets, Liabilities, StockholdersEquity, EPS basic/diluted, share counts, cash flows, etc.
- **MCP tool:** `get_fundamentals`
- **Source:** `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json` (one call returns ALL tagged observations for a company across every 10-K + 10-Q they've ever filed)
- **Auth:** SEC User-Agent.
- **Cadence:** Weekly Sundays 4 AM ET. Streaming saver in `scrapeAndSaveXbrlStreaming` (saves per-company to keep peak memory <1 GiB).
- **Universe:** Curated 132-ticker watchlist in `src/data/xbrl-universe.ts` (S&P-100 + cross-source-relevant additions: defense, banks, healthcare, energy, big tech, autos). 130 tickers successfully ingest; BRK.B + MMC skip per known issues.
- **Idempotent key:** `{cikPadded}-{concept}-{period_end}-{form-with-slash-sanitized}-{period_start || "pit"}`.
- **Three critical Hard Lessons (CAPTURED IN CLAUDE.md, MUST KNOW BEFORE PORTING):**

  1. **doc-ID MUST include `period_start`.** A 10-K filing tags BOTH the FY cumulative observation (start=Oct prior year, end=Sept) AND the Q4 standalone (start=Jul, end=Sept) under the SAME `concept` + `period_end` + `form`. Without `period_start` in the ID, one overwrites the other. Agents querying for "Revenues for FY2018" can get the wrong number depending on which observation happened to land last.

  2. **`cikToTicker` reverse lookup picks preferred-share series via last-write-wins.** SEC's `company_tickers.json` has multiple entries per CIK for companies with preferred series (JPM has JPM common + JPM-PA/PC/PD/PG/PM preferred). The LAST ticker in the catalog (often a preferred series like JPM-PM) clobbers the common ticker. Records end up stored with `ticker="JPM-PM"` and agents querying `ticker:"JPM"` find nothing. **Fix:** callers of `scrapeXbrlByCik` MUST pass a `tickerOverride` parameter that preserves the INPUT ticker. `scrapeXbrlByTicker` was updated to always pass-through the input.

  3. **SEC `company_tickers.json` strips dots from class-share tickers.** BRK.B is stored as "BRKB". BF.B is "BFB". HEI.A is "HEIA". Naive ticker lookup misses these. **Fix:** `getTickerInfo` tries direct lookup → strip dots → strip slashes, in that order.

- **Volume:** 593,461 observations scraped across 130 companies; 323,590 unique docs preserved (the ~46% collision is EXPECTED — each company refiles prior-period comparatives in every subsequent 10-K with a different accession number; merge:true keeps the most-recent restatement, which is the canonical value).
- **Universe dedup:** GOOG was removed from the universe because GOOGL covers the same CIK 1652044 — running both clobbers each other.

### 19. FRED Economic Data — `src/scrapers/fred.ts`

- **Function:** Federal Reserve Economic Data (St. Louis Fed). Curated 30-series watchlist: rates (Fed Funds DFF, 2Y/10Y/30Y Treasury, 10Y-2Y spread, 30yr mortgage, AAA/BAA), GDP (nominal/real/growth), activity (industrial production, housing starts, retail sales), inflation (PCE, Core PCE, 5Y/10Y breakevens), employment (UNRATE/PAYEMS — FRED republish of BLS + JOLTS + jobless claims), money (M2, Fed total assets WALCL, overnight reverse repo), debt (federal debt, Treasury general account), trade (trade balance, broad dollar index), sentiment (U Michigan).
- **MCP tool:** `get_economic_indicators` (with `source: "fred"`) — SHARED with BLS, same tool extended to two sources
- **Source:** `https://api.stlouisfed.org/fred/series/observations` (V1 API; V2 is bulk-by-release which we don't use)
- **Auth:** REQUIRED `FRED_API_KEY` env var (free registration at `https://fredaccount.stlouisfed.org/apikeys`).
- **Cadence:** Daily 9 AM ET, 5-year lookback.
- **Idempotent key:** `{series_id}-{period}` (e.g., `DGS10-2026D131` for daily, `UNRATE-2026M04` for monthly).
- **Period labels** (KeyVex convention, fixed-width so lex-sort = chronological):
  - `{YYYY}M{MM}` monthly (e.g., `2026M04`)
  - `{YYYY}Q{QQ}` quarterly (e.g., `2026Q01`)
  - `{YYYY}A01` annual
  - `{YYYY}W{WW}` weekly (ISO week number)
  - `{YYYY}D{DDD}` daily (day-of-year, zero-padded to 3 digits)
- **Hard lesson 1:** AAA and BAA are MONTHLY in FRED, not daily (despite my initial catalog labeling). Got 64 obs over 5 years = monthly. Fixed in the catalog.
- **Hard lesson 2:** FRED uses `"."` as the missing-value sentinel for daily series (when markets close on holidays). Treat `"."` as `null`.
- **Provenance:** `source_url` → `https://fred.stlouisfed.org/series/{series_id}`.

---

## DAY 10 ADDITIONS (May 14, autonomous batches)

Day 10 was a two-batch autonomous run focused on closing the political-alpha loop (FEC contributions / IE / grants) and adding the options-adjacent surface (CFTC COT futures positioning, SEC FTD short-squeeze leading indicator). Plus FTC enforcement (6th regulator source) and Senate roll-call votes (XML from senate.gov, since api.congress.gov has no Senate vote endpoint).

### 20. FEC Schedule A (Individual + Committee Contributions) — `src/scrapers/fec-schedule-a.ts`

- **Function:** Itemized contribution rows — money flowing INTO a federal committee. Required disclosure for ≥ $200 from an individual; PACs also report all PAC-to-PAC and CCM transfers. The "follow the money" half of political-alpha. 5,000 rows seeded across 180 days for cycle 2026 with $2,500+ filter.
- **MCP tool:** `get_fec_contributions`
- **Source:** `https://api.open.fec.gov/v1/schedules/schedule_a/` (OpenFEC v1 Schedule A endpoint)
- **Auth:** Same `FEC_API_KEY` as fec.ts. Same api.data.gov gateway rate limit.
- **Cadence:** Daily 7:30 AM ET, 7-day rolling window, $1,000+ floor (filters payroll-deduction memo noise that dominates raw volume; signal-rich rows are large donations).
- **Idempotent key:** `sub_id` — FEC's globally unique row identifier (NOT `link_id`, which is filing-level and shared across all sub-rows).
- **Hard lesson 1 (load-bearing — captured in CLAUDE.md):** **FEC Schedule A silently IGNORES `page=N` pagination past ~10K result rows.** Pass page=2 with a filter that produces a large result set and the API returns the FIRST page over and over — same `sub_id` set, no error, no warning. Cursor-based pagination via `last_index` + `last_contribution_receipt_date` is required (extracted from `pagination.last_indexes` in each response; first request omits them; subsequent requests pass them back). Terminate when results[] is empty.
- **Hard lesson 2:** `link_id` is FILING-level, not ROW-level. Multiple contribution rows share one `link_id` (it's the FEC's relational join to filing metadata). Using `link_id` as a doc-ID collapses entire filings into one Firestore document with massive data loss. The row-level unique ID is `sub_id`.
- **Cross-source pair:** Joins to `fec_candidates` via `candidate_id`, to `fec_committees` via `recipient_committee_id`, and via `contributor_employer` substring to `lobbying_filings` for lobbyist-employee donation patterns.

### 21. FEC Schedule E (Independent Expenditures) — `src/scrapers/fec-schedule-e.ts`

- **Function:** Super PAC ad spending FOR or AGAINST federal candidates. The hallmark vehicle for political ad warfare since Citizens United (2010). F24 (24-hour notices within 20 days of an election) + F5 (quarterly) both flow through this endpoint. 1,000 rows seeded as the v1 seed.
- **MCP tool:** `get_fec_independent_expenditures`
- **Source:** `https://api.open.fec.gov/v1/schedules/schedule_e/` (OpenFEC v1 Schedule E endpoint)
- **Auth:** Same `FEC_API_KEY`.
- **Cadence:** Daily 7:45 AM ET (offset from Schedule A by 15 min to spread api.data.gov budget). 7-day rolling window, $1,000+ floor, cycle 2026 default.
- **Idempotent key:** `sub_id` (same FEC convention as Schedule A).
- **Critical signal field:** `support_oppose_indicator` — `"S"` = support, `"O"` = oppose. A single candidate often has dozens of S and O entries across many super PACs in one cycle. The `payee_name` field reveals ad-agency / media-buyer networks.
- **Hard lesson:** Same cursor-based pagination as Schedule A (FEC silently ignores `page=N`). Cursor field for sort-by-date is `last_expenditure_date` (not `last_contribution_receipt_date`). Match the cursor field to the sort field.
- **Cross-source pair:** Joins to `fec_candidates` via `candidate_id` (the target politician). Useful for "who's running attack ads against Senator X" queries.

### 22. USAspending Federal Grants — `src/scrapers/usaspending-grants.ts`

- **Function:** Federal GRANTS and cooperative agreements — distinct recipient universe from `federal_contracts`. Universities, non-profits, state & local agencies, research institutions, healthcare orgs. CFDA-program-keyed. 167 rows seeded in 7-day window backfill.
- **MCP tool:** `get_federal_grants`
- **Source:** `https://api.usaspending.gov/api/v2/search/spending_by_award/` (same endpoint as `federal_contracts`, different `award_type_codes`)
- **Auth:** None — USAspending is unauthenticated public API.
- **Cadence:** Daily 6:12 AM ET (offset from contracts run at 6:10).
- **Idempotent key:** USAspending's `generated_internal_id` (stable across modifications). Same convention as `federal_contracts`.
- **Award type codes:** `["02", "03", "04", "05"]` — 02 = Block Grant, 03 = Formula Grant, 04 = Project Grant (most common), 05 = Cooperative Agreement.
- **Grant-specific fields:** `cfda_number` (Catalog of Federal Domestic Assistance program ID, e.g. "93.847" = NIH R01 research grants). No NAICS / PSC codes (those are contract-only). `Award Type` field text rather than `Contract Award Type`.
- **Cross-source pair:** `cfda_number` as program-level join key (all NIH R01 awards = `cfda_number='93.847'`). Pairs with `lobbying_filings` (which universities lobbied for what), `fec_contributions` (university-employee donations to politicians on relevant committees).

### 23. CFTC Commitments of Traders (COT) — `src/scrapers/cftc-cot.ts`

- **Function:** Weekly aggregated futures + options-on-futures positioning by trader class (non-commercial = large speculators / commercial = hedgers / non-reportable = small specs). The macro positioning dataset, released every Friday 3:30 PM ET for prior Tuesday close. Captures EVERY regulated U.S. futures contract — agricultural commodities, metals, energy, financials, FX, crypto. 1,106 rows seeded across 4 weeks.
- **MCP tool:** `get_cftc_cot_reports`
- **Source:** `https://publicreporting.cftc.gov/resource/jun7-fc8e.json` (Socrata API, legacy futures-only report dataset)
- **Auth:** None — unauthenticated Socrata API.
- **Cadence:** Weekly Saturday 7 AM ET (COT publishes Friday 3:30 PM; Saturday 7 AM gives a comfortable buffer).
- **Idempotent key:** Composite `{cftc_contract_market_code}-{report_date YYYY-MM-DD}`.
- **Socrata query API note:** Use `$where` for SQL-shaped filtering, `$limit` (per-page max 50K), `$offset` for pagination, `$order` for sort. Standard Socrata conventions.
- **Disaggregated report variant** (NOT in v1A; v1.1 polish): dataset id `72hh-3qpy` breaks commercials further into `producer_merchant_long` / `swap_dealer_long` / `m_money_long` (managed money) / `other_reportables`. v1A uses the legacy 3-class breakdown for broadest comparability with historical analysis.
- **CFTC field-name typos (preserve in raw shape):** `noncomm_postions_spread_all` (missing 'i' in "positions") and `change_in_noncomm_spead_all` (missing 'r' in "spread") are official field names in the CFTC dataset. Don't fix them in raw normalization — pass through as-is.
- **Cross-source pair:** Macro positioning context for `economic_indicators` (BLS/FRED) + `treasury_auctions`. "Latest COT positioning snapshot + Fed Funds + 10Y + auction demand" = one query, full macro picture.

### 24. SEC Fails-to-Deliver (FTD) — `src/scrapers/sec-ftd.ts`

- **Function:** Daily settlement failures by ticker / CUSIP / date. The Reg SHO Threshold Securities list (FTDs > 0.5% of issued shares for 5+ consecutive days) is a derived view of this data; this scraper exposes the underlying daily FTD rows. **49,844 rows seeded from Apr 2026 first-half alone.** Signal: persistent FTDs are a contrarian short-squeeze leading indicator.
- **MCP tool:** `get_sec_fails_to_deliver`
- **Source:** `https://www.sec.gov/files/data/fails-deliver-data/cnsfails<YYYYMM><a|b>.zip` — bi-monthly zip files. `a` = first half (settlement dates 1-15), `b` = second half (16-EOM). Each zip is ~1MB compressed, ~3MB plain, ~30K rows.
- **File format inside zip:** Pipe-delimited text: `SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE`. Settlement date is `YYYYMMDD` (no separators).
- **Auth:** None — public SEC bulk data. Standard SEC User-Agent.
- **Cadence:** Bi-monthly cron on the 1st + 16th @ 5 AM ET.
- **Idempotent key:** Composite `{YYYY-MM-DD}-{cusip}` (one row per ticker per settlement date).
- **Derived field:** `fail_value = quantity_fails × price` (dollar magnitude of the failure that day).
- **New dependency:** `adm-zip` (already added to package.json). Streams zip from HTTP body buffer; entry text read as UTF-8.
- **Hard lesson (load-bearing — captured in CLAUDE.md):** **SEC FTD posting lag is 2-3 weeks, not 1 week.** SEC posts each half-month file ~2-3 weeks AFTER the half ends, NOT immediately. Initial scraper resolved target to `today - 10 days` and 404'd because the most-recent expected file wasn't yet published. Fix: use `today - 20 days` as the baseline, AND add auto-fallback that walks backward through up to 6 half-months on 404 until a published file is found. Makes the cron resilient to SEC's variable posting cadence.
- **Cross-source pair:** Joins to `activist_ownership` (large stakes) + `insider_transactions` (insider activity) for short-squeeze setup detection.

---

## Day 10 audit findings (NOT new scrapers — gaps captured for v1.1)

These were flagged during Day 10 work but deferred since they need 2-3 hour build sessions each:

### Gap A: Form 4 derivative table NOT ingested

The `form4.ts` scraper currently parses **only** `nonDerivativeTable.nonDerivativeTransaction` from the SEC ownership XML. Derivative transactions — stock-option exercises, warrant exercises, conversion-of-convertibles — live in `derivativeTable.derivativeTransaction` and are silently dropped. This affects roughly 30-50% of all Form 4 filings (exec option grants + vesting + exercise events).

**Fix recipe (~2-3 hr):** Extend the `form4.ts` parser to also walk `derivativeTable.derivativeTransaction` rows, adding `is_derivative: boolean`, `conversion_or_exercise_price`, `expiration_date`, `underlying_security_title`, `underlying_security_shares` fields to the `InsiderTransaction` type. Then re-backfill the `insider_trades` collection. Adds an `is_derivative` filter to `get_insider_transactions`.

### Gap B: N-PORT primary_document XML NOT parsed

The `nport.ts` scraper currently captures only filing-level metadata (filing_id, filer_cik, period_ending, primary_document_url, etc.). The actual per-holding derivative positions (swaps, options, futures, repurchase agreements) live INSIDE `primary_document_url` XML which isn't fetched or parsed. Same metadata-only posture as 8-K.

**Fix recipe (~2-3 hr):** Add a second-pass scraper that walks each `nport_filings` doc's `primary_document_url`, fetches the XML, parses `invstOrSec` entries (each is one holding), extracts derivative-specific fields (swap notional, option strike/expiry, futures contract details), and writes per-holding rows to a new `nport_holdings` collection. New MCP tool or extension on `get_nport_filings` with `include_holdings: true`.

### Gap C: CBOE put/call ratio NOT scraped

CBOE's modern endpoints are mostly Cloudflare-403'd for non-browser requests. VIX history is available (and already ingested via FRED). The put/call ratio + daily options volume aggregates need HTML scraping of CBOE pages — a dedicated session-sized investigation. **Currently deferred indefinitely.** Real-time options chains (strike/expiry/IV/greeks) require the paid OPRA feed and are not feasible without revenue.

---

## Companion (not a scraper, but a major tool)

### Unified Search — `src/tools/unified-search.ts` (TOOL, NOT SCRAPER)

Cross-collection fan-out tool that queries 12 collections in parallel for ticker, 10 collections for company_cik, 2 for bioguide_id, 1 for recipient_uei. Uses `Promise.allSettled` so one slow source doesn't block the rest. Single MCP call replaces 6-10 sequential tool calls for "tell me everything about X" questions.

- **Identifier coverage:**
  - `ticker` → 11 collections (insider_trades, institutional_holdings, congressional_trades, planned_insider_sales, initial_ownership_baselines, activist_ownership, material_events, proxy_filings, xbrl_fundamentals, tender_offers, registration_statements)
  - `bioguide_id` → 2 collections (congressional_trades, annual_financial_disclosures)
  - `company_cik` → 10 collections (insider_trades, planned_insider_sales, initial_ownership_baselines, activist_ownership, material_events, proxy_filings, xbrl_fundamentals, private_placements, registration_statements, nport_filings)
  - `recipient_uei` → 1 collection (federal_contracts)

If Derek's project also wants a unified_search equivalent: the adapter pattern in `src/tools/unified-search.ts` is dead simple — array of `{name, call: (q, limit) => promise | null}` adapters, each returning null when the identifier doesn't apply.

---

## Stable patterns shared across all scrapers

These are conventions that hold across all 24 scrapers. Lifting them into Derek's codebase one-time will pay back across the whole port.

1. **Rate-limit helper:** `const sleep = (ms) => new Promise(r => setTimeout(r, ms))`. Call before every HTTP request. SEC and EDGAR want ≥150ms between requests; FINRA wants ≥200ms; FRED is unspecified but 200ms is polite.

2. **User-Agent:** SEC's EDGAR + EDGAR FTS + EDGAR submissions API + data.sec.gov ALL require an identifying User-Agent. They block bare bots. Default to `"KeyVexMCP/0.1 contact@keyvex.com"` style. CFPB + OCC + FDIC + Federal Register need browser-style UAs (CloudFront challenges otherwise).

3. **`fast-xml-parser` settings:** When parsing SEC XML (Form 4, Form 144, Form 3, 13D/G, XBRL): ALWAYS set `parseTagValue: false` AND `parseAttributeValue: false`. Otherwise numeric-looking strings (CUSIPs, ticker codes) get auto-coerced to numbers and corrupted.

4. **Idempotent saves:** Every `save*` function uses `batch.set(doc, data, { merge: true })`. Batch size 400 (Firestore limit is 500). Re-runs upsert cleanly. Doc IDs are deterministic from source data so the same observation lands at the same doc ID every time.

5. **Stub mode:** `isStubMode()` checks for absence of `secrets/service-account.json`. Each `save*` throws if called in stub mode; each `query*` returns empty results. Useful for local dev without credentials.

6. **Cloud Function deployment:** Each scraper has an `onSchedule` Cloud Function in `functions/src/index.ts`. Memory typically 512 MiB; XBRL + OIG bump to 1 GiB. Timeout 9-30 min. `retryCount: 0` because we have daily retries via the next cron tick.

7. **Service-key authentication on Cloud Functions:** `firestore.ts` auto-detects GCP runtime via `process.env.K_SERVICE`/`FUNCTION_TARGET`/`FUNCTION_NAME` and uses `applicationDefault()` instead of the local service-account.json. Mirror this if Derek's project mixes local + Cloud Function deployment.

8. **Secrets in Cloud Functions:** API keys (MCP_API_KEY, FEC_API_KEY, CONGRESS_API_KEY, BLS_API_KEY, FRED_API_KEY) use `defineSecret` from `firebase-functions/params` + `.value()` at runtime. Set via `firebase functions:secrets:set NAME --data-file=-` piping the value from stdin.

---

## What's NOT included in this handoff

The MCP-server side (HTTP transport, tool registry, server-setup) is specific to KeyVex's product positioning. Derek's project doesn't need it — the scrapers are the data layer; the dashboard reads from Firestore directly.

The unified_search tool is similarly product-specific. Useful pattern but only relevant if Derek's project wants a federated query surface for its own UI/agent.

The CLAUDE.md project memory file has additional context but it's KeyVex-specific operational notes — not needed for the scraper port.

---

**Questions Derek's Claude might have:**

- **Q:** Why a separate `xbrl-universe.ts` file vs. inline list?
- **A:** Universe membership is a curation decision that changes quarterly. Isolating it makes the dependency clear; multiple files (scrape.ts, functions/src/index.ts) import the same constant.

- **Q:** Why merge:true everywhere?
- **A:** Idempotency. Same scraper running twice produces the same doc IDs; merge:true upserts cleanly without duplicates.

- **Q:** Why composite Firestore indexes per query shape?
- **A:** Firestore requires composite indexes for any query combining ≥2 fields. KeyVex's `firestore.indexes.json` has ~80 indexes total. The cost is paid at write time (negligible) for sub-second read times on cross-cutting queries.

- **Q:** Should Derek's project preserve KeyVex's "source_url" provenance field?
- **A:** Strongly recommend yes. Every record traceable to its source-of-record filing makes compliance / audit / agent-trust work cleanly. Costs nothing at scrape time.

---

**Generated:** May 14, 2026 (Day 10 LATE — autonomous batches 1 + 2 + 3 inclusive). KeyVex repo: https://github.com/gregorywglenn-spec/Keyvex-API at commit `89a361e` (v0.42.0, 33 MCP tools, 24 scrapers covered in this doc + a few smaller ones the dashboard project already has). Reach out via `contact@keyvex.com` if any of this needs clarification.

**Day 10 summary for Derek's Claude:** 5 new scrapers (FEC Schedule A, FEC Schedule E, USAspending grants, CFTC COT, SEC FTD) + 2 enhancements on existing scrapers (FTC source added to `enforcement-actions.ts`, Senate XML branch added to `congress-legislation.ts`). The political-alpha loop is closed via the FEC scrapers (donations → trades → votes → contracts). Options-adjacent surface is now covered for free public data (CFTC futures positioning, SEC FTD short-squeeze signals). Real options data — chains, IV, greeks — remains paywalled via OPRA and is deliberately out of scope. Two real gaps logged for v1.1: Form 4 derivative table not yet ingested; N-PORT primary-doc XML not yet parsed. Both are 2-3 hr lifts done right.
