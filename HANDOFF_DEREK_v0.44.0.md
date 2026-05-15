# KeyVex v0.44.0 Additions — Port Handoff for Derek

**Purpose:** Catalog of what KeyVex shipped in v0.44.0 (2026-05-15) so Derek's Claude can port the relevant pieces into `C:\CapitalEdge` / `capital-edge-d5038` without reverse-engineering each one.

**Companion to:** `HANDOFF_DEREK_SCRAPERS.md` (Day 8+9, 19 scrapers) and `HANDOFF_DEREK_SCRAPERS_DAY10.md` (Day 10 Track A + B).

**Repo state at handoff:** `main` at commit `5459f38`, **v0.44.0, 38 MCP tools live** at `https://mcp.keyvex.com`. Battle test green: **128 PASS · 0 EMPTY · 4 SLOW · 0 ERROR** across 132 cases. The 4 SLOW are pre-existing substring-filter perf items on big collections (v1.1 polish queue), not v0.44.0 regressions. Pull the latest `main` HEAD.

---

## What's in this push

### NEW scrapers (2)
1. **`src/scrapers/fara.ts`** — FARA foreign-agent registrations (efile.fara.gov)
2. **`src/scrapers/csl.ts`** — US Consolidated Screening List (api.trade.gov)

### EXTENDED scrapers (1)
3. **`src/scrapers/form4.ts`** — added `scrapeForm5LiveFeed` (Form 5, the annual catch-up insider filing)

