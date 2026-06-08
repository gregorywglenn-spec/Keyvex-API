# KeyVex Reconciliation System — THE method (not another fix)

The thing that ends the cycle. One framework, every dataset reconciled the same
way, continuously. Built once; each dataset is then a small, identical drop-in.

Pairs with `KEYVEX-QUALITY-BENCHMARK.md` (the target) and
`KEYVEX-DATA-INVENTORY.md` (current state). Set 2026-06-08.

---

## Why this is "THE" solution and not more patching
Past work found gaps **by accident** (a bad Kustoff filing) and patched them **by
hand**. That guarantees endless surprises. This system finds **every** gap
**mechanically and on a schedule** — including silent category holes (dropped
exchanges) — so nothing waits to be stumbled on. Build the framework + one adapter,
and every other dataset is the same machine with a 30-line config.

---

## The 5 components (built once)

### 1. Source Adapter — the ONLY per-dataset code (small, ~30–50 lines)
Each dataset defines exactly five things:
- `sourceIds()` → the authoritative set of IDs that *should* exist (the denominator).
  e.g. House Clerk yearly XML → every PTR id; EDGAR full-index → every accession.
- `keyvexIdField` → the field in our collection holding that id (e.g. `ptr_id`).
- `sourceRecord(id)` → fetch one source document, for correctness checking.
- `sourceUrl(id)` → the clickable government link (so Greg verifies, not the AI).
- `expectedTypes` → categories that must be present (buy/sell/exchange, etc.) so a
  whole class can never silently read zero.

### 2. Reconciler — generic, runs ANY adapter
- Pull `sourceIds()` + KeyVex ids → diff.
- Output: **coverage %** + the **exact missing-id list**.
- Classify every missing id by fetching it: **recoverable** (has data) / **nil**
  (nothing to report) / **unreadable** (corrupt) / **gone** (404).
- **Unexplained-missing = missing − (nil + unreadable + gone). Target: 0.**

### 3. Correctness Sampler — generic
- Stratified random sample (across years / formats / types).
- Size: ~400 → 95% conf ±5% (configurable up).
- Fetch each source doc, compare every field → **accuracy %**, **error classes**,
  and **per-type counts** (so missing categories surface).

### 4. Recovery — reuses each dataset's existing scraper/parser
- Reprocess the **recoverable** missing through the parser.
- Where the parser has a real gap (exchanges, a filing format), fix the parser
  **once**, then reprocess. The fix is permanent and covered by the verifier forever.

### 5. Standing Report — one artifact Greg reads (and a cron that keeps it fresh)
- Auto-generated table: every dataset × three gauges + clickable links.
- Re-runnable on demand; scheduled so drift (new filings un-ingested, a regression)
  shows up immediately instead of months later.

---

## The procedure — IDENTICAL for every dataset
1. Write the adapter (5 fields).
2. Run Reconciler → coverage % + classified missing list.
3. Fix any real parser gap **once**; run Recovery.
4. Run Sampler → accuracy % + per-type presence.
5. When **all three gauges are green AND Greg has clicked a few links to confirm**,
   flip that dataset's line in the inventory from "NOT MEASURED" to the measured %.
6. Schedule the Reconciler so it **stays** green.

### The three gauges (the definition of "complete," per the benchmark)
- **G1 Coverage** ≥ 98%, unexplained-missing = 0.
- **G2 Correctness** ≥ 98%, all expected types present.
- **G3 Continuous** — verifier re-runs on schedule; ongoing updates stay in band.

---

## Order of execution
- **Congress (House) first** — it's in flight and becomes the **template**. Building
  its adapter + proving the Reconciler/Sampler on it is ~80% of the total build.
- Then each remaining dataset = write a 5-field adapter, run the same machine, fix
  any one-time parser gap, confirm. Down the inventory by value.

## Honest limits (stated up front, not discovered later)
- A few sources publish no authoritative index. For those, completeness can't be
  fully proven; the report will say "consistency-checked, not census-verified"
  rather than show a false %.
- "Complete" = every source item accounted for (have-it-correctly OR known-reason-
  we-don't). It is **not** "100.000% perfect" — the benchmark floor is 98% with
  every remaining gap explained.

---

## What you get at the end
A single page where every one of the ~39 datasets shows three green gauges and links
you can click to verify. Completeness stops being a feeling you chase and becomes a
dashboard you watch. The surprises end because the machine surfaces every gap on a
schedule — there's nothing left to stumble onto.
