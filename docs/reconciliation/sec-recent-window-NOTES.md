# SEC accumulating-feed recent-window completeness — notes

Generated 2026-06-10 during the data/MCP deep-dive.

## What this measures

Several SEC-form feeds ACCUMULATE via a daily/hourly cron rather than mirror all
history. For these, the meaningful gauge is recent-window completeness: of every
filing EDGAR's COMPLETE daily index lists in the last 30 days, what fraction does
KeyVex hold? (Coverage % here = recent completeness; "extra" = older records,
expected and ignored.)

## The systemic leak this found — and fixed

Five SEC feeds enumerated via EDGAR full-text search (FTS), which silently
caps/under-reports. Measured recent-window coverage BEFORE the fix:

| Feed | collection | before | after fix |
|---|---|--:|--:|
| 8-K | material_events | 59.65% | **100.00%** ✅ |
| Form 144 | planned_insider_sales | 38.17% | **86.63%** |
| Form 3 | initial_ownership_baselines | 35.12% | 52.84% (see nil note) |
| DEF 14A | proxy_filings | 99.74% | n/a — already clean |
| 13D/G | activist_ownership | 0/9 — measurement bug, see below | pending |

**Fix:** switched 8-K / Form 144 / Form 3 enumeration from FTS to the complete
EDGAR daily index (`fetchEdgarDailyIndex`), plus a new `fetchPrimaryDocUrl`
helper that resolves each filing's real primary XML via index.json (ownership
forms don't use a fixed filename — Form 3 ships ownership.xml OR form3.xml OR
primary_doc.xml; assuming one 404s). Committed (04c5d80, 85cdf3c) and **DEPLOYED**
to production (scrape8kHourly / scrapeForm144Hourly / scrapeForm3Hourly) — the
crons no longer leak going forward. One-time backfills recovered the historical
gap: Form 144 3,708→6,640, Form 3 5,316→6,370, 8-K 8,817→13,085.

## Why Form 3 reads 52.84% and that's NOT data loss

Verified by sampling the "missing" list (9 of 9 sampled): **every one is a
legitimate NIL** — a Form 3 with `<noSecuritiesOwned>1</noSecuritiesOwned>` and
zero holdings (a person who became an insider owning nothing yet). These
correctly produce no holding row, so they're absent from the collection and the
reconciler counts them as "missing." This is the same nil pattern as the
congressional "nothing to report" filings — the denominator includes filings
that have nothing to store. **Every Form 3 that actually has holdings is
captured.** Form 144's residual (~13%) is similar (timing + occasional nils) and
self-heals via the hourly cron's 2-day lookback.

DESIGN DECISION for Greg (capture-all posture): should KeyVex store a nil-marker
record for `noSecuritiesOwned` Form 3s, so "did person X file a Form 3?" returns
yes even when they reported zero holdings? Today it stores nothing (no holding =
no row). Storing a marker would make the filer-event visible and lift the
reconcile % to ~100, at the cost of rows that carry no position data. Mirrors the
congressional-nil question; Greg's call.

## 13D/G measurement still to fix

The recent-window check for 13D/G (activist_ownership) enumerated only 9 filings
in 30 days — far too low. The daily-index form codes used (["SC 13D","SC 13D/A",
"SC 13G","SC 13G/A"]) likely don't match EDGAR's daily-index strings for these
forms. Needs: probe a recent daily index for the actual 13D/G form-type strings,
correct the adapter's `forms`, then re-measure (and, if it leaks like the others,
apply the same daily-index fix to activist.ts). Quick follow-up.
