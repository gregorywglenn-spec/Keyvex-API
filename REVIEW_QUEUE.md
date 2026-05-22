# REVIEW_QUEUE.md

Items flagged but NOT fixed in the v0.47.0 fix-pass. Blocked on either source-data
gaps, a Greg decision, or an explicit "v1.1 polish" scope cut.

Each item: what it is, why it's not in v1, what unblocks it, and (where relevant)
a verified status check from today.

---

## 1. Bills — `introduction_date` field + full-text/subject search + backfill

**Scope cut**: introduced_date field IS in the v0.47.0 code (scraper, types, tool,
query). What's MISSING is the data on existing records, because the scheduled
function had not yet run with the new bundle.

**Verified status (2026-05-22, 16:50 ET)**: queried `119-HR-2152` directly. The
record's `scraped_at` is `2026-05-21T11:15:04.234Z` and `introduction_date` is
ABSENT from the record (not even an empty string — the field hasn't been written
yet by the post-v0.47.0 scraper).

  - Last night's cron (2026-05-21 ~6 AM ET) ran on PRE-v0.47.0 code → no
    introduction_date.
  - Today's deploy of v0.47.0 landed ~16:30 ET.
  - **Next `scrapeCongressLegislationDaily` cron run is the first with the new
    code** — it will re-pull the full 119th Congress and merge-write
    `introduction_date` on every record via the bill_id idempotent key.

**Two action options for Greg**:

  a. **Wait for tomorrow's cron** (default; no action). Bills will have the field
     populated by mid-morning tomorrow.
  b. **Trigger the scheduled function manually now** via Cloud Functions Console
     → `scrapeCongressLegislationDaily` → "Test the function" / "Run". ~30-60
     minute runtime. Same end-state as (a), just faster.

**Full-text / subject search**: separate v1.1 polish item. Requires ingesting
congress.gov's `policyArea` + `subjects` sub-resources (separate API calls per
bill) and storing them as queryable arrays. Significant new ingestion work +
new array-contains-any indexes. Not in v1 scope.

---

## 2. OFAC SDN — `designation_date` field

**Source-data gap**. OFAC's basic `SDN.csv` (https://www.treasury.gov/ofac/downloads/sdn.csv)
publishes 12 columns and does NOT include the entry's designation date. The date
lives in the advanced XML at `sdn_advanced.xml` and on the "Recent Actions" page
of ofac.treasury.gov. Adding it requires a parallel XML-parsing ingestion path
plus a backfill rewrite of all ~25K SDN records.

**Current state**: documented honestly in the `get_ofac_sdn` tool description as
of v0.47.0:

> *"WHAT'S NOT IN v1A: the schema does NOT include designation_date... v1.1
> polish will add advanced-XML ingestion to capture designation_date. Also:
> there's no since/until filter and no date sort option for the same reason."*

**Unblocks**: v1.1 polish session — write `ofac-sdn-advanced.ts` scraper that
parses the XML format, extend `OfacSdnEntry` type with `designation_date`,
extend `queryOfacSdn` with since/until filters, run a backfill that overwrites
every record. ~3-4 hours.

---

## 3. Lobbying — null `income` on in-house filers (rankings methodology)

**Greg decision needed, not a code fix**. LDA mandates a hard split: third-party
lobbying firms report `income` (what client paid them); in-house corporate
lobbying departments report `expenses` (what they spent). In KeyVex's data,
~30% of filings have income, ~70% have expenses, mutually exclusive.

So `sort_by=income` ranks only the third-party-firm population. A true "top
lobbying spenders" leaderboard for any sector needs to combine both. Three
candidate behaviors:

  a. **Status quo** (current v0.47.0): expose `income` and `expenses` as separate
     fields, agents sum client-side. Tool description documents the split.
  b. **Add server-side derived `total_lobbying_spend`**: scraper writes
     `income + expenses` into a new numeric field. Becomes sortable. Backfill
     pass needed across all existing lobbying records.
  c. **Add a `sort_by="total_spend"` option that does the sum at query time**:
     in-memory only, no schema change, but doesn't survive Firestore-side
     ordering for large result sets.

**Recommendation**: (b) for the cleanest agent UX. Requires a one-time backfill
run after the scraper change. ~30 min code + scraper backfill.

**Status**: documented honestly in the `get_lobbying_filings` tool description
as of v0.47.0:

> *"Income vs expenses (IMPORTANT for ranking by spend): the LDA mandates a
> hard split... sort_by=income ranks the third-party-firm subset; for an actual
> top-spenders leaderboard, agents should fetch both populations and sum
> income + expenses per filing client-side. v1.1 polish will add a derived
> total_lobbying_spend field that does this sum server-side for indexed
> queries."*

