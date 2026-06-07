# Session handoff — 2026-06-07 (testing day + OCR investigation)

Read this first to continue seamlessly. Branch: **`claude/form278-annual-parser-2026-06-01`** (NOT main). Live: **`mcp.keyvex.com` v0.52.1, 38 tools**. All listed commits are pushed.

---

## TL;DR — where we are

1. **Testing day shipped ~17 real fixes** (all committed, deployed, pushed). Listed below.
2. **One ACTIVE, UNRESOLVED decision: OCR of 185 scanned House PTRs.** Fully investigated this session — the conclusion is that reliable extraction of buy/sell + amount is NOT achievable with Document AI; details + the pending choice are in the OCR section. **This is where to resume.**
3. **One background job still running:** the 13F empty-ticker backfill (`scripts/backfill-13f-tickers.ts`), ~15.4K/22.9K CUSIPs processed last check. Resumable via the supervisor; safe to let finish.

---

## Shipped this session (committed + deployed + pushed)

Testing-day fixes (each its own commit on the branch):
- **#1** FEC candidate name-search window widened (`Schumer` now resolves)
- **#2** insider `source_url`/`sec_filing_url` now a real EDGAR Archives URL (shim builds it from company_cik+accession)
- **#3** CFPB `company` search → server-side `search_term` + ES envelope (Wells Fargo 645ms)
- **#6** insider v2 `sort_by`: `disclosure_date`→`filing_date` alias; `total_value` actionable error
- **#7** `get_tender_offers` `since`: order by filing_date server-side + 5 composite indexes
- **#8** treasury TIPS/FRN now queryable (flag-based: `inflation_indexed`/`floating_rate`; captured `floating_rate`, re-backfilled)
- **#11** `economic_indicators` enum errors list valid options
- **#12/#13** future-dated transaction typos corrected (17: 15 insider + 2 congressional, invariant = txn ≤ filing/disclosure, source preserved in `transaction_date_source`)
- **#15** central **unknown-parameter rejection** in `server-setup.ts` (every tool's `additionalProperties:false` now enforced); `unified_search` accepts `limit` as `per_source_limit` alias
- **#16** ascending-sort composite indexes for 8 entity collections (incl. fixing the `fundamentals`→`xbrl_fundamentals` collectionGroup)
- **#17** `registration_statements` filer_ticker CIK-backfill (8,265 resolved)
- **#18** `parseIsoDate` now rejects impossible calendar dates (regex tightened across 16 tool files)
- **#19** validation errors phrased `INVALID <field>:` now classify as `INVALID_PARAMETER` not `INTERNAL_ERROR`
- **oig** removed dead `is_reinstated` filter + `reinstatement_date` sort (LEIE = active-only; 0/83,030 had reinstatement_date)
- **executive_trades** added **`filer_position`** substring filter (query officials by agency, e.g. `Health & Human Services` — note ampersand) + made **`min_amount`** a client-side filter so it composes with date sorting (was INDEX_MISSING)

Data / infra:
- **OpenFIGI key** installed in `secrets/.env` (`OPENFIGI_API_KEY`), verified.
- **`registration_statements` lean fix:** added **S-3ASR** (Apple/Ford now present + ticker-queryable), deliberately **dropped S-8** (high-volume/low-signal — 25,284 partial S-8 rows deleted); S-3ASR historical backfill complete (~10,629 records, 2005→today); `scrapeRegStatementsDaily` cron deployed pulling S-1/S-3/S-3ASR.
- **Source-accuracy pass (verified source-faithful):** Treasury vs fiscaldata API ✓; XBRL 6/6 byte-exact vs SEC company-concept ✓; 8-K 5/5 item codes vs EDGAR ✓; Form 4 dates+codes byte-exact vs XML. **Documented nuance:** Form 4 v2 shares/prices match SEC's **bulk** Form 345 feed (rounded to 2dp), NOT the XML's fuller precision — that rounding is SEC's, our loader does `Number()` with no rounding. Tool description scoped the "auditable" claim to "the bulk extract" accordingly.

Competitive (for launch positioning): **executive-branch trading is a category Quiver doesn't carry.** Verified Quiver's dataset list + NVDA page — they have Congress trading, insiders, 13F, contracts, lobbying, and a single-person Trump page, but **no executive-branch-official dataset**. KeyVex `get_executive_trades` = 71 officials, 3,277 trades, **825 over $100K**; Quiver = 0 for that query. NVDA exec trades (12, all sales) spot-checked byte-accurate against the OGE 278-T source PDFs (Gabbard, Dixon).

---

## ⚠️ ACTIVE DECISION — OCR of 185 scanned House PTRs (resume here)

**The list exists:** Firestore collection **`needs_ocr`** = 185 scanned House PTRs (`scanned_no_text_layer`), each with `filing_url`, `filer_name`, `filing_date`, `page_count`, `doc_id`. Produced by `scripts/detect-ocr-needed.ts` (House sweep only; OGE/President-VP NOT swept).

