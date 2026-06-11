# Reconciliation deep-dive — living status (start here)

**Last updated: 2026-06-10.** Read this first to continue the data/MCP reconciliation
sweep. Goal of the sweep: prove every dataset/tool does what it claims (coverage +
correctness), and fix gaps. "The builder is never the grader" — reports list source
links; Greg verifies by clicking.

## How to run it

- `npx tsx scripts/reconcile.ts <adapter>` — runs one dataset, writes
  `docs/reconciliation/<adapter>-G1.{html,csv,md}` (+ `-extras.csv` when there are
  stale/extra records). `--list` shows all adapters. `--classify=all|N` classifies
  the missing list (recoverable/nil/gone) where an adapter supports it.
- `npx tsx scripts/reconcile-ftd.ts` — the one bespoke checker (FTD is period-level,
  not per-id).
- Adapters live in `src/reconcile/adapters/` and are registered in `index.ts`.
  Generic engine: `src/reconcile/reconciler.ts`; shared EDGAR helpers:
  `src/reconcile/sec-edgar-index.ts` (`fetchEdgarFilingsByForm`,
  `fetchEdgarDailyIndex`, `fetchPrimaryDocUrl`).

## ✅ Done / verified (36 of ~38 datasets)

congress House, congress Senate, SEC tender offers, S-1/S-3 registration, Form D,
Federal Register, N-PORT, OFAC, OIG exclusions, CSL screening, FTD, bills,
FEC candidates, FEC committees, FEC contributions, FEC independent expenditures,
DEF 14A proxies, 8-K, Form 144, Form 3, 13D/G, **member profiles (legislators),
roll-call votes, Form 278 (annual financial disclosures), CFTC COT,
treasury auctions, FARA, GovInfo publications, CFPB complaints (live
passthrough + total_count), **federal contracts + federal grants (live
passthrough audited + upgraded — same treatment as CFPB), product recalls
(100.00% after the report_date window fix), enforcement actions (100.00%
recent-window after reviving two silently-dead cron legs), **13F tracked
funds (100.00% supersession-aware), economic indicators (54/54 clean)**.

### 2026-06-10 session (cont.) — 13F: 53.03% → 100.00% (three backfill bugs + a gauge insight)
New `sec-13f-tracked` adapter (filing completeness for the 10 watchlist
funds vs EDGAR submissions incl. older chunks). Baseline 53.03%; root
causes in `scripts/backfill-13f.ts`:
1. `--dry` runs CHECKPOINTED — the real run then skipped everything
   previewed (Berkshire: 45/45 skipped, saved 0; the flagship fund had 87
   rows). Checkpoints now write only on real saves.
2. Enumeration read only EDGAR's recent-1000 block — heavy filers'
   (BlackRock/Vanguard) older 13F-HRs live in paginated chunks. Now walked.
3. Newest-first processing made ORIGINALS overwrite AMENDMENTS (doc ids are
   `13f-{fund}-{cusip}-{quarter}` — same-quarter filings collide by design,
   last writer wins). Now oldest-first so the latest filing survives.
Re-backfilled ~617K rows (Vanguard 223K, BlackRock 187K, Berkshire 57/57
filings). Gauge insight: superseded accessions are LEGITIMATELY absent, so
the adapter measures "latest filing per fund-quarter present" — re-verified
**100.00% (492/492 quarters)**. `sec-13f-tracked-G1.html`.

- **economic indicators (BLS/FRED/EIA)**: curated check — 54/54 cataloged
  series present, all current within each publisher's lag, values sane.
  Day-10 EIA crude-production unit caveat RESOLVED as correct (13,696
  thousand b/d ≈ 13.7M b/d daily rate). `econ-indicators-NOTES.md`.