**Greg's call**: pick (b) or (c) for v1.1 priority. (a) ships today as-is.

---

## 4. CFPB — historical depth (rolling 8 days vs requested 90+)

**Already scoped — confirmed tracking**. The `consumer_complaints` collection
holds 2026-05-10 to 2026-05-18 (8 days) because the daily scraper runs with a
2-day window. The Bug #6 `coverage_warning` (v0.47.0) explains this to agents
when they query for an older window.

**Tried, blocked**: attempted a manual `--since=2026-02-21` backfill today
(2026-05-22). Hit V8 string-length error because the CFPB public API at
`consumerfinance.gov/data-research/consumer-complaints/search/api/v1/`
IGNORES the `size` parameter — a single request with a 90-day `date_received_min`
returned **945 MB** of JSON in one response (verified empirically). Even
14-day chunks exceed V8's 512 MB string-length cap.

**Real v1.1 fix**: switch from the search API to the bulk CSV download at
https://files.consumerfinance.gov/ccdb/complaints.csv.zip. Streaming CSV
parser + chunked-write to Firestore. ~1-2 hours of scraper rewrite.

**Confirm**: yes, tracked. Not attempting again in this pass.

---

## 5. 13F scraper coverage gap — only 18 funds, all big-caps absent

**Data gap surfaced by Greg's WFC test (2026-05-22)**. `get_institutional_holdings(ticker="WFC")` returns 0. Root cause is NOT a CUSIP→ticker enrichment issue (the `ticker` field IS populated on every doc) — it's a **scraper coverage gap**.

The `institutional_holdings` collection holds **903 docs across only 18 distinct funds**, all small specialty managers. Of the 10 "tracked aliases" the scraper is supposed to ingest (berkshire / blackrock / vanguard / bridgewater / citadel / point72 / deshaw / renaissance / twosigma / millennium), **only Berkshire is actually present**. BlackRock / Vanguard / etc. — all ABSENT.

That's why WFC returns 0: WFC IS held by BlackRock and Vanguard at massive scale, but those funds' 13F filings haven't been ingested.

**v1.1 fix**: investigate why the 13F scheduled scraper is only running against Berkshire + Harvest + Park West + Energy Income Partners + Diker + Bruce + Washington Capital + Hermes + Viking + Tekla + Coastline + Atlas Brown + Lane Five + Broadwood + Trafelet + Matrix + New Generation + Garcia Hamilton. The fund-alias list in `src/scrapers/13f.ts` should include the 10 tracked aliases above; verify why they're not being ingested. Probably either: (a) CIK lookup is failing for those, (b) `13f-feed` is only scraping a subset, (c) the scheduled function only fires on a subset.

**Confirmed**: not a query bug, not a ticker bug — purely scraper coverage. Captured here so Greg can prioritize the scraper investigation separately.

---

## 6. Default-orderBy INDEX_MISSING — broader sweep needed (v1.1)

**Context** (2026-05-22 commit `<this commit>`): the v0.47 audit found 38 (filter × default_sort) combos returning `INDEX_MISSING`. Greg's recommended split:
  - **(i) Query-builder fix**: skip default orderBy when only equality filters are present
  - **(ii) Provision composite indexes** for the genuinely-needed money-ranking queries

This commit applies (i) to `queryInstitutionalHoldings` only (the function Greg specifically reported) plus adds 8 high-value composite indexes for (ii). The remaining ~25 query functions follow the same pattern and need the same (i) treatment.

**Why I didn't sweep all 30 functions in this pass**:
  1. The bug bites hardest on numeric-default queries (`institutional_holdings.market_value`) — fixed now
  2. Date-default queries DO regress in UX when default orderBy is dropped (recency lost on equality-only queries) — needs a per-function decision about whether to client-side-sort after fetch
  3. The mechanical diff across 30+ functions deserves a focused PR with its own smoketest matrix

**What needs to happen next pass**:
  - Apply `applyOrderByConditionally()` helper to the other ~25 query functions
  - For date-default tools, decide per-tool whether to also client-side sort after fetch to preserve "most recent first" UX
  - Add a battle-test that hits every (equality_field × default_sort) combo and asserts no INDEX_MISSING

**Audit table of remaining 38 combos** stored in `scripts/audit-indexes.ts` — re-runnable any time via `npx tsx scripts/audit-indexes.ts`. Re-run after each pass to see what's left.

---

## 7. Full-text search architecture — build vs. buy (v1.1, Greg's call)

