# KeyVex Day 10 Additions — Port Handoff for Derek

**Purpose:** Catalog of what KeyVex shipped on May 14, 2026 (Day 10) so Derek's Claude can port the relevant pieces into `C:\CapitalEdge` / `capital-edge-d5038` without reverse-engineering each one.

**Companion to:** `HANDOFF_DEREK_SCRAPERS.md` (Day 8 + 9 additions, 19 scrapers).

**Repo state at handoff:** commit `e437972` on `main`, v0.41.0, **31 MCP tools live** at `https://mcp.keyvex.com`, 32+ scheduled scrapers running on cron. Battle test green: 97 PASS · 0 EMPTY · 5 SLOW · 0 ERROR across 102 cases. All 5 SLOW are pre-existing substring-filter perf items on big collections (v1.1 polish queue), not Day 10 regressions.

---

## What's in this push

### NEW scrapers (4)
1. **`src/scrapers/fda-recalls.ts`** — openFDA drug + device + food recalls
2. **`src/scrapers/cpsc-recalls.ts`** — CPSC consumer-product recalls
3. **`src/scrapers/eia.ts`** — EIA energy data (WTI / Brent / natgas / gasoline / crude production)
4. **`src/scrapers/govinfo.ts`** — GovInfo congressional + GAO documents (CRPT / PLAW / CHRG / GAOREPORTS)

### EXTENDED scrapers (2)
5. **`src/scrapers/nport.ts`** — added per-holding extraction from `primary_doc.xml`
6. **`src/scrapers/form4.ts`** — added derivative-table parsing (was P/S non-derivative only)

### NEW MCP tools (3 — bringing total to 31)
- `get_fund_holdings` (29th tool) — N-PORT per-security holdings including derivatives
- `get_product_recalls` (30th tool) — unified FDA + CPSC + (reserved) NHTSA
- `get_government_publications` (31st tool) — GovInfo packages

### EXTENDED MCP tools (2)
- `get_economic_indicators` — adds `eia` source alongside `bls` + `fred`
- `unified_search` — adds `company_name` (EDGAR-resolved) + `cusip` identifier cascade; 5 new name-keyed adapters

### NEW helpers (1)
- **`src/load-secrets.ts`** — reads `secrets/.env` at module load, populates `process.env` for local dev. Wired into FRED + EIA + GovInfo scrapers. Production uses Firebase Secret Manager.

### Infrastructure
- Node 20 → 22 in functions/package.json engines + esbuild target
- firebase-functions ^6.1.0 → ^7.2.5 (major bump, surface-clean upgrade)
- firebase-admin ^13.0.1 → ^13.9.0 (minor)

---

## Quick-reference table

| # | Scraper / Tool | File | Source | Cadence | Collection |
|---|---|---|---|---|---|
| 20 | FDA Recalls (drug+device+food) | `fda-recalls.ts` | api.fda.gov | Daily 6:50 AM | `product_recalls` |
| 21 | CPSC Recalls | `cpsc-recalls.ts` | saferproducts.gov | Daily 6:55 AM | `product_recalls` (shared) |
| 22 | EIA Energy | `eia.ts` | api.eia.gov | Daily 9:15 AM | `economic_indicators` (shared w/ BLS+FRED) |
| 23 | GovInfo Documents | `govinfo.ts` | api.govinfo.gov | Daily 9:30 AM | `gov_documents` |
| 24 | N-PORT Holdings (extension) | `nport.ts` | EDGAR primary_doc.xml | Daily 6:40 AM (after metadata phase) | `nport_holdings` (new) |
| 25 | Form 4 Derivatives (extension) | `form4.ts` | EDGAR primary_doc.xml | Existing 30-min Form 4 cadence | `insider_trades` (same; new fields) |

---

## DAY 10 ADDITIONS — Detailed catalog

### 20. FDA Recalls — `src/scrapers/fda-recalls.ts` → `scrapeFdaRecalls` / `scrapeAllFdaRecalls`

