# XBRL fundamentals — curated-subset check (2026-06-10)

**Verdict: 132/132 universe tickers explained — 131 present and current,
1 (STLA) classified legitimate. Two recoverable gaps found, root-caused,
fixed, backfilled (7,363 observations), and the weekly cron redeployed.**

Curated dataset (132-ticker universe × ~40-concept us-gaap watchlist), so
the gauge is scope + freshness, not a coverage %.

## Method (reproducible: `.tmp/xbrl-check.ts`)

Census `xbrl_fundamentals` per ticker (count + latest period_end) vs
`XBRL_UNIVERSE`; staleness threshold 140 days (quarter-end + 10-Q lag);
flagged items classified against SEC's own records.

## Findings

1. **BRK.B: ZERO records** (the universe's flagship class-share ticker).
   Root cause: SEC's `company_tickers.json` changed its class-share
   convention — BRK.B is now listed as **`BRK-B` (hyphen)**, not `BRKB`
   (the dot-stripped form the Day-9 lesson recorded and getTickerInfo
   tried). Lookup failed silently every weekly run. FIX: getTickerInfo now
   tries hyphen first, then the legacy dot-strip. ⚠ Cross-scraper sweep
   follow-up: other scrapers' dot-strip fallbacks (form144/form8k/13f
   getTickerInfo variants) may have the same quiet breakage for class-share
   inputs — tracked in SWEEP-STATUS.
2. **MMC: ZERO records.** Root cause: Marsh & McLennan CHANGED ITS TICKER —
   SEC's submissions record for CIK 62709 lists `MRSH` / NYSE (same pattern
   as Fiserv → FI). The universe entry was stale. FIX: universe updated to
   MRSH with a comment.
3. **STLA "stale" (latest 2025-12-31, only 9 obs): LEGITIMATE.** Stellantis
   is a foreign private issuer — files an annual 20-F under IFRS, so (a)
   annual cadence means 2025-12-31 IS current, and (b) the us-gaap concept
   watchlist only matches its `dei` shares-outstanding concept (IFRS facts
   live in the ifrs-full namespace, out of v1A scope). Documented, not a
   gap. If IFRS filers matter later, the watchlist needs ifrs-full twins.

## Re-verify

`npx tsx .tmp/xbrl-check.ts` → 328,027 observations, 131/132 ok + STLA
classified, 0 missing, 0 orphan tickers. Spot-verify any value against the
record's source (SEC companyfacts for the CIK).
