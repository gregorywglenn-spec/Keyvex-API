# Form 4 Backfill — Plan + Q1/Q2 Answers

**Date:** 2026-05-23
**Owner:** Greg
**Status:** SPIKE pending; harness build not started; no production changes yet.

---

## Decisions locked

| | Decision | Rationale |
|---|---|---|
| Target depth | **5 years (back to 2021)**, architecture built to extend to 10 | Build work identical either way; 5-first halves cost/time/risk; extension is just re-running on older years. *Override only if convergence-math lookback check says hardcoded 10yr.* |
| Rate target | **~9 req/s** (RATE_LIMIT_MS 110ms) | SEC's 10/s ceiling, leaving burst headroom |
| User-Agent | Already correct: `"KeyVexMCP/0.1 contact@keyvex.com"` | Per SEC requirement |
| Deploy posture | Branch + PR, **Greg deploys manually** | Standing rule |
| Verification | **Re-query LIVE data, spot-check vs SEC source** per year before staging next year | Layer 2 self-check is necessary but not sufficient |

---

## Q1: Does a BULK / daily-index path exist?

**No.** Code-read findings:

| Existing path | Code | Limitation |
|---|---|---|
| `scrapeForm4ByTicker` (`form4.ts:400`) | per-ticker submissions API | recent[] cap ~1000 per CIK; no CIK enumeration |
| `scrapeForm4LiveFeed` (`form4.ts:470`) | cross-CIK FTS | single page, maxFilings=100 hard cap; EDGAR FTS 10K-result hard ceiling per window |

**Build needed:** bulk enumeration via `/Archives/edgar/full-index/YYYY/QTRn/form.idx`. ~40 text-index files for 10 years; filter to form=4+4/A; gives (cik, accession, primary_doc) tuples.

### Current scraper robustness gaps (will be addressed)

| Required | Status |
|---|---|
| Descriptive User-Agent | ✅ |
| Throttling | ⚠️ 150ms ≈ 6.7 req/s (under target 9) |
| 429 / 5xx backoff with Retry-After | ❌ throws on first failure — applies to PROD scrapers too |
| Resumability / checkpoints | ❌ none |

---

## Q2: Does the parser handle PRE-2023 Form 4 XML?

**Probably yes for 2016+, but needs empirical verification via the SPIKE.**

Parser (`form4.ts:200 parseForm4Xml`) reads canonical Form 4 ownership XML paths (`ownershipDocument.{issuer,reportingOwner,nonDerivativeTable,derivativeTable}`). These structural names have been constant across SEC schema versions `form345X02 → X03 → X04 → X05` (~2013 onward). The `read()` helper already handles both bare-value and `{value:...}` wrapper shapes (the dominant historical variation).

**Risk areas requiring empirical test (the SPIKE covers these):**

1. Pre-2013 X01 schema — outside the 5-year target window (2021+), but spot-check 2016-2018 to confirm
2. Text-only paper-filing fallback — parser silently returns `[]` when `parsed.ownershipDocument` is undefined; need to LOG every such skip
3. Multi-owner array-shape handling — fixed April 2026 (`form4.ts:215`); validate 2016-era multi-owner filings still trip the array path
4. Derivative-row fields — pre-v0.41 rows had null `is_derivative`. NEW writes from parser populate it correctly (hard-coded in `nonDerivativeTable` vs `derivativeTable` paths)
5. value == shares × price arithmetic — parser computes server-side; verify it holds on old filings

---

## Step 0 — Parser SPIKE (runs first, no harness)

**`scripts/spike-form4-old-xml.ts`** — throwaway script:
- Pulls ~30 Form 4 filings from EDGAR FTS spanning 2016/2017/2018 (10 per year, stride-sampled across each year)
- Runs each through the existing `parseForm4Xml`
- Verifies per-filing: ownershipDocument defined, ≥1 row parsed (or legitimately 0), value=shares×price, year in [2012, current+1], is_derivative is boolean, multi-owner array-shape handled
- Prints a result table + summary + clean-gate verdict

