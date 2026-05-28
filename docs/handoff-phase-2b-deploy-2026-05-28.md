# Handoff — Phase 2b Deploy Session → Next Session (2026-05-28)

**Purpose:** Carryover surface for the session that picks up after the Phase 2b
extension deploy + merge. Captures what is NOT already durable in CLAUDE.md /
memory / the `docs/` design specs — specifically the session-discovered
operational facts and the CLAUDE.md staleness flag. Read this alongside a fresh
Session Bootstrap (`git fetch` / `git branch -a` / `git log origin/main -8`).

---

## Ground-truth state (do not get these wrong)

- **main**: `01ccac3` (merge bubble), origin/main in sync
- **feature branch** `claude/form345-bulk-load-2026-05-23`: `f433759`, origin in sync
- **production** `mcp.keyvex.com`: `GET /` → `{"version":"0.52.1","tools":38,"auth":"none"}`, serving the `f433759` tree content
- **Deploy pattern (load-bearing):** production deploys come from the **feature
  branch directly** via `firebase deploy --only functions:mcp`; `main` is the
  audit-trail backbone, caught up *afterward* via `--no-ff` housekeeping merges.
  Before this session, main was **37 commits behind production**. **Never assume
  `main` == production at a given moment** — verify with `curl mcp.keyvex.com/`.

---

## ⚠ CLAUDE.md IS STALE — highest-value flag

CLAUDE.md's "Last Updated" stamps top out around **May 14–15 / v0.44.0**, and its
`get_insider_transactions` sections describe the **pre-bulk_v2 world**. It does
NOT describe:

- the bulk_v2 default flip (commit `81c5a8a`)
- the Phase A data-integrity engine — `transaction_nature`, `INSUFFICIENT_DATA`,
  honest-by-default filtering (v0.50.0 / v0.51.0 / v0.52.0 / v0.52.1)
- Phase 2a SEC-source-date-convention docs (commit `c4c1192`)
- the Phase 2b read-time `source_metadata` shim (commit `22db470`)
- the Phase 2b period_of_report extension (commit `f433759`)
- the v2 backward-compat shim (`src/tools/insider-transactions-v2-shim.ts`)

**A fresh session that trusts CLAUDE.md's version/architecture claims for
insider-transactions will be designing against a ~2-week-old snapshot that
predates this entire arc.** For anything insider-transactions / bulk_v2 /
Phase A / Phase 2 related, cross-check CLAUDE.md against the `docs/` files
(`phase-2b-*.md`, `bulk-form345-*.md`, `architecture-data-integrity.md`,
`handoff-phase-a-*.md`) + the actual code.

**Recommended follow-up:** a CLAUDE.md refresh commit bringing it current to
v0.52.1 + this deploy. Substantial edit — best as its own focused pass or the
tail of the next session.

---

## Live-surface operational facts (each cost real effort to discover)

1. **MCP POST requires `Accept: application/json, text/event-stream`.** Without
   it: HTTP 406 `"Not Acceptable: Client must accept both application/json and
   text/event-stream"`. Standard MCP StreamableHTTP transport requirement.

2. **`include_non_open_market: true` is REQUIRED to surface gift-class
   (trans_code `G`) and other non-open-market rows.** The v0.51.0 Phase A
   honest-by-default filtering excludes them. The 142 anomalous
   `period_of_report` rows include gift transactions — so verifying the Phase 2b
   shim on those rows needs this flag. (Cost 5 probes to discover this session.)

3. **`npm test` has no script** in package.json — the canonical invocation is
   `npx tsx --test tests/<file>`. (v1.1: add `"test": "tsx --test"` to scripts.)

4. **INDEX_MISSING** on the (ticker + transaction_date, `sort_order: asc`) filter
   combo in the bulk_v2 path. The default-sort works fine; only asc-on-
   transaction_date is missing. (v1.1: add the composite index to
   firestore.indexes.json.)

5. **`until` filter boundary quirk** — `until: "2015-12-31"` returned a row with
   disclosure_date `2016-01-29`. Possible off-by-one / inclusivity bug in the v2
   date-window filter. Worth a focused look.

