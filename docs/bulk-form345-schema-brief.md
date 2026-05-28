# SEC Bulk Insider Dataset → Firestore Schema Brief

**Status:** Gate 2 deliverable — awaiting Greg's approval before Gate 3 (loader build).
**Date:** 2026-05-23
**Source:** https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/YYYYqN_form345.zip
**Verified eras:** 2008q1, 2018q1, 2023q1 (all downloaded + inspected; column lists diffed).
**Replaces:** EDGAR Form 4 historical scraper (`claude/form4-backfill-spike-2026-05-23`). Bulk dataset gives 20 years of Form 3/4/5 in 80 quarterly zips totalling ~1.1 GB — vs ~21 days of FTS-paced EDGAR scraping for 5 years.

---

## 1. Headline findings

| Finding | Detail |
|---|---|
| **8 TSV tables per quarter** | SUBMISSION · REPORTINGOWNER · NONDERIV_TRANS · DERIV_TRANS · NONDERIV_HOLDING · DERIV_HOLDING · FOOTNOTES · OWNER_SIGNATURE |
| **7 of 8 tables are SCHEMA-STABLE across 2008→2018→2023** | Same columns, same order, in every quarter sampled. |
| **Only SUBMISSION changes** | Single column added: **`AFF10B5ONE`** (the 10b5-1 plan flag), present in 2023q1, absent in 2008q1 + 2018q1. |
| **Date format** | Oracle-style `DD-MON-YYYY` (e.g. `28-MAR-2018`). Convert to ISO `YYYY-MM-DD` at parse. |
| **Footnotes carried as references** | Most numeric/date columns ship with a sibling `*_FN` column (e.g. `TRANS_SHARES_FN = "F11"`); the actual footnote text lives in the FOOTNOTES table keyed by `ACCESSION_NUMBER` + `FOOTNOTE_ID`. |
| **Row scale** | Per quarter: ~70-80K filings, ~110-200K nonderiv-trans rows, ~40-50K deriv-trans rows. 80 quarters total → est. **~12-15M transactions**, **~6M filings**, **~6M reporting-owners**, **~12M footnotes** loaded over the full backfill. |

**Row counts measured (real, not estimated):**

| Table | 2008q1 | 2018q1 | 2023q1 |
|---|---:|---:|---:|
| SUBMISSION | 78,685 | 68,559 | 69,457 |
| REPORTINGOWNER | 85,330 | 72,759 | 73,681 |
| NONDERIV_TRANS | 180,191 | 105,102 | 106,093 |
| DERIV_TRANS | 47,706 | 44,090 | 42,592 |
| NONDERIV_HOLDING | 51,048 | 36,998 | 32,256 |
| DERIV_HOLDING | 48,517 | 24,408 | 17,092 |
| FOOTNOTES | 145,140 | 159,855 | 166,835 |
| OWNER_SIGNATURE | 83,750 | 71,956 | 73,240 |

2008 has 70% more nonderiv-trans rows than 2018/2023 — that's a real signal (peak insider activity around 2007-2008 financial crisis), not a schema artifact.

---

## 2. Era differences (the whole list)

```
SUBMISSION:
  AFF10B5ONE        — ABSENT in 2008q1, ABSENT in 2018q1, PRESENT in 2023q1
```

That's it. Literally the only column that varies across the three eras sampled. Every other column in every other table is identical across 2008/2018/2023.

**Implication for the loader:** ONE schema, applied uniformly to every quarter. AFF10B5ONE handled with a `NOT_TRACKED` sentinel for pre-2023 records (Gate 4 requirement).

**Verification needed before Gate 3:** the actual cutover quarter for AFF10B5ONE inside 2022→2023 (could be earlier than 2023q1; the SEC sometimes ships schema changes mid-period). Worth one more inspect-script run on 2022q4 to confirm the boundary, so the era-tag math is exact.

---

## 3. Proposed Firestore schema

### 3.1 Three collections — one per row type

The TSVs are normalized (one accession → many transactions → many footnotes). For agent-side query ergonomics, we partly DENORMALIZE: each transaction doc carries enough joined fields from SUBMISSION + REPORTINGOWNER + FOOTNOTES that agents don't need cross-collection joins for the common questions.

