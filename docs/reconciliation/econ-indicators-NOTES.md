# Economic indicators (BLS / FRED / EIA) — curated-subset check (2026-06-10)

**Verdict: CLEAN. 54/54 cataloged series present; every series current within
its publisher's lag; values eyeball-sane; the Day-10 EIA unit caveat resolved
as CORRECT.**

This is a curated-watchlist dataset (like the FEC schedules), so the gauge is
scope + correctness, not a coverage %: does `economic_indicators` hold every
series the three catalogs claim, with current data?

## Method (reproducible: `.tmp/econ-check.ts`)

Census the collection per series_id (count, latest period label, latest
value) and diff against `BLS_SERIES_CATALOG` (19) + `FRED_SERIES_CATALOG`
(30) + `EIA_SERIES_CATALOG` (5).

## Results

- **Presence: 54/54** — no cataloged series missing, no orphan series beyond
  the catalogs (collection has exactly 54).
- **Freshness (as of 2026-06-10):** BLS monthlies at 2026M05 (May CPI/jobs —
  current), quarterlies at 2026Q01 (current). FRED dailies at day-of-year
  159/160 = Jun 8-9 (current), weeklies at W22-23 (current), GFDEBTN at
  2025Q04 (matches FRED's own quarterly publication lag — Q1'26 lands ~mid
  June). EIA weeklies at W22-24 (current), crude production at 2026M03
  (matches EIA's ~2-month monthly lag).
- **Spot-sane values:** UNRATE 4.3, DGS10 4.56, GDP $31.82T, WTI 93.45,
  MORTGAGE30US 6.48 — all in-range for June 2026.
- Verify any series yourself: compare `get_economic_indicators(series_id:X,
  latest_only:true)` against the series' `source_url` on the record.

## Day-10 caveat RESOLVED — EIA crude-production unit label is CORRECT

The open v1.1 note questioned whether `EIA-CRUDE-OIL-PROD-MONTHLY`'s
"thousand barrels per day" label mislabeled a monthly total. Verified: the
2026M03 value is **13,696**, and US field production in March 2026 is
~13.7M b/d — so the value IS thousand-barrels-per-day (a daily rate).
Label correct; caveat closed.

## Status

Audited 2026-06-10, no fixes needed. The daily crons (BLS/FRED/EIA) are
keeping all three sources current.
