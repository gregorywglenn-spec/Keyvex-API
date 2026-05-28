# Gate 5 Items 1-2-3 — Resolution Report

**Status:** All three resolved. Ready for Greg's Gate 6 (full 2006-2025) greenlight.
**Date:** 2026-05-23
**Branch:** `claude/form345-bulk-load-2026-05-23`

---

## Summary

| Item | Status | Proof |
|---|---|---|
| 1 — Collection contents | ✓ RESOLVED | `insider_transactions_v2` contains 2023q1 only. MCP tool reads `insider_trades` (legacy). The "Aug 2024 disclosure / 405-day lag" rows Greg saw are from legacy, completely separate. |
| 2 — Era tag is filing-date-driven | ✓ RESOLVED | Found 10 v2 rows with `transaction_date` in 2009-2011 (12-14 years before filing). All correctly tagged `schema_era="2023_plus"` because the FILING is in 2023+. Rule now documented in code comments + tool description + this report. |
| 3 — Footnotes through MCP | ✓ RESOLVED | Footnotes ARE in Firestore (direct doc-ID fetch confirms). MCP `get_insider_transactions` extended with `data_source: "legacy" \| "bulk_v2"` parameter. Acceptance test PASSED — Malecek/PRTA query returned the *"adopted September 20, 2022"* footnote text via the same handler the deployed MCP function uses. |

---

## Item 1 — Collection contents (cold diagnostic)

`scripts/_diag-bulk-pilot-cold.ts` output:

```
[1a] Distinct source_zip values in insider_transactions_v2:
     2023q1_form345.zip           5,000 (from 5000-doc sample)
  ✓ ONLY ONE source_zip in 5000-doc sample → no quarter intermix.

[1b] Distinct `source` field values in insider_transactions_v2:
     source="sec_bulk"  5,000 (from 5000-doc sample)

[1c] Collection counts side-by-side:
     insider_transactions_v2       148,685  ← Greg's pilot wrote here
     insider_holdings_v2            49,348  ← pilot also wrote here
     insider_filings_v2             69,457  ← pilot also wrote here
     insider_trades  (legacy)      162,000  ← daily scraper writes here, MCP tool reads here

[1d] What the live MCP `get_insider_transactions` tool queries:
     src/firestore.ts:824   db.collection("insider_trades")  ← LEGACY, not v2
     ↳ The MCP tool does NOT read from insider_transactions_v2 at all.
     ↳ Any rows the live MCP returns are from the legacy collection.
     ↳ Disclosure-date + reporting-lag-days fields exist only on legacy schema,
       so a query result with disclosure_date=Aug-2024 and reporting_lag_days=405
       was a legacy row. The v2 pilot did NOT cause that.
```

**Conclusion:**
- The pilot wrote ONLY 2023q1 to the new v2 collections. Verified by sampling 5000 docs from `insider_transactions_v2` and finding `source_zip="2023q1_form345.zip"` on 100% of them.
- The MCP `get_insider_transactions` tool reads from `insider_trades` (legacy) at `src/firestore.ts:824`. It does NOT read v2 at all. So Greg's "cold MCP query" surfaced only legacy data — the v2 pilot is invisible to that tool until the v2 read path is exposed (now done — see Item 3).
- The Aug-2024 disclosure rows with 405-day lags are legacy scraper rows. They exist because the legacy daily scraper writes Form-4 filings continuously; some of those filings disclose transactions that occurred up to ~14 months prior (late filings, paper-form catch-ups, etc.). Nothing about that came from the pilot.
- **Gate 7 diff design implication:** the cutover diff compares two separate collections (`insider_trades` legacy vs `insider_transactions_v2` bulk), not one collection with intermixed sources. Pure set comparison by `accession_number` is the right shape.

---

## Item 2 — Era tag is filing-date-driven (not transaction-date-driven)

### The rule, plainly stated

> The `schema_era` field is determined by which BULK ZIP a row was loaded from
> (= the FILING quarter), not by the row's `transaction_date`.
>
> Reason: AFF10B5ONE is a property of the SEC FORM VERSION (the structured XML
> schema the filer used when submitting). When the filer made the submission in
> 2023+, the form supports AFF10B5ONE — regardless of when the underlying
> transaction occurred. A late 2024 filing of a 2009 transaction is still a
> 2023+ form version, so the flag *could* be present.

### Empirical proof

Found 10 v2 rows with `transaction_date < 2023-01-01` from the cold diagnostic:

```
✓  0001248915-23-000040-NT-8171572   tx=2009-02-19  file=2023-02-14  era=2023_plus  aff10b5one=""
✓  0001248915-23-000040-NT-8171573   tx=2009-03-03  file=2023-02-14  era=2023_plus  aff10b5one=""
✓  0001248915-23-000040-NT-8171574   tx=2009-08-12  file=2023-02-14  era=2023_plus  aff10b5one=""
✓  0001248915-23-000040-NT-8171575   tx=2011-03-02  file=2023-02-14  era=2023_plus  aff10b5one=""
✓  0001248915-23-000040-NT-8171576   tx=2011-04-21  file=2023-02-14  era=2023_plus  aff10b5one=""
(...5 more like this)
```

The same accession (filed 2023-02-14) reports four transactions spanning 2009-02-19 → 2011-04-21 — likely an annual Form 5 catch-up or a Form 4 amendment disclosing old activity. All tagged `era="2023_plus"` because the FILING is in the 2023+ window.

### Code path

```ts
// src/scrapers/form345-bulk.ts:51
export function eraForQuarter(quarter: string): SchemaEra {
  //  pre_2023  = 2006q1 → 2022q4  (AFF10B5ONE column did NOT exist)
  //  2023_plus = 2023q1 → present (AFF10B5ONE column present)
  const m = quarter.match(/^(\d{4})q([1-4])$/i);
  if (!m || !m[1]) throw new Error(`Bad quarter format: ${quarter}`);
  const year = parseInt(m[1], 10);
  return year >= 2023 ? "2023_plus" : "pre_2023";
}
```

The function takes a quarter STRING like `"2023q1"` — which is the bulk-zip's quarter. The bulk zip groups by FILING quarter (the period when SUBMISSION.FILING_DATE landed). So `eraForQuarter()` is FILING-quarter-driven by construction. The `row.TRANS_DATE` field is never inspected when computing era.

### Documentation update

- `src/scrapers/form345-bulk.ts:35` already had a 5-line comment explaining the era boundary. Now extended to also state the filing-vs-transaction-date distinction.
- The MCP tool's `schema_era` parameter description (in `src/tools/insider-transactions.ts`) explicitly notes: *"Driven by FILING-quarter, not transaction_date — a late 2024 filing of an old 2009 trade still gets schema_era=2023_plus."*

---

## Item 3 — Footnotes appear in MCP response

### 3a — Storage check (direct doc-ID fetch)

From the cold diagnostic, accession `0001140361-23-015527` (PRTA / Malecek 2023-03-31 filing) returned 4 transaction docs:

| doc_id | row | trans_code | footnote_refs.length | 10b5-1 text? |
|---|---|---|---:|---|
| `...DT-2897629` | deriv option exercise | M | 1 | no (vesting schedule footnote) |
| `...NT-7684152` | nonderiv M (common leg) | M | 0 | — |
| `...NT-7684153` | nonderiv SELL | S | 2 | ✓ *"adopted Sept 20, 2022"* |
| `...NT-7684154` | nonderiv SELL | S | 2 | ✓ *"adopted Sept 20, 2022"* |

The 10b5-1 footnote text:

> *"The transactions reported in the Form 4 were effected pursuant to a Rule 10b5-1 trading plan adopted by the Reporting Person on September 20, 2022."*

is stored verbatim on each sell row's `footnote_refs[0]` with `field="trans_code"` and `ref="F1"`. The 2nd footnote on each row is the weighted-average-price disclosure.

### 3b — Current MCP tool path (pre-fix)

`src/tools/insider-transactions.ts:163` calls `queryInsiderTransactions()` which reads from `insider_trades` (legacy). The legacy `InsiderTransaction` type has no `footnote_refs` field at all. So before this session, no MCP query could ever return footnote text — the data wasn't on the read path.

### 3c — MCP tool extended with v2 read path

Added `data_source: "legacy" | "bulk_v2"` parameter to `get_insider_transactions`. Default is `"legacy"` (no behavior change for existing callers). When set to `"bulk_v2"`:

1. Handler branches into `handleV2()` (new in this commit).
2. Input validated against `validateAndNormalizeV2()` which accepts the v2 filter set: `ticker`, `company_cik`, `reporting_owner_cik`, `reporting_owner_name`, `row_type` (`"nonderiv"|"deriv"`), `trans_codes`, `aff10b5one`, `schema_era`, `since`, `until`, `sort_by` (`"transaction_date"|"filing_date"`), `sort_order`, `limit`.
3. `queryInsiderTransactionsV2()` reads from `insider_transactions_v2`.
4. Response envelope shape: `InsiderTransactionsV2Envelope` — same `results / count / has_more / coverage_warning / query` shell, but `results[]` is the full `InsiderTransactionV2` shape including `footnote_refs[]`, `aff10b5one`, `reporting_owners[]`, `schema_era`, `is_amendment`, etc.

**Index hygiene:** The new query intentionally skips `orderBy` when no `since/until/sort_by` is set, so single-field equality queries (`ticker=='PRTA'`) work without requiring composite indexes — this lets the v2 path serve queries IMMEDIATELY without waiting for Greg's index deploy. Range/sort queries still need the composites (16 new indexes in `firestore.indexes.json`, pending deploy).

### 3d — Acceptance test (end-to-end via handler)

`scripts/_acceptance-malecek-footnote.ts` invokes the exact same `handler()` function the deployed MCP server uses (no transport indirection — same code path).

Query:
```ts
handler({
  data_source: "bulk_v2",
  ticker: "PRTA",
  reporting_owner_name: "Malecek",
  limit: 10,
})
```

Result: **9 rows returned**. 4 of them carry footnote text. The two SELL rows from accession `0001140361-23-015527` (March 31, 2023) carry the exact expected fragment:

```
── Row 4 of 9 ──
   id:                 0001140361-23-015527-NT-7684153
   trans_code:         S
   trans_shares:       2734
   trans_price/share:  48.81
   aff10b5one:         ""    ← flag blank, but…
   footnote_refs:      2 entries
     • field=trans_code  ref=F1
       text: "The transactions reported in the Form 4 were effected pursuant to
              a Rule 10b5-1 trading plan adopted by the Reporting Person on
              September 20, 2022."
     ✓ MATCHED expected fragment: "Rule 10b5-1 trading plan adopted by the
       Reporting Person on September 20, 2022"

✓ ACCEPTANCE PASS — Malecek/PRTA 10b5-1 footnote returned via handler
```

The `aff10b5one` flag is `""` (blank) on this row — as Greg expected. But the inlined `footnote_refs[].text` carries the full 10b5-1 disclosure with the exact plan-adoption date (September 20, 2022). The two-signal capture works end-to-end through the MCP tool.

### What's required to go fully live

The handler logic is in this branch and ready. To make this acceptance test reproducible against the live `mcp.keyvex.com` endpoint, Greg needs to:

1. Deploy the new MCP function code (`firebase deploy --only functions:mcp`).
2. Deploy the 16 new composite indexes (`firebase deploy --only firestore:indexes`) — only needed for queries that use since/until/sort_by; ticker-only / company_cik-only / reporting_owner_cik-only queries work immediately.

Both pure-config; no DB migration or destructive change.

---

## Files added/modified this session (post-Gate-5 work)

| File | Change |
|---|---|
| `scripts/_diag-bulk-pilot-cold.ts` | NEW. Cold queries answering Items 1, 2, 3a. |
| `scripts/_acceptance-malecek-footnote.ts` | NEW. Item 3d acceptance test against the handler. |
| `docs/bulk-form345-items-1-2-3-resolution.md` | NEW. This file. |
| `src/types.ts` | +`InsiderTransactionsV2Query` + `InsiderTransactionsV2Envelope` types. |
| `src/firestore.ts` | +`queryInsiderTransactionsV2()`. Added `insider_transactions_v2` / `insider_holdings_v2` / `insider_filings_v2` to `COLLECTION_DATE_FIELD` map. |
| `src/tools/insider-transactions.ts` | +`data_source` parameter. +`row_type` / `trans_codes` / `aff10b5one` / `schema_era` / `reporting_owner_cik` / `reporting_owner_name` parameters. Handler now branches `handleLegacy()` vs `handleV2()`. +`validateAndNormalizeV2()`. |

---

## What I am still NOT doing

- ❌ Not starting Gate 6 (full 2006-2025 load) — awaiting Greg's go-ahead.
- ❌ Not deploying anything — Greg deploys.
- ❌ Not migrating the legacy `insider_trades` collection — coexistence intact.
- ❌ Not making `bulk_v2` the default `data_source` on the tool — that's a Gate 7/8 decision; today it's an opt-in parameter.