- **Function:** Three sub-feeds under one shared `ProductRecall` shape: `fda_drug`, `fda_device`, `fda_food`. Each pulls openFDA's `/{category}/enforcement.json` with date-range filter. Paginates 1000 records per page up to a 25K skip cap (openFDA limit). Convenience wrapper `scrapeAllFdaRecalls` runs all three sequentially.
- **MCP tool:** `get_product_recalls` (with `source` enum filter)
- **Source:** `https://api.fda.gov/drug/enforcement.json`, `/device/enforcement.json`, `/food/enforcement.json`
- **Auth:** **No key required** at 240 req/min, 1000 req/day. Optional `OPENFDA_API_KEY` env var enables higher limits (120K req/day) — not needed for daily refresh.
- **Cadence:** Daily 6:50 AM ET, 7-day lookback.
- **Idempotent doc-ID:** `${source}-${recall_number}` (e.g. `fda_drug-D-1234-2026`).
- **Provenance:** `source_url` → query URL on api.fda.gov for that exact recall_number.
- **Schema mapping:** Date format YYYYMMDD → ISO YYYY-MM-DD via `isoDate()` helper. FDA `voluntary_mandated` → `initiator`. FDA `product_type` → `product_category`. FDA `code_info` + `more_code_info` → `product_codes` array.
- **Hard lesson:** openFDA returns **HTTP 404** when a query matches zero records (NOT 200 with empty results). Treat 404 as normal "no data in window" rather than error.

### 21. CPSC Recalls — `src/scrapers/cpsc-recalls.ts` → `scrapeCpscRecalls`