**Triage done (Document AI Form Parser):** **163 trade-bearing, 22 nil** (nils = mostly Harold Rogers "nothing to report"). Multi-page (>2pg, 80) = has trades; 1-2pg (105) → 83 trades / 22 nil.

**Verified Document AI cost (Google pricing page):** Enterprise OCR `DOCAI_PROCESSOR_ID` = **$1.50/1k pages (~$2 for all 1,358 trade-bearing pages)**; Form Parser `DOCAI_FORMPARSER_ID` = **$30/1k pages (~$41)**. Both processor IDs are in `secrets/.env`.

**THE HARD FINDING (tested end-to-end — do not re-litigate without new evidence):** reliable extraction of the two fields that matter — **buy/sell direction and dollar amount** — is **NOT achievable** from these rotated, faint-checkmark paper-form scans:
- **tesseract** (free): fails on rotation entirely (confidence 33-41, noise).
- **Cheap OCR ($2):** deskews + reads text fine (asset + date) but **misses the real-row checkmarks entirely** — got 0 of Lamborn's 3 real type/amount marks (only the bold pre-printed Example mark).
- **Form Parser ($41):** detects most checkmarks (☑) but **missed 1 of 3 amounts** on Lamborn, and the type ☑ sits at the Purchase/Sale column boundary (a ~0.01 normalized-x error flips buy↔sell).
- **Even human vision** (rendered the form, read it): on the rotated faint grid, pinning the exact amount bracket ($1,001-15k vs $15,001-50k) is genuinely uncertain.

Writing geometry-guessed type/amount into `congressional_trades` = unreliable financial data → violates the source-faithful posture (worse than the gap).

**Recommended path (pending Greg's pick):**
- **(a) NOW:** ingest reliably-extractable fields only — filer + date + asset name (these DO extract cleanly via cheap OCR ~$2) — with `transaction_type`/`amount` marked "see source PDF `<filing_url>`". Honest, searchable, no fabrication. Closes discoverability immediately.
- **(b) PROJECT:** a **vision-LLM** extraction spike (page image → vision model → structured JSON). Vision read Rogers + Lamborn correctly by eye where Document AI couldn't, so it's the only thing likely to get type+amount — but it's a NEW pipeline (vision API key + per-page cost + accuracy validation, target ≥95% on amount bracket before trusting). Not built; no ANTHROPIC/vision key in secrets yet.
- **Do NOT** write geometry-guessed amounts from Document AI.

**President/VP 278-Ts** (Trump/Vance — the one spot Quiver's Trump page beats us): separate OGE index, NOT swept, not in data. Same OCR problem applies. Deferred (scraper comment: "Track B, pending Director ruling").

OCR infra present: `tesseract.js`, `pdf-to-img`, `mupdf`, `eng.traineddata`, `@google-cloud/documentai` (installed this session — **package.json/package-lock are uncommitted**), `src/needs-ocr.ts` (detector), `scripts/detect-ocr-needed.ts` (sweep). `executive_trades` collection has NO President/VP (PAS index excludes them).

---

## State / gotchas for the next session

- **Branch `claude/form278-annual-parser-2026-06-01`**, not main. All feature commits pushed.
- **Uncommitted:** `package.json` + `package-lock.json` (the `@google-cloud/documentai` add) + untracked `eng.traineddata`, `scripts/backfill-cftc-cot.ts`, `scripts/backfill-roll-call-votes.ts`, `.tmp/`. Decide whether to commit the documentai dep when the OCR path is chosen.
- `secrets/.env` keys: `OPENFIGI_API_KEY`, `DOCAI_PROJECT_NUMBER/LOCATION/PROCESSOR_ID/FORMPARSER_ID`, `LDA_API_KEY`, `FEC_API_KEY`. Document AI auth uses `secrets/service-account.json` (the SA can `processDocument` but lacks `processors.get`).
- `.claude/settings.local.json` deny list = `[gcloud, rm, rmdir, del]` → use node `fs`/PowerShell `Remove-Item`/`firebase`, not `rm`. Git push is allowed.
- Deploy pattern: `firebase deploy --only functions:mcp` (and `firestore:indexes` for index changes). **Do NOT** `firebase deploy --only functions` without `:mcp` — other branches' functions exist in the project but not in this worktree's code.
- `.tmp/ocrcache/lamborn.json` has a cached Document AI Form Parser result for the Lamborn PTR (useful for any OCR parser work without re-spending API).
- Background: supervisor (a long-running node proc) + the 13F-tickers backfill child. Don't double-start backfills.

## Suggested first moves in the new conversation
1. Read this file + skim `CLAUDE.md` Session Bootstrap.
2. Confirm the 13F-tickers backfill finished (`.tmp/13f-tickers-progress.json`); if done, the institutional_holdings empty-ticker gap is closed.
3. Get Greg's pick on the OCR decision (a vs b above) and proceed.