| Collection | One doc per | Source tables (joined) | Est. row count (80 quarters) |
|---|---|---|---|
| `insider_trades_bulk` | Each `NONDERIV_TRANS` + `DERIV_TRANS` row | SUBMISSION + REPORTINGOWNER + NONDERIV/DERIV_TRANS + FOOTNOTES (text inlined for any referenced `*_FN`) | ~12-15M |
| `insider_holdings_bulk` | Each `NONDERIV_HOLDING` + `DERIV_HOLDING` row | SUBMISSION + REPORTINGOWNER + NONDERIV/DERIV_HOLDING + FOOTNOTES (text inlined) | ~3-4M |
| `insider_filings_bulk` | Each `SUBMISSION` row | SUBMISSION + REPORTINGOWNER (aggregated) + OWNER_SIGNATURE | ~5-6M |

**Rationale for three collections vs one:**
- Transactions and holdings are **different question shapes**. "What did insiders buy this week?" hits trades. "What does the CEO currently own?" hits holdings. Querying these together would force every query to filter by `row_type`.
- Filings table preserves the "submission as a unit" view for agents that want a denormalized parent record (e.g. "show me the SUBMISSION envelope and all reporting owners for accession X").
- Each collection has its own index footprint, growth curve, and query patterns. Splitting now avoids a painful index-cost migration later.

### 3.2 `insider_trades_bulk` doc shape

```ts
interface InsiderTradeBulk {
  // ─── Doc ID ─────────────────────────────────────────────
  // Format: "{accession_number}-{table}-{sk}"
  // Examples:
  //   "0001144204-18-018358-NT-4062474"   (NONDERIV_TRANS row, SK 4062474)
  //   "0001144204-18-018358-DT-437244"    (DERIV_TRANS row, SK 437244)
  // Idempotent — same source row = same doc ID, infinite re-runs safe.
  id: string;

  // ─── Provenance + era ───────────────────────────────────
  source: "sec_bulk";                          // never overwrites scraper-tagged data
  source_zip: string;                          // "2018q1_form345.zip"
  schema_era: "pre_2023" | "2023_plus";        // controls NOT_TRACKED defaults
  bulk_loaded_at: Timestamp;                   // when we wrote it
  source_url: string;                          // https://www.sec.gov/cgi-bin/browse-edgar?...accession

  // ─── Filing envelope (joined from SUBMISSION) ───────────
  accession_number: string;                    // "0001144204-18-018358"
  filing_date: string;                         // ISO "2018-03-28"
  period_of_report: string;                    // ISO "2018-03-28"
  date_of_orig_sub: string | null;             // ISO or null
  document_type: "3" | "3/A" | "4" | "4/A" | "5" | "5/A";
  issuer_cik: string;                          // zero-padded "0001234567"
  issuer_name: string;                         // "APPLE INC"
  issuer_trading_symbol: string;               // "AAPL"
  remarks: string | null;
  no_securities_owned: boolean;
  not_subject_sec16: boolean;
  form3_holdings_reported: boolean;
  form4_trans_reported: boolean;

  // ─── 10b5-1 plan flag (era-gated) ───────────────────────
  aff10b5one:
    | "Y"                                       // 2023+ filings only — plan adopted
    | "N"                                       // 2023+ filings only — no plan
    | "NOT_TRACKED";                            // pre-2023 — SEC did not collect this

  // ─── Reporting owner (joined from REPORTINGOWNER) ──────
  // If filing has multiple owners, primary stored here; full array under reporting_owners[].
  reporting_owner_cik: string;
  reporting_owner_name: string;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  is_other: boolean;
  officer_title: string | null;
  other_relationship_text: string | null;
  reporting_owners: Array<{
    cik: string;
    name: string;
    is_director: boolean;
    is_officer: boolean;
    is_ten_percent_owner: boolean;
    is_other: boolean;
    officer_title: string | null;
    other_relationship_text: string | null;
  }>;

  // ─── Transaction (the row itself) ───────────────────────
  table: "NONDERIV_TRANS" | "DERIV_TRANS";
  sk: number;                                  // surrogate key from SEC (stable across re-publishes)
  security_title: string;                      // "Common Stock", "Stock Option (right to buy)"
  transaction_date: string;                    // ISO "2018-03-28"
  deemed_execution_date: string | null;        // ISO
  trans_form_type: "3" | "4" | "5";
  trans_code: string;                          // P, S, A, M, X, C, F, G, D, I, V, etc.
  equity_swap_involved: boolean;
  trans_timeliness: string | null;             // "L" (late), "E" (early), etc.
  trans_shares: number | null;
  trans_price_per_share: number | null;
  trans_total_value: number | null;            // DERIV_TRANS only; nonderiv computed = shares × price
  trans_acquired_disp_cd: "A" | "D" | null;    // Acquired / Disposed
  direct_indirect_ownership: "D" | "I" | null;
  nature_of_ownership: string | null;          // free-text on I rows
  shrs_owned_following_trans: number | null;
  valu_owned_following_trans: number | null;

  // ─── Derivative-only fields ─────────────────────────────
  // null for NONDERIV_TRANS rows
  conv_exercise_price: number | null;
  exercise_date: string | null;                // ISO
  expiration_date: string | null;              // ISO
  underlying_security_title: string | null;
  underlying_security_shares: number | null;
  underlying_security_value: number | null;

  // ─── Footnote dereferencing ─────────────────────────────
  // Each *_FN column in the source becomes a footnote_refs[] entry with the resolved text.
  // Agents see human-readable footnote prose instead of cryptic "F11" tokens.
  footnote_refs: Array<{
    field: string;                             // "trans_shares" | "conv_exercise_price" | etc.
    ref: string;                               // "F11"
    text: string;                              // "The 212,500 shares were acquired by JOJ Holdings…"
  }>;
}
```

