# KeyVex — Test-Day Report (2026-06-07)

Side-by-side + source-verification pass across the full tool surface, vs Quiver Quantitative (competitive) and SEC EDGAR (ground truth).

## Scorecard

| Area | Result |
|---|---|
| **All 38 tools functional** (live `mcp.keyvex.com`) | ✅ every tool returns real data; mostly < 500ms |
| **Congressional trades vs Quiver** | ✅ coverage + recency (both current to Jun 4 2026) + accuracy all match; KeyVex richer (bioguide_id, district, party, owner, reporting-lag, OPEN_MARKET classification, source PDF, verbatim comments). Quiver adds derived "excess return %" — KeyVex deliberately omits (pure-publisher). |
| **Source-faithful claim (insider vs EDGAR)** | ✅ **validated** — a 2012 NVIDIA Form 4 (Karen Burns) matches the actual filing byte-for-byte, vesting footnotes included |
| **Source-URL correctness (9 SEC tools)** | 8 correct; 1 broken (insider) → **fixed** |
| **Name-search (lobbying 905K, congressional, oig)** | ✅ all reliable |
| **Enforcement text-search** | ✅ works (`fraud` → real actions) |
| **Passthrough (contracts/grants/FEC/CFPB)** | ✅ live in prod; contracts is timeout-borderline under cold-start (see Open Items) |

## Findings (both fixed)

### 🐞 #1 — `get_fec_candidate_profile` bare name search missed older filers
- **Symptom:** `candidate_name:"Schumer"` (and "Fetterman") → 0 results, though the records exist (found via `candidate_id` / `office+state`).
- **Root cause:** name substring is client-side over a window of only 2,000 rows ordered by `last_file_date`; on the 25K-candidate collection, older filers fell outside the window.
- **Fix:** widen the name-search window to scan the whole reference collection (candidates 30K, committees 50K). `firestore.ts`.
- **Verified:** "Schumer" → SCHUMER, CHARLES E. ✓

### 🐞 #2 — `get_insider_transactions` source link was malformed
- **Symptom:** `sec_filing_url` / `source_url` were a broken `browse-edgar?...&search_text=<acc>` search URL that doesn't resolve to the filing — undermining the "auditable" promise.
- **Root cause:** the bulk loader (`form345-bulk.ts buildSourceUrl`) punted, thinking CIK wasn't on the row — but `company_cik` IS present.
- **Fix:** (a) shim builds the proper EDGAR Archives URL at serve-time from `company_cik` + `accession_number` → fixes all 9.9M served rows immediately, no migration; (b) loader corrected so future loads + direct-Firestore reads are also right.
- **Verified:** now `https://www.sec.gov/Archives/edgar/data/<cik>/<acc>/<acc>-index.htm` (confirmed HTTP 200 against EDGAR).
- **Note for Derek (Firestore-direct):** existing v2 rows still carry the old stored `source_url`; reconstruct from `company_cik`+`accession_number` (formula above) or use the MCP tool, which serves the corrected link.

## Verdict
The surface is healthy: 38/38 functional, the core source-faithful claim is validated against EDGAR, congressional matches the category leader and beats it on structured fidelity. Two narrow bugs found and fixed. **Fixes go live on the next `firebase deploy` (mcp + form345 loader).**

## Open items (not blockers)
- **Contracts passthrough timeout** — `get_federal_contracts` (heaviest USAspending response) occasionally trips the 8s live-timeout on cold start → cache fallback. Goes live in 1.5–2.8s when warm. Consider bumping its timeout to ~15s or reducing page count.
- **Remaining side-by-sides** to round out coverage when wanted: lobbying, contracts, insider vs Quiver; 13F + fundamentals vs EDGAR.
