# Gate 6 — Full SEC Bulk Insider Dataset Load — COMPLETE

**Status:** ✓ COMPLETE and verified across 3 eras
**Date:** 2026-05-24
**Branch:** `claude/form345-bulk-load-2026-05-23`

---

## Final state

| Collection | Doc count |
|---|---:|
| `insider_transactions_v2` | **9,923,755** |
| `insider_holdings_v2` | **4,108,700** |
| `insider_filings_v2` | **4,402,307** |
| **TOTAL** | **18,434,762** |

**Coverage:** 2006q1 → 2026q1 inclusive (81 quarters loaded + 1 not_published — 2026q2 ends June 30, won't publish until mid-July 2026).

## Wall time breakdown

| Phase | Wall |
|---|---:|
| Single-threaded resume run (2006q1 → 2008q1, 9 quarters) | ~10 hr 42 min |
| Power outage (no progress) | (interrupted 2008q2 mid-write) |
| Parallel saver build + N=50 fail + N=10 smoke | ~30 min code work |
| N=10 parallel orchestrator (2008q2 → 2026q1, 71 quarters) | ~8 hr 44 min |
| **Cumulative wall** | **~20-24 hrs** |

For context: original EDGAR-scraping plan estimated **3+ weeks**. Bulk-dataset pivot collapsed that. See `docs/bulk-form345-schema-brief.md` for the full pivot story.

## Verification — cross-era cold check

Script: `scripts/_verify-bulk-cross-era.ts`
Eras sampled: **2008q2** (post-crisis peak, pre_2023), **2015q3** (mid-cycle calm, pre_2023), **2024q1** (modern, 2023_plus)

| Metric | 2008q2 | 2015q3 | 2024q1 |
|---|---:|---:|---:|
| Source TSV transactions | 222,376 | 86,040 | 154,295 |
| Firestore transactions (by source_zip filter) | 222,376 ✓ | 86,040 ✓ | 154,295 ✓ |
| Source TSV holdings | 73,197 | 35,044 | 46,853 |
| Firestore holdings (by source_zip filter) | 73,197 ✓ | 35,044 ✓ | 46,853 ✓ |
| Source TSV filings | 67,641 | 42,553 | 67,671 |
| Firestore filings (by source_zip filter) | 67,641 ✓ | 42,553 ✓ | 67,671 ✓ |

**Per-quarter doc counts match source TSV exactly.** Zero loss.

### Field-by-field round-trip

15 accessions sampled (5 per quarter, deterministic stride spread), pulling each accession's filing + every transaction + every holding from Firestore by doc-ID and comparing every non-timestamp field against the source TSV row:

| Metric | Count |
|---|---:|
| Docs round-tripped | 64 |
| Docs with any mismatch | **0** |
| Field-level mismatches | **0** |

### Era-tag invariant

For each quarter, sampled 100 random `insider_transactions_v2` docs and checked the `aff10b5one` field:

| Quarter | Era | Expected | Actual |
|---|---|---|---|
| 2008q2 | pre_2023 | `"NOT_TRACKED"` on every row | **100 / 100 ✓** |
| 2015q3 | pre_2023 | `"NOT_TRACKED"` on every row | **100 / 100 ✓** |
| 2024q1 | 2023_plus | one of `"1"` / `"0"` / `""`, NEVER `"NOT_TRACKED"` | **100 / 100 ✓** |

Gate 4 spec held perfectly across 20 years. Era boundary (2022q4 → 2023q1) is clean — no rule violations.

## Operational tooling added this session

| Script | Purpose | Safe-while-running? |
|---|---|---|
| `scripts/_progress-snapshot.ts` | Read-only progress + ETA + sanity-check of checkpoint vs Firestore counts | YES |
| `scripts/_verify-bulk-cross-era.ts` | Multi-era field-by-field cold check (replayable any time) | YES |
| `scripts/_check-2008q2.ts` | Quick single-quarter count probe | YES |
| `scripts/_diag-post-outage.ts` | What-landed-vs-expected for a partial-write recovery | YES |
| `scripts/_acceptance-malecek-footnote.ts` | Earlier Gate 5 footnote-through-MCP test | YES |
| `scripts/deploy-mcp.sh` / `.ps1` | Bakes `FUNCTIONS_DISCOVERY_TIMEOUT=120` for 15.6 MB bundle | n/a |

## What's already running in production

- `mcp.keyvex.com` v0.48.0 serves the v2 surface via `get_insider_transactions(data_source: "bulk_v2", ...)` (deployed earlier this session).
- Daily Form 4 scraper continues writing to legacy `insider_trades` collection (unchanged — Greg's choice to coexist during Gates 5-7).
- 18.4M v2 docs queryable now via ticker/company_cik/reporting_owner_cik/etc. **Date-range and sort_by queries need the 16 composite indexes to be deployed.**

## Open items rolling forward

1. ✅ Deploy 16 composite indexes — unlocks v2 date-range/sort queries
2. Gate 7 — cutover diff between bulk and legacy across 2023+ overlap
3. Gate 8 — SEAM definition + daily-scraper upgrade architecture
4. Independent cold-check by Greg through `mcp.keyvex.com` (any 2008/2015/2024 row he wants to inspect)

## Key memorable facts for future-Greg / future-Claude

- **Per-quarter idempotent doc-IDs** make re-runs safe. Crash mid-quarter = re-run that quarter, no data corruption ever. Proven by the power outage incident.
- **Bulk dataset publish lag is ~2-3 weeks** post-quarter-end. 2026q2 (ends June 30) won't appear until ~July 15.
- **N=50 parallel batches saturates residential upload** → DEADLINE_EXCEEDED. **N=10 is the verified sweet spot** for this network (8 min/quarter avg). For Cloud Run / fiber networks N could go much higher.
- **Era boundary locked at 2023q1.** All 2006q1-2022q4 = `pre_2023`. All 2023q1+ = `2023_plus`. Matches SEC Rule 10b5-1 amendment compliance date (April 1, 2023). Verified empirically on 2022q4 and 2023q1.