**Clean gate criteria (all must pass before harness build):**
- 0 parser exceptions
- 0 ownershipDocument-undefined silent-empties
- 0 transaction_date year out of [2012, current+1]
- 0 value≠shares×price rows
- ≥1 multi-owner filing surfaced in the sample (coverage check)
- ≥1 derivative-row filing surfaced (coverage check)

**If spike FAILS on any era → fix parser FIRST.** Do not build harness around broken foundation.

---

## Harness build items (only if spike clean)

| # | Layer | Item | Hardens prod too? |
|---|---|---|---|
| 1 | Q1 fix | Bulk full-index reader (`/Archives/edgar/full-index/YYYY/QTRn/form.idx`) | New code |
| 2 | Layer 1 | 429/5xx exponential backoff honoring Retry-After in `fetchText/fetchJson` | **Yes** — current prod scrapers throw on first 429 |
| 3 | Layer 1 | RATE_LIMIT_MS 150→110 (~9 req/s) | Yes |
| 4 | Q2 guard | transaction_date year sanity in parseForm4Xml (in [2012, current+1] or null + log) | Yes — prevents future-year corruption class |
| 5 | Layer 1 | Per-filing try/catch ensures full accession + URL in skip log for forensic recovery | Yes |
| 6 | Resumability | `meta/form4Backfill/{year_qtr}` Firestore checkpoint doc | New |
| 7 | Cloud dispatcher | `runForm4BackfillChunk(year, quarter, cursor?)` Cloud Function — chunked, resumes from checkpoint | New |
| 8 | Layer 2 | Post-chunk self-check assertions; on failure write `status: "HALTED"` + reason; do NOT trigger next chunk | New — **load-bearing safety piece** |

**Sequencing:** items 1-8 before pilot. **Items 2-5 hardening also addresses latent prod gaps.**

---

## Pilot — calendar year 2022

After harness items 1-8 commit, run pilot ONE YEAR (2022) only. Layer 2 self-check on completion: count sanity, no future dates, value=shares×price sample, is_derivative populated. Halt if any fail.

**Human verification (Greg + Claude) — required gate:**
- Bring count, date range, parser error count, skipped accessions to chat
- Re-query live data; spot-check 5-10 known 2022 filings (e.g. AAPL CIK 320193 Tim Cook sells) against actual SEC source
- Coverage_warning window updated correctly

Only after pilot is verified clean do we:
1. Compute cost estimate (pilot doc count × year-count × Firestore pricing)
2. Build item 9 — scheduled monitor (Layer 3, separate Cloud Function)
3. Stage 2021 (then 2020/2019/etc. if extending to 10)

---

## Three-layer model (Greg's spec)

| Layer | Scope | Action on failure |
|---|---|---|
| **1. Self-heal** | Mechanical (429s, network, single bad filing) | Backoff + retry; SKIP single failures with logged accession |
| **2. Self-check** | Correctness (date sanity, value math, is_derivative coverage, count ballpark) | **HALT + write reason; do NOT auto-fix; do NOT trigger next chunk** |
| **3. Scheduled monitor** | External watcher | Alert Greg via existing Slack/email plumbing on stall or HALT status |

**Distinction is load-bearing:** mechanical failures self-heal; correctness failures wait for a human. Never auto-guess at bad financial data.

---

## Known bug guards baked into harness

| Bug | Guard |
|---|---|
| year-3031 transaction_date corruption (House PTR class) | Item 4 — parse-time year sanity, log + null rather than store |
| is_derivative null gap (pre-v0.41 rows) | Parser already populates correctly on new writes; verify in SPIKE |

---

## What's NOT in scope yet

- Convergence-math lookback check (Greg owns this; could override 5→10)
- Stripe / paid-tier billing (post-Anthropic submission item)
- Per-customer API keys
- Multi-source health-check telemetry extension (separate concern)
