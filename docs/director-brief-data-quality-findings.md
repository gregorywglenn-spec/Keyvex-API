# Brief for the Director — Data-Quality Findings & Systematic Repair

**Date:** 2026-06-03
**From:** Code (with Greg)
**Subject:** Targeted source-truth sampling shows severe, systematic undercoverage across KeyVex's scraped data (overall completeness unmeasured pending the full audit). Root cause, evidence, and the repair now underway.
**Full living detail:** `docs/data-quality-remediation.md` (board + findings log).

---

## 1. Executive summary

Targeted source-truth checks — comparing KeyVex's data against the actual government APIs (and Quiver as a cross-check) — found **severe, systematic undercoverage in every dataset we sampled.** High row counts (51k lobbying, 23k contracts, 163k insider) created an *illusion of depth*; the true universes are far larger. **These are targeted samples, not a census** — the precise overall completeness rate is unmeasured pending the full audit. But every probe we ran came back severely short, with exact numbers below.

**Root cause: we built 38 scrapers but never backfilled them.** Each scraper was validated on a small, recent, or capped sample, marked "done" when it returned data, and we moved to the next. The comprehensive historical backfill — the actual hard part — was assumed or deferred and, for almost everything, never run.

The automated audit (battle-test) did not catch this because **it measured the wrong thing**: "does the tool respond / are there rows," never "does the result match the source." Green meant *"it didn't crash,"* not *"it's complete."* So it passed at 100% while the data was hollow. This fooled the build process and the agents in it alike — it is a methodology gap, not any individual's failure.

We have set a new standard, built a verification harness, and started the systematic repair. The first dataset (lobbying) is backfilling now.

---

## 2. How we got here — built, never backfilled