- **XBRL fundamentals**: 132/132 universe tickers explained (131 current +
  STLA legitimate: IFRS 20-F annual filer). Two recoverable gaps fixed +
  7,363 obs backfilled: BRK.B (SEC's catalog switched class shares to
  HYPHENS — BRK-B — breaking the dot-strip lookup silently) and MMC
  (Marsh & McLennan changed ticker to MRSH — verified vs SEC submissions;
  universe updated). scrapeXbrlWeekly redeployed. `xbrl-NOTES.md`.

### 2026-06-10 session (cont.) — enforcement: 38.79% → 100.00%; two dead legs revived
Recent-window adapter (the six regulators' LIVE feeds = denominator, 243
items) found 142 missing and two production failures the per-source
try/catch had been hiding from the health check:
- **DOJ leg dead since ~2026-05-15 — VERIFIED UNFIXABLE FROM GCP
  (2026-06-11)**: the browser-header retry did NOT work (today's 6:35 cron:
  0 DOJ docs; OCC's new RSS leg worked: 10 docs). A disposable `dojProbe`
  function then proved justice.gov 401s ALL surfaces (API, RSS, homepage,
  full browser headers) from GCP egress — an IP-range block. NO header
  trick can fix this; DOJ needs a NON-GCP runner. **Decision for Greg**,
  options: (a) GitHub Actions daily cron running the DOJ pull (cleanest —
  repo already on GitHub; requires putting a scoped service-account key in
  Actions secrets, and Azure-runner IPs are UNVERIFIED against the same
  WAF — test first); (b) a tiny Cloudflare Worker fetch-proxy (new vendor;
  CF egress also unverified); (c) scheduled task on Greg's machine
  (residential egress — guaranteed but machine-dependent). INTERIM: the
  4,000-release local backfill covers ~May 15→Jun 10; the gap regrows
  daily until a runner is picked — a manual `npx tsx .tmp/doj-topup.ts`
  style pull bridges it whenever run locally.
- **OCC leg dead since ~2026-05-22** — OCC retired the per-year index pages
  (404). Fix: switched to OCC's RSS feed (same nr-* release URLs → same
  action_id slugs, existing docs merge).
Re-verified **100.00% (243/243, 0 missing)**; extras (2,768) are the
accumulated history older than the rolling feeds — the collection's value,
not staleness. scrapeEnforcementDaily redeployed. Note: OCC has a dedicated
Enforcement Actions Search tool (apps.occ.gov/EASearch) — a richer future
source than press releases; noted, not built. `enforcement-recent-G1.html`.

### 2026-06-10 session (cont.) — product recalls: 99.99% → 100.00% + cron bug fixed
Denominator = openFDA bulk download zips (file-based full-index rule) +
CPSC's single full JSON: 95,579. Baseline 99.99% with 5 missing — all fresh
2026 publications, which exposed a REAL cron bug: the daily FDA scraper
windowed on `recall_initiation_date`, but FDA classifies recalls months to
YEARS after initiation (one 2026-published device recall carries a 2011
initiation date), so anything published after its initiation aged out of
the lookback was permanently missed (the 2026-06-05 bulk backfill masked
it). Fixed: window on `report_date` (publication time); 14-day re-scrape;
re-verified **100.00% (95,579/95,579, 0 extras)**; scrapeFdaRecallsDaily
redeployed. Note: per-feed manifest counts run exactly 1 higher — each feed
has one blank-recall_number record, skipped identically by scraper and
adapter. `product-recalls-G1.html`.

### 2026-06-10 session (cont.) — federal contracts + grants live-path upgrade
Greg's standing posture (per CFPB): live passthrough is the architecture;
cron-fed cache is the fallback. The audit found the 2026-06-06 live paths
under-pushed (only recipient+date floor server-side, 200-row page, no
totals). Upgraded both (mirrors CFPB):
- **total_count** from `spending_by_award_count` — authoritative volume over
  the full USAspending dataset for the filtered query; fetched IN PARALLEL
  with the page pull (serializing blew the 8s budget). liveFirst timeout
  12s for these two (USAspending is slower than CFPB).
