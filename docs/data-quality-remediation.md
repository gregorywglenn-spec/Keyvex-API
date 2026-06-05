# KeyVex Data-Quality Remediation Board

**The living checklist for fixing every scraper/capability to verified completeness.**
Created 2026-06-03 after a side-by-side test (KeyVex vs Quiver vs the authoritative
government sources) exposed systemic data holes. This is the single source of truth —
we mark each item off only when it's **verified against the source**, not when it "looks
populated."

## ✅ RESOLVED (2026-06-05) — insider was ALREADY complete (the "2022+ gap" was false)

**The premise was wrong.** `insider_transactions_v2` (SEC bulk Form 345, **9.9M rows,
2006→2026q1**, loaded 2026-05-24) is complete, and the MCP tool `get_insider_transactions`
**defaults to it (`bulk_v2`)** — so insider coverage has been complete + served in
production since 2026-05-24. AAPL in v2: 4,782 (full history).

**The trap that wasted a day:** `insider_trades` (the legacy daily feed) is NOT what the
tool serves. Auditing that obvious-named collection (165K, thin) and concluding "insider is
broken" was wrong. The 2016–2021 bulk loaded into `insider_trades` on 2026-06-04 is
**redundant** (duplicate of v2; tool ignores it). **STANDING LESSON for this whole audit:
check what the TOOL queries (the query fn's collection), not the obvious-named collection.**
Optional: delete the redundant `insider_trades` rows to save storage (not urgent; ask Greg).

_(Historical note: the section below was the original deferral plan — now moot.)_

**Why deferred — doc-ID scheme mismatch would create duplicates:**
- Bulk loader id = `{accession}-{SK}` (SEC transaction SK from the TSV).
- Deployed Form 4 cron (`src/scrapers/form4.ts` `parseForm4Xml`; functions
  `scrapeForm4HalfHourly` + `scrapeForm5Daily`) id = `{accession}-{txDate}-{code}-{ndIdx}`
  (non-deriv) / `{accession}-D-{txDate}-{code}-{dIdx}` (deriv).
- Existing ~165k "2022+" `insider_trades` feed records use the cron scheme AND have
  garbage dates (years like 0023 / 2034).

**The fix (one deliberate session — a deploy is involved, so needs Greg's go):**
1. Choose ONE deterministic, content-based doc-id both paths compute identically — NO
   parse-order index — e.g. `{accession}-{N|D}-{txDate}-{code}-{round(shares)}-{acqDisp}`.
   Both the bulk TSV and the cron XML carry all those fields.
2. Update `src/scrapers/form4.ts` `parseForm4Xml` to emit that id.
3. Update `scripts/backfill-form4-bulk.ts` to emit the SAME id.
4. **Redeploy** the Form 4/5 cron functions (`firebase deploy --only functions:scrapeForm4HalfHourly,scrapeForm5Daily`) — gated, ask Greg.
5. Extend the bulk `QUARTERS` cap (currently ends 2021q4) to present, run it → it
   overwrites the garbage-date 2022+ feed records with clean, complete data, dedup-safe.
6. Verify: AAPL insider count jumps 114 → ~550+; all dates clean YYYY-MM-DD; no dup
   transactions per accession; cron keeps topping off latest with the same id (no dupes).

**Done = complete clean `insider_trades` 2016→present + cron top-off with no dupes.**

## 📌 DECISION (2026-06-04) — contracts/grants = PASS-THROUGH, not mirrored

USAspending federal **contracts (~1.86 GB/yr)** + **grants (~1.28 GB/yr)** are too large
to mirror cost-effectively (full = ~$100+ writes + ~$20–40/mo storage forever; slow-scrape
reaches the same storage bill, just deferred). **DECIDED (Greg):** serve them via **live
pass-through to the USAspending API** (free, complete, always current); keep only the small
recent-window cache we already have for fast common queries. Do **NOT** let the daily cron
accumulate full history (that's the storage trap). Bulk download stays the **fallback** if
pass-through ever fails or gets too slow. Rationale: cost then scales with *usage* (what
subscriptions pay for), not as dead fixed storage. Budget alert is set in Firebase.

**IMPLEMENTATION PENDING (needs MCP redeploy — gated, ask Greg):** wire
`get_federal_contracts` / `get_federal_grants` to call USAspending live for queries outside
the recent cache; stop the cron from hoarding history.

**Same split applies to FEC (verified 2026-06-04):** the FEC bulk files at
`fec.gov/files/bulk-downloads/{cycle}/` divide cleanly —
- **BULK (cheap, do it):** candidate master `cn` (0.3 MB), committee master `cm` (0.8 MB),
  cand-committee linkages `ccl` (0.1 MB), committee→candidate `pas2` (23.5 MB). Completes
  the candidates / committees / PAC-to-candidate-money picture for ~25 MB.
- **PASS-THROUGH (giant):** individual contributions `indiv` = **4 GB/cycle** (Schedule A,
  ~100M+ rows/decade) → serve via FEC Schedule A API, not mirrored. PAC contributions
  `oth` (482 MB) → bounded or pass-through.
General rule established: **small reference data → bulk; transaction firehoses → pass-through.**

## 🔬 VERIFIED COVERAGE AUDIT + CORRECTION QUEUE (2026-06-05)

Full per-collection audit run (`.tmp/audit-all.ts`), then false-positives re-verified.
**Method lesson applied: check what the TOOL serves, not the obvious-named collection.**

**✅ COMPLETE / served (no action):** insider (`insider_transactions_v2` 9.9M 2006→2026),
lobbying (905K), institutional_holdings (802K), congressional_trades (68K 2014→2026),
xbrl_fundamentals (324K 2006→2026), oig_exclusions (83K), annual_financial_disclosures
(278), economic_indicators (17.8K 2018→2026 — audit misdetected via scraped_at; real
`period` field shows history), bills (current 119th Congress), + reference lists
(ofac_sdn, screening_list, fec_candidates/committees, legislators/historical).

**⚠️ CORRECTION QUEUE — recent-only, bulk-fixable (verify-first each, build dedup-safe loader, queue under supervisor):**
| Collection | Now | Fix | Source verified? |
|---|---|---|---|
| private_placements (Form D) | 3.7K / ~25d | SEC Form D bulk (`form-d-data-sets/YYYYqN_d.zip`), merge by accession | ✅ YES (schema in hand) |
| product_recalls | 537 | openFDA bulk download | ⬜ |
| treasury_auctions | 47 | TreasuryDirect API history | ⬜ |
| federal_register_documents | recent | Federal Register API history | ⬜ |
| consumer_complaints | ~23d | CFPB API history | ⬜ |
| sec_fails_to_deliver | April only | SEC FTD bi-monthly files, more history | ⬜ |
| registration_statements (S-1/S-3) | 317 | EDGAR — per-filing or check for dataset | ⬜ |
| tender_offers | 273 | EDGAR per-filing | ⬜ |
| nport_filings | ~30d | EDGAR N-PORT | ⬜ |
| fec_independent_expenditures | 2.2K | FEC bulk (bounded) | ⬜ |
| material_events (8-K), proxy_filings (685) | thin | EDGAR per-filing (no clean bulk) — pass-through candidates | ⬜ |

**🔁 PASS-THROUGH (decided):** federal_contracts, federal_grants, fec_contributions (also has a future-date `2036` bug to fix).
**🐛/hard:** executive_trades (blank dates + President OCR gap); congressional Khanna-style scanned-PTR OCR (proven, parked).

## ⛔ GOVERNING RULE (set by Greg, 2026-06-03) — read before any scraper work

**Foundation before features. Always.** The root failure here was building scraper after
scraper without the foresight to backfill them — chasing breadth ("another source!")
while the data underneath stayed at ~1%. That stops now.

1. **A scraper is NOT "done" until it is built + backfilled + verified against the source.**
   "Returns data on a sample" is not done. Three legs or it doesn't count.
2. **The backfill is part of building it — never a "later."** Identify the bulk/full source
   up front, as part of the work, the way you don't frame a house before the slab is poured.
3. **NO new scrapers until the existing ones are real.** Zero new sources added until the
   current set is stocked and verified. Fixing what we have comes first, every time.
4. **No "complete" on a vibe or a row count — ever again.** The source-truth check (the
   Costco/NVDA method) is the only thing that flips a row to ✅.

## Strategy (agreed 2026-06-03)

1. **Phase 0 — fix the shared query-layer bug FIRST (once, globally).** Name/company
   substring search only scans the most-recent 5,000 rows then filters in memory, so it
   returns 0 even for data we have (proven: Costco lobbying record exists, tool returned 0).
   This is cross-cutting (~10 tools) and contaminates every per-scraper verification, so it
   must be fixed before the march. Also fix the misleading `coverage_warning`.
2. **Then per-scraper loop, one at a time, priority order:**
   pull source truth (gov API) for N probe entities → 3-way check (source count / in
   Firestore / tool returns) → diagnose (ingestion gap / history gap / parser-skip / query)
   → fix → re-verify against source **and** Quiver (where it overlaps) → mark green.
3. **Oracle hierarchy:** government source = PRIMARY (authoritative, free, unlimited, covers
   all 38; corrected Quiver on Costco). Quiver = secondary cross-check on the ~10 overlapping
   datasets.
4. **Definition of "done" (✅):** the 3 numbers match the source within tolerance for the
   probe entities — NOT "looks populated."
5. **Honest scope:** weeks, not a weekend.

**Status key:** ⬜ not started · 🔧 in progress · 🔬 verifying · ✅ verified-complete · ⛔ broken/empty

---

## 🔄 IN-FLIGHT BACKFILLS (live ledger — keep this straight)

Parallel rule: only ONE backfill per source family at a time (shared rate budget),
but different families run concurrently. Each still must verify against source before ✅.

| Tool | Source family | Started | Status | Window | Notes |
|---|---|---|---|---|---|
| lobbying_filings | LDA | 2026-06-03 | RUNNING (bg) | 2016–2026 | resumable; verify Costco→13, Pfizer→1,745 on completion |
| congressional_trades (House) | House Clerk | 2026-06-03 | RUNNING (bg) | 2016–2026 | House only; Senate half + PDF parser-skip hardening = follow-ups; verify vs Quiver |

Source families (one backfill each can run in parallel): **LDA** · **SEC EDGAR** (insider/13F/144/3/13D-G/8-K/proxy — pick ONE) · **USAspending** (contracts/grants — scope TBD) · **House Clerk / Senate eFD / Congress.gov** · **FEC**.

## Phase 0 — shared infrastructure (do first)

| # | Item | Status | Notes |
|---|---|---|---|
| 0.1 | Replace 5,000-row name-search window with indexed/tokenized name lookup (server-wide: officer_name, member_name, filer_name, fund_name, client_name, registrant_name, recipient_name, company/text) | ⬜ | The single highest-leverage fix. Un-breaks name search across ~10 tools. |
| 0.2 | Fix misleading `coverage_warning` (it implies a full-range search when it only scanned recent N) | ⬜ | |
| 0.3 | Build 3-way verification harness (source API vs Firestore vs tool) + probe-entity sets | ⬜ | Reusable across all collections. |

## Tier 1 — flagship comparables (worst holes, fix first)

| Collection | Status | Source oracle | Known issue (2026-06-03 audit) |
|---|---|---|---|
| congressional_trades | ⬜ | House Clerk XML + Senate eFD (Quiver xcheck) | 68k/2014–2026 but **Swiss-cheese** — NVDA missing Khanna, McCaul, MTG, Mullin, Britt. Parser-skip + completeness. |
| lobbying_filings | 🔧 | LDA API (Quiver xcheck) | 51k but **capped sample** — ~1–2% complete (Pfizer 11/1,745, Lockheed 46/3,152). Comprehensive backfill BUILT (`scripts/backfill-lobbying.ts`, 10-yr window 2016+, resumable). **BLOCKED on free LDA API key** — anonymous tier = 15 req/min (backfill would take ~40h + constant 429s); key tier = 120/min (~5.5h smooth). Register: lda.senate.gov/api/register/ → add `LDA_API_KEY` to secrets/.env → wire auth header → relaunch. NOTE: the daily lobbying cron has also been silently over-rate (500ms = 120/min vs 15/min anon) — the key fixes that too. |
| institutional_holdings | ⬜ | SEC EDGAR 13F (Quiver xcheck) | **1,498 total — badly broken/thin** (13F should be hundreds of thousands). |
| federal_contracts | ⬜ | USAspending (Quiver xcheck) | 23k but **only ~1 month** (Apr 29–Jun 1 2026). No history. |
| insider_trades | ⬜ | SEC EDGAR Form 4 (Quiver xcheck) | 163k/2022+ — large, **completeness unverified**, likely per-entity holes. |

## Tier 2 — important

| Collection | Status | Source oracle | Known issue |
|---|---|---|---|
| federal_grants | ⬜ | USAspending | ~1 month only — no history. |
| proxy_filings | ⬜ | EDGAR DEF 14A (Quiver exec-comp) | 645 — thin. |
| nport_filings / nport_holdings | ⬜ | EDGAR N-PORT (Quiver ETF) | filings recent-only; holdings 297k but recent window. |
| fec_contributions / fec_independent_expenditures | ⬜ | FEC API (Quiver election) | 5k / 2k — verify completeness. |
| executive_trades (OGE 278-T) | 🔬 | OGE | Cabinet/appointee in (3,267); **President/Trump gap** (Track B / OCR). Some blank filing_date. |
| material_events (8-K) | ⬜ | EDGAR | 8k — verify. |
| xbrl_fundamentals | ⬜ | EDGAR companyfacts | 324k — verify completeness per ticker. |

## Tier 3 — KeyVex-unique (verify vs gov source only)

| Collection | Status | Source oracle | Known issue |
|---|---|---|---|
| government_publications | ⛔ | GovInfo | **EMPTY (0 records)** — scraper totally failing. |
| registration_statements | ⬜ | EDGAR S-1/S-3 | **date field undefined** — date queries broken. ~285. |
| private_placements | ⬜ | EDGAR Form D | **date field undefined** — date queries broken. ~3,627. |
| tender_offers | ⬜ | EDGAR SC TO | 266 — thin/recent-only. |
| activist_ownership | ⬜ | EDGAR 13D/G | 8k — verify. |
| planned_insider_sales | ⬜ | EDGAR Form 144 | 3,352 — verify. |
| initial_ownership_baselines | ⬜ | EDGAR Form 3 | 5,089 — verify. |
| enforcement_actions | ⬜ | SEC/DOJ/CFTC/OCC/FDIC/FTC | 404 — RSS rolling, sparse. |
| sec_fails_to_deliver | ⬜ | SEC FTD | 115k but **only April 2026**. |
| cftc_cot_reports | ⬜ | CFTC | ~3 months only. |
| treasury_auctions | ⬜ | TreasuryDirect | **47 — thin**. |
| consumer_complaints | ⬜ | CFPB | recent-only window. |
| federal_register_documents | ⬜ | Federal Register | recent-only window. |
| ofac_sdn | ⬜ | Treasury OFAC | 19k — verify (full list). |
| screening_list | ⬜ | ITA CSL | 26k — verify. |
| foreign_agents | ⬜ | FARA | 1,221 — verify. |
| oig_exclusions | ⬜ | HHS-OIG | 83k — verify. |
| product_recalls | ⬜ | FDA/CPSC | 537 — thin. |
| bills | ⬜ | Congress.gov | 16k — verify. |
| roll_call_votes | ⬜ | Congress/Senate | 1,346 — verify. |
| economic_indicators | ⬜ | BLS/FRED/EIA | 18k — verify. |
| annual_financial_disclosures (Form 278) | ⬜ | Senate eFD | 1,886 — verify. |
| fec_candidates / fec_committees | ⬜ | FEC | 3,478 / 31,471 — verify. |
| legislators / legislators_historical | ⬜ | unitedstates/congress-legislators | reference data — likely OK, confirm. |

---

## Findings log (evidence as we go)

- **2026-06-03 — congressional NVDA:** KeyVex 50+ (capped) back to ~2024; Quiver back to 2016 with members KeyVex omits entirely (Ro Khanna [most frequent], McCaul, MTG, Mullin, Britt). → ingestion/parser-skip + history gap.
- **2026-06-03 — lobbying Costco:** authoritative LDA = 13 filings, 2017–2020 Q1 (Capitol Tax Partners, $70k/qtr; no in-house; nothing post-2020 — Pfizer-2025 control = 56 proves API isn't truncating). KeyVex Firestore = 1 of 13 (ingestion ~8%). KeyVex tool = 0 (query-window bug). Quiver = correct.
- **2026-06-03 — query-window bug confirmed:** `fetchLimit = query.<name> ? 5000 : userLimit+1` across ~10 query fns → name search misses everything older than the recent 5,000 rows.
- **2026-06-03 — SIZING PASS (3-way, source-truth):** scraped collections hold a *tiny recent slice* of the real record, not a comprehensive mirror. High row counts are an illusion of depth (real universes are millions).
  - lobbying: Pfizer 11/1,745 · Lockheed 46/3,152 · Comcast 47/3,080 → **~1–2% complete** (+ query bug).
  - federal_contracts: Lockheed 12/**673,869** · Boeing 7/278,939 → **~0.002% complete** (+ query bug).
  - federal_grants: Johns Hopkins 40/10,402 · Stanford 43/8,994 → **~0.4% complete** (ingestion only; query layer ok here).
  - **Systemic conclusion:** the cron architecture captures only recent windows / capped pulls. Every scraped collection is a thin recent sample. This is a data-completeness *architecture* problem, not a set of isolated bugs — and "mirror everything" is infeasible for the giant sources (USAspending alone = hundreds of millions of awards). Forces a product-scope decision (see strategy note below).

## ⚠️ Strategy inflection (2026-06-03)
"Backfill everything comprehensively" is **not uniformly feasible.** USAspending has hundreds of millions of awards; KeyVex can't (and shouldn't) mirror it. The fix is NOT one-size — it's a per-dataset product decision among:
  - **(A) Make truly comprehensive** — viable for *bounded* high-value sets (congressional, executive 278-T, Form 4 for tracked tickers, FEC, FARA, OFAC, recalls). Backfill fully from source.
  - **(B) On-demand / pass-through** — for giant sources (federal contracts/grants), query the source API live per request rather than pre-mirroring hundreds of millions of rows.
  - **(C) Recent-window, HONESTLY labeled** — if a dataset stays a rolling window, the tool description + coverage_warning must say so plainly ("last 30 days") instead of implying full history.
Decision needed (Greg + brother/Director) before committing the build.