- The project was built in fast daily sprints: scraper after scraper, optimizing for breadth ("another source live!").
- Every documented ingest was a **small, recent, or capped** pull — e.g. `form4-feed 1`, `senate 7`, `house 7`, `8k-feed 1`, `lobbying-feed 2025 fourth_quarter --save --max=100`, `form144-feed 7`. The Cloud Function crons run on **1-/7-/30-day lookbacks** (correct for *incremental* top-off, but they assume a backfill happened underneath).
- **"Done" was defined as "returns data on a sample."** The comprehensive backfill was only ever run for a handful (Form 278, bioguide, XBRL, OGE 278-T). For the flagship collections — lobbying, contracts, congressional, insider — it was **never executed.**
- Net result: a broad, impressive-looking 38-tool surface, every tool standing on a thin, never-backfilled slice of its data — severity varies by collection (lobbying low-single-digit %, institutional 17 of the SEC's thousands), but every dataset we sampled came back severely undercovered.
- The battle-test/audit reinforced the illusion (responds + row-count, not completeness), so nobody — including the Director and the building agents — distinguished "the scraper functions on a sample" from "we have the whole dataset."

---

## 3. The evidence (targeted source-truth probes, 2026-06-03)

These are **hand-picked probes, not a statistical census.** Each is a 3-way check —
**source API truth / what's in our Firestore (direct scan) / what our tool returns** —
and each came back severely short. Read them as "every door we opened was undercovered,"
not as a measured rate.

**Lobbying** (source = LDA all-time totals; our store is all-time too, so this is a true ratio):
| Client | LDA truth | In Firestore | Tool returns |
|---|---|---|---|
| Costco | 13 | 1 | 0 |
| Pfizer | 1,745 | 11 | 2 |
| Lockheed | 3,152 | 46 | 21 |
| Microsoft | 2,253 | 36 | 12 |
| Comcast | 3,080 | 47 | 18 |

→ Lobbying holds **low-single-digit %** of the real record, AND the tool returns *fewer than
we even hold* (Lockheed 21 of 46) — i.e. **both** an ingestion gap **and** a query bug. Both
directly evidenced (Firestore direct-scan count > tool count > we'd need ≫ to match source).

**Institutional 13F** (verified this session):
| Probe | In Firestore | Tool returns | vs source |
|---|---|---|---|
| NVDA holders | 17 | 17 | SEC has *thousands* of 13F filers holding NVDA |

→ Firestore (17) **equals** tool (17), so **query is fine here — this is pure ingestion.**
Whole collection is only 1,498 rows. (This is the disambiguation that confirms "never
backfilled" as the cause for 13F, rather than a retrieval bug.)

**Congressional** (qualitative — no % computed): NVDA returns recent trades but is
**missing whole prolific filers** that Quiver's record shows (e.g. Ro Khanna, McCaul) — i.e.
present-but-incomplete, not empty. Exact ratio not yet measured.

**Federal contracts / grants — READ CAREFULLY (window-vs-all-time, NOT a coverage rate):**
KeyVex's `federal_contracts` holds only a **~1-month window** (Apr 29 – Jun 1 2026); the
USAspending totals are **all-time** (Lockheed 673,869; Boeing 278,939). So these show
**we have essentially no historical depth** — but comparing a 1-month window to an all-time
total is NOT a measured completeness percentage and must not be quoted as "0.002% complete."
The defensible statement: *contracts/grants currently retain only a recent rolling window;
historical depth is absent.* (Within-window completeness is unmeasured.)

Plus structural failures found in the audit:
- **`government_publications`: 0 records** — scraper totally failing.
- **`registration_statements`, `private_placements`: broken date fields** — date-sorted/filtered queries don't work.
- **Rolling-window collections hold ~1 month only:** federal_contracts, federal_grants, sec_fails_to_deliver, cftc_cot, consumer_complaints, federal_register, nport_filings.

---

## 4. Two bug classes — confirmed per-collection, not assumed universal

1. **Ingestion incompleteness (the dominant cause).** Capped / recent-only pulls; the data was never fully fetched. Confirmed for lobbying (11 of Pfizer's 1,745 in Firestore) and institutional (17 NVDA filers in Firestore; 1,498 rows total vs the SEC's vastly larger universe). Fix = comprehensive backfill from the bulk source.
2. **Query-layer window bug (real, but per-collection — not blanket).** ~10 query functions use `fetchLimit = query.<name> ? 5000 : ...` then filter in memory, so a name/company search only scans the most-recent 5,000 rows. **Confirmed to bite on lobbying** — Costco's 1 record exists in Firestore but the tool returns 0; Lockheed has 46 in Firestore but the tool returns 21. **Confirmed NOT to bite on institutional** — NVDA is 17 in Firestore = 17 from the tool (collection smaller than the window). So the code is shared, but its *impact* must be checked per collection, not assumed. Also emits a misleading `coverage_warning` implying a full-range search when it scanned only a recent slice.
3. **History gaps** — rolling-window collections (contracts, grants, FTD, etc.) retain only ~1 month; no historical depth.

Crucially: the split between "present-but-unreachable" (#2) and "never loaded" (#1) **varies by collection and must be measured per collection.** Institutional is purely #1; lobbying is both. We do **not** yet have that split across all 38 — establishing it is part of the systematic audit, not something this brief assumes.

---

## 5. Strategy inflection — comprehensive IS feasible (mostly)

We verified the government sources publish bulk/full data:
- **FEC** — bulk files back to 1979. **USAspending** — yearly award archives back to 2008. **SEC EDGAR** — complete filing index (we already connect to it). **LDA lobbying** — full history via the API (with a key) or Senate bulk XML (pre-2021). **House Clerk** — yearly index of every filing.

So the backfill is feasible — it is the one-time step we skipped — **except** the giants (federal contracts: hundreds of millions of rows). For those: on-demand pass-through or a cheaper bulk store, not full Firestore mirroring.

**Lookback policy:** 10-year default (matches/beats Quiver's ~2016 depth and covers virtually all use). Full history only where a dataset is small enough that keeping all of it is effectively free (executive 278-T, OFAC, FARA, recalls).

---

## 6. The governing rule (the discipline change)

**Foundation before features. Always.**
1. A scraper is **done** only when **built + backfilled + verified against the source** — never on a row count or "it returned data."
2. The backfill is part of building it, not a someday.
3. **No new scrapers until the existing ones are real.** Breadth stops; we finish.
4. Source-truth verification (the Costco/NVDA method) is the only thing that marks a dataset complete.

---

## 7. The systematic repair (now underway)

- **Verification harness** (3-way: source API / Firestore / tool) classifies each collection's failure precisely. Reusable across all ~40.
- **Living board** (`docs/data-quality-remediation.md`): every collection by priority tier, with its source oracle, known issue, and status. ✅ only when source-verified.
- **Phase 0 (once, global):** fix the shared query-window bug + ship the harness.
- **Per-scraper loop, priority order** (congressional, lobbying, institutional, contracts, insider first): comprehensive backfill from bulk → verify vs source (+ Quiver where it overlaps) → mark green → next.
- **Proof it works — running now:** the **lobbying backfill** is live (`scripts/backfill-lobbying.ts`): keyed LDA access (120/min — we found the old scraper was silently over the 15/min anonymous limit), 10-year window, resumable/checkpointed, streaming idempotent writes. First batches confirmed saving. On completion it will be verified to match the source for the 2016+ window (Costco→13, Pfizer→1,745, Lockheed→3,152).
- **Realistic timeline:** ~1 week for the full sweep across all collections.

---

## 8. Architecture decision in flight — shared warehouse

Both KeyVex (`capitaledge-api`) and Derek's project (`capital-edge-d5038`) need this same raw data. Rather than stock two copies, we're consolidating the raw layer into **one warehouse (KeyVex side)**; Derek's project reads from it and retires its duplicate scrapers as each dataset goes verified-complete. Derek's derived layer (convergence scores, etc.) stays on his side. Brief sent to Derek (`docs/shared-warehouse-brief-for-derek.md`).

---

## 9. Recommendation for the audit itself

The battle-test should be **rebuilt around source-truth comparison** — counts/responds-without-error is exactly the blind spot that let this hide. The new 3-way harness is that replacement and should gate any future "complete" claim.

— Code
