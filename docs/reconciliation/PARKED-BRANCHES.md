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

## Small data/MCP items — let the SWEEP settle them (don't do git archaeology)
- **`claude/bills-detail-fetch-2026-05-23`** (1 commit) — adds bill detail enrichment
  (touches `congress-legislation.ts`). Revisit when reconciling the **bills** dataset:
  if bills are missing detail, this is the source.
- **`claude/fec-indexes-2026-05-22`** (1 commit) — adds FEC Firestore composite indexes
  + small tool tweaks. Revisit when reconciling **FEC** datasets: if an FEC MCP query
  fails with INDEX_MISSING, this branch has the fix.

The right test for the last two is the reconciliation sweep (does the data/MCP
actually deliver?), not merging stale branches.
