# HANDOFF v4 — KeyVex Phase A count-check arc CLOSEOUT (2026-05-25)

**Read this if you're resuming after the count-check arc landed.** v4 supersedes v3 ([`a045d8b`](../../../commit/a045d8b)) for the questions v3 left open; v3 stays in git history as the pre-deploy ground state.

Branch `claude/form345-bulk-load-2026-05-23` @ `c6cd1e5` (latest), pushed. **No merge to main.**

Every load-bearing claim carries a confidence label: **HIGH / CONTRADICTED / UNDETERMINED / SPECULATION**. Treat anything unlabeled as needing verification before you act on it. The Tourniquet applies to our own reasoning — including this document's.

**Verification provenance:** Code ran EDGAR + Firestore writes/reads; the wire-Claude independently confirmed against the deployed `mcp` HTTP function's serving layer. Two-sided observations (write/Firestore + wire/serving) are marked HIGH.

---

## What changed v3 → v4 (read first)

1. **The count-check fix (B+) shipped, deployed, and is verified live two-sided. [HIGH]** Pre-fix `verification_status` stamping compared aggregated-by-CUSIP count vs raw declared count — apples-to-oranges, false-positive INSUFFICIENT_DATA on every aggregating filer. Now uses raw row count + raw value sum vs declared `<tableEntryTotal>` + `<tableValueTotal>`, AND'd, independent failure logging. Commits `d5977e4` (B+) + `c6cd1e5` (recon scripts). Deployed to `scrape13FQuarterHourly` + `mcp`. **778+ live observations across the 10 tracked funds + 5 healed funds + Berkshire reconciliation — all dual-gate exact to the dollar.**

2. **The 5 false-INSUFFICIENT_DATA stamps from the 16:00Z pre-fix tick are RETIRED. [HIGH]** Coastline / Atlas Brown / Energy Income Partners / Park West / Harvest re-stamped under deployed B+ via raw-CIK CLI re-tick. Active rows now serve VERIFIED through the consumer layer (wire-confirmed). Harvest's 29 orphan docs got incidentally cleared by closed-row CUSIP overlap — emergent side-effect, not a designed cleanup feature (see v1.1 polish below).

3. **The "rare-event guard" framing from v3 is DEAD. [HIGH]** Step 4a probe found genuine `raw < declared` filings at ~3-4% prevalence in an 88-filing small-filer sample (Dogwood `0002056922-25-000003` declared 592 / raw 591; Legacy `0002045082-25-000001` declared 795 / raw 794; MONECO `0001765690-25-000005` declared 466 / raw 465). The guard catches a **non-rare small-filer manual-count-typo class**, not an exotic corpus needle. v4 framing must reflect this prevalence honestly.

