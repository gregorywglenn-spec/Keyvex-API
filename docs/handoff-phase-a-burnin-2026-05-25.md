# HANDOFF v3 — KeyVex Phase A burn-in + Phase B data-integrity arc

**Paste as the first message in the new Code conversation, or read from `docs/`.**

Ground state verified 2026-05-25. Branch `claude/form345-bulk-load-2026-05-23` @ `08c03b0`, pushed.

Every load-bearing prediction carries a confidence label: **HIGH / CONTRADICTED / UNDETERMINED / SPECULATION**. Treat anything unlabeled as needing verification before you act on it. The Tourniquet applies to our own reasoning — including this document's.

**Verification provenance for this version:** Code ran EDGAR + Firestore cross-checks; the wire-Claude independently confirmed against SEC source-of-truth and its own earlier live-wire reads. Where a fact is triangulated across all three, it's marked HIGH.

---

## What changed v2 → v3 (read first)

1. **The "normal position_change in production" milestone CANNOT happen on this tick** — and not just because Berkshire won't ingest. **None of the 10 tracked funds has a prior-quarter baseline in the store.** Every one trips the false-new guard on re-ingest. The whole tracked set is single-quarter-per-fund (or gapped). See §THE 16:15Z TICK.
2. **Berkshire's gap is TWO consecutive missing periods, not one** (Q3-2025 missing 6+ months AND Q1-2026 missing 10 days). This kills the "30-day window-edge" hypothesis from v2 — the failure is structural. And it weakens v2's combination-report SPECULATION, because Berkshire's Q4-2025 *did* ingest. See §COMPLETENESS BLIND SPOT.
3. **BlackRock's tracked CIK (0001364742) is stale** — latest 13F-HR under it is 2024-06-30 (~22 months ago). Same bug class as the 5 wrong CIKs fixed May 23. Adds a 4th audit axis: TRACKED_FUNDS entity/CIK integrity. See §NEW FINDING.
4. **Vanguard hasn't filed Q1-2026** (independently confirmed via the EDGAR filing list + Code's direct query). Resolves v2 Open Question #4. Its eventual Q1 filing is a useful natural experiment — see §COMPLETENESS BLIND SPOT.
5. **Berkshire is the single cheapest unlock**: its Q4-2025 baseline already exists in store (42 rows), so fixing only its ingestion gap simultaneously delivers (a) completeness, (b) the first real normal-`position_change` production test, and (c) the reconciliation fixture. Triple value from one fix.

---

## Mission (in order)

1. **Fix the data problem.** Phase A's "Tourniquet" tags rows `INSUFFICIENT_DATA` when verification can't be proven. Tags exist; rows aren't yet re-fetched/resolved — that's Phase B (heal worker). Once production cron surfaces real `INSUFFICIENT_DATA` rows, the heal pass closes them: re-fetch → re-parse → recompute deltas → atomically flip to `VERIFIED` (or `FAILED_PERMANENT` after 3 retries).
2. **Continue the complete audit.** Phase A covers Form 4/5, Senate + House (`transaction_nature`), 13F (`verification_status` count check + `position_change` guards). Not yet covered: `insider_transactions_v2`, `congressional_trades` (**57,213 rows**), `institutional_holdings` (**1,353 rows — top-~50/fund capped slice, not full coverage**), `planned_insider_sales`, `activist_ownership`, `nport_holdings`, ~25 others. The audit now has **four axes**, not two: (a) silent **misclassification**, (b) silent **incompleteness/staleness** (Berkshire), (c) the **tool enum gap**, (d) **TRACKED_FUNDS CIK/entity integrity** (BlackRock).

---

## Bootstrap (mandatory, every session)

```
git fetch origin
git branch -a                  # sibling branches are other Claude sessions
git worktree list
git log --oneline origin/main -6
git branch --show-current      # claude/form345-bulk-load-2026-05-23
git log --oneline -6           # head = 08c03b0
git status --short             # clean except pre-existing diag-* + the 2 uncommitted recon scripts (see Open Questions)
```

Latest 6 commits:

```
08c03b0 chore(phase-b): commit Phase A burn-in diagnostic scripts
27a5ddb feat(phase-b): scaffold sync_queue infra + INERT worker + Index Pass
9fb155e fix(v0.52.1): wire-coerce boolean params across all 30 tool sites
6104381 feat(v0.52.0): Phase A scope-gap fix — broaden honest-by-default + INSUFFICIENT_DATA passthrough
2b79545 docs(phase-a): clarify transaction_nature does NOT apply to 13F holdings
c83e806 chore(release): v0.51.0 — Phase A data-integrity engine deployed
```

Feature-only branch; **not merged to main. Do not merge without Greg's explicit sign-off.**

---

## What's deployed where

| Surface | Version | Deployed | Notes |
|---|---|---|---|
| mcp HTTP function | v0.52.1 | 2026-05-25 morning | Phase A READ-side shim live. Wire verified across 5 acceptance cases. |
| scrape13FQuarterHourly | Phase A bundle | 2026-05-25 ~13:00Z | Only function that stamps `verification_status` + `verification_expected/actual` + `position_change=INSUFFICIENT_DATA`. **Has a fund-specific ingestion gap — see COMPLETENESS BLIND SPOT.** |
| scrapeForm4HalfHourly | Phase A bundle | 2026-05-25 ~13:00Z | `transaction_nature` only. Healthy: 2 clean post-deploy ticks (13:27Z + 13:57Z). |
| scrapeForm5Daily | Phase A bundle | 2026-05-25 ~13:00Z | Shares `parseForm4Xml`. Next tick: tomorrow 8:20 AM ET. |
| scrapeSenateDaily | Phase A bundle | 2026-05-25 ~13:00Z | `transaction_nature` via `deriveCongressionalNature`. Next tick: tomorrow 6 AM ET. |
| scrapeHouseDaily | Phase A bundle | 2026-05-25 ~13:00Z | Same. Next tick: tomorrow 6 AM ET. |
| form345-bulk.ts (CLI) | Phase A code | n/a | Stamps `transaction_nature` AND `verification_status`. Manual: `npx tsx src/scrape.ts form345-bulk YYYYqN --save`. |
| All other ~40 schedulers | unchanged | — | Pre-Phase-A bundles. Untouched. |

---

## Confirmed vs unverified

**✅ Confirmed in production:**

- Phase A bundle loads + initializes (2 clean Form 4 ticks past `writeJobMeta`).
- Scheduler fleet healthy (8-K, Form 3, Form 144, activist, FRED, EIA on cadence).
- Read-side shim derives `transaction_nature` on the fly for historical rows.
- 5 acceptance fixtures PASS via wire (Cases A–F). Wire-coerce v0.52.1 accepts native bool + string, throws on garbage.
- **Guard conditions (Code-read 2026-05-25):** false-new fires **iff `priorByCusip.size === 0`** (`13f.ts` ~514–533); phantom-closed fires **iff `currentIsVerified === false`** (`13f.ts` ~567–576). Both pathological. *Re-confirm line numbers against the file before any patch — note v1's "489-499" drifted to "514-533."*
- **Dedup (Code-read):** `fetchLatest13F` does not pre-check ingested accessions; `saveInstitutionalHoldings` uses `merge:true`. Intended = re-fetch latest per fund + overlay. **Contradicted in practice for Berkshire — see COMPLETENESS BLIND SPOT.**
- **Counts (Code, Firestore):** `congressional_trades` 57,213; `institutional_holdings` 1,353.
- **Cap confirmed (wire-Claude, EDGAR):** Vanguard's real 13F is ~4,000+ entries (4,042 in 2004); store holds 50/fund. The uniform "50"s are this cap.
- **Tool enum (Code-read + wire-Claude tool context):** `get_institutional_holdings` `position_change` filter enum = `new|increased|decreased|closed|unchanged`; handler rejects others as "INVALID." No `INSUFFICIENT_DATA`.
- **No tracked fund has a prior-quarter baseline in store (wire-Claude, morning probe + Code recon):** Vanguard Q4-2025 rows and Berkshire Q4-2025 rows both carry `position_change=new` with `shares_change == shares_held` and null `shares_change_pct` — the no-prior-baseline signature. The 7 hedge funds' Q1-2026 rows are also `pc=new`. (Normal-`pc` rows *do* exist in the store — Harvest, Diker — but those funds are NOT in the tracked 10.)