### 3.3 `insider_holdings_bulk` doc shape

Mirror of `insider_trades_bulk` but no transaction-date fields. Doc ID format: `{accession}-NH-{sk}` for nonderiv, `{accession}-DH-{sk}` for deriv.

### 3.4 `insider_filings_bulk` doc shape

One doc per accession. Carries the SUBMISSION envelope + ALL reporting owners as an array + OWNER_SIGNATURE rows. Doc ID = `{accession_number}` (raw, no transformation needed — accessions are already path-safe and globally unique).

---

## 4. Idempotent doc-ID scheme — why these IDs

| Doc ID format | Source row | Stability guarantee |
|---|---|---|
| `{accession}-NT-{nonderiv_trans_sk}` | NONDERIV_TRANS row | SK is SEC's surrogate key; stable across re-publishes |
| `{accession}-DT-{deriv_trans_sk}` | DERIV_TRANS row | Same |
| `{accession}-NH-{nonderiv_holding_sk}` | NONDERIV_HOLDING row | Same |
| `{accession}-DH-{deriv_holding_sk}` | DERIV_HOLDING row | Same |
| `{accession}` | SUBMISSION row | Accession is the canonical filing ID |

Re-running the loader against the same quarter writes to the same doc IDs → existing docs MERGE updated (Firestore default `.set(data, {merge: true})`) → zero duplicates, never. **This is the Greg test:** "Run the same quarter twice; row count unchanged."

The SK columns are NEW in the bulk dataset (not visible to the scraper that hits EDGAR XML). They're stable surrogate keys SEC assigns at ingestion — same row = same SK across the bulk re-publishes that happen each Tuesday. We rely on them as the per-row anchor.

---

## 5. Cost estimate (Firestore)

Working assumptions:
- Each `insider_trades_bulk` doc ≈ 2-3 KB (with reporting owners + footnotes inlined)
- Each `insider_holdings_bulk` doc ≈ 1.5-2 KB
- Each `insider_filings_bulk` doc ≈ 1-2 KB (mostly metadata)

Storage estimate over 80 quarters:

| Collection | Docs | Avg doc size | Storage |
|---|---:|---:|---:|
| `insider_trades_bulk` | ~13M | 2.5 KB | ~32 GB |
| `insider_holdings_bulk` | ~3.5M | 1.8 KB | ~6.5 GB |
| `insider_filings_bulk` | ~5.5M | 1.5 KB | ~8.5 GB |
| **TOTAL** | **~22M docs** | | **~47 GB** |