- **Server-side pushdown, all probe-verified 2026-06-10:** recipient name,
  NAICS, PSC, min-amount, last_modified_date bounds (time_period
  date_type), all four sort fields, and — grants — CFDA via
  `program_numbers`, which matches the award's FULL assistance-listings
  array (first probe looked like wrong-CFDA rows; second probe proved
  list-semantics, not breakage). Residual client-side: recipient_uei,
  awarding_agency, dates on non-last_modified sorts → total omitted there.
- Live-wire verified: contracts Lockheed total_count=681,466; grants CFDA
  93.847 total_count=19,213. Tool descriptions updated; mcp redeployed.
- Like CFPB, the warehouse-coverage question is moot by design — coverage =
  USAspending's own dataset; the cron-fed cache only serves outage fallback
  (flagged + not-volume-safe).

### 2026-06-10 session (cont.) — CFTC COT + treasury auctions + FARA + GovInfo
- **govinfo-recent** (30d window): 78.89% → **100.00%** (1,042/1,042). Root
  cause: the scraper's `maxPerCollection` default (500) silently truncated
  GovInfo bulk-reprocessing days — the hidden-cap pattern. Fixed (default
  5000 + LOUD truncation log per no-silent-caps), 1,279-package backfill,
  `scrapeGovInfoDaily` redeployed. GAOREPORTS legitimately 0 in window
  (dormant archive — verified 200-with-zero, not an error). NOTE for local
  runs: `GOVINFO_API_KEY` was missing from `secrets/.env` (DEMO_KEY fallback
  = 30 req/hr 429s); now copied in from Secret Manager. 291 extras =
  older-than-window accumulation, normal. `govinfo-recent-G1.html`.
- **fara** (registrant-level, snapshot): 99.64% (554/556), 0 unexplained — the
  2 missing are the two NEWEST registration numbers (7734/7736, registered
  after Sunday's weekly cron; self-heals). 11 extras = registrants terminated
  since ingest — pruning-vs-keep-as-history is a Greg call (tracked below).
  `fara-G1.html`.
- **cftc-cot**: 100.00% (147,670/147,670), 0 missing, 0 extras, all 13 exchange
  codes populated. Window = the 2026-06-06 backfill's 10-year floor. The
  (previously uncommitted) `scripts/backfill-cftc-cot.ts` landed with this.
  `cftc-cot-G1.html`.
- **treasury-auctions**: 99.97% (10,998/11,001) over FULL fiscaldata history
  (1979→present), 0 extras. The 3 missing are this week's bills (one auctioned
  today, two tomorrow) — cron timing, self-heals. TIPS/FRN are FLAGS upstream,
  not security_type values (source vocabulary is Bill/Note/Bond only) — flag
  capture cross-counted exactly: TIPS 265/265, FRN 151/151.
  `treasury-auctions-G1.html`.

### 2026-06-10 session — quick catalogs, both 100%
- **legislators** (snapshot dataset): 536/536 current members, 0 missing,
  0 stale extras (436 House + 100 Senate). `legislators-G1.html`.
- **roll-call-votes** (113th–119th, both chambers): 9,924/9,924, 0 missing,
  0 extras (4,981 House + 4,943 Senate). Denominator reuses the scraper's list
  endpoints, so the House side was ALSO independently cross-checked against the
  House Clerk's own records (clerk.house.gov `roll517.xml` exists / `roll518.xml`
  404s → 2024 really ended at 517, matching). Senate side is canonical
  senate.gov vote-menu XML. `roll-call-votes-G1.html`. Note: `--years` on this
  adapter means CONGRESS numbers (113–119), not calendar years.

### Biggest finding — RESOLVED: the FTS enumeration leak (5 SEC feeds)
Five feeds enumerated via EDGAR full-text search, which silently caps/under-reports.
Recent-window coverage before → after the fix (switch to complete daily index +
`fetchPrimaryDocUrl` for the real doc filename, backfill, redeploy the cron):
- 8-K 60%→**100%** · Form 144 38%→**87%** · Form 3 35%→high(nils) · 13D/G 34%→**98.6%** · DEF 14A already clean.
- ~16K recovered. All crons (scrape8kHourly, scrapeForm144Hourly, scrapeForm3Hourly,
  scrapeActivistHourly) redeployed. Form D + N-PORT were fixed the same way earlier.
