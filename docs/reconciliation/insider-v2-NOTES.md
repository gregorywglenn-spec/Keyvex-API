# insider_transactions_v2 — full reconcile (2026-06-11) — THE BIG ONE, CLOSED

**Verdict: 81/81 quarters count-exact against SEC's own bulk TSVs. Zero
mismatches across all three collections (transactions + holdings + filings,
18.4M docs, 2006q1 → 2026q1).**

## What was verified, layer by layer

1. **All-quarters count check (this session):**
   `scripts/_verify-bulk-all-quarters.ts` — for EVERY loaded quarter,
   Firestore doc counts (by source_zip filter) vs row counts rebuilt from
   SEC's quarterly bulk TSV bundles. Result: 81/81 OK, 0 mismatches.
   Artifact: `insider-v2-81q.csv` (per-quarter numbers, both sides).
   Re-run any quarter: `npx tsx scripts/_verify-bulk-all-quarters.ts
   --quarters=2019q3`.
2. **Field-level fidelity (Gate-6, 2026-05-24, still standing):** 64-doc
   round-trips across 3 eras, 0 field mismatches; era-tag invariants hold.
   `docs/bulk-form345-gate6-complete.md`.
3. **Recency boundary (found + fixed this session):** bulk ends at the last
   PUBLISHED SEC quarter; a default-source query for later filings returned
   ~nothing with no explanation. The tool now warns when the queried window
   crosses the boundary and points at the data_source:'legacy' bridge.
4. **Quarterly continuation (built this session):**
   `scrapeForm345BulkQuarterly` fires monthly, no-ops until SEC publishes
   the next quarter bundle, loads it, and advances the boundary via
   `meta/insiderBulkSync` (which the tool reads — no code change per
   quarter). Health-monitored as `insiderBulkSync` (monthly tier).

## Source of truth

SEC "Insider Transactions Data Sets" quarterly zips
(www.sec.gov/files/structureddata/data/insider-transactions-data-sets/
{quarter}_form345.zip). Per-quarter zips cache in TEMP scratch dirs;
re-verification re-uses them.