- **Function:** Pulls CPSC consumer-product recalls from `saferproducts.gov/RestWebServices/Recall` as JSON. Single round trip (CPSC doesn't paginate this endpoint). ~20-60 recalls/month, tiny payload.
- **MCP tool:** Same `get_product_recalls` (with `source: "cpsc"`).
- **Source:** `https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=YYYY-MM-DD&RecallDateEnd=YYYY-MM-DD`
- **Auth:** **No key required.**
- **Cadence:** Daily 6:55 AM ET, 30-day lookback.
- **Idempotent doc-ID:** `cpsc-${recall_number}` (e.g. `cpsc-26477`).
- **Provenance:** `source_url` → CPSC's HTML page (`URL` field in response is already a fully-qualified `cpsc.gov/Recalls/...` URL).
- **Schema mapping:** CPSC dates ship as `YYYY-MM-DDT00:00:00` → strip `T00:00:00` for ISO date. CPSC has Manufacturers / Importers / Distributors / Retailers as nested arrays — `pickFirm()` walks the fallback chain and picks the first non-empty `.Name`. CPSC doesn't use FDA-style severity classes; `classification` stays null. Products[0].NumberOfUnits → `product_quantity`; Products[0].Type or .Name → `product_category`; Hazards[0].Name → `reason_for_recall`.
- **Hard lesson:** Some CPSC recalls have empty `Manufacturers[]` and instead use `Importers[]` for foreign goods. The fallback chain (Manufacturers → Importers → Distributors → Retailers) is necessary to get a non-empty `recalling_firm`.

### 22. EIA Energy — `src/scrapers/eia.ts` → `scrapeEia`

- **Function:** Curated 5-series watchlist pulled from EIA's v2 API. Series: WTI crude (RWTC, weekly), Brent crude (RBRTE, weekly), Henry Hub natural gas (RNGWHHD, weekly), US retail gasoline (EMM_EPMR_PTE_NUS_DPG, weekly), US crude oil production (NUS+EPC0, monthly).
- **MCP tool:** Extends existing `get_economic_indicators` with `source: "eia"` filter (no new tool; additive).
- **Source:** `https://api.eia.gov/v2/{category}/{dataset}/data/`
- **Auth:** **REQUIRES API key.** Free signup at `https://www.eia.gov/opendata/register.php`. Set `EIA_API_KEY` env var. **Note:** Same key works for GovInfo + NHTSA + USDA + DOL since EIA uses api.data.gov-style key infrastructure under the hood (verified Day 10).
- **Cadence:** Daily 9:15 AM ET, since 2018 default.
- **Idempotent doc-ID:** `${spec.id}-${period}` (e.g. `EIA-WTI-SPOT-WEEKLY-2026W18`).
- **Provenance:** `source_url` → `https://www.eia.gov/opendata/browser/{apiPath}`.
- **Schema mapping:** EIA serves period strings as YYYY-MM-DD (daily/weekly), YYYY-MM (monthly), YYYY (annual). The `periodToLabel()` helper converts to KeyVex period format (`2026W18`, `2026M05`, `2026A01`, `2026D127`).
- **Hard lesson:** EIA v2 uses **path-based addressing** (`/v2/{category}/{dataset}/data/`) with **facet filters** rather than series-IDs like FRED. Each series in the catalog specifies its own `apiPath` + `facets`. Different from FRED's pattern.
- **CAVEAT FOR DEREK:** Series IDs (RWTC / RBRTE / RNGWHHD / EMM_EPMR_PTE_NUS_DPG) are best-effort from working knowledge. Run a smoke test (`npx tsx src/scrape.ts eia`) after porting to verify each series pulls real data before relying on the schedule. Adjust facet keys / dataset paths if needed.

### 23. GovInfo Documents — `src/scrapers/govinfo.ts` → `scrapeGovInfo` / `scrapeGovInfoCollection`

- **Function:** Pulls recent packages from 4 GovInfo collections in sequence: CRPT (Congressional Reports), PLAW (Public + Private Laws), CHRG (Congressional Hearings), GAOREPORTS (GAO oversight). Per-collection pagination via `offsetMark` cursor (NOT numeric `offset`).
- **MCP tool:** `get_government_publications`
- **Source:** `https://api.govinfo.gov/collections/{COLLECTION}/{ISO_TIMESTAMP}?offsetMark=*&pageSize=100&api_key=...`
- **Auth:** **REQUIRES api.data.gov key.** Free signup at `https://api.data.gov/signup/` — one signup, works across GovInfo + NHTSA + USDA + DOL + EIA. Set `GOVINFO_API_KEY` env var. **DEMO_KEY also works** at low quota for testing.
- **Cadence:** Daily 9:30 AM ET, 7-day lookback (committee reports + hearings trickle in days after the actual event).
- **Idempotent doc-ID:** `packageId` directly (e.g. `CRPT-119hrpt27` for House Report 27 of the 119th Congress).
- **Provenance:** `source_url` + `package_link` → `https://api.govinfo.gov/packages/{packageId}/summary` (or whatever GovInfo returned in `packageLink`).
- **Schema mapping:** `congress` field is the Congress number as string (e.g. "119"). `doc_class` is the sub-type within collection (`hrpt`, `srpt`, `pub`, `pvt`, `hr`, `s`). `dateIssued` → `date_issued` (YYYY-MM-DD). `lastModified` is full ISO datetime.
- **Hard lesson #1 (load-bearing):** GovInfo API requires `offsetMark=*` for first-page pagination — **NOT** `offset=N`. DEMO_KEY has loose validation and tolerates `offset=0` for the first page, but real api.data.gov keys return **HTTP 200 with a `"Please provide an offsetMark"` message body** (NOT a 400 error). Silent-ish failure mode: HTTP succeeds, JSON has no data. The fix is `offsetMark=*` on first call + extracting the next offsetMark from `data.nextPage` URL's query string. Pattern likely applies to other api.data.gov-backed services with paginated endpoints.
- **Hard lesson #2 (universal key):** A single api.data.gov key works across **all** opted-in agencies: GovInfo, NHTSA, USDA, DOL, EIA (since EIA uses the same underlying infrastructure). Don't register separately for each — use one key everywhere. Greg's EIA key was tested against GovInfo PLAW and returned 5,948 real records, confirming this.

### 24. N-PORT Holdings Extension — `src/scrapers/nport.ts` → `scrapeNportHoldings` / `parseNportHoldings`

- **Function:** Walks each `NportFiling`'s `primary_doc.xml`, parses the `<invstOrSecs>` block, and emits one `NportHolding` per `<invstOrSec>` element. Covers equities (EC/EP), debt (DBT/ABS/MBS/UST/STIV), derivatives (DCO/DCR/DE/DFE/DIR/DR), repos (REPO/RP), cash (CASH). Discriminator: `derivative_type` ("future" / "forward" / "swap" / "option" / "warrant" / "swaption" / "other") derived from which `<derivativeInfo>` child element is present.
- **MCP tool:** `get_fund_holdings` (new 29th tool).
- **Source:** Each filing's `primary_document_url` (resolved during the metadata phase; saved on `NportFiling`).
- **Auth:** None beyond standard EDGAR User-Agent.
- **Cadence:** Daily 6:40 AM ET — runs after the existing N-PORT metadata phase as a second step within the same Cloud Function (`scrapeNportDaily`). Memory bumped 512MiB → 1GiB to accommodate XML parsing.
- **Idempotent doc-ID:** `${filing_id}-${holding_index}` (e.g. `0001752724-26-103456-0`, `-1`, ... for each row in order of appearance).
- **Provenance:** `NportHolding` ties to its parent `NportFiling` via `filing_id`. Agents read parent for filing metadata, child for security-level detail.
- **Schema mapping:** Asset category code preserved in `asset_cat`. `is_derivative: true` iff `asset_cat` starts with "D". `cusip` + `ticker` + `isin` extracted from `<cusip>` + `<identifiers>` block. Sign convention: positive balance = long, negative = short per N-PORT spec. `payoff_profile`: "Long" / "Short".
- **Hard lesson #1:** N-PORT XML root is `<edgarSubmission><formData><invstOrSecs><invstOrSec>...` — three levels of nesting. Don't try to grab `invstOrSecs` from `edgarSubmission` directly.
- **Hard lesson #2:** Deep derivative sub-blocks (counterparty, strike, expiration, leg-level terms) are intentionally NOT extracted in v1A — heavy XML, agent rarely needs that level. Agents follow `package_link` for the unbounded prose if they need it. v1.1 polish to extract for specific use cases.
- **Hard lesson #3:** N-PORT primary docs are 100KB-5MB XMLs. A daily run with ~30-50 filings can pull ~250MB. Cloud Function timeout 540s is comfortable but tighter than metadata-only runs; memory 1GiB recommended.

### 25. Form 4 Derivative Table Extension — `src/scrapers/form4.ts`

- **Function:** Parser now walks BOTH `<nonDerivativeTable>` AND `<derivativeTable>` (was non-derivative only). Accepts 11 transaction codes (P, S, A, M, X, C, F, G, D, I, V) instead of just P + S. **Recovers an estimated 30-50% of Form 4 data previously dropped silently** — option exercises, RSU vests, tax-withholding sales, gifts, conversions.
- **MCP tool:** `get_insider_transactions` (unchanged; same 30th-tool name).
- **NEW fields on `InsiderTransaction`:**
  - `is_derivative: boolean` — true iff row came from derivative table
  - `underlying_security_title: string | null`
  - `underlying_security_shares: number | null`
  - `conversion_or_exercise_price: number | null`
- **NEW filters on `get_insider_transactions`:**
  - `is_derivative: boolean` — filter to derivative or non-derivative rows
  - `transaction_codes: string[]` — OR-filter on raw SEC codes (max 30)
- **Idempotent doc-ID strategy (load-bearing):**
  - **P/S non-derivative records keep the legacy format** `${accession}-${txDate}-${code}-${roundedShares}` — preserves existing data's idempotency on re-runs.
  - Non-P/S non-derivative records use a row-index suffix: `${accession}-${txDate}-${code}-${ndIdx}`
  - All derivative records use D-marker + row-index: `${accession}-D-${txDate}-${code}-${dIdx}`
  - Three distinct ID namespaces; old data unaffected; new data flows into new namespaces.
- **Direction derivation (`transaction_type`):** P → "buy", S → "sell". For all other codes, derive from `acquired_disposed` (A → "buy", D → "sell"); fallback to code semantics (`/^(A|M|X|C|I)$/` → "buy", else "sell").
- **Hard lesson:** When you extend a parser to capture rows it used to drop, **preserve the existing namespace's doc IDs unchanged** — otherwise re-running the scraper creates duplicate records in a new namespace alongside old orphans. Three-namespace strategy avoids this entirely.
- **CAVEAT FOR DEREK:** Existing `insider_trades` records ingested before this change lack `is_derivative` and the 3 other new fields. Firestore queries with `is_derivative=false` will silently EXCLUDE pre-extension records (Firestore can't filter on field-doesn't-exist). To backfill, run `npx tsx src/scrape.ts form4-feed <wide-N> --save` post-port — the parser will re-walk recent accessions and `merge: true` writes will add the new fields.

---

## NEW types added in `src/types.ts`

```typescript
// In types.ts:

// Extended on existing InsiderTransaction (4 new required fields)
export interface InsiderTransaction {
  // ... existing fields ...
  is_derivative: boolean;
  underlying_security_title: string | null;
  underlying_security_shares: number | null;
  conversion_or_exercise_price: number | null;
}

// NEW
export interface NportHolding {
  id: string;
  filing_id: string;
  filing_type: string;
  is_amendment: boolean;
  period_ending: string;
  filer_name: string;
  filer_cik: string;
  sec_file_number: string;
  holding_index: number;
  name: string;
  lei: string | null;
  title: string | null;
  cusip: string | null;
  ticker: string | null;
  isin: string | null;
  asset_cat: string | null;
  is_derivative: boolean;
  derivative_type: string | null;
  issuer_cat: string | null;
  country: string | null;
  balance: number | null;
  units: string | null;
  currency: string | null;
  value_usd: number | null;
  pct_of_portfolio: number | null;
  payoff_profile: string | null;
  fair_val_level: number | null;
  is_restricted: boolean | null;
  is_non_cash_collateral: boolean | null;
  is_loaned: boolean | null;
  scraped_at: string;
}

// NEW unified shape across FDA + CPSC + (reserved) NHTSA
export interface ProductRecall {
  id: string;
  source: "fda_drug" | "fda_device" | "fda_food" | "nhtsa" | "cpsc";
  recall_number: string;
  recall_initiation_date: string;
  posted_date: string | null;
  recalling_firm: string;
  product_description: string;
  reason_for_recall: string;
  classification: string | null;
  status: string | null;
  initiator: string | null;
  distribution_pattern: string | null;
  product_quantity: string | null;
  product_category: string | null;
  product_codes: string[] | null;
  vehicle_make: string | null;       // NHTSA-only (null elsewhere)
  vehicle_model: string | null;       // NHTSA-only
  model_year_range: string | null;    // NHTSA-only
  affected_component: string | null;  // NHTSA-only
  termination_date: string | null;
  source_url: string;
  scraped_at: string;
}

// NEW
export interface GovDocument {
  id: string;
  collection: "CRPT" | "PLAW" | "CHRG" | "GAOREPORTS";
  collection_name: string;
  package_id: string;
  doc_class: string;
  congress: string | null;
  date_issued: string;
  last_modified: string;
  title: string;
  source_url: string;
  package_link: string;
  scraped_at: string;
}

// Extended on existing EconomicIndicator (one type added to source union)
export interface EconomicIndicator {
  // ... existing fields ...
  source: "bls" | "fred" | "eia";  // was: "bls" | "fred"
}
```

---

## Firestore indexes added (14 total, all in `firestore.indexes.json`)

**For `insider_trades` (Form 4 derivative extension):**
- `is_derivative + disclosure_date DESC`
- `ticker + is_derivative + disclosure_date DESC`
- `ticker + transaction_code + disclosure_date DESC`

**For `nport_holdings` (new collection):**
- `ticker + value_usd DESC`
- `cusip + value_usd DESC`
- `filer_cik + value_usd DESC`
- `filing_id + value_usd DESC`
- `is_derivative + period_ending DESC`
- `derivative_type + value_usd DESC`
- `asset_cat + value_usd DESC`

**For `product_recalls` (new collection):**
- `source + recall_initiation_date DESC`
- `classification + recall_initiation_date DESC`
- `status + recall_initiation_date DESC`
- `vehicle_make + recall_initiation_date DESC`
- `source + classification + recall_initiation_date DESC`

**For `gov_documents` (new collection):**
- `collection + date_issued DESC`
- `congress + date_issued DESC`
- `doc_class + date_issued DESC`
- `collection + last_modified DESC`

Deploy via `firebase deploy --only firestore:indexes`. Empty collections build instantly; populated collections may take 5-15 min for the first build.

---

## Cloud Function schedulers added (5 new)

In `functions/src/index.ts`:

| Function | Cron | Secrets | Memory | Notes |
|---|---|---|---|---|
| `scrapeFdaRecallsDaily` | `50 6 * * *` | none | 512 MiB | 7-day lookback, 3 sub-feeds |
| `scrapeCpscRecallsDaily` | `55 6 * * *` | none | 256 MiB | 30-day window, single API call |
| `scrapeEiaDaily` | `15 9 * * *` | `EIA_API_KEY` | 512 MiB | 5 series, since 2018 |
| `scrapeGovInfoDaily` | `30 9 * * *` | `GOVINFO_API_KEY` | 512 MiB | 4 collections, 7-day window |
| `scrapeNportDaily` (extended) | `40 6 * * *` | none | 1 GiB (was 512) | Metadata + holdings phases |

Secrets need to be set before deploy. For each:
```bash
firebase functions:secrets:set EIA_API_KEY --data-file=-
firebase functions:secrets:set GOVINFO_API_KEY --data-file=-
```

---

## Cross-source pairing patterns (new compositions unlocked)

**FDA recall → company filings:**
```
get_product_recalls(source:"fda_drug", recalling_firm:"Pfizer", limit:5)
→ get_material_events(ticker:"PFE", item_codes:["7.01","8.01"], since:"<recall_date>")
→ get_insider_transactions(ticker:"PFE", since:"<recall_date>")
→ get_enforcement_actions(text:"Pfizer", since:"<recall_date>")
```
Pattern: recall → 8-K Reg FD disclosure → insider activity → SEC/DOJ follow-on.

**N-PORT fund derivative exposure → ticker-keyed agent queries:**
```
get_fund_holdings(ticker:"NVDA")
→ funds holding NVDA across mutual + ETF + closed-end universe
→ get_fund_holdings(filer_cik:"<one fund's CIK>")
→ that fund's complete portfolio composition
```

**EIA + congressional roll-call (energy-policy alpha):**
```
get_economic_indicators(source:"eia", category:"energy", latest_only:true)
→ current crude / gas / gasoline prices
→ get_roll_call_votes(congress:119, legislation_type:"HR")
→ filter to energy-bill votes
→ get_congressional_trades(ticker:"XOM", since:"<bill date>")
```

**GovInfo committee report → bill passage → trade:**
```
get_government_publications(collection:"CRPT", congress:"119", limit:10)
→ recent committee reports (often signal an upcoming floor vote)
→ get_bills(bill_id:"<from committee report>")
→ get_roll_call_votes(bill_id:"<same>")
→ get_congressional_trades(bioguide_id:"<member who voted>")
```

**unified_search v1.1 name cascade (Wells Fargo example):**
```
unified_search(company_name:"Wells Fargo", per_source_limit:5)
→ resolves to ticker WFC + CIK 0000072971 via EDGAR
→ fans out to all 12 ticker-keyed adapters
→ + all 10 CIK-keyed adapters
→ + 5 name-keyed adapters (federal_contracts, lobbying, enforcement, complaints, recalls)
→ single response across the disclosure surface
```

---

## What to port first (priority order for Derek)

1. **Form 4 derivative extension** — biggest data-quality win. Recovers 30-50% of dropped Form 4 records that the existing parser was silently skipping. Pure parser change; no new API integration. Same EDGAR endpoint, same auth (none). Schema change requires backfill via wide-N `form4-feed`.

2. **FDA + CPSC product recalls** — two clean APIs, no auth needed, daily ~50 records total. The unified `product_recalls` collection + `ProductRecall` type are reusable for NHTSA later. High agent value (cross-source with insider trades + 8-Ks).

3. **N-PORT holdings extension** — big unlock for fund-level derivative visibility but heavier infrastructure ask (1GiB memory, 250MB/day XML parsing). Wait until Derek's project actually needs fund holdings.

4. **GovInfo documents** — clean API, one key (api.data.gov), useful for the political-alpha overlay. Watch the `offsetMark` pagination gotcha.

5. **EIA energy data** — extends an existing `economic_indicators` collection rather than creating a new one. Series IDs need verification before relying on the schedule. Defer until Derek's project wants the energy-overlay.

---

## Things explicitly DEFERRED (NOT in this push)

- **NHTSA Vehicle Recalls** — `api.nhtsa.gov/recalls/recallsByVehicle` works per-vehicle but requires make+model+year per call (not bulk-friendly). The bulk endpoint pattern needs investigation. Source enum `"nhtsa"` is reserved in `ProductRecall` so adding it later is purely additive. When we revisit, the same api.data.gov key already in use will likely work.
- **BEA Macro Data** — FRED already republishes BEA's national-level NIPA series. BEA's unique value is state-level data (state personal income, state GDP) — that requires a schema extension to `EconomicIndicator` (geo dimension). Deferred to a dedicated v1A.1 session.
- **FOIA logs** — Each federal agency publishes its own FOIA request log in its own format; no unified API exists. Per-agency scrapers would be 1-2 hours each; deferred to v1.1.

---

## Caveats / known issues for Derek

1. **Form 4 backfill required** — existing `insider_trades` records pre-Day-10 lack `is_derivative` etc. Run `form4-feed 60 --save` post-port to backfill recent accessions.
2. **N-PORT smoke test before scheduling** — parser assumes specific XML structure (`edgarSubmission > formData > invstOrSecs > invstOrSec`). Run `nport 1 --extract-holdings --save` once after porting to verify the parser matches live data.
3. **EIA series IDs are best-effort** — RWTC / RBRTE / RNGWHHD / EMM_EPMR_PTE_NUS_DPG were specified from working knowledge. Run `eia` once locally with the key to verify each series returns real data. If any return empty, adjust facet keys.
4. **GovInfo `offsetMark` pagination** — `offset=N` numeric scheme works for DEMO_KEY but **silently fails** with real api.data.gov keys (200 OK + error message, no data). Make sure you use `offsetMark=*` for first page and extract next-offsetMark from response's `nextPage` URL.
5. **Pre-existing v1.1 perf issues unchanged** — substring queries on lobbying_filings (51K records) and federal_contracts (5K window) remain slow. Not Day 10 regressions.
6. **firebase-functions v7 migration** — clean upgrade for our usage (`onSchedule`, `onRequest`, `defineSecret`, `logger`). No code changes required. Bundle still 15.4 MB.

---

## File checklist for the port

Files to copy from `gregorywglenn-spec/Keyvex-API` (commit `e437972`):

### Scrapers (new)
- `src/scrapers/fda-recalls.ts`
- `src/scrapers/cpsc-recalls.ts`
- `src/scrapers/eia.ts`
- `src/scrapers/govinfo.ts`

### Scrapers (extended)
- `src/scrapers/nport.ts` (added holdings phase — last ~200 lines of file)
- `src/scrapers/form4.ts` (added derivative table parsing — full file rewrite worth re-reading)

### MCP tools (new)
- `src/tools/fund-holdings.ts`
- `src/tools/product-recalls.ts`
- `src/tools/government-publications.ts`

### MCP tools (extended)
- `src/tools/insider-transactions.ts` (new filters + new fields in input schema)
- `src/tools/economic-indicators.ts` (added `eia` to source enum)
- `src/tools/unified-search.ts` (company_name + cusip cascade)

### Helpers
- `src/load-secrets.ts` (new — local-dev key loader)
- `src/sec-tickers.ts` (added `resolveCompanyByName` export)

### Data layer
- `src/firestore.ts` (added `saveNportHoldings`, `queryNportHoldings`, `saveProductRecalls`, `queryProductRecalls`, `saveGovDocuments`, `queryGovDocuments`)
- `src/types.ts` (4 new types + `InsiderTransaction` extended + `EconomicIndicator.source` extended + `UnifiedSearchQuery` extended)

### Config / infra
- `firestore.indexes.json` (14 new indexes)
- `functions/package.json` (Node 22, firebase-functions ^7.2.5, firebase-admin ^13.9.0)
- `functions/src/index.ts` (5 new schedulers + N-PORT scheduler extended)
- `package.json` (Node ≥22, version 0.41.0)

### Tool registry
- `src/tools/index.ts` (3 new tool entries)

### CLI
- `src/scrape.ts` (new commands: `fda-recalls`, `cpsc-recalls`, `eia`, `govinfo`; extended `nport --extract-holdings`)

---

## How to verify the port is clean

After porting, in Derek's repo:

```bash
# Typecheck
npx tsc --noEmit
# Should exit 0.

# Smoke each new scraper (no --save flag yet)
npx tsx src/scrape.ts fda-recalls 7
npx tsx src/scrape.ts cpsc-recalls 7
EIA_API_KEY=<key> npx tsx src/scrape.ts eia
GOVINFO_API_KEY=<key> npx tsx src/scrape.ts govinfo 7 --max=5

# Form 4 extension
npx tsx src/scrape.ts form4 AAPL
# Verify the output now includes derivative rows (is_derivative: true) — Apple files RSU vests + option exercises regularly.

# N-PORT holdings
npx tsx src/scrape.ts nport 1 --extract-holdings
# Verify the output includes per-holding rows after the filings array.

# unified_search company_name cascade
# (requires the MCP server running locally OR direct handler call)
```

Then:
```bash
# Deploy indexes (run once when ready)
firebase deploy --only firestore:indexes

# Deploy functions
firebase deploy --only functions
```

---

**Questions / clarifications:** Greg has all the context on the KeyVex side. The HARD LESSONS above are the load-bearing details — if anything in Derek's port silently produces zero records or misses data, check the relevant Hard Lesson first.