- Detail: `sec-recent-window-NOTES.md`. Snapshot lists (OFAC/OIG/CSL) also made
  self-pruning + deployed; detail in their G1 reports + commit history.

## Tracked follow-ups (NOT lost; do when prioritized)
1. **FEC Schedule E polish** — cycle field is null on many rows (cycle filter
   undercounts), a missing no-cycle index, and $9.99B sentinel amounts. Detail:
   `fec-schedule-ae-NOTES.md`. (A spawn_task chip existed; restart cleared it — this
   note is the record.)
2. ~~Form 3 nil-capture~~ **RESOLVED + IMPLEMENTED 2026-06-10** (Greg: store
   nil-markers). parseForm3Xml emits one `is_nil_filing:true` marker row
   (doc id `{accession}-{ticker}-NIL`) when a Form 3 carries zero holdings;
   30-day re-walk wrote 2,724 rows; sec-form3-recent re-verified
   **52.84% → 100.00%** (1,622/1,622). include_baseline description
   documents nil semantics. scrapeForm3Hourly redeployed.
3. **Dead branch:** do NOT merge `claude/fec-indexes-2026-05-22` (would delete ~250
   live indexes). See `PARKED-BRANCHES.md`.
4. ~~FARA terminated-registrant policy~~ **RESOLVED + IMPLEMENTED
   2026-06-10** (Greg: keep + status flag). 12 docs across the 11 departed
   registrants flagged status:"terminated" (+termination_observed_date);
   `markTerminatedForeignAgents` wired into scrapeFaraWeekly with a <50%
   partial-scrape safety guard; `status` filter added to get_foreign_agents
   (+2 composite indexes); fara reconcile adapter scoped to active.
   Re-verified: extras 11 → 0. Cron + mcp redeployed.
5. **Index drift (1)** — `firebase deploy --only firestore:indexes` on
   2026-06-10 reported 1 index in production that is NOT in
   firestore.indexes.json. Additive deploys are safe; NEVER run with
   --force until the file is reconciled to mirror production (capture
   `firebase firestore:indexes`, diff, add the missing entry).
6. **Class-share ticker convention sweep** — SEC's `company_tickers.json`
   switched class-share tickers to HYPHENS (BRK-B; BRKB is gone), which
   silently broke xbrl.ts's dot-strip lookup (fixed there 2026-06-10 with a
   hyphen-first fallback). Other scrapers carry the same dot-strip pattern
   (form144/form8k/form3/13f getTickerInfo variants) — sweep them for the
   same quiet breakage on class-share inputs.
7. **13F amendment-removal orphans** — doc ids are per (fund,cusip,quarter);
   an amendment that REMOVES a position leaves the original's row behind
   under a stale accession. Proper fix = clear-quarter-before-amendment
   write semantics (touches live save paths — own decision/session).
8. **FARA doc-id scheme uses positional fpIndex** (`fara-{reg}-{fpIndex}`) —
   if the FARA API ever reorders a registrant's principal array, re-runs
   would write the same pair under a different id (drift/dupes). Sturdier id:
   hash of (reg, principal_name). Low urgency; revisit if dupes appear.
