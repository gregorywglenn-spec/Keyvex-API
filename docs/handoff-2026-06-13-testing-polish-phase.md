# Handoff — 2026-06-13 — entering the TESTING & POLISH phase

Cold-boot this first, then `CLAUDE.md` + `docs/reconciliation/SWEEP-STATUS.md`.
Trust git + the live endpoint over this narrative — re-derive after any restart.

## State at handoff (verified, not asserted)

- **Git:** clean. `origin/main` == local == branch
  `claude/congress-house-reconciliation-2026-06-08`, all at `2278a2d`.
  0 ahead / 0 behind. Nothing to commit, push, merge, or deploy.
- **Live:** `https://mcp.keyvex.com` → `status:ok, version:0.52.1, tools:38`.
  All function changes are deployed; production and `main` are in sync.
- **Reconciliation sweep: COMPLETE — 38 of 38 datasets** verified against
  source, each with a reproducible checker + clickable report in
  `docs/reconciliation/`. The data layer is audited end-to-end. No coverage
  gaps remain open; everything left in SWEEP-STATUS "Tracked follow-ups" is
  polish, not a hole.
- **No background process is required.** All ingestion runs as scheduled
  Cloud Functions on GCP; nothing depends on this machine staying awake.

## This phase: test & polish the MCP server

The build + data-audit phases are closed. The goal now is to harden and
refine the live MCP server (`mcp.keyvex.com`, 38 tools) for real agent use.

**Working loop:**
- **claude.ai (the wire client / "ClaudeAI") drives the testing.** It runs
  real searches/queries against the live MCP tools, and reports back what it
  finds — wrong/empty results, confusing tool descriptions, missing filters,
  slow queries, anything that trips up an agent — plus any recommendations
  to improve the server.
- **This Claude Code session implements.** Take each finding/recommendation,
  reproduce it against the live endpoint or locally, root-cause it, fix it,
  and ship it the same way the sweep did: **commit → push → merge to main →
  deploy if a cron/function/tool changed → re-verify live.** Same audit bar:
  the builder is never the grader — verify against source/live, sample before
  concluding, don't just document.
- Findings will arrive conversationally from Greg relaying claude.ai's
  results. Treat each as a ticket: reproduce, fix, verify, report back what
  changed and how it was confirmed.

**Likely shapes of findings (anticipate, don't assume):** tool-description
clarity (an agent picked the wrong tool / wrong filter), result correctness
on a specific query, coverage_warning wording, latency on substring-scan
collections, identifier-cascade gaps in `unified_search`, missing filter
params. Reproduce each on the live wire before changing code.

## Already teed up for polish (from the sweep) — SWEEP-STATUS "Tracked follow-ups"

0. **Scale-safety audit (TOP candidate).** The N-PORT era drain exposed a
   bug *class*: unbounded `.collection(x).get()` snapshots and
   accumulate-then-save loops that OOM / stack-overflow once a collection or
   a single record gets large. N-PORT is fixed (stream the diff, stream the
   save, loop-not-spread). Audit the siblings BEFORE they bite in prod:
   13F holdings, XBRL fundamentals, the bulk loaders. Grep `.get()` on big
   collections + `push(...spread)`.
1. FEC Schedule E polish (null cycle, missing no-cycle index, $9.99B
   sentinels) — `fec-schedule-ae-NOTES.md`.
2. Form 278 content-parse enrichment (~16.7K metadata-first records;
   overnight job, `merge:true` layers content on safely).
3. Class-share-hyphen lookup sweep — SEC switched class tickers to hyphens
   (BRK-B); fixed in xbrl.ts, may lurk in form144/form8k/form3/13f.
4. 13F amendment-removal orphans (clear-quarter-before-amendment-write).
5. FARA positional-fpIndex doc-id scheme (drift risk if SEC reorders).
6. 1-index production-vs-file drift — never `firebase deploy
   --only firestore:indexes --force` until reconciled.
7. N-PORT HTML-exhibit parser — SHELVED. One-off (PIMCO PCPI pre-launch
   seed; `nport-holdings-NOTES.md`); Quiver exposes no ETF N-PORT portfolio
   either, so not a competitive gap. Revisit ONLY if the marker count grows
   (`nport_filings where holdings_extraction_status ==
   "no_structured_holdings"`; today: 1).

## Standing context (unchanged)

- DOJ runs OFF GCP via GitHub Actions → `dojIngest` (justice.gov IP-blocks
  GCP egress) — see `project_gov_sites_blocking_gcp_egress.md`.
- Greg's rules: plain-English + analogies; tell the ugly truth; don't quote
  weeks for hours of work; pure-publisher posture (no derived signals);
  session runs `dontAsk` with rm/rmdir/del/gcloud denied.
- Verify-before-asserting; merge-to-main is part of "done"; no dirty handoff.

## Bootstrap commands

```
git fetch origin && git status --short && git log origin/main -3 --oneline
curl https://mcp.keyvex.com                     # version + tool count
# live tool call (authless): POST tools/call to https://mcp.keyvex.com/
```