---

## Standing locks (carry verbatim — all intact)

- Phase B / `heal-worker.ts` — **LOCKED** (code shipped to production but
  **INERT** — does not run)
- Backfill / reconstruction — **permanently CLOSED**
- Re-ingest — **NOT authorized**
- CIK swap — **NOT authorized** (BlackRock CIK-swap is task #7, parked)
- Orphan cleanup — **NOT authorized**
- Axis-7 Issue B (5,000-cap, 30 sites) — **PARKED for B3** tokenized-index
  architectural pass
- 142 `period_of_report` rows — **annotated read-time** via the shim, NOT
  backfilled / rewritten. Source bytes preserved byte-exact.
- `missing_required_field` flag — **designed-for-not-built** (canonical
  first-use-case dissolved this session: the 6 insider_trades rows have
  `disclosure_date` populated; legacy schema doesn't declare `filing_date`)
- **Only Greg's explicit gos authorize production writes.** Every commit /
  deploy / merge this session was individually gated. No step self-authorized
  from the previous step's success.

---

## Queue (next work)

- **Top: Axis-7 B3** — tokenized-index architectural pass (the parked Issue B)
- Task #7: BlackRock CIK swap + orphan rename (parked, needs explicit go)
- Task #9: Scope-D explicit-TRACKED_FUNDS branch decision (parked)
- **v1.1 polish batch** (discovered this session):
  - add `"test": "tsx --test"` to package.json scripts
  - add the (ticker + transaction_date asc) composite index
  - investigate the `until` filter boundary quirk
  - add an `include_non_open_market: true` note to the get_insider_transactions
    tool description (so agents know how to surface flagged gift / non-open-
    market rows)
  - functions/ npm audit vulnerabilities (15: 1 low / 13 moderate / 1 high)
  - CLAUDE.md refresh (see staleness flag above)

---

## Re-verification anchor (re-confirm the deploy without re-deriving)

```
curl -s https://mcp.keyvex.com/   →   {"version":"0.52.1","tools":38}

Phase 2b shim live-check (the query shape that took 5 probes to find):
  tools/call get_insider_transactions with arguments:
    ticker = UPS
    reporting_owner_name = Abney
    data_source = bulk_v2
    since = 2014-01-01
    until = 2015-03-31
    include_non_open_market = true
  → accession 0001225208-15-002577 returns 3 rows, each with
    source_metadata.period_of_report = ["anomalous_year_likely_filer_entry"]

  (POST must include header: Accept: application/json, text/event-stream)
```

---

## What this session accomplished (brief context)

Built the Phase 2b extension — `period_of_report` coverage on the read-time
source-metadata shim (one `DETECT_FIELDS` entry + one `FUTURE_THRESHOLDS` entry
+ doc housekeeping; no new flag type, no new function, no type-side change) +
7 unit tests + the extension design spec
(`docs/phase-2b-extension-period-of-report-design.md`).

Drafting passed through **5 Standing-Protection-#1 payouts** (each restage
surfaced an under-verified detail until the spec recognized the per-class
population paragraph wanted to be smaller, not more precise): APD fabrication →
6× undercount + suppressed filing-agent finding → Class 2 tuple cross-check
failure → 9-singleton inference unverified → de-specification. Every
load-bearing claim that shipped traces to enumerated source evidence in the
`.tmp/` diagnostics.

Then the full push-gate sequence: feature-branch push → deploy from feature
branch to live → version probe → behavior verification (both halves green) →
`--no-ff` housekeeping merge to main (`01ccac3`). Deploy verified live via the
Abney accession returning correctly-annotated source_metadata blocks.

**Diagnostics preserved (untracked) in `.tmp/`:** `sample-parked-rows.ts`,
`cluster-142.ts`, `epoch-subpopulation.ts`, `singleton-enum.ts`. These hold the
per-class population counts deliberately omitted from the spec; query them if a
future use-case needs the breakdown.
