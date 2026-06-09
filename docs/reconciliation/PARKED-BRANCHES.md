# Parked branches — stranded work, intentionally deferred (not forgotten)

Found 2026-06-08 during the post-merge branch audit (after `main` was finally
synced to production). These remote `claude/*` branches have commits NOT on
`main`. Recorded here so they're tracked, not lurking.

## Out of scope for the data/MCP deep-dive — revisit later
- **`claude/tender-hertz-255404`** (25 commits, last 2026-05-11) — COMMERCIAL/launch
  work: pricing tiers ($0/$29/$99/$499), landing page, Privacy Policy, logo/mascot,
  competitor comparison. A month old; much may be superseded. Greg's call (branding/
  pricing), to do when launch work resumes. **Do not blind-merge** — could overwrite
  newer landing/pricing decisions.

## Dead ends — do NOT merge
- **`claude/gifted-ptolemy-cd665c`** (3 commits) — the abandoned OAuth 2.1 / WorkOS
  login direction. Project chose authless (`none`); merging would revive a dropped path.
- **`claude/form4-backfill-spike-2026-05-23`** (2 commits) — a labeled throwaway
  "spike"; the real SEC bulk insider loader landed on main separately.

## Small data/MCP items — SETTLED by the sweep (2026-06-09)
- **`claude/bills-detail-fetch-2026-05-23`** (1 commit) — **SETTLED: enhancement,
  not needed for completeness.** The bills reconcile (congress-bills-G1) shows the
  bill LIST is 100% complete (16,542/16,542). This branch adds per-bill DETAIL
  enrichment (sponsors, action history) = the documented v1.1 scope (agents follow
  api_url). A nice-to-have, not a gap. Merge only if/when detail enrichment is
  prioritized — and re-base it first (it's 2+ weeks stale).
- **`claude/fec-indexes-2026-05-22`** (1 commit) — **DEAD, DO NOT MERGE.** Verified
  2026-06-09: its `firestore.indexes.json` was cut from a far older base and would
  DELETE ~250 live production indexes (4,143 → 1,655 lines) if merged. The real need
  (FEC composite indexes — see `fec-schedule-ae-NOTES.md` finding #2) must be met by
  ADDING targeted indexes to the CURRENT file, never by merging this branch.

The sweep was the right test (does the data/MCP actually deliver?) — it settled
both without merging stale branches, exactly as intended.