**Surfaced by Greg's 2026-05-22 AI-query bug.** Naive substring matching (`.toLowerCase().includes()`) on short query tokens produces ~93% false positives — "AI" matched inside maintaining, Chairman, training, Air, aiding, against, remain, claiming, etc. Confirmed across two unrelated collections (bills, enforcement_actions) — treat as a server-wide architectural property.

**Shipped today as INTERIM mitigation** (`matchesSubstringSafe` helper, commit `<this commit>`):
  - Short needles (≤3 chars, including 2–3 char acronyms): require word-boundary match (regex `\b`)
  - Long needles (≥4 chars): unchanged substring behavior
  - Applied to all 62 substring filter sites in `firestore.ts`
  - Reproducible smoketest at `scripts/smoketest-substring-tokenization.ts` (43/43 PASS)
  - End-to-end repro: enforcement_actions text="AI" went 15→2, bills title="AI" went 243→5

**The interim is good for v1, NOT good for v1.1+.** Limitations baked in:
  - Word-boundary still misses "AI" inside glued compounds (RoboticAI → no match) — acceptable false-negative for the false-positive win, but not great UX
  - Long-needle substring still has rare collisions (e.g. "Trump" inside "trumped-up" matches)
  - No relevance ranking (alphabetical / chronological surface ordering)
  - No fuzzy / typo tolerance ("AAPL" vs "APPL")
  - No phrase ranking ("artificial intelligence" as a 2-word concept gets no special treatment vs random co-occurrence)
  - No language analysis (stemming, stopwords, synonyms — "AI" and "machine learning" are searched separately)

**Two real solutions, Greg's call**:

**(a) Build: precomputed keyword arrays per document at ingestion** (~1-2 weeks)
  - Run a tokenizer (split on whitespace + punctuation, lowercase, dedupe, strip stopwords) on each ingested doc
  - Store as a `keywords: string[]` field
  - Query via Firestore's native `array-contains` — no external system, no extra cost
  - Limitations: still no fuzzy / phrase / ranking, but token-level matches become indexable + fast
  - Estimated cost: ~10-20% storage increase, ~1 hr per scraper to wire in the tokenizer pass + a backfill run per collection
  - Suits the pure-publisher posture well — every transform is reproducible, no third-party retains your data

**(b) Buy: third-party search service (Typesense / Meili / Algolia / Elastic)** (~3-5 days integration)
  - Dual-write each ingested doc to both Firestore and the search service
  - Substring queries delegate to the search service via REST
  - Get fuzzy / phrase / ranking / suggest / etc. for free
  - Cost: ranges from free (self-hosted Meili) to $80-500/mo (Algolia at moderate volume)
  - Operational footprint: extra service to monitor + reconcile if dual-write desyncs

**Recommendation**: (a) for v1.1 — fits the architecture's idempotent-recompute philosophy, no recurring cost, no external data dependency. (b) becomes attractive only if/when fuzzy + ranking become real customer asks; revisit on signal.

**Status**: Greg's recommendation in the bug report was "ship the word-boundary interim now; SHELVE the full-text-search infra decision to REVIEW_QUEUE.md for me (it's a build vs buy call + cost)." Done as specified.

---

## 8. federal_contracts + federal_grants — backfill the historical universe (HARD-FLAG)

**Surfaced by Greg's 2026-05-22 Lockheed Martin diagnosis.** `get_federal_contracts(recipient_name="Lockheed")` returned 6 records, max $42M, has_more=false. Greg correctly retracted his earlier "truncation" hypothesis and traced it to scraper COVERAGE: the indexed `recipient_uei` path returned the same shallow data, proving the prefetch window is not the limit — the data simply isn't there.

**Confirmed root cause** (verified in code today): `src/scrapers/usaspending.ts:scrapeContractsLiveFeed(lookbackDays=7)` posts a `time_period: [{start_date: <today-7>, end_date: today}]` filter to USAspending's `/api/v2/search/spending_by_award/` endpoint. That filter is interpreted as `action_date` window — only contract actions (new awards, modifications, options exercise) whose `action_date` falls in the last 7 days come back. The daily cron at 6:10 AM ET ingests up to 1,000 records per run (10 pages × 100). Same shape on `scrapeUSAspendingGrantsDaily` for grants.

**Direct probe of the live collection** (`scripts/diag-fc-coverage.ts`):
  - Date range stored: **2026-04-29 → 2026-05-20** (~22 days as residue of recent crons; older records get displaced as the rolling window advances)
  - Top awards in entire collection: $35B Triad National Security, $30B Battelle Memorial, $27B Savannah River, $25B Battelle Energy, $22B Boeing — all big contracts that *happened* to have a recent modification
  - Lockheed Martin entries: 6 records, max $42M — coincidence that LMT had no big mods this window; the underlying F-35 / SR-71 multi-billion contracts aren't surfaced because they weren't modified recently

