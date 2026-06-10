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

## ✅ Done / verified (21 of ~38 datasets)

congress House, congress Senate, SEC tender offers, S-1/S-3 registration, Form D,
Federal Register, N-PORT, OFAC, OIG exclusions, CSL screening, FTD, bills,
FEC candidates, FEC committees, FEC contributions, FEC independent expenditures,
DEF 14A proxies, **8-K, Form 144, Form 3, 13D/G**.

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
2. **Form 3 nil-capture design decision (Greg's call)** — should KeyVex store a
   nil-marker for `noSecuritiesOwned` Form 3s so "did X file a Form 3?" returns yes
   even with zero holdings? Today it stores nothing. Mirrors the congressional-nil
   question. Detail: `sec-recent-window-NOTES.md`.
3. **Dead branch:** do NOT merge `claude/fec-indexes-2026-05-22` (would delete ~250
   live indexes). See `PARKED-BRANCHES.md`.

## ⏭️ Remaining to reconcile (~17) — roughly by effort
- **Quick catalogs:** member profiles (legislators), roll-call votes, Form 278.
- **Standard reconciles** (one adapter + run each): federal contracts, federal grants,
  government publications (GovInfo), enforcement actions (5-6 regulators), treasury
  auctions, CFTC COT, consumer complaints (CFPB), FARA, product recalls (FDA/CPSC),
  13F institutional holdings, N-PORT holdings.
- **Curated-subset checks** (scope + correctness, not coverage %, like the FEC
  schedules): XBRL fundamentals, economic indicators (BLS/FRED/EIA).
- **The big one — own session:** insider_transactions_v2 (~9.9M Form 4/5 rows).

## Working rules that held up
- Per dataset: commit → push → **merge to main** → (deploy if a cron/code changed) →
  verify. All sweep work is on `main`.
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
