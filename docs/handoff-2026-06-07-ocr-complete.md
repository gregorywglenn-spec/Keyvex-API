# Session handoff — 2026-06-07 (scanned House PTR OCR — COMPLETE)

Branch: `claude/form278-annual-parser-2026-06-01`. **Code is NOT yet committed** (awaiting Greg's go). Data IS live in `congressional_trades` (capitaledge-api Firestore).

## TL;DR
The 185 scanned/no-text-layer House PTRs (the `needs_ocr` backlog) are **fully processed via vision OCR**. The handoff's prior conclusion ("buy/sell + amount NOT reliably extractable") was scoped to *Document AI* (geometry OCR). A **vision-LLM** (Claude Sonnet) reads the checkbox grid directly and is reliable.

**Result: 21,053 trades extracted from the 185 scanned filings → now in `congressional_trades`.**
- Total `congressional_trades` collection: **89,729** (was ~68.7K).
- Split: 11,383 buys / 9,670 sells.
- ~1,427 municipal-bond positions (no ticker) — a category text scrapers + Quiver miss entirely.
- 185/185 filings processed, 0 failed pages.

## Why this matters competitively
These filings have **no text layer**, so any scraper relying on PDF text extraction (the industry norm — Quiver, Capitol Trades, Unusual Whales) gets **zero** from them. KeyVex now has ~21K congressional trades competitors structurally can't see. Pairs with the executive-branch-trading edge already tested against Quiver.

Top filers recovered from scanned PTRs:
- **Ro Khanna: 14,832 trades** (his filings are 500–660 rows each — huge ETF/options activity)
- **Michael McCaul: 5,484** (incl. hundreds of muni bonds + family-LP interests)
- Byron Donalds 200, Fleischmann 164, Lisa McClain 109, Tony Wied 76, Lamborn 45, Harshbarger 44, Rogers 43, Wagner 16.

## KeyVex-vs-Quiver comparison set (ready to run; sub active until Jul 3)
Check these specific trades — KeyVex has them from scanned PTRs; verify whether Quiver does:
- **Big-cap stocks** (most checkable on Quiver): NVDA 17 trades (e.g. David Kustoff buy 2022-11-29, $15K–50K); AAPL 12 (Khanna sell 2023-05-23, $100K–250K); MSFT 14; TSLA 9 (Khanna sell 2024-03-20); AMZN 8; GOOGL 7; META 3 (Byron Donalds buy 2023-07-05).
- **McCaul muni bonds** (Quiver doesn't track munis at all): KATY TEX INDPT SCH DIST, MICHIGAN ST UNIV REVS, MARYLAND ST DPT TRANSN, ILLINOIS ST TOLL HWY — all with dates + amount brackets.
- **Ro Khanna volume**: 14,832 trades across his scanned filings — spot-check any of his filing dates against Quiver.

Run via the live endpoint: `get_congressional_trades(member_name:"Khanna")` etc. at `mcp.keyvex.com` (the new rows are flagged `extraction_method: "vision_ocr"`).

## Verification status
- **Hand-checked sample (~20 rows, 5 filings)**: 100% correct on type + amount after fixes (Lamborn sells, Lamborn buys, Fleischmann mixed, Khanna dense 19-row page incl. a B→A amount transition, McCaul dates).
- **Mechanical sanity audit**: 207/21,053 (~1%) flagged. Breakdown: most are McCaul **private-LP interest rows** ("LLM Family Investments LP (11.% INT)") that have no standard transaction amount/date — arguably faithful, not errors. ~23 `txdate_after_disclosure` + 2 out-of-range = genuine date-read anomalies worth an eyeball.
- **Remaining QA**: a formal larger random-sample hand-audit to put a hard accuracy % on it. Every row is source-PDF-linked (`report_url`) + flagged, so any record is auditable/correctable forever.
- Tool: `npx tsx scripts/audit-ocr-trades.ts --sample=40`

## The pipeline (new files — uncommitted)
- `scripts/lib/ocr-vision.ts` — Claude vision extraction (Sonnet) + orientation detect (Haiku). **Forced tool-use** for guaranteed structured output (sonnet-4-6 does NOT support assistant prefill — learned the hard way).
- `scripts/ocr-house-run.ts` — download → detect rotation → render upright (~1568px) → parallel page extraction (concurrency 5) → crash-safe JSONL. Resumable via `.tmp/ocr-house-progress.json`. Flags: `--doc`, `--max`, `--skip-multipage`, `--concurrency`, `--force`, `--maxpages`.
- `scripts/ingest-house-ocr.ts` — maps vision rows → CongressionalTrade (amount cols A–K → brackets, owner SP/JT/DC, dash+slash dates), idempotent doc IDs `house-<doc>-ocr-<n>`, `extraction_method: "vision_ocr"`, DRY by default. Accepts .json or .jsonl.
- `scripts/audit-ocr-trades.ts` — sanity flags + stratified sample audit.
- `src/types.ts` — added `extraction_method?: "text_layer" | "vision_ocr"` to CongressionalTrade.

Model: `claude-sonnet-4-6`. Haiku tested but fails on dense pages (said buy/A where truth was sell/B). Cost: a few dollars total (ANTHROPIC_API_KEY in secrets/.env).

Hard lessons captured: Document AI fails on checkbox geometry but vision reads box structure; sonnet-4-6 rejects assistant prefill (use forced tool-use); House PTR scans arrive at varied rotations (0/90/180/270 — orientation must be detected per filing); House dates mix `MM/DD/YYYY` and `MM-DD-YYYY`; full-page images downscale to ~1568px so table-region framing matters for faint grids.

## Next steps (morning)
1. **Commit + push** the 5 files above (awaiting Greg's word). Suggested: `feat(house-ocr): vision-OCR pipeline recovers 21K trades from scanned House PTRs`.
2. Run the KeyVex-vs-Quiver comparison queries above (sub expires Jul 3).
3. Optional: larger random-sample accuracy audit for a hard %.
4. Eyeball the ~25 genuine date-anomaly flags (`audit-ocr-trades.ts`).
5. **Automation decision**: wire this into the scheduled House scraper so future scanned PTRs self-heal (currently a manual backfill script).
6. **President/VP 278-Ts (Trump/Vance)**: separate OGE index, never swept, same OCR problem — the one spot Quiver's Trump page still beats us. Own follow-up.
7. Decide whether to drop the now-unused `@google-cloud/documentai` dep (added in the prior session's Document AI investigation; vision route doesn't need it).