**Today's honesty fix** (commit `<this commit>`): added `SHALLOW_COVERAGE_NOTICES` registry to `withCoverageWarning`. Every query against `federal_contracts` or `federal_grants` now returns a `coverage_warning` describing the rolling-window limitation + pointing to https://www.usaspending.gov/search for full history. Fires whether results are empty or non-empty. Verified by `scripts/smoketest-shallow-coverage.ts` (5/5 PASS).

**v1.1 real fix (scraper-side)**: add a recipient-backfill mode that, when a query targets a specific recipient_uei / recipient_name, kicks off a one-shot deep pull via USAspending's `/api/v2/search/spending_by_award/` with NO time_period filter for that entity. Cache the result. Triggers + storage to be designed.

---

## 9. Latent: client-side-substring-after-prefetch may silently truncate on DEEP collections (verify-before-fix)

**Greg's 2026-05-22 caveat**: the pattern in many query functions is *fetch wider Firestore window → client-side substring filter → client-side sort → trim to limit*. On THIN collections (today's federal_contracts) this is fine because the prefetch window contains everything. On DEEP collections (fec_contributions, lobbying_filings, congressional_trades, bills) it COULD produce partial-window rankings: the top-N by amount within the prefetch window may not be the true top-N by amount across the full collection.

**Greg's explicit instruction**: "verify, do NOT assert". Don't fix until confirmed.

**Verification plan** (next session can run):
  1. Pick a deep collection with substring filter — `lobbying_filings.client_name` is the natural candidate (51K records, $5M+ income range, substring is heavy use case)
  2. Run a TIGHT client-side substring (expected to return < 5000 rows) sorted by income DESC — confirm top-3 has the largest incomes
  3. Run a LOOSE client-side substring (expected to return > 5000 rows) sorted by income DESC — capture the top-3
  4. Bump the fetchLimit ceiling locally (say from 5000 → 20000), re-run #3 — if the top-3 by income changes, truncation is real

If confirmed real, the fix is one of:
  - (a) Raise fetchLimit dynamically based on observed prefetch density
  - (b) Use the result-set-streaming pattern (paginate Firestore cursor, accumulate matches, sort at end)
  - (c) Document the upper bound on substring queries + recommend tighter filters for ranking

This is NOT scoped for v1 because no customer report has confirmed it bites. Keep it on the radar for the v1.1 architecture pass that's already on this list as item 6 (default-orderBy sweep).

---

## 10. congressional_trades — `reporting_lag_days` semantics (calendar vs business days)

**Greg's 2026-05-22 observation**. The field's name reads as calendar days, but the values look like business days:

  - Kelly: transaction → disclosure = **42 calendar days**, field reads `30`
  - Meuser: 27 calendar → field reads `19`
  - Cohen: 16 calendar → field reads `12`

All three fit calendar-minus-weekends. Field is undocumented in the tool description / schema; agents must guess which convention is in use.

**Why this matters**: the STOCK Act statutory window is **45 calendar days** transaction → disclosure. If `reporting_lag_days` is business days, an agent (or downstream compliance product) using `reporting_lag_days > 45` as the "late filing" check will UNDERSTATE late filings — a row at 60 calendar days would read `42` business and slip past the threshold.

**Decision needed (Greg's call)**:
  a. **Switch to calendar days** — re-derive from `transaction_date` / `disclosure_date` at ingestion, no schema change. Backward-compatible value change (numbers go up); agents using the field for compliance checks become correct.
  b. **Keep business days but rename + document** — rename to `reporting_lag_business_days`, add explicit note in tool description, add a new `reporting_lag_calendar_days` field for compliance use. Schema-additive.
  c. **Keep as-is + document** — least work, biggest agent-surprise risk; not recommended.

**Recommendation**: (a) — the field name already implies calendar days, fixing the values to match is the lowest-friction "make it correct" path. Greg owns this call because it's a behavioral change.

**Status**: shelved per Greg's instruction ("log the lag-semantics item for me"). No code change in this pass.

---

## Tracking signal for v1.1

Each item above has a known fix. None are launch blockers — the v0.47.0 fix
pass already addresses them at the *transparency* layer (tool descriptions
explaining limitations, Bug #6 coverage_warning surfacing empties). v1.1 polish
sessions can take them in any order; #1 (bills introduced_date) auto-resolves
via tomorrow's cron with no action.