### NEW MCP tools (2 — bringing total to 38)
- `get_foreign_agents` (tool #37) — FARA registrant ↔ foreign-principal relationships
- `get_screening_list` (tool #38) — the 12-list Consolidated Screening List

### EXTENDED MCP tools (0 new — Form 5 feeds an existing tool)
- `get_insider_transactions` — now also serves Form 5 records (tagged `data_source: "SEC_EDGAR_FORM5"`)

### NEW collections (2)
- `foreign_agents` — FARA records
- `screening_list` — CSL entries

### Infrastructure
- 7 new Firestore indexes (4 `foreign_agents`, 3 `screening_list`)
- 3 new Cloud Function schedulers (`scrapeFaraWeekly`, `scrapeForm5Daily`, `scrapeCslDaily`)
- No new dependencies, no new API keys — both new sources are key-free

---

## DETAILED CATALOG

### FARA Foreign Agents — `src/scrapers/fara.ts` → `scrapeFara`

Foreign Agents Registration Act registrations from efile.fara.gov (DOJ National Security Division). Every US registrant who has registered to act on behalf of a foreign principal — with the foreign principal's **country** as the marquee signal.

- **One record per (registrant, foreign principal) pair.** A registrant representing three foreign principals → three records. A registrant with no active foreign principal → one record with `has_foreign_principal: false`.
- Backfill volume: **724 records** (422 with a foreign principal) across 558 active registrants.
- Collection: `foreign_agents`. Doc ID: `fara-{registration_number}-{fpIndex}` (or `-none`).
- MCP tool `get_foreign_agents` — filter by `registration_number`, `registrant_name` (substring), `foreign_principal_name` (substring), `foreign_principal_country` (exact, uppercase), `has_foreign_principal`, `since`/`until`.
- Scheduler: `scrapeFaraWeekly` — Sunday 5:30 AM ET, **1800s timeout** (a full run is ~18-20 min).

### Form 5 — `src/scrapers/form4.ts` → `scrapeForm5LiveFeed`

Form 5 is the annual catch-up insider filing — transactions exempt from or missed on Form 4. It shares Form 4's **identical** `ownershipDocument` XML schema.

- Implementation: `parseForm4Xml` was parameterized with a third arg `dataSource` (default `"SEC_EDGAR_FORM4"`). `scrapeForm5LiveFeed` queries EDGAR FTS for `forms=5` and calls `parseForm4Xml(xml, meta, "SEC_EDGAR_FORM5")`.
- Records land in the existing `insider_trades` collection — **no new collection, no new tool.** `get_insider_transactions` serves them. The `InsiderTransaction.data_source` type was widened to `"SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5"`.
- Doc IDs use the shared Form 4/5 scheme; Form 5 accessions are distinct from Form 4 so no collision.
- Scheduler: `scrapeForm5Daily` — daily 8:20 AM ET, 3-day lookback. Low volume (Form 5 is annual).

### Consolidated Screening List — `src/scrapers/csl.ts` → `scrapeConsolidatedScreeningList`

The US Consolidated Screening List — twelve export-screening lists from Commerce (BIS), State, and Treasury (OFAC) in one feed. ~25,660 entries.

- Twelve source lists: SDN, Entity List (EL), Denied Persons (DPL), Military End User (MEU), Unverified List (UVL), CMIC, Capta (CAP), ITAR Debarred (DTC), ISN, NS-MBS (MBS), PLC, SSI. The `source_short` field carries the code.
- Broader than `get_ofac_sdn` (SDN is one of the twelve sources). Keep both — OFAC SDN is the deep OFAC view; CSL is the "on ANY US screening list" view.
- Collection: `screening_list`. Doc ID: `csl-{source_short}-{source_id}`.
- MCP tool `get_screening_list` — filter by `name` (substring, incl. alt_names), `source_short`, `type`, `country` (array-contains on the entry's countries), `program` (substring).
- Scheduler: `scrapeCslDaily` — daily 5:50 AM ET.

---

## HARD LESSONS — read before porting (saves hours of debugging)

1. **FARA's `ForeignPrincipals` LIST endpoint is broken on FARA's side.** `/api/v1/ForeignPrincipals/json/Active` (and `/xml/Active`, and the exact example URL from FARA's own docs) consistently returns FARA's public CMS HTML instead of API JSON. The sibling `/api/v1/Registrants/json/Active` works fine. **The workaround:** the *per-registrant* form `/api/v1/ForeignPrincipals/json/Active/{regNumber}` works. So the scraper pulls the registrant list, then queries each registration number's foreign principals individually. If FARA ever fixes the list endpoint, the per-registrant loop can be replaced — but don't count on it.

2. **The FARA host (efile.fara.gov) is genuinely flaky.** Intermittent HTTP 500s, connection resets, SSL errors, HTTP 000, and the HTML-for-JSON routing glitch — all observed within a single run. `fetchJson` in `fara.ts` retries up to 5× with exponential backoff (2s/4s/8s/16s) and **treats an HTML response body as a retryable failure** (not just non-2xx status). Without that, the scraper silently produces partial data. Port the retry logic verbatim.

3. **FARA's two endpoints have different trailing-slash + filter behavior.** `Registrants/json/Active` (no trailing slash) works. The path structure is `/api/v1/{Endpoint}/{format}/{filter}`. The `Active` filter segment is required — an empty filter falls through to the CMS HTML.

4. **FARA rate limit is 5 requests / 10 seconds.** The scraper paces at 2200ms/request. A full sweep of ~558 registrants is ~18-20 min — set the Cloud Function timeout to 1800s (the hard max for scheduled functions; 2400s is rejected at deploy).

5. **The CSL has a key-free bulk file — use it.** The live CSL *search* API (`api.trade.gov/consolidated_screening_list/v1/search`) requires an ITA Developer Portal subscription key. But the **bulk static file** at `https://api.trade.gov/static/consolidated_screening_list/consolidated.json` is key-free and carries the full ~25K-entry list. One fetch, no pagination, no auth. Don't bother with the keyed API.

6. **CSL `source_short` is parsed from the parenthetical in the `source` string.** `"Entity List (EL) - Bureau of Industry and Security"` → `EL`. `"Non-SDN Menu-Based Sanctions List (NS-MBS List) - Treasury"` → normalized to `MBS`. The regex + the NS-MBS special-case are in `sourceShort()` in `csl.ts`.

7. **CSL query sorts client-side, not via Firestore `.orderBy()`.** `queryScreeningList` does `.where()` equality filters + `.limit()` + `.get()`, then sorts in JS. This deliberately avoids needing a composite index for every (filter, sort) combination — single-field equality filters use Firestore's automatic indexes. FARA's `queryForeignAgents` *does* use `.orderBy()`, so it needs the composite indexes (4 of them, in `firestore.indexes.json`). **If you port FARA, deploy the indexes** (`firebase deploy --only firestore:indexes`) or queries fail with `FAILED_PRECONDITION`.

8. **Form 5 is nearly free if you've ported Form 4.** Same `ownershipDocument` XML schema. Parameterize your Form 4 parser with a `dataSource` arg and add a `forms=5` FTS query — that's the whole change.

---

## NEW types added in `src/types.ts`

- `ForeignAgent` + `ForeignAgentsQuery`
- `ScreeningListEntry` + `ScreeningListQuery`
- `InsiderTransaction.data_source` widened: `"SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5"`

## Firestore indexes added (7 total, in `firestore.indexes.json`)

`foreign_agents`: (registration_number, registration_date) · (foreign_principal_country, registration_date) · (foreign_principal_country, foreign_principal_reg_date) · (has_foreign_principal, registration_date)
`screening_list`: (source_short, name) · (type, name) · (countries CONTAINS, name)

## Cloud Function schedulers added (3, in `functions/src/index.ts`)

- `scrapeFaraWeekly` — Sun 5:30 AM ET, 1800s timeout
- `scrapeForm5Daily` — daily 8:20 AM ET
- `scrapeCslDaily` — daily 5:50 AM ET, 1GiB memory

---

## What to port first (priority order for Derek)

1. **Form 5** — trivial if Form 4 is already ported (parameterize the parser, add a `forms=5` query). Pure data-completeness win.
2. **CSL** — clean key-free bulk file, single fetch, high compliance value. Pairs with federal_contracts + OFAC for trade screening.
3. **FARA** — the highest-value addition (foreign-influence linkage) but the heaviest: the per-registrant iteration, the flaky-host retry logic, and the 18-20 min run time. Port last, and port the retry logic carefully.

## File checklist for the port

**Scrapers (new):** `src/scrapers/fara.ts`, `src/scrapers/csl.ts`
**Scrapers (extended):** `src/scrapers/form4.ts` (parameterized parser + `scrapeForm5LiveFeed`)
**MCP tools (new):** `src/tools/foreign-agents.ts`, `src/tools/screening-list.ts`
**Shared files (merged versions on `main` contain everything):** `src/types.ts`, `src/firestore.ts`, `src/tools/index.ts`, `src/scrape.ts` (new CLI commands `fara`, `csl`, `form5-feed`), `functions/src/index.ts`, `firestore.indexes.json`

## How to verify the port

```bash
npx tsc --noEmit                              # should exit 0
npx tsx src/scrape.ts fara --max=5            # 5 registrants, ~30s — confirms the per-registrant iteration
npx tsx src/scrape.ts csl                     # ~25,660 entries — confirms the bulk-file parse
npx tsx src/scrape.ts form5-feed 7            # confirms Form 5 XML parses via the Form 4 parser
firebase deploy --only firestore:indexes      # FARA queries need the composite indexes
firebase deploy --only functions
```

---

**Questions:** Greg has the full context on the KeyVex side. The HARD LESSONS above — especially #1 (FARA broken list endpoint), #2 (flaky-host retry), and #5 (CSL key-free bulk file) — are the load-bearing details. If a ported scraper silently returns zero records, check the relevant Hard Lesson first.
