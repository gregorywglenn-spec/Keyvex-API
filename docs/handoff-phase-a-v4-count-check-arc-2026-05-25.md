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

**End of v4 as originally written.** Phase B LOCKED. A not authorized. D unscoped. Orphan cleanup not authorized. Standing by for fresh decisions.

---

# AMENDMENT — post-v4, same-day 2026-05-25

After the v4 doc (`0c54105`) and recon-scripts (`25feed4`) commits landed, the session continued with a Track-2 fan-out across remaining collections. This amendment captures findings that emerged post-v4 + corrections to the doctrine the original v4 wrote.

Confidence labels: same convention as the original — **HIGH / CONTRADICTED / UNDETERMINED / SPECULATION**. Verification provenance for amendment content: Code-side Firestore aggregate counts + source-code reads; wire-Claude's recon reads on `activist_ownership`, `insider_transactions_v2`, `congressional_trades`, `planned_insider_sales`, `material_events`, `annual_financial_disclosures`, `tender_offers`, `registration_statements`. Findings marked HIGH where Code and wire-Claude triangulated; UNDETERMINED where only one side observed; CONTRADICTED where a prior framing was disproved by source.

---

## Findings that emerged post-v4

### P0: insider date-field corruption (Axis 1 — data correctness) [HIGH]

Wire-Claude's recon on `insider_transactions_v2` surfaced records with malformed years (transaction_date "2047-06-07" on a row whose period_of_report and filing_date said 2017; ancient-side records with year "0012" on rows whose siblings said 2012). Mechanism characterized from a 10-record sample, then sized by Code via field-aware Firestore count (`scripts/_diag-bulk-v2-date-corruption-count.ts`).

