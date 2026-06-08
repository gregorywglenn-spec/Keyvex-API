# KeyVex Data Quality Benchmark — THE fixed target

This is the standard every KeyVex dataset is held to. It is the goal we work to.
When work drifts, point at this file.

Set by Greg, 2026-06-08.

---

## The standard

For **every** dataset KeyVex publishes (all ~38 sources), strive to be **as close to
100% as possible** — and, non-negotiably, **closer to 100% than the nearest
competitor** (Quiver, Capitol Trades, Unusual Whales, FMP, EODHD, etc.).

Floor: **≥ 98%** on both tests below. Goal: as far above that as the source allows.

This is not a one-time bar. **Ongoing daily updates are held to the same standard.**

---

## "Done" = two tests, both verifiable BY GREG (not by the AI's word)

A dataset meets the benchmark only when both pass, and both are confirmed by Greg
against the government's own records — never accepted on the builder's say-so.

### Test 1 — COMPLETENESS (a full census, not a sample)
Completeness has **two dimensions** — both must pass:

**1a. Every FILING.** Diff KeyVex against the source's **authoritative index**
(House Clerk index, Senate eFD list, EDGAR filing index, FEC totals, Treasury
list, etc.).
- Checkable at 100% — every filing, not a sample.
- **Pass = ≥98% of the source's filings are in KeyVex**, and *every* gap is
  documented with a reason (nil / unreadable / pending), not silently absent.

**1b. Every TRANSACTION within each filing — ALL types.** Capture **buy, sell,
AND exchange** (and any other disclosed transaction type). Exchanges are trades:
corporate spinoffs, stock-for-stock deals, fund share-class exchanges all count
and must NOT be dropped. No transaction type, owner code, or asset class is
silently excluded. Where the source gives an **exact amount** (newer electronic
filings), capture it; otherwise capture the disclosed range.

- **Verified by:** a report Greg runs that lists each missing filing with a
  **clickable source link**, plus a per-type count (buy / sell / exchange) so a
  whole category can't silently read as zero. Greg confirms by opening links.

### Test 2 — CORRECTNESS (a stratified sample)
Can't hand-check every record, so sample — but deliberately.
- **Stratified** across years, filing formats, and transaction/record types
  (so systematic category holes — e.g. dropped exchanges — can't hide).
- Sample size: **~400 records → 95% confidence, ±5%.** ~1,070 → ±3%.
  (Sample size is ~independent of total population size.)
- Paired with a **category checklist**: every known format and record type must
  be confirmed to parse (catches silent category drops a random sample misses).
- **Pass = ≥98% field accuracy** vs the source documents, with every error class
  named and counted.
- **Verified by:** the sample report with a source-doc link next to each record.

---

## Non-negotiable principles

1. **The builder is never the grader.** Every quality number bottoms out in
   something Greg can independently confirm against the government source.
2. **No silent exclusions.** Any record/field/category the code drops is a
   documented decision, surfaced — never buried in a `continue`.
3. **Foundation before features.** No new data sources are added until the
   existing ones meet this benchmark and have a re-runnable verifier.
4. **One dataset at a time**, driven fully to benchmark + verified, before the
   next. This prevents the accretion-of-uncoordinated-pipelines problem.

---

## Order of attack
1. **Congressional trades** (House + Senate PTRs) — in flight, do first.
2. Then the rest of the ~38 sources, one at a time, highest-value first.

Each gets: a completeness verifier + a correctness sample report, both
Greg-runnable, both producing the two numbers above, before it's called "done."
