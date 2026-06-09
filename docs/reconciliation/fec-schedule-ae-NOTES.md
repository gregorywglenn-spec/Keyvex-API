# FEC Schedule A (contributions) + Schedule E (independent expenditures) — reconciliation notes

Generated 2026-06-09 during the data/MCP deep-dive.

## Why these aren't a coverage-% gauge

Unlike catalog datasets (candidates, committees, bills), FEC Schedule A and E
are **deliberate curated subsets**, not complete mirrors of FEC:

- **Schedule A (contributions)** — collection `fec_contributions`, **5,022 docs**.
  KeyVex ingests **$1,000+ only** (the cron's default floor, to skip
  payroll-deduction memo noise) over a **recent rolling window** (records span
  ~2025-05 → 2027-04, i.e. cycle 2026). FEC itself has ~130M contribution rows
  per cycle; KeyVex intentionally holds a thin, recent, large-dollar slice. A
  "coverage %" against full FEC would be meaningless — the scope is the point.
- **Schedule E (independent expenditures)** — collection
  `fec_independent_expenditures`, **322,772 docs**, spanning **2014 → 2026**.

So the gauge here is **scope + correctness + does the MCP serve it**, not a
≥98% completeness floor.

## Live MCP verification (2026-06-09, via mcp.keyvex.com)

- `get_fec_contributions(cycle=2026, sort_by=contribution_receipt_amount desc)`
  → real data, no error. Composite index (cycle + amount) present and working.
- `get_fec_independent_expenditures(sort_by=expenditure_amount desc)` → real
  data, no error (single-sort, auto-indexed).
- `get_fec_candidate_profile` → verified earlier (catalog adapters).

**Both tools serve data.** The MCP behaves; the issues below are data/scope
polish, not "the tool is broken."

## Findings (real, worth fixing — none is a missing-data gap)

1. **IE `cycle` filter silently undercounts.** Many `fec_independent_expenditures`
   rows have `two_year_transaction_period: null` (and `report_year: null`) — the
   field the `cycle` param filters on. So `get_fec_independent_expenditures(cycle=2024|2026, support_oppose='O')`
   returns 0 even though oppose-ads exist. The reliable date field is
   `expenditure_date` / `dissemination_date`. **Fix options:** (a) derive a
   cycle from `expenditure_date` on ingest and store it, or (b) document that
   `cycle` is unreliable for IE and steer agents to `since`/`until` date filters.
   Recommend (a).

2. **Missing index: IE `support_oppose` + amount/date WITHOUT cycle.**
   `get_fec_independent_expenditures(support_oppose='O', sort_by=expenditure_amount)`
   (no cycle) → `INDEX_MISSING`. "Top oppose-spends across all cycles" is a
   reasonable query. **Fix:** add composite indexes to `firestore.indexes.json`
   for the IE equality filters (support_oppose / candidate_id / committee_id /
   candidate_office_state) each paired with expenditure_amount and
   expenditure_date (no-cycle variants), then deploy. Same pattern worth
   mirroring for Schedule A equality filters.

3. **Sentinel amounts in IE.** Top-by-amount IE rows carry
   `expenditure_amount: 9999999999` ($10B) — FEC source placeholder/garbage on
   some F24 24-hour notices. Faithfully preserved (pure-publisher posture), but
   it pollutes amount-sorted results. **Fix option:** a `source_metadata` flag
   marking the sentinel (KeyVex's interpretation, never altering the source
   value), so agents can filter it. Do NOT silently rewrite the value.

## Parked branch disposition

- **`claude/fec-indexes-2026-05-22` — DEAD, do not merge.** Verified 2026-06-09:
  its `firestore.indexes.json` was cut from a much older base (4,143 → 1,655
  lines) and would **DELETE ~250 live production indexes** (activist_ownership,
  etc.) if merged. The legitimate need behind it (FEC composite indexes, finding
  #2) should be satisfied by **adding** targeted indexes to the CURRENT
  `firestore.indexes.json`, never by merging this stale branch.

## Verdict

Schedule A/E **serve real data via the MCP** and hold their intended curated
scope. Three polish items (IE cycle field, IE no-cycle index, IE sentinel
amounts) are logged above for a focused follow-up — none blocks; none indicates
missing data.