6. ~~CFPB scope decision~~ **RESOLVED 2026-06-10**: Greg chose live
   passthrough + cron-fed fallback cache. Implemented: `total_count`
   (CFPB's authoritative hits.total over the full 15.7M-row DB) + full
   server-side filter pushdown on the live path; verified on the wire
   (wells fargo → total_count 168,909). Cron unchanged. Detail:
   `cfpb-NOTES.md`. Two decisions still open from this batch: FARA
   keep-with-status-flag (approved — implementation pending) and Form 3
   nil-markers (approved — implementation pending).

### 2026-06-10 session — Form 278: 12.12% → 99.99%+ (root-caused, fixed, backfilled, deployed)
Baseline reconcile found **12.12%** (2,221 / 18,327). Three root causes, all fixed
in `src/scrapers/form278.ts`:
1. **House "O" (annual original) excluded from ingestion** — `HOUSE_FD_FILING_TYPES`
   was {A,C,H,T}; the flagship member-annual type was never ingested. Added O
   (+ letter→"Annual" mapping).
2. **House index-year off-by-one** — the Clerk index is keyed by COVERED year;
   annuals for CY y are FILED in y+1 (verified: a CY2024 "O" carries FilingDate
   4/29/2025 in the 2024 index). The cron only fetched the window's own years, so
   the May annual wave was invisible even where the type was in scope. Now fetches
   [startYear−1 … endYear].
3. **eFD `submitted_end_date` is EXCLUSIVE** (verified by probe: [d,d] → 0 rows,
   [d,d+1] → d's rows) while `ScrapeOptions.endDate` is documented inclusive —
   every window silently dropped its last day. Now sends end+1day.
Plus: Senate history before 2016 had never been backfilled (467), and no House
historical backfill had ever run (~15.6K).

**Backfill:** `scripts/backfill-form278.ts` (resumable; metadata-first) — 16,739
filings saved (Senate 2012-2015/2019/2026 + House index years 2015-2026).
Re-verify: **99.99% (18,326/18,327, 0 extras)**; the 1 straggler (a 2013 Udall
paper filing eFD listed inconsistently between runs) recovered on a targeted
re-run. Report: `form278-G1.html`.

**Adapter lesson (fixed in `src/reconcile/adapters/form278.ts`):** the first
denominator bisected windows with INCLUSIVE ends — with eFD's exclusive end
that drops every midpoint day; the tell was 172 "extras" clustering on exactly
three mass-filing days. eFD start/length pagination IS honored for this query
shape, so windows are now half-open + paged, no bisection.

**Follow-up (tracked):** content-parse enrichment pass over the ~16.7K
metadata-first backfill records — re-run `scripts/backfill-form278.ts` with the
progress file cleared and parseContent on (~6-8h, overnight job; `merge:true`
layers content onto existing docs without touching ids).

## ⏭️ Remaining to reconcile (~2)
- **N-PORT holdings era catch-up** — in flight 2026-06-10 (resumable
  `scripts/backfill-nport-holdings.ts`; cron healing + NPORT-EX-URL fix
  deployed); re-verify coverage-by-day when it drains.
- **The big one — own session:** insider_transactions_v2 (~9.9M Form 4/5 rows).

## Working rules that held up
- Per dataset: commit → push → **merge to main** → (deploy if a cron/code changed) →
  verify. All sweep work is on `main`.
- **No dirty handoff.** Never end a chunk / hand off with a dirty `git status` or
  undocumented loose ends — the BORING housekeeping is what rots silently. Clean it
  to zero (commit keepers / gitignore+untrack runtime files / delete *verified*-stale
  artifacts) or record it explicitly here. Prefer eliminating over documenting.
- Snapshot/current-state lists (sanctions/exclusions/screening): watch BOTH directions
  — missing AND stale extras; prune stale on full refresh (with a <50% safety guard).
- Accumulating SEC feeds: the meaningful gauge is recent-window completeness (does the
  cron leak?), not all-of-history.
- A low coverage % is not automatically data loss — sample the "missing" and classify
  (nil vs timing vs real gap) before concluding. Form 3's "53%" was ~all nils.
- Permissions: session runs `dontAsk`; deny list = rm/rmdir/del/gcloud (use PowerShell
  Remove-Item for cleanup). Deploys/scrapers/git/reconciles auto-approve.
- Don't run two EDGAR-heavy jobs concurrently (429s); deploys need a free machine or
  the 10s init analysis can time out.