**⏳ NOT confirmed:**

- Write-side attaching fields to a freshly ingested row (every post-deploy tick had 0 rows; holiday).
- Count-check guard firing on a real fetch. Both `position_change` guards firing on a real fetch.
- Whether the read surface projects `verification_status` to the wire at all (wire-Claude could not see it on any sampled row — UNDETERMINED: absent from storage vs not projected).
- Whether a `position_change=INSUFFICIENT_DATA` row survives an unfiltered read query (none sampled yet).

---

## THE 16:15Z 13F TICK — a heal-only exercise this cycle

Re-fetches the 10 tracked funds (no ingested pre-check) and merge-overlays Phase A fields. Run after Greg's "go" (~16:20Z):

```
npx tsx scripts/_check-all-meta.ts           # confirm tick landed
npx tsx scripts/_phase-a-burnin-inspect.ts   # verification_status / position_change on fresh rows
```

**Predicted signature (confidence-labeled):**

- **HIGH — the genuine win:** the **false-new guard fires on every tracked fund that re-ingests**, because none has a prior-quarter baseline in the store. Each fund's existing/refetched rows overlay to `position_change=INSUFFICIENT_DATA`. Expect the bulk of this from the 7 hedge funds (~50 each ≈ 350) plus Vanguard (~50, healing its own baseline-less Q4-2025 rows) plus BlackRock's stale rows. This is the first real production `INSUFFICIENT_DATA` population — what Phase B sizes against.
- **Field nuance (don't confuse the two guards):** these rows will most likely be **`verification_status = VERIFIED`** (count check passes on clean filings) **AND `position_change = INSUFFICIENT_DATA`** (no baseline). The count check and the baseline guard are independent fields; a row carrying both is correct, not contradictory.
- **CONTRADICTED — will NOT happen this tick:** "normal `position_change` exercised in production." **Zero** tracked funds can produce it, because none has a prior quarter in store to diff against. The milestone is gated on first backfilling a prior quarter for a tracked fund (see Recommendations).
- **CONTRADICTED — do NOT expect Berkshire/Vanguard "VERIFIED normal-pc" rows.** Berkshire's Q1-2026 hasn't ingested in 10 days (won't this tick either); Vanguard's Q1-2026 doesn't exist yet. Both instead either re-stamp baseline-less rows to `INSUFFICIENT_DATA` or write nothing.
- **UNCONFIRMED:** phantom-closed guard (rare pathology). SPECULATION: the natural candidate is a combination-report filer (Berkshire) whose parsed count may miss `tableEntryTotal` — *if* it ever ingests.
- **Open sub-question (the inspect script can answer post-tick):** where does the Berkshire fetch fail — at "identify latest" (then it re-stamps Q4-2025 → 42 rows flip to `INSUFFICIENT_DATA`) or at parse (then Berkshire writes nothing)? Check whether Berkshire's Q4-2025 rows gained `verification_status`.

**Branches:**

- New/overlaid rows carry `verification_status` → write-side stamping confirmed. **Then present findings and await Greg's explicit go on the Phase B Index Pass re-run — do NOT self-authorize it.**
- Rows touched but no `verification_status` → write-side bug. Stop; diagnose via logs (needs `roles/logging.viewer` grant — the log path currently 403s).
- Nothing overlaid at all → the tick didn't fetch. Investigate; this is not "the holiday" (dedup is re-fetch-and-overlay).

---

## COMPLETENESS BLIND SPOT (audit seed — likely the biggest finding)

`verification_status` can only tag rows you *have*. It is structurally blind to a filing you never ingested.

**Berkshire (CIK 0001067983) — triangulated EDGAR + wire + Firestore:**

| Period | EDGAR | Firestore | Status |
|---|---|---|---|
| 2026-03-31 | 13F-HR filed May 15 (acc 0001193125-26-226661) | 0 rows | **GAP (10 days)** |
| 2025-12-31 | 13F-HR filed Feb 17 (acc 0001193125-26-054580) | 42 rows | served as "latest" |
| 2025-09-30 | 13F-HR filed Nov 14 2025 (acc 0001193125-25-282901) | 0 rows | **GAP (6+ months)** |
| 2025-03-31 | 13F-HR/A filed Aug 14 2025 (acc 0000950123-25-008361) | 0 rows | amendment missing |

The tool serves Berkshire's Q4-2025 portfolio as current — still showing positions Berkshire has since exited. Stale data presented as current, **no honesty tag, because there's no row to tag.** This is a freshness/completeness failure class distinct from per-row verification. **First audit probe for every collection: does the store's newest period for each tracked entity match its newest filing on EDGAR? Mismatches are silent staleness.**

**Mechanism — UNRESOLVED; v2's combination-report SPECULATION is now WEAKER, not confirmed.** Two consecutive gaps (Q3-2025 + Q1-2026) rule out a 30-day window-edge. But Berkshire's Q4-2025 *did* ingest (42 rows) — so it is NOT a blanket "Berkshire always skipped," which a combination-report-always-fails theory would predict. Two discriminating checks for Code, neither assuming a conclusion:

1. **Provenance of the 42 Q4-2025 rows** (`created_at` / source path): cron vs a manual backfill. If backfill, the cron may have *never* pulled a Berkshire filing.
2. **Does 42 equal Berkshire's Q4-2025 `tableEntryTotal`?** Q1-2026 had 90 entries (14 included managers). If Q4-2025's total is also ~80–90 but the store has 42, the *existing* Berkshire data is itself an under-parse (and would have failed the count check) — which would support a combination-report under-parsing theory. If 42 ≈ the filing's total, the structure isn't the blocker.

**Natural experiment coming:** Vanguard (CIK 0000102909) hasn't filed Q1-2026 yet (newest is period 2025-12-31, filed Jan 29 2026; confirmed via EDGAR filing list + Code's direct query — it's past the May 15 deadline, so late/imminent). Vanguard files a plain *13F HOLDINGS REPORT* (no included managers), unlike Berkshire's combination report. When Vanguard's Q1-2026 lands: if it ingests cleanly but Berkshire still doesn't, that's strong evidence the combination-report structure is the blocker. Watch for it.

---

## NEW FINDING — TRACKED_FUNDS CIK integrity (4th audit axis)

BlackRock under tracked CIK **0001364742** has no 13F-HR newer than **2024-06-30** (filed 2024-08-13) — ~22 months stale (confirmed: matches the wire's stored BlackRock data exactly, and EDGAR shows nothing newer under this CIK). Either (a) wrong CIK — same bug class as the 5 CIKs corrected May 23 (per `CLAUDE.md` Hard Lesson, those pointed at wrong entities entirely), or (b) BlackRock files under a different entity now (it has dozens of registered RIAs). Either way, v2's BlackRock prediction is moot — there's no Q1 under this CIK; the tick can only re-fetch the 2024-Q2 filing and overlay it. **Action: audit the full TRACKED_FUNDS list against current 13F filer CIKs on EDGAR.** BlackRock is the 6th candidate for the May-23 bug class; there may be more.

---

## Verified per-fund pre-tick state (replaces v2's table)

| Fund | EDGAR latest 13F-HR | Firestore latest | Tick behavior → `position_change` | Confidence |
|---|---|---|---|---|
| Berkshire | 2026-03-31 (May 15) | 2025-12-31 (42, `pc=new`) | Q1 won't ingest (10-day + 6-month gaps). Either re-stamps Q4 → `INSUFFICIENT_DATA`, or writes nothing | HIGH |
| BlackRock | 2024-06-30 (stale CIK) | 2024-06-30 (50 rows, only quarter in store) | Re-fetch stale Q2-2024; no prior → false-new → `INSUFFICIENT_DATA`. Nothing fresh | HIGH |
| Vanguard | 2025-12-31 (no Q1 filed) | 2025-12-31 (50 capped, `pc=new`) | Re-fetch Q4-2025; no Q3 prior in store → false-new → `INSUFFICIENT_DATA`. NOT normal-pc | HIGH |
| Bridgewater | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |
| Citadel | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |
| Point72 | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |
| D.E. Shaw | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |
| Renaissance | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |
| Two Sigma | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |
| Millennium | (Q1 in store) | 2026-03-31 (50, `pc=new`) | Overlay → `INSUFFICIENT_DATA` | HIGH |

**Net:** the tick is a **false-new heal exercise across the board.** It confirms stamping + count-check + the false-new guard — real value — but exercises the normal-`position_change` comparison path on **zero** funds.

---

## Recommendations / unlocks (for Greg's decision)

- **Prioritize the Berkshire ingestion fix as the next foundation item.** It's the single cheapest unlock: its Q4-2025 baseline already sits in store, so fixing only its Q1-2026 ingestion gives, in one move, (a) completeness (current quarter restored), (b) the **first real normal-`position_change` production test** (prior=Q4-2025 present → false-new won't fire), and (c) the reconciliation fixture below. Diagnose first (read-only — the two checks above), do not patch on the combination-report hypothesis until it's confirmed.
- **Reconciliation fixture (closes v2 smaller-fix-C).** Once Berkshire Q1-2026 ingests, its moves are large and externally documented, so expected `position_change` is falsifiable against the filing XML. Per secondary coverage *(treat as targets to confirm against the XML, not as fact — one aggregator source contained an obvious unrelated fabrication)*: Visa / Mastercard / Amazon / UnitedHealth → `closed`; Alphabet Class A → `increased`; Alphabet Class C, Delta → `new`; parsed rows must equal `tableEntryTotal` (90). Any of these landing as `new`-across-the-board or `INSUFFICIENT_DATA` means prior-quarter resolution is broken.
- **Backfill one prior quarter for a tracked fund** if you want the normal-pc path exercised without waiting on the Berkshire fix (e.g., backfill Vanguard or a hedge fund's prior quarter so the next tick computes a real delta).

---

## Fix item — tool enum + filter gap

`get_institutional_holdings` cannot filter for `INSUFFICIENT_DATA` (input schema + handler reject it as "INVALID"; description doubly stale at `institutional-holdings.ts:43-44, :76, :182-202`). The honest tag Phase A exists to surface has no read-side filter path. Whether such rows pass *unfiltered* queries is undetermined (handler doesn't post-filter output, so probably yes). Define the expected wire representation of an `INSUFFICIENT_DATA` 13F row and make it an acceptance case before calling Phase A read-side "done."

---

## Phase B gates — LOCKED

Do NOT, under any circumstances:

- Start a heal run.
- Touch `src/phase-b/heal-worker.ts` (inert; dual-gated by `HEAL_AUTHORIZED=true` AND `command="heal"`; every entry point throws otherwise).
- Re-run the Index Pass until Greg authorizes it post-13F-confirmation.
- Write to `/sync_queue` (doesn't exist yet; the heal pass creates it).
- Deploy any function without explicit Greg authorization.

Greg owns heal-pass authorization. Your job: prepare ground truth, present findings, await go.

---

## Files that matter

**Docs (read in order):** `CLAUDE.md` (stale, last entry v0.44.0 — arc since: v0.45 authless MCP + rate limiting → v0.46–0.51 bulk Form 3/4/5 loader + fixes + indexes → v0.51.0 Phase A doctrine → v0.52.0 scope-gap → v0.52.1 wire-coerce → Phase B scaffold; update after the burn-in story lands, don't rush); `docs/architecture-data-integrity.md` (Tourniquet doctrine, fixed vocabulary, locked `trans_code` mapping); `docs/architecture-phase-b-sync-queue.md` (sync_queue schema, heal state machine, rate-limit policy, "measure before you heal").

**Phase A write-side:**

- `src/scrapers/13f.ts` ~514–533 + ~567–576 — false-new + phantom-closed guards *(re-confirm line numbers)*
- `src/scrapers/13f.ts:640-691` — only place that writes `VERIFIED`/`INSUFFICIENT_DATA` via Cloud Function
- `src/scrapers/13f.ts` — `fetchLatest13F` (implicated in the Berkshire gap) + `saveInstitutionalHoldings` (`merge:true`)
- `src/scrapers/form345-bulk.ts:509-525`; `src/scrapers/form4.ts:286-289 + :360-362`; `src/scrapers/senate.ts:509-519` + `src/scrapers/house.ts:531-540`; `src/tools/insider-transactions-v2-shim.ts:109-170`; `src/tools/institutional-holdings.ts:43-44, :76, :182-202` (enum gap)
- **TRACKED_FUNDS definition** — locate and audit every CIK against EDGAR (BlackRock 0001364742 is the known-bad candidate).

**Phase B scaffold (inert):** `src/phase-b/types.ts`, `src/phase-b/heal-worker.ts` (throws `HealNotAuthorizedError`), `scripts/phase-b-index-pass.ts` (read-only).

**Diagnostics (all read-only):**

- `scripts/_check-all-meta.ts`, `scripts/_phase-a-burnin-inspect.ts`, `scripts/_phase-a-acceptance.ts`, `scripts/_phase-a-13f-count-spot-check.ts` (probes live EDGAR), `scripts/_smoke-boolean-coerce.ts`
- `scripts/_pull-gcp-logs.ts` — 403s (`firebase-adminsdk-fbsvc` lacks `roles/logging.viewer`). Grant at `https://console.cloud.google.com/iam-admin/iam?project=capitaledge-api`. **Prerequisite for the "write-side bug → logs" branch, not a someday task.**
- `scripts/_pre-tick-recon.ts` — per-fund pre-tick state.
- `scripts/_verify-berkshire-blackrock-gap.ts` — EDGAR-vs-Firestore cross-check; load-bearing for the gap findings above.

---

## Standing rules from Greg (NON-NEGOTIABLE)

- **NEVER ASSUME. VERIFY EVERY LOAD-BEARING FACT WITH A TOOL CALL BEFORE STATING IT.** (`feedback_verify_facts_dont_assume.md`.) ~30s to verify; 14h+ documented cost of not.
- **Tell the ugly truth**, especially about whether something will actually work. Push back, run diagnostics, report the real picture.
- **Plain English with builder/trades analogies.**
- **Time estimates run 5–10× too high.** Quartile them; don't make it a chat topic.
- **Foundation before features. Always.**
- **Pure-publisher posture.** No derived intelligence in tool outputs. Phase A tags = structural honesty, NOT derived signal.
- **Project boundary:** `capitaledge-api` NEVER writes to `capital-edge-d5038` (Derek's dashboard).
- **"Raw" describes input, not output.** Raw government feeds in → clean, ready-to-use data out.
- **Session bootstrap mandatory.** Anchor to version/commit/date, never "Day N."
- **"Done" = committed + pushed + deployed-and-verified.** Confirm with `git log origin/main` + live `curl https://mcp.keyvex.com`.
- **Scraper + scheduler ship together** in the same commit.
- **Speculation must be labeled SPECULATION.** Verify confident-sounding artifacts against the actual file/source before any patch.
- **Make the call, surface the reasoning** (not for deploys/commits/destructive ops — those need explicit ask).
- **Don't re-ask inside an authorized scope.**

---

## Critical recent lessons

- **Gemini fabrication (2026-05-25):** fake stack trace, fake line numbers/function names, concrete patch — for a bug that didn't exist (`form4.ts:142` is XMLParser config, not `parseTransactionCodes`). The TS source paths were the tell — real Gen 2 traces hit bundled `lib/index.js`. Verify confident artifacts against the actual file before patching.
- **"Missed Form 4 tick" non-event (2026-05-25):** two stale `/meta` probes triggered an escalation cascade with two retracted hypotheses; the 13:27Z tick proved health all along. Pull back escalation when your own hypotheses get retracted.
- **The patient path won:** through rounds of confident alarm, Greg authorized nothing and waited for ground truth, which vindicated patience.
- **The Berkshire ingestion gap (2026-05-25):** a filing on EDGAR inside the lookback was absent from the store for 10 days / ~60 ticks. Caught only by cross-checking a code-read and a store-count against the source of truth (EDGAR). **Two individually-correct internal facts hid a bug in their conjunction.** Cross-check internal state against the outside world, not just against itself.
- **The cadence cross-check (2026-05-25):** the wire-Claude initially doubted Code's "Vanguard hasn't filed Q1" on a cadence argument, chased it to the EDGAR filing list, and the doubt resolved in Code's favor on better reasoning. The doubt was still correct to raise — surprising load-bearing facts get independently confirmed, even when the other AI turns out right.

---

## Production endpoint

`https://mcp.keyvex.com` — authless MCP, v0.52.1. Health: `curl https://mcp.keyvex.com/` → version + 38-tool list.

---

## What to surface back to the wire-Claude (live MCP read-verification node)

The wire-Claude verifies the serving layer + SEC source of truth; it cannot see Firestore internals, logs, or repo. Report back:

1. **The exact 10 tracked-fund list with CIKs**, plus the result of the TRACKED_FUNDS CIK audit (which are wrong, like BlackRock).
2. **Fetch-window semantics of `fetchLatest13F`** — latest-regardless-of-date vs last-30-days. The Berkshire gap turns on this.
3. **Berkshire gap diagnosis** — the two discriminating checks (provenance of the 42 Q4 rows; 42 vs `tableEntryTotal`). Confirm or kill the combination-report SPECULATION.
4. **Whether the read surface projects `verification_status`.** If not, the wire-Claude cannot verify that field — it's a Firestore-only (your) check, and the doc must say so.
5. **Exact cap value + where applied** (fetch-time vs store-time).
6. **Whether any row currently carries `position_change=INSUFFICIENT_DATA`** in storage (so the wire-Claude can test the out-of-enum sentinel on the wire).
7. **Post-tick: which funds wrote, with counts + a sample of stamped fields** — including whether Berkshire's Q4-2025 rows gained `verification_status` (answers the "where does Berkshire fail" sub-question).
8. **When Vanguard's Q1-2026 lands** (the natural experiment) — flag it so the wire-Claude can check ingestion cleanliness vs Berkshire.

The wire-Claude will, on its side: confirm the tick landed; re-pull tracked funds; verify served fields; run the Berkshire reconciliation if/when it ingests; and independently confirm staleness from EDGAR. It cannot verify `verification_status` from the wire (until #4 resolves) or confirm guard *firing* (your write-path + logs question).

---

## Open questions

1. **Update `CLAUDE.md`** (v0.45 → v0.52.1 + Phase B scaffold)? After the burn-in story lands. Don't rush.
2. **Diagnose the Berkshire gap before or after the 16:15Z tick?** Strong case for before/next — it's the cheapest unlock for completeness + the normal-pc test + the reconciliation fixture. Diagnosis is read-only; stays read-only until Greg sees root cause.
3. **Manual `gcloud` fire of `scrape13FQuarterHourly`** instead of waiting? Gives an immediate answer (idempotent doc IDs = double-write-safe) but hits the same Berkshire gap and initiates real SEC traffic from untested code. Discuss with Greg first.
4. **Audit scope** — prioritize the ~30 remaining collections with Greg, across all four axes (misclassification, completeness/staleness, enum gap, CIK integrity).

---

*End of handoff v3. Ground state verified 2026-05-25. Branch `claude/form345-bulk-load-2026-05-23` @ `08c03b0`, pushed. Berkshire/BlackRock gaps and Vanguard Q1-non-filing triangulated across Code (Firestore + EDGAR), wire-Claude (live wire + EDGAR source-of-truth), and independent aggregator cross-check.*