4. **The guard's operational scope is "latest filing per (fund, tick)," NOT "the corpus." [HIGH]** `fetchLatest13F` only fetches each fund's most-recent 13F-HR. Historical malformed filings exist in EDGAR (Dogwood's `-25-000003` is mid-history; Legacy's `-25-000001` is 2 quarters back) and are NEVER re-fetched or re-stamped. The guard is fixture-proven (synthetic case #4) and corpus-confirmed (2 real shortfalls found via independent probe), but **live firing in production is unobserved** because every real shortfall we found is historical for its filer. This is a structural boundary, not an unresolved verification gap.

5. **v3's "Berkshire = combination report" SPECULATION is killed. [CONTRADICTED]** Berkshire Q1-2026 is `<reportType>13F HOLDINGS REPORT</reportType>` with 14 included managers and 90 rows — parses trivially under B+ (dual-gate exact, $263.1B value match). The mechanism behind Berkshire's missing periods is the **discovery-only architecture** (see C diagnosis closeout), not a combination-report parser issue.

6. **v3's "rules out window-edge" wording was too strong. [CORRECTED]** The discovery-only architecture finding shows the cron only sees each tick's FTS-first-page result (limited paginate, no per-tracked-fund explicit-call branch). For a quarterly filer like Berkshire, the latest filing falls outside the 30-day window between filings; the FTS first-page cap means even within the window, the CIK can be bumped by higher-ranked filings. v3's "structural exclusion" verdict is right; the specific mechanism is FTS first-page truncation, with the 25-CIK `maxFunds` cap as a secondary limiter. The diagnosis is now precise.

7. **The product-boundary finding emerged and is BUSINESS-RELEVANT. [HIGH]** See §PRODUCT BOUNDARY. Marketing-honest copy on data integrity must say "latest-filing verification at ingest," NOT "we verify our data." Disclaimer-discipline applies the same way it does to advice-vs-information framing.

---

## What's deployed where

| Surface | Version | Deployed | Notes |
|---|---|---|---|
| `mcp` HTTP function | bundle @ `d5977e4` | 2026-05-25 ~19:00Z | Read-side projects `verification_value_expected/actual` fields end-to-end to consumer. Wire-verified. |
| `scrape13FQuarterHourly` | bundle @ `d5977e4` | 2026-05-25 ~19:00Z | B+ dual-gate stamping active. Next scheduled tick: 20:00Z then 00:00Z + every 4h. |
| All other ~40 schedulers | unchanged | — | Pre-B+. Untouched. |

`SERVER_VERSION` did NOT bump with B+ (deliberate — read-side schema additions are purely additive, optional fields). Implication: the version string `0.52.1` cannot distinguish pre/post-B+ deploys. **The determinative tell** that B+ is live is the presence of `verification_value_expected` + `verification_value_actual` fields on freshly-stamped rows (those fields didn't exist in the schema before B+). v4 record item: integrity-affecting deploys should bump `SERVER_VERSION` so the version string IS a label.

---

## C diagnosis closeout — Berkshire ingestion gap mechanism

**Mechanism: FTS first-page truncation + discovery-only architecture. [HIGH]**

The 13F scheduler ([`functions/src/index.ts:710-733`](../functions/src/index.ts#L710-L733)) calls `scrape13FLiveFeed({ days: 30 })` and nothing else. `scrape13FLiveFeed` queries EDGAR FTS for 13F-HRs in the last 30 days, dedups by CIK in the FTS result order, caps at `maxFunds=25`. The scheduler **never reads `TRACKED_FUNDS`**, never invokes `scrape13FByFund` for specific tracked CIKs.

Mechanism that excludes Berkshire:
- **FTS first-page cap.** Without explicit pagination, the FTS endpoint returns a single page (~100 hits). Berkshire's CIK 1067983 only reaches the loop if it's in the first page of FTS results sorted by filing date desc.
- **25-CIK dedup cap.** Even when surfaced in FTS, Berkshire competes with all other 13F filers in the 30-day window for the first-25 unique-CIK slots.
- **Quarterly filer + 4-hourly cron.** Berkshire's Q3-2025 (filed 2025-11-14) and Q1-2026 (filed 2026-05-15) filings exist in EDGAR. Q3-2025 fell out of the 30-day FTS window months ago; Q1-2026 has been buried below higher-ranked filings on subsequent ticks.

**Empirical confirmation.** The 16:00Z 2026-05-25 tick wrote 16 unique CIKs / 534 docs. Berkshire NOT in the 16. The Day-2 (2026-04-29) manual CLI write is Berkshire's ONLY entry in the `institutional_holdings` collection — 11 EDGAR-attested filings since 2024 missing entirely.

**v3's softening was right.** v3 wrote "consistent with evidence" on window-edge; v4 sharpens that to: **the scheduler's architectural shape (discovery-only, latest-only, no explicit-tracked-CIK branch) is the mechanism.** Window-edge AND cap-binding are both consequences of the same architectural shape.

**Phrasing for v4 record:** "discovery-only posture rather than monitored-portfolio posture" — the sharpest one-line statement of why `TRACKED_FUNDS` is decorative under the current scheduler. The two-branch fix (keep discovery for new filers, add explicit monitoring for tracked ones) maps onto that distinction one-to-one. That fix is **D**, unscoped post-v4.

---

## Step 4 — the asymmetric finding

**Forward direction (false-positive fix): comprehensively proven. [HIGH]** 778+ live observations across:
- Step 3 re-tick: 9 tracked aliases + BlackRock-new raw CIK = 495 docs, all VERIFIED, dual-gate exact
- 5-fund heal: Coastline (50) + Atlas Brown (50) + EIP (51) + Park West (60) + Harvest (72) = 283 docs, all active VERIFIED, dual-gate exact
- Berkshire reconciliation: 45 docs (29 active + 16 closed)
- Two-sided: write/Firestore (Code-read) + wire/serving (wire-Claude read of `get_institutional_holdings` for Berkshire + Coastline)

**Reverse direction (guard fires on real shortfall): fixture-proven + corpus-confirmed, NOT live-observed.**
- Fixture-proven: synthetic cases #4 (TRUNCATED), #5 (ROW-COUNT-PASS-VALUE-FAIL), #6 (VALUE-PASS-ROW-COUNT-FAIL) in [`scripts/_acceptance-13f-count-check.ts`](../scripts/_acceptance-13f-count-check.ts) all stamp INSUFFICIENT_DATA correctly. [HIGH]
- Corpus-confirmed: 2 genuine off-by-1 shortfalls found in an 88-filing sample via Step 4a probe. Both classified Branch (1) genuine-shortfall by the four-inspection tree. [HIGH]
- **Live-observed: no.** Both off-by-1 filings are HISTORICAL for their filers (Dogwood: ~mid-history; Legacy: 2 quarters back). The latest-only `fetchLatest13F` architecture cannot reach them; Step 4b on Dogwood fetched Dogwood's clean current filing (declared=860, raw=860) and correctly stamped VERIFIED, observing a no-mismatch case. Step 4b on Legacy was authorized only if Legacy's off-by-1 was latest — read-only check confirmed Legacy's latest is also clean (declared=1082, raw=1082), so Legacy 4b was NOT run.

**MONECO Advisors edge case [(3) ambiguous, UNDETERMINED]:** the only 13F-HR/A amendment in our probe sample with `raw < declared` (declared 466, raw 465, period 2024-Q4). Cross-filing inspection found no matching original 13F-HR for the same period in MONECO's `recent[]` submissions feed. Cannot classify additive (Branch 2) vs restatement (Branch 1) read-only. Documented as Branch (3) ambiguous. Worth a deeper read whenever someone has time, but not blocking — `MONECO` is not a tracked fund and the production cron may or may not surface it.

**Branch (2) [amendment FP class] NOT found in the sample. [UNDETERMINED]** No 13F-HR/A with clear additive language + `raw < declared` surfaced. The 40-amendment sample is small enough that "none in this sample" ≠ "none exists" — worth one line in any future Track-2 audit that touches amendments.

---

## PRODUCT BOUNDARY — marketing/legal copy implication

The operational-scope finding bounds what KeyVex can honestly claim to subscribers about data integrity. The integrity primitive has a known and named operational reach:

- **Engineering-accurate claim:** "B+ verifies each fund's most-recent 13F-HR at ingestion against the SEC filer's own declared row count and aggregate value. Historical accessions are not re-stamped."
- **Marketing-honest paraphrase:** "Latest-filing verification at ingest." (Acceptable.)
- **Marketing-overclaim that must NOT appear:** "We verify our institutional holdings data." OR "Our 13F data is integrity-checked end-to-end." Both read as corpus-wide guarantees. Both contradict the fact that historical malformed filings (~3-4% of small-filer 13F-HRs, demonstrably) are never re-fetched.

The same disclaimer-discipline that bounds the "information not advice" framing on KeyVex's product surface applies here: the latest-only qualifier must ride wherever the integrity claim does. **Not v4's job to fix copy** — but v4 names it as a product boundary so it doesn't get forgotten when subscriber-facing copy on data quality gets drafted. Worth flagging to whoever owns marketing/legal alongside v4.

This finding is also the strongest argument for **D** (the explicit-TRACKED_FUNDS branch + accession-targeting). If the eventual D-architecture supports re-fetching specific historical accessions, the integrity claim's operational scope widens correspondingly — and so could the marketing copy.

---

## v1.1 polish items (none blocking)

All earned by Step 3 / heal / Step 4 observations:

1. **Synthetic closed-row field gap.** `applyPositionChanges`'s closed-row synthesis spreads from prior-quarter docs and only explicitly sets `verification_status: "VERIFIED"`. The other three B+ fields (`verification_expected`, `verification_actual`, `verification_value_expected`, `verification_value_actual`) come from the spread — which is `undefined` if the prior-quarter doc predates Phase A. 54 synthesized closed rows across this session (Berkshire 16 + EIP 1 + Park West 12 + Harvest 29) carry VERIFIED status but lack value-gate fields. v1.1: have closed-row synthesis explicitly propagate all four B+ fields from the active set's verdict.

2. **`/meta` CLI staleness.** `/meta/institutional13FSync` is written by `writeJobMeta` inside `scrape13FQuarterHourly` (Cloud Function), NOT by the CLI's `--save` path. So CLI re-ticks (Step 3, heal, 4b) don't refresh `/meta`. After today's session, `/meta` reflects the 16:00Z scheduled tick (pre-fix), not the ~700 docs written by CLI later. Misleading if a future reader uses `/meta` as a "last activity" signal. v1.1: have CLI `--save` either also write `/meta` (with a tag distinguishing CLI from cron) OR document this gap explicitly.

3. **Orphan accumulation — refined (not eliminated).** v3's framing implied orphan accumulation was a class-wide problem. Today's heal observation refines it: when a fund's aggregated set shrinks between writes AND the prior-quarter CUSIPs overlap with the orphan set, closed-row synthesis cleans the orphans incidentally (Harvest's 29 cleared this way). When prior-quarter CUSIPs don't overlap, orphans persist. So orphan accumulation is real but narrower than v3 stated, and incidental cleanup is fragile (depends on overlap that isn't designed). v1.1: a proper tombstone/deletion pass remains the robust fix; the heal's incidental cleanup is observable but not relied upon.

4. **OpenFIGI name-mismatch rejections at scale.** BlackRock-new's re-tick logged Tier-1 rejections for CSCO/AMAT/GE/IBM/etc. Pre-existing per CLAUDE.md's wrong-ticker tiebreaker work, not B+ scope. v1.1: relax `namesMatch` for well-known issuer name variants (CSCO ↔ CISCO SYS vs CISCO SYSTEMS, GE ↔ GE AEROSPACE vs GENERAL ELECTRIC), or add a curated alias map for top-50-by-frequency issuers.

5. **Probe-script regex was less robust than production parser.** Step 4a v1's independent grep used `/<infoTable\b/` which is namespace-blind. Production `parse13FXml` uses `removeNSPrefix: true` and correctly counts namespace-prefixed `<ns1:infoTable>` elements. v1's "parser-bug" classifications for 3 candidates resolved cleanly to genuine shortfalls under corrected namespace-aware grep. Worth a v4 line: **probes should be at least as defensive as the production code they validate**, and that defense must be load-bearing-in-the-test.

6. **Accession-suffix heuristic for filing-history depth is unreliable for filers that switch filing agents.** Used the heuristic in Legacy planning ("`-25-000001` likely = first-ever filing → off-by-1 likely latest"); Legacy actually had filed under two filer-agent CIKs (0002045082 + 0002044858 across 2025), so the `-25-000001` was sequence-1 for one of two filer-CIKs, not first-ever filing. Worth a v4 line for future probe-planning: filer-agent switches break sequence-number monotonicity.

---

## Process-discipline patterns earned (worth pinning for Track-2)

The session generated several patterns that should be re-applicable across the broader audit:

- **Probe-vs-production skepticism.** Always be at least as skeptical of the test as of the thing tested. Step 4a v1's parser-bug misclassification surfaced because Code doubted its own probe and re-ran with corrected regex. Had Code trusted the probe over the production parser, we'd have chased phantom parser fixes for 3 genuine shortfalls.
- **Hunk accounting at commit gates.** "Every hunk identified and attributable to a named feature; zero unattributed." Caught nothing on this commit, but the discipline IS the catch — Code reviewed all 10 hunks of B+ before commit and confirmed no debug prints, no commented-out code, no orphan experiments. The 195-line core scraper diff is past the size where "looks right" works.
- **Two-sided verification (write + wire as independent confirmations).** B+ verified live by Code writing fields to Firestore AND wire-Claude reading them back through the consumer API. Either alone is partial; together they prove storage-side AND serving-side correctness.
- **Pre-decisions before find-pressure.** The 4-inspection classification tree + the (1)/(2)/(3) branch outcomes were pinned BEFORE Step 4a ran. When Step 4a actually surfaced candidates, classification happened on evidence, not under pressure to claim a result. Especially "Branch (2) outranks teeth question" — pre-pinned so that a false-positive class discovery wouldn't be rushed past as a "miss."
- **Honest reporting (observed vs predicted).** Step 4b on Dogwood predicted INSUFFICIENT_DATA stamps; observed VERIFIED. Code reported observed-not-predicted, which surfaced the latest-only scope finding. Smoothing toward the prediction would have hidden the structural finding.
- **Read-before-write classification.** The 4-inspection tree explicitly required reading filings before any production write. MONECO and Dogwood both stopped at the read step rather than chaining writes; only when a candidate passed all four inspections would it be eligible for 4b.

These six are the kind of pattern Track-2 should adopt across the ~30 unaudited collections. Each axis (misclassification / incompleteness / count-check / entity-integrity / orphan-accumulation) has its own probe shape, but the patterns above apply uniformly.

---

## Track-2 audit axes — now 4-5, formalized

v3 stated the audit had **four axes**. v4 promotes it to **five** based on the heal's orphan-accumulation observation:

1. **Silent misclassification** (e.g., a row's `transaction_nature` is wrong; row exists but is incorrectly tagged)
2. **Silent incompleteness / staleness** (e.g., Berkshire's 11 missing 13F-HRs; rows that should exist don't)
3. **Count-check correctness** (e.g., B+ row-count + value-sum dual gate; covers within-filing integrity)
4. **`TRACKED_FUNDS` entity / CIK integrity** (e.g., BlackRock's stale `0001364742`; the registry points at the wrong entity)
5. **Orphan accumulation** (e.g., Harvest's 29 pre-2026-05-15 orphan docs; old-aggregation rows persist past the parser's current view)

For each collection in the Track-2 scope, the audit asks all 5 questions. The probe shapes overlap across collections (e.g., the namespace-aware grep pattern from B+ generalizes; the four-inspection classification tree generalizes to any source-vs-store integrity check), but each collection has its own data shape.

**Track-2 prioritization is a fresh decision post-v4 (not v4's job to set).** v3 listed `congressional_trades` (57,213 rows) and `institutional_holdings` (1,353 rows top-50-capped slice) as priority — those carry forward.

---

## Open / unscoped post-v4

| Item | State | Notes |
|---|---|---|
| D — explicit-TRACKED_FUNDS scheduler branch | **unscoped** | Architectural fix for discovery-only posture. Would also unlock A (BlackRock CIK swap). Greg's decision: build vs defer vs accept the latest-only operational scope as the product boundary. |
| A — BlackRock CIK swap + orphan rename | **gated on D scoping** | TRACKED_FUNDS edit `0001364742` → `0002012383` + orphan-rename pass on the 50 stale Q2-2024 docs. A alone is structurally pointless under current scheduler (correct CIK but cron won't pull); A+D together is the fix. |
| MONECO Branch (3) ambiguous case | **documented, not blocking** | Cross-filing inspection found no matching original 13F-HR. Worth a deeper read but not load-bearing. |
| Track-2 prioritization | **unscoped** | ~30 unaudited collections, 5-axis template above. Greg's decision: where to point the audit next. |
| Phase B / heal worker | **STRICTLY LOCKED** | `heal-worker.ts` inert. `sync_queue` not yet created. Index Pass re-run requires explicit go post-v4. |
| v1.1 polish items | **logged, not blocking** | 6 items above. Pick up opportunistically or batch into a polish sprint. |
| Marketing/legal copy review | **flagged to copy-owner** | Product-boundary finding needs to ride wherever the integrity claim does. |

---

## v4 trigger conditions — all met (record)

- ✅ Forward-direction count-check fix verified two-sided (write/Firestore + wire/serving) — 778+ live observations
- ✅ Reverse-direction guard fixture-proven + corpus-confirmed (2 of 88 sample, ~3-4% prevalence)
- ✅ Reverse-direction live observation — UNRESOLVED-BY-STRUCTURE (latest-only scope), not unresolved-by-pending. Calibrated negative documented with positive evidence of what was searched and what was found.
- ✅ 5-fund heal applied — false-INSUFFICIENT_DATA stamps retired, consumer surface serves correct data
- ✅ Step 4 closed with structural characterization (rare-event framing dead, operational-scope bounded)
- ✅ Product-boundary flag elevated for marketing/legal copy

---

## Reproducibility scripts created this session

Following Step 1b's discipline (recon scripts as a SEPARATE commit, never folded into the substantive commit), the 10 new `_diag-*.ts` files below land as a follow-up commit. Each is read-only against EDGAR + Firestore unless explicitly marked.

| Script | Purpose | Read/Write |
|---|---|---|
| `scripts/_diag-step-a-berkshire.ts` | Step A behavioral confirmation of B+ live (Berkshire post-write fields) | Read-only |
| `scripts/_diag-step-b-verify.ts` | Step B aggregate verification across all 10 Step-3 funds | Read-only |
| `scripts/_diag-vanguard-quarter-check.ts` | Resolve Vanguard quarter discrepancy (filed Q4-2025, no Q1-2026 yet) | Read-only |
| `scripts/_diag-heal-verify.ts` | 5-fund heal verification + Harvest orphan accounting | Read-only |
| `scripts/_diag-teeth-probe-4a.ts` | Step 4a v1 — initial teeth probe (had namespace-blind grep bug) | Read-only |
| `scripts/_diag-teeth-probe-4a-v2.ts` | Step 4a v2 — corrected FTS date filtering + 80-filing sweep | Read-only |
| `scripts/_diag-teeth-probe-4a-reclassify.ts` | Namespace-aware reclassification of 3 v2 candidates → 2 Branch (1) + 1 Branch (3) | Read-only |
| `scripts/_diag-moneco-crossfile.ts` | Inspection 3 cross-filing for MONECO's ambiguous 13F-HR/A | Read-only |
| `scripts/_diag-dogwood-4b-verify.ts` | Dogwood 4b post-write verification (observed clean VERIFIED, not predicted INSUFFICIENT_DATA) | Read-only (post-write) |
| `scripts/_diag-legacy-latest-check.ts` | Legacy latest-filing check — gates Legacy 4b | Read-only |

Plus earlier session scripts already committed in `c6cd1e5`: `_diag-berkshire-ingestion.ts`, `_diag-post-tick-snapshot.ts`, `_diag-coastline-shortfall.ts`, `_diag-insuff-widen-4fund.ts`, `_diag-harvest-tick-stamps.ts`.

---

## Bootstrap for the next session

```
git fetch origin
git branch -a
git worktree list
git log --oneline origin/main -6
git branch --show-current      # claude/form345-bulk-load-2026-05-23
git log --oneline -6           # head = c6cd1e5 (or the v4 doc commit landing this)
git status --short
```

Branch state at v4 commit landing:
- `c6cd1e5` chore(phase-a): commit B+ burn-in census + Berkshire diagnosis scripts
- `d5977e4` fix(13f): dual-gate §1 verification — raw count + value sum vs declared
- `a045d8b` docs(phase-a): v3 burn-in handoff + reproducibility scripts
- earlier commits unchanged

**Not merged to main. Do not merge without Greg's explicit sign-off.**

---

## One-paragraph TL;DR

The count-check arc closed today. B+ (dual-gate raw-count + value-sum verification) is committed (`d5977e4`), deployed surgically to `scrape13FQuarterHourly` + `mcp`, and verified live two-sided across 778+ observations. The 5 false-INSUFFICIENT_DATA stamps from the 16:00Z pre-fix tick are retired. The guard catches a real, non-rare small-filer over-declaration class (~3-4% prevalence in the EDGAR corpus, confirmed via independent probe) but is operationally bounded to latest-per-fund-per-tick — historical malformed filings exist but are never re-fetched, so live firing is structurally unobservable without changes outside B+ scope. v3's "Berkshire = combination report" speculation is dead; the real mechanism behind Berkshire's ingestion gaps is the discovery-only architecture (FTS first-page truncation + 25-CIK dedup cap + no explicit `TRACKED_FUNDS` branch in the scheduler). v4 record retires the rare-event-guard framing, qualifies the integrity claim to latest-filing-at-ingestion, and flags the product-boundary implication for marketing/legal copy. Open post-v4: D scoping decision, A (gated on D), Track-2 prioritization across the 5 audit axes, MONECO ambiguous case as a deeper read whenever. Phase B / heal worker remains STRICTLY LOCKED.

---

**End of v4.** Phase B LOCKED. A not authorized. D unscoped. Orphan cleanup not authorized. Standing by for fresh decisions.