**Firestore storage cost:** $0.18/GiB-month × 47 GB ≈ **$8.50/month** ongoing.

**One-time write cost** (Gate 6 full backfill):
- 22M doc writes × $0.18 per 100K writes = **~$40 one-time**.
- Plus ~22M read operations during verification (Gate 7 diff) = another ~$8.

**Per-query cost** at runtime is unchanged — composite indexes pay $0.18/GB-month against the indexed-fields subset. Index count to design carefully in Gate 3.

Total Gate 6 budget envelope: **~$50 one-time, $9-12/month thereafter**. Within Blaze pricing tier; no payment-method ceiling concerns.

---

## 6. Composite indexes (preliminary — to lock in Gate 3)

Same field patterns as existing `insider_trades` for query-shape parity:

**`insider_trades_bulk`:**
- `(issuer_trading_symbol ASC, transaction_date DESC)` — "Apple insider trades chronological"
- `(reporting_owner_cik ASC, transaction_date DESC)` — "All Tim Cook trades chronological"
- `(issuer_cik ASC, transaction_date DESC)` — same as ticker but for CIK-only callers
- `(trans_code ASC, transaction_date DESC)` — "All planned sales (code S) chronological"
- `(aff10b5one ASC, transaction_date DESC)` — "All 10b5-1 plan trades chronological" (Derek's flag)
- `(schema_era ASC, transaction_date DESC)` — segment by era when needed

**`insider_holdings_bulk`:** parallel set with `period_of_report` instead of `transaction_date`.

**`insider_filings_bulk`:** `(issuer_trading_symbol ASC, filing_date DESC)`, `(reporting_owner_cik ASC, filing_date DESC)`, plus document-type variants.

Final index list locked when the loader is built (Gate 3) — exact field shapes flush out edge cases.

---

## 7. Coexistence with existing `insider_trades` collection (Gate 7 cutover plan)

The existing `insider_trades` collection (scraped via EDGAR Form 4 XML through `src/scrapers/form4.ts`) stays untouched during Gates 5-6. Two collections coexist during Gate 7 diff:

1. **`insider_trades`** (existing): scraper-built, ~hundreds of thousands of recent rows, EDGAR XML provenance, `data_source: "SEC_EDGAR_FORM4"`.
2. **`insider_trades_bulk`** (new): bulk-built, ~13M historical rows, TSV provenance, `source: "sec_bulk"`.

**Gate 7 diff (manual, NOT automated):**
- For the overlap window (let's say 2024-01-01 through latest bulk-published quarter), enumerate accessions in both collections.
- Rows that exist in scraper-only: investigate. Likely causes: amendments not yet in bulk, late filings, parser bugs we didn't catch.
- Rows that exist in bulk-only: investigate. Likely causes: scraper missed them (XML fetch failures, parsing edge cases, derivative table previously dropped).
- Row counts that match perfectly: confirm field-by-field on a 10-row sample (shares, price, owner, date all identical).

**Gate 7 conclusion** delivered to Greg as a markdown report. Greg approves the retirement (or doesn't) before Gate 8 re-architects the daily scraper into incremental mode.

---

## 8. The SEAM (Gate 8 setup)

The bulk dataset is published quarterly with ~2-week lag after quarter-end. Example: 2025q4 zip publishes ~mid-January 2026.

**SEAM date** = `max(period_of_report)` across the latest bulk quarter loaded.

After Gate 8:
- **Bulk loader** runs ONCE per quarter (cron: 1st Tuesday after each quarter-end + 14 days, ~~mid-January, mid-April, mid-July, mid-October), pulling the just-published quarter's zip → writing to `insider_trades_bulk` etc.
- **Daily scraper** runs from `SEAM + 1 day` forward through `today`. Never overlaps with bulk. Writes to the SAME `insider_trades_bulk` collection (consistent schema) so agents see one continuous timeline.

**Daily scraper schema upgrade required:** must capture AFF10B5ONE (XML element `<aff10b5One>`), footnotes (XML `<footnote>` elements), DEEMED_EXECUTION_DATE, TRANS_TIMELINESS, DIRECT_INDIRECT_OWNERSHIP, NATURE_OF_OWNERSHIP, full UNDLYNG_SEC fields. This is a non-trivial parser upgrade — captured in Gate 8 scope.

**Test the seam:** for a week post-cutover, run BOTH bulk-loaded quarter AND daily-scraper days adjacent → query Firestore for `period_of_report` on the boundary days → confirm continuous coverage with no overlap, no gap.

---

## 9. What I am explicitly NOT proposing in this brief

- **No tool-surface changes.** Existing `get_insider_transactions` MCP tool keeps reading `insider_trades` until Gate 7 cutover. Then re-points to `insider_trades_bulk` in a separate version bump after Greg approves Gate 7.
- **No derivative analytics.** Pure publisher posture intact — we expose AFF10B5ONE as a field, never derive "10b5-1 trading pattern" or "discretionary vs scheduled" classification.
- **No automatic cutover.** Gate 7 ends with a written diff report for Greg, not a `git push` that retires the legacy collection.
- **No backfill of existing `insider_trades` collection** with the new fields. Bulk goes to NEW collections; the existing scraper data stays as-is until Gate 7/8 explicitly migrate it.

---

## 10. Open questions for Greg (answer before Gate 3)

1. **Collection naming.** I proposed `insider_trades_bulk` / `insider_holdings_bulk` / `insider_filings_bulk`. Alternative: drop the `_bulk` suffix and use `insider_transactions_v2` / `insider_holdings_v2` / `insider_filings_v2` to signal "this is the canonical version, scraper output is legacy v1." Greg's call.
2. **One transaction collection vs two.** I proposed merging NONDERIV_TRANS + DERIV_TRANS into a single `insider_trades_bulk` collection with `table` discriminator. Alternative: keep them in separate `insider_nonderiv_trans_bulk` + `insider_deriv_trans_bulk` collections. Single collection wins on query simplicity ("all CEO activity in 2024") but doubles index writes per row.
3. **Footnote inlining vs lookup table.** I proposed inlining resolved footnote text into each row's `footnote_refs[]`. Alternative: keep FOOTNOTES as its own collection and have agents follow ref tokens. Inlining is ~10-15% storage overhead for ~zero query overhead. I'd inline; cheap.
4. **Verify the AFF10B5ONE cutover quarter.** I'm proposing era split at 2023q1 based on the three samples. Worth one extra inspect-script run on **2022q4** to lock the exact boundary; if it's already in 2022q4, the era tag math shifts by one quarter.
5. **Start year.** Brief assumes 2006q1 → present. SEC bulk archive goes back further but data quality drops. Confirm 2006 is the floor (or pick a different one — e.g. 2003 or 2009).
6. **Live `insider_trades` collection — read-only freeze during Gates 5-7?** Or keep the daily scraper writing as-usual? Recommend: keep it running; the bulk load goes to NEW collections so there's no write conflict.

---

## 11. What's already on disk

Two reusable scripts already on this branch (`claude/form4-backfill-spike-2026-05-23` history is being abandoned for the bulk pivot; these get re-committed on a fresh `claude/form345-bulk-load-2026-05-23` branch):

- **`scripts/inspect-form345-bulk.ts`** — downloads + unzips + dumps column lists + sample row + counts. Reusable for any quarter: `npx tsx scripts/inspect-form345-bulk.ts 2022q4`.
- **`scripts/_diff-form345-eras.ts`** — reads already-downloaded scratch dirs and emits the era-comparison markdown above.

No loader code written yet. **Awaiting Greg's Gate 2 approval before Gate 3.**

---

## 12. Greg sign-off

Mark [x] when reviewed and answer the open questions in §10:

- [ ] Schema shape acceptable (three collections, doc shapes per §3)
- [ ] Doc-ID scheme acceptable (§4)
- [ ] Cost envelope acceptable (~$50 one-time + ~$10/mo, §5)
- [ ] Coexistence + cutover plan acceptable (§7)
- [ ] SEAM design acceptable (§8)
- [ ] Open questions §10 answered (collection names, single vs two trans collections, footnote inlining, AFF10B5ONE cutover quarter to verify, start year, live-collection freeze)

After sign-off: Gate 3 (loader code) gets built on `claude/form345-bulk-load-2026-05-23` with the exact decisions above hard-coded in.
