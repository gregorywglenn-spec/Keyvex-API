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

## Tracking signal for v1.1

Each item above has a known fix. None are launch blockers — the v0.47.0 fix
pass already addresses them at the *transparency* layer (tool descriptions
explaining limitations, Bug #6 coverage_warning surfacing empties). v1.1 polish
sessions can take them in any order; #1 (bills introduced_date) auto-resolves
via tomorrow's cron with no action.