**Mechanism (corrected from wire-Claude's initial framing, now grounded):**
- Year-digit corruption: month/day always intact; year's high-order digits mangled
- Pattern: predominantly **20XX → 00XX** (century-prefix drop, ancient-side ~29,500 instances) with a small minority **20XX → 204X** (high-end, ~240 instances)
- NOT a fixed offset (the original "+30" framing was falsified by the low-end data)
- Isolated to: `transaction_date`, `exercise_date`, `expiration_date` (the bulk-ingested date fields). Some `period_of_report` rows also corrupt (142 instances) — see reconstruction note below.

**Size — pinned honestly post-recount:**
- `insider_trades` (live-feed Form 4, 162,067 docs): **6 corrupt field-instances** (1 future + 5 ancient on transaction_date). All `data_source: "SEC_EDGAR_FORM4"`.
- `insider_transactions_v2` (bulk quarterly TSV, 9,923,755 docs): **29,893 corrupt field-instances** across transaction_date / exercise_date / expiration_date / period_of_report. All `data_source: (absent)` — v2 docs don't populate that field.
- **Combined: ~29,899 corrupt field-instances → estimated ~15-25K unique corrupt docs (~0.15-0.25% of v2).** This is an estimate, not an exact unique-doc count: a single doc can carry multiple corrupt fields, so the field-instance total overstates unique docs, and the range reflects that uncorrected overlap. An exact unique-doc count was not run.
- Bounded (< 1% of either collection), ancient-side prefix-drop dominant.

**Attribution corrected from initial wire-Claude framing:**
- Initial framing: "bulk_v2 TSV ingestion path, identified via data_source field"
- Corrected: corruption exists in BOTH live-feed Form 4 path AND bulk_v2 path. The `data_source` field is **unreliable as a path-distinguisher** — absent on every v2 record (the field isn't populated by v2 ingestion), only labels the live-feed `insider_trades` collection. Path attribution must come from the collection itself, not the field.

**Reconstruction source (CONTRADICTED from initial framing):**
- Initial framing (wire-Claude): "reconstruct from period_of_report or filing_date, both intact"
- Corrected: `period_of_report` has 142 corrupt rows in v2 — **unsafe as sole reconstruction source**
- `filing_date` is universally clean across 10M+ rows (0 corrupt at both extremes) — **canonical reconstruction source**
- Repair design must use filing_date with sibling-consistency check, NOT period_of_report alone

**Threshold-design correction earned this round** (mechanism: my initial recount over-counted by treating forward-looking fields as backward-looking):
- `exercise_date` per [`types.ts:1128`](../src/types.ts#L1128) is "ISO date the derivative becomes exercisable" — **forward-looking** for unvested options. Future values are legitimate.
- `expiration_date` similarly forward-looking — long-dated options legitimately expire in 2030s/2040s.
- A blanket `>2027` threshold on these fields treated 5,209 legitimate exercise dates and **254,123 legitimate expiration dates** as corruption. Recount with `>2050` reduced these to 28 and 155 respectively.
- v4 standing-protections list grew by one because of this: *"field semantics drive threshold choice"* (and probes must be at least as defensive as the production code they validate — earned twice now: the namespace-blind grep in Step 4a, the field-blind threshold here).

**Consumer impact:**
- Sort `transaction_date desc` returns the small future-dated corruption first (visible-wrong on flagship query)
- Sort `transaction_date asc` returns year-0012 records first (visible-wrong on ancient query)
- Date-range filters that intersect either extreme include corrupt records
- Severity: P0 because consumer-visible on the flagship query. Magnitude: bounded backfill (~15-25K docs), reconstructable.

**Remediation status: PARKED to next-session design task.** Now genuinely needs a design pass (filing_date-based reconstruction, sibling-consistency validator, field-aware thresholds, dry-run on sample, derived-field recompute including `reporting_lag_days`). NOT a quick fix. Gated to its own authorization.

### Axis 7: query-path consistency (NEW, HIGH severity)

Distinct from Axes 1-5 framed in original v4 and distinct from Axis 6 added below. **Cannot be remediated by copy/disclaimer** — requires code-level serving-layer fix.

**Definition:** Different access paths to the same logical query return different result sets. Demonstrated:
- `activist_ownership` filter `filer_name="Pershing"` misses a Jan-2025 Howard Hughes filing that `company_cik=<HHC>` catches (wire-Claude observation)
- `insider_trades` filter `officer_name="3G Special Situations Fund"` misses an Avis Budget Group filing where the name appears in `reporting_owners[]` but not in the primary single-field name (wire-Claude observation on QSR / 3G Capital)

**Source inspection (Code, this round) — DEFINITIVE:**
All four name-search implementations in `src/firestore.ts` use the **identical pattern**:
- `queryInsiderTransactions` (line ~858, `officer_name`)
- `queryInsiderTransactionsV2` (line ~1183, `reporting_owner_name`)
- `queryForm144Filings` (line ~1836, `filer_name`)
- (at least one more at line ~1925, `filer_name`)

The pattern is: fetch up to 5000 docs from Firestore → client-side `.filter(d => matchesSubstringSafe(d.<single_primary_field>, needle))`. The shared `matchesSubstringSafe` helper is applied to a single primary-name field on each row.

**Two structural issues, both in the same code path:**

- **Issue 1 — multi-reporter blind spot:** The helper targets a single primary-name field. Multi-reporter filings store the full reporter list in arrays (`reporting_owners[]`). A name in the array but not in the primary field is silently missed. This is the Pershing/Howard Hughes + 3G Capital/QSR shape.
- **Issue 2 — 5000-doc pre-substring cap:** When the Firestore-side filter (ticker/CIK/date range) would match more than 5000 docs, the client-side substring filter only sees the first 5000. A second silent-undercount on high-volume name queries (common surnames, heavily-traded issuers). Independent of Issue 1, same path.

**Fix scope (revised from original v4 assumption):**
- Original v4 estimate: "weeks, architectural, scope TBD post source-inspection"
- Now: **ONE shared fix at `matchesSubstringSafe` + the 5000-cap ceiling, lands across all 4+ name-search collections at once.** Plausibly **days, not weeks.**
- v1.1 polish direction already noted in firestore.ts comments: "move substring search to Firestore-side via tokenized indexes" — would solve both issues in one redesign.
- Axis-7 is no longer the longer-tail item on the launch-readiness ladder.

**Confirmed-affected collections (HIGH):** `activist_ownership`, `insider_trades` (legacy), `insider_transactions_v2` (bulk), `planned_insider_sales`.
**Probable platform-wide (UNDETERMINED):** all collections with a name-substring filter share the helper. A full audit per Track-2 would enumerate.

### Axis 6: label-claim integrity (NEW, copy-fixable)

The collection's surface name + tool description claim a broader scope than what the data actually covers. Distinct from Axis 7 because **remediation is copy/docstring edits, not code changes.** Distinct from Axes 1-5 because the data is correct within actual scope.

**Confirmed instances** (citation-backed from this session's wire reads):
- `registration_statements` — claims "registration statements"; actual coverage is S-1 (IPO) and S-3 (shelf) only. S-8 employee-plan registrations not ingested.
- `activist_ownership` — description references "Pre-2023 paper-style filings"; actual coverage floor is January 2024.
- `insider_transactions` — `data_source: "legacy"` option doesn't disclose that it holds ~91% fewer filings than `bulk_v2` (the default) for the same window. Consumer who explicitly picks legacy gets ~a tenth of the data silently.
- `annual_financial_disclosures` — Senate eFD coverage only; House Form 278 not yet ingested. Description discloses this; the tool name does not (mild — low priority).

**Additional rider — clarity item, not strictly an overclaim:**
- `activist_ownership` 13G/A exit filings have `shares_owned: 0` / `percent_of_class: 0` rows. These are correct data (an exit IS zero) but consumer-misreadable as missing data / nulls. Worth a docstring line clarifying the semantic.

**Remediation status:** Drafted as Commit B (Axis-6 tool description edits + 13G/A rider), separate authorization required before commit.

### Annual Financial Disclosures probe (resolved clean)

Wire-Claude's probe on Pelosi (bioguide P000197) returned zero docs from `annual_financial_disclosures`. Could have been per-entity coverage gap or dead scraper. Resolved by tool description: collection covers Senate eFD Form 278 only; House Clerk Form 278 is v1.1 (per the tool's own description). Pelosi is House → correctly empty by documented scope. Cross-confirmed: collection has recent Senate data (Cantwell 2026-05-18, Markey 2026-05-15) — scraper is current and parsing cleanly. Filed as resolved, not a finding.

---

## Doctrine refinements

### Standing-protections list grew from 2 to 4

The original v4 implicitly carried two protections from prior sessions. This round earned two more:

1. **Verify against source, not paraphrase.** (existing — Anthropic doc on auth, etc.)
2. **Every test result must cite an executable reproduction step.** (existing — earned from the Gemini Pentwater fabrication this session: a confident, plausible writeup of a probe that never ran, caught by comparing claimed test to execution history. Same pattern recurred a second time mid-session.)
3. **A mechanism sample is not a size estimate, ever.** (NEW — earned from the P0 sizing drift: wire-Claude's 10-record sample correctly characterized the mechanism but the framing implied "bounded, probably small"; the actual size was orders of magnitude larger at first count, then required threshold-design correction to be honest. Characterized ≠ sized.)
4. **Probes must be as defensive as the production code they validate.** (NEW — earned twice: (a) the Step 4a v1 namespace-blind grep regex misclassified 3 genuine shortfalls as parser-bugs; corrected via Code's mid-flight self-catch; (b) the initial recount blanket `>2027` threshold treated forward-looking fields as backward-looking; corrected via source-grounded resolution from `types.ts:1128`. Both times: the probe was less defensive than the production code it was supposedly validating.)

These should ride with every future audit / handoff. Worth pinning in the bootstrap section of the next handoff.

### Track-2 audit axes grew from 5 to 7

Original v4 framing had 5 axes. This round adds two more:

1. Silent misclassification (e.g., `transaction_nature` wrong)
2. Silent incompleteness / staleness (e.g., Berkshire's 11 missing 13F-HRs)
3. Count-check correctness (e.g., B+ dual-gate)
4. `TRACKED_FUNDS` entity/CIK integrity (e.g., BlackRock stale 0001364742)
5. Orphan accumulation (e.g., Harvest's 29 stale Q1-2026 docs pre-heal)
6. **Label-claim integrity (NEW).** Surface name + tool description matches actual data coverage. Remediation: copy/docstring edits.
7. **Query-path consistency (NEW).** Different access paths to same logical query return same result set. Remediation: code-level serving-layer change.

Every collection in the Track-2 scope should be audited against all 7 axes. The remediation paths differ:
- Axes 1-5: data-side fixes (parser, backfill, registry edits)
- Axis 6: copy fixes (cheapest, ship-anytime)
- Axis 7: code-level serving-layer fixes (one shared fix per the source-inspection finding)

### Launch-readiness ladder, revised

Original v4 implied a single integrity ladder. This amendment splits it into three independent unlocks, each gated by a specific fix:

| Fix | Shape | Effort | Unlocks |
|---|---|---|---|
| **Axis 6 (scope labels)** | Copy / docstring edits | Hours | Subscriber-facing claims honest about coverage |
| **P0 date corruption** | Parser fix + sibling-reconstruction backfill (~15-25K docs) | Days | "Recent insider activity" feature integrity |
| **Axis 7 (query-path consistency)** | One shared serving-layer fix (`matchesSubstringSafe` + 5000-cap), revised from "weeks" to plausibly "days" pending fix-design | Days (revised down) | "Search by filer/person/officer" feature integrity |

Each fix unlocks distinct surface area. The platform is not on hold behind one monolithic remediation. Sequencing is Greg's call; the dependencies are independent.

### Product boundary — the latest-only finding now generalizes

Original v4 named the latest-filing-at-ingestion qualifier as a product boundary specific to 13F. This amendment notes a pattern: multiple collections have narrower coverage than their names imply (Axis 6 family). The marketing/legal copy implication broadens:

- Any subscriber-facing claim about "comprehensive data" / "full coverage" / "verified data" must be qualified by the actual scope of the collection it describes.
- The honest claim pattern is "X covers Y (scope) verified at Z (operational boundary)." Each variable specific per collection.
- This is foundation-level copy discipline, not a per-feature carve-out.

---

## Process pattern: fabrication caught against execution history (recurring)

Twice in two sessions, a node has produced a confident, plausible writeup of a probe that never ran. The most recent example: a writeup referencing a "Pentwater Capital / Avis Budget" test with specific accession numbers and observed values, where no such query was actually executed against the live collection. Caught both times by comparing claimed test to execution history.

This is the failure mode the standing-protection (#2 above — "every test result cites an executable reproduction step") exists to prevent. The catch mechanism works **only** because:
- Execution history is reliable and cross-checkable across nodes
- At least one node compares claimed-vs-actual at the moment a claim enters the record
- The discipline is held in both directions (Code's count caught wire-Claude's attribution error; wire-Claude's read on `congressional_trades` would have caught a Code overclaim, etc.)

Worth pinning explicitly in next-session bootstrap: **fabrication is not a hypothetical risk; it has been observed twice. The catch mechanism is mandatory, not optional.**

---

## State of the world at amendment close

**Recon arc:** characterized, scoped, sized. Findings catalog has the P0 sized, Axis 7 sourced, Axis 6 enumerated. The Track-2 sweep of remaining ~23 collections is a follow-on track, not a blocker.

**Production state:** unchanged from original v4 close. Phase B LOCKED. A not authorized. D-architecture unscoped (now scoped pending Greg's go on the matchesSubstringSafe fix). Orphan cleanup not authorized. No production writes since `25feed4`.

**Open queue ordered by remediation severity (per launch-readiness ladder above):**
1. Axis 6 copy fixes (Commit B, drafted, awaiting Greg's go) — hours
2. P0 backfill — days, design-task next session
3. Axis 7 architectural fix — days (revised down), design-task next session

**Standing protections active:** all four.
**Track-2 axes:** 7.

---

**End of amendment.** Phase B LOCKED. A not authorized. D unscoped. Orphan cleanup not authorized. Standing by for Greg's review of Commit A hunks, then progression to Commits B and C per the stage-and-show sequence.

---

## Amendment 2 — P0 reframe: parser-innocent, source-faithful (2026-05-26)

The P0 sized in Amendment 1 was characterized as "bulk_v2 date corruption" — a pipeline bug to be reconstructed in a Phase 2 backfill. A read-only investigation through three layers (dry-run, source-TSV grep, EDGAR primary-filing spot-check) has refuted that framing at the root. **There is no KeyVex bug.** The dates are byte-faithful to SEC's authoritative source data; the "corruption" is a mix of SEC-side sentinels and filer-side data-entry errors that flow through our pipeline correctly.

This amendment closes the investigation record with the corrected characterization. Forward product work (interpretation layer, tool descriptions, positioning) is a separate Phase 2 effort and is intentionally not bundled into this close.

### Parser-innocent verdict

The bulk_v2 ingestion path was inspected in full. The only date transformation is `parseSecDate` at `src/scrapers/form345-bulk.ts:68-77` — a stateless `DD-MON-YYYY` → `YYYY-MM-DD` regex converter that returns `null` on bad input. No default, no clamp, no ceiling, no mutation. Bad input either yields `null` (preserved for `exercise_date` / `expiration_date`) or triggers a row-skip (for `TRANS_DATE`, line 419 in the same file). The save path (`saveInsiderTransactionsV2` at `src/firestore.ts:1026-1039`) calls `commitBatchesParallel` directly — no transformation in the storage path either. **Every value in `insider_transactions_v2` is a faithful translation of the corresponding `DD-MON-YYYY` value in SEC's source TSV.**

### SEC-source characterization — two distinct phenomena

What looked like "year-digit corruption" is two unrelated patterns in SEC's authoritative bulk distribution:

1. **The 2050-sentinel (~183 affected rows).** SEC's convention for "no-expiration / perpetual" instruments. Spot-checked rows show `EXCERCISE_DATE=31-DEC-2050` and `EXPIRATION_DATE=31-DEC-2050` on Deferred Stock Units, Units of Limited Partnership Interest, and certain Non-Qualified Stock Options — instruments with no calendar expiration date. SEC's bulk extract serializes "no expiration" as a far-future placeholder. This is correct data that the dry-run misread as corruption because the parser sees `2050-12-31` and the threshold catches it.

2. **Filer data-entry errors (~29,400 affected rows).** Two faces:
   - **2-digit-year typos** (the `00XX` face — ~29,363 rows): filer enters "12" / "15" / "23" / "25" into a year field, SEC's primary filing system accepts it verbatim as XML year `0012` / `0015` / `0023` / `0025`, the bulk extract preserves it, our parser produces `0012-XX-YY` etc. faithfully.
   - **Single-digit transpositions** (the `203X` face — ~205 rows): filer enters "2028" instead of "2024", "2031" instead of "2021", "2027" instead of "2026" — single-digit typos in the year. SEC accepts as-filed; bulk and parser preserve faithfully.

The taxonomy was confused by treating both faces as "corruption" and one transform. They're independent.

### Spot-check evidence — strong directional, NOT a census

A stratified spot-check of 19 evaluated rows (across all four corruption faces: 6 NONDERIV `00XX` transaction_date · 6 DERIV `00XX` exercise/expiration · 4 NONDERIV `203X` transaction_date · 3 multi-field DERIV) compared each corrupt date field against the original SEC primary Form 4/5 EDGAR XML.

**Result: 22 / 22 corrupt field-comparisons were byte-identical between the bulk extract and the SEC primary filing. Zero bulk-vs-primary discrepancies. Zero primary-missing.**

**Bound the claim explicitly.** This is a **stratified sample, not a full audit** of all ~29,400 affected rows. It is strong directional evidence that the filer-error characterization holds at the population level, but it does not formally certify zero discrepancies across the full ~10M-row collection. A single bulk-vs-primary discrepancy in unsampled rows would not be inconsistent with this evidence. The committee's read: 22/22 with 0 discrepancies across all four corruption faces is sufficient to close the investigation and commit to the publisher-posture remediation — but the language stays "strongly confirms," not "proves" or "definitively establishes."

Concrete examples from the spot-check (logfile: `.tmp/edgar-spotcheck-20260526-150902.log`):

| Doc ID | Filed | Bulk value | EDGAR primary value | Verdict |
|---|---|---|---|---|
| `0001900188-25-000010-NT` | 2025-07-25 | `transaction_date: 0025-07-25` | `0025-07-25` | filer typed "25" |
| `0001434728-24-000220-NT-7996300` | 2024-06-07 | `transaction_date: 0023-11-14` | `0023-11-14` | filer typed "23" |
| `0001193125-26-025268-NT` (Alphabet/Google) | 2026-01-27 | `transaction_date: 2027-01-25` | `2027-01-25` | filer typed "2027" for 2026 |
| `0001214659-14-002126-DT` | 2014-03-21 | `trans / exer / exp = 0012-11-21 / 0012-11-21 / 0017-11-21` | all three IDENTICAL in primary | multi-field co-occurrence in source |

**Footnote on the 3 AMBIGUOUS_MATCH rows.** Three of the 19 evaluated rows returned multiple XML candidates after the 4-field match key (security_title + transaction_code + transaction_shares + transaction_price_per_share). For 2 of the 3, the ambiguity was only on `transaction_date` (clean field, multiple candidates with different transaction dates) — every XML candidate's *corrupt* forward-field date was identical, so the verdict would have been CONFIRMED_FILER_ERROR regardless of which candidate matched. For 1 row (`0001133416-25-000047-DT-3324625`), the candidates had genuinely different exercise dates; that single row is indeterminate. These ambiguities do not weaken the result; they're match-key footnotes for the record.

### Ongoing-occurrence finding

The earliest spot-check row is from 2014; the **latest is 2026-02-11**, including a recent Alphabet filing (`0001193125-26-025268`). This pattern is not a legacy artifact — filers continue to enter 2-digit years and transposed-digit years in 2025 and 2026 filings, and SEC's primary filing system continues to accept and publish them. **Implication for the eventual interpretation layer: it is permanent standing behavior, not a one-time cleanup.** New bad dates will keep arriving via the live feed indefinitely. Whatever read-time annotation or documentation strategy is chosen in Phase 2 needs to be production-permanent, not a backfill-and-forget intervention.

### Reconstruction path: CLOSED, with the strengthened reason

The Phase 1 close already gated reconstruction as "risky." The investigation strengthens that closure to a categorical one: **backfilling these dates would fabricate data that diverges from the authoritative SEC source.** That is a direct violation of KeyVex's pure-publisher posture — a customer auditing a KeyVex record against EDGAR would find KeyVex's "fixed" date does not match SEC's published record. The reconstruction would have replaced ~14,541 faithful-to-source rows with KeyVex's *guess* of what the filer meant, including ~27,639 forward-field reconstructions that the dry-run's last-2-digit diagnostic measured as 99.96% systematically wrong.

**The gate held.** Catching this before any production write was the system working — but the lesson is bigger than "the gate worked." It's that the premise (data was internally corrupted by our pipeline) was unverified for most of the session; the cheap source-grep that refuted it (one TSV line read) was done at the END instead of the start. Earned standing protection below.

### Standing protection — added 2026-05-26

(v4-record version; a standalone memory file landing as Phase 2 will mirror this, linked from `MEMORY.md`)

> **Verify against the authoritative upstream source before naming any pipeline as the cause of anomalous data.** When values look wrong, the first check is "what does the upstream source actually contain?" — not "where did our pipeline mangle this?" Cached or locally-retained source files are the cheapest first check (one row, ~30 seconds of grep). Documentation summaries, second-hand characterizations, and "the value looks wrong" are not verification. This is the data-side companion to the existing `feedback_verify_facts_dont_assume.md` rule (the documentation-side version, which cost 14 hours of OAuth chase). Same failure mode: building elaborate scaffolding on an unverified premise. The 2026-05-26 P0 reframe session built a sized, gated, designed reconstruction on the premise that the bulk_v2 dates were internally corrupted; a one-row source grep — done at the end instead of the start — showed the data was SEC-faithful. **Verify the root before designing remediation.**

Standing-protections list grows from four to five.

### Parked items unchanged by this amendment

- The 6 missing-`filing_date` `insider_trades` rows (live-feed Form 4 scraper schema gap) — still Phase 2 / next-session.
- The 142 corrupt-looking `period_of_report` rows in `insider_transactions_v2` — same SEC-source-faithful framing applies; will be covered by the Phase 2 interpretation layer alongside `transaction_date` / `exercise_date` / `expiration_date`.
- Axis 6 copy fixes (Commit B `3bdd56d`) — already committed locally, still pre-deploy.
- Axis 7 (`matchesSubstringSafe` + 5000-cap) — design task still open for a separate session.
- Track-2 sweep of remaining ~23 collections — still a follow-on track, not a blocker.

### State of the world at Amendment 2 close

- **Investigation record:** closed. Parser innocent, dates SEC-faithful, reconstruction permanently off the table.
- **Production state:** unchanged. No writes since `25feed4`. The local commit batch (A `90dce88` · B `3bdd56d` · C `9546d47` · housekeeping `6e77a39`) is still pre-push.
- **Phase 2 (forward product work):** designed in shape (interpretation layer = documentation + read-time annotation per Model B; positioning = provenance-faithful trust claim) but **not yet drafted, not committed, not designed in code** — separate session, separate review, separate gate.
- **Standing protections:** five.
- **Track-2 axes:** seven.

**End of Amendment 2.** Phase B LOCKED. Backfill/reconstruction CLOSED — and now permanently, on the strengthened reason: fabrication against the authoritative source violates pure-publisher posture. Re-ingest NOT authorized (would change nothing — values are SEC-faithful). CIK swap NOT authorized. Axis-7 fix NOT authorized. Orphan cleanup NOT authorized. The 6 missing-filing_date live-feed rows + 142 period_of_report rows remain parked for Phase 2.
