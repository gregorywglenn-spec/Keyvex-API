# KeyVex MCP Tool Inventory — Coverage & Status

_Generated 2026-06-06 after the data-quality backfill push. Counts/ranges from a live Firestore audit._

---

## 📖 For Derek — how to read KeyVex's data

You've got **read-only** access to the `capitaledge-api` Firestore (Cloud Datastore Viewer, granted to your `firebase-adminsdk-fbsvc@capital-edge-d5038` service account). There are two ways to pull our data, and **you don't need any API keys for either:**

**1. Firestore direct (your read-only SA).** Point your Firebase Admin SDK at project `capitaledge-api` and read the collections in the table below. Fast path, and it gives you the **complete** data for the ~34 full-mirror / bounded / reference collections. You can read everything; you can't write anything.

**2. Our MCP endpoint — `https://mcp.keyvex.com`.** Authless (no key, just call it). Use this when you want the **live passthrough** data described next.

**The one gotcha — the 4 passthrough collections** (`federal_contracts`, `federal_grants`, `fec_contributions`, `consumer_complaints`):
- These are giant firehoses we deliberately **don't** fully mirror. Reading them straight from **Firestore** gives you only the **cached recent subset** our cron stores (a rolling slice — not full history).
- For **complete / live** results on those four, call **`mcp.keyvex.com`** instead. It hits the source APIs (USAspending / FEC / CFPB) in real time using *our* keys, server-side — so you get full results and **never need a key of your own.**

Everything else in the table is a full mirror → just read it straight from Firestore. Coverage questions → Greg, or `contact@keyvex.com`.

---

**Legend**
- **BACKFILLED** — full historical mirror in Firestore; cron keeps it topped off.
- **BOUNDED** — deliberately mirrored to a recent window (full history is a multi-million-row firehose with little signal); cron tops off.
- **REFERENCE** — complete current catalog/snapshot (small, replaced or merged each run).
- **PASSTHROUGH** — giant transaction firehose we do *not* fully mirror; serves a cached recent subset today, with live-API passthrough as the model (wiring partial/deploy-pending).
- **THIN** — known coverage gap; backfill deeper if/when we want it.

---

## 38 tools

| # | MCP tool | Collection | Status | Coverage (rows · span) |
|---|----------|-----------|--------|------------------------|
| 1 | `get_insider_transactions` | insider_transactions_v2 (served) · insider_trades (legacy) · initial_ownership_baselines (Form 3) | **BACKFILLED** | 9.9M · 2006→2026 |
| 2 | `get_institutional_holdings` | institutional_holdings (13F) | **BACKFILLED** | 802K · 2014→2026 |
| 3 | `get_congressional_trades` | congressional_trades | **BACKFILLED** | 69K · 2014→2026 |
| 4 | `get_planned_insider_sales` | planned_insider_sales (Form 144) | **BACKFILLED** | 3.5K · 2023→2026¹ |
| 5 | `get_activist_stakes` | activist_ownership (13D/G) | **BACKFILLED** | 8.5K · 2024→2026² |
| 6 | `get_private_placements` | private_placements (Form D) | **BACKFILLED** | 526K · 2016→2026 |
| 7 | `get_registration_statements` | registration_statements (S-1/S-3) | **BACKFILLED** | 115K · 2001→2026 |
| 8 | `get_tender_offers` | tender_offers (Schedule TO) | **BACKFILLED** | 45K · 2001→2026 |
| 9 | `get_material_events` | material_events (8-K) | **BACKFILLED** | 8.5K · 2020→2026 |
| 10 | `get_proxy_filings` | proxy_filings (DEF 14A) | **BACKFILLED** | 685 · 2016→2026 |
| 11 | `get_fundamentals` | xbrl_fundamentals | **BACKFILLED** | 324K · 2006→2026 |
| 12 | `get_sec_fails_to_deliver` | sec_fails_to_deliver | **BOUNDED** (3 yr) | 3.9M · 2023→2026³ |
| 13 | `get_nport_filings` | nport_filings | **BOUNDED** (2 yr) | 102K · 2024→2026³ |
| 14 | `get_fund_holdings` | nport_holdings | **BOUNDED** (1 yr) | 349K · 2025→2026³ |
| 15 | `get_lobbying_filings` | lobbying_filings (LDA) | **BACKFILLED** | 905K · 2016→2026 |
| 16 | `get_fec_independent_expenditures` | fec_independent_expenditures (Sch E) | **BACKFILLED** | 323K · 2016→2026 |
| 17 | `get_fec_candidate_profile` | fec_candidates · fec_committees | **REFERENCE** | 26K cand / 49K cmte · cycles 2016+ |
| 18 | `get_congressional_trades` ↔ profile | legislators · legislators_historical | **REFERENCE** | 536 current / 12.2K historical |
| 19 | `get_member_profile` | legislators (+ historical) | **REFERENCE** | 536 · current Congress |
| 20 | `get_lobbying_filings` (see 15) | — | — | — |
| 21 | `get_foreign_agents` | foreign_agents (FARA) | **BACKFILLED** | 1.2K · 1943→2026 |
| 22 | `get_government_publications` | gov_documents (GovInfo) | **BACKFILLED** | 1.1K · 1845→2026 |
| 23 | `get_treasury_auctions` | treasury_auctions | **BACKFILLED** | 11K · 1979→2026 |
| 24 | `get_federal_register_documents` | federal_register_documents | **BOUNDED** (10 yr) | 278K · 2016→2026³ |
| 25 | `get_product_recalls` | product_recalls (FDA+CPSC) | **BACKFILLED** | 96K · 1973→2026 |
| 26 | `get_enforcement_actions` | enforcement_actions (SEC/DOJ/CFTC/OCC/FDIC/FTC) | **BACKFILLED** | 410 · 2009→2026 |
| 27 | `get_oig_exclusions` | oig_exclusions (LEIE) | **BACKFILLED** | 83K · 1977→2026 |
| 28 | `get_ofac_sdn` | ofac_sdn | **REFERENCE** (snapshot) | 19K · current SDN list |
| 29 | `get_screening_list` | screening_list (CSL) | **REFERENCE** (snapshot) | 26K · current CSL |
| 30 | `get_economic_indicators` | economic_indicators (BLS+FRED+EIA) | **BACKFILLED** | 18K obs · multi-year series |
| 31 | `get_annual_financial_disclosures` | annual_financial_disclosures (Form 278) | **BACKFILLED** | 1.9K · 2016→2026 |
| 32 | `get_executive_trades` | executive_trades (OGE 278-T) | **BACKFILLED** | 3.3K · executive-branch |
| 33 | `get_bills` | bills | **BACKFILLED** | 16K · recent Congresses |
| 34 | `get_roll_call_votes` | roll_call_votes | **THIN** | 1.4K · 2025→2026 |
| 35 | `get_cftc_cot_reports` | cftc_cot_reports | **THIN** | 5.1K · ~90 days |
| 36 | `get_federal_contracts` | federal_contracts (USAspending) | **PASSTHROUGH** | cached 25K (live-API wiring pending) |
| 37 | `get_federal_grants` | federal_grants (USAspending) | **PASSTHROUGH** | cached 4.9K (partial live-API) |
| 38 | `get_fec_contributions` | fec_contributions (Sch A) | **PASSTHROUGH** | cached 5K of ~15.7M (partial live-API) |
| 39 | `get_consumer_complaints` | consumer_complaints (CFPB) | **PASSTHROUGH** | cached 29K of 15.7M (live-API wiring pending) |
| ★ | `unified_search` | fans out across ticker/CIK/name/cusip-keyed collections | meta-tool | one call → many collections |

¹ Form 144 mandatory-electronic since late 2022 — pre-2022 not in the feed.
² 13D/G structured-XML mandate 2024 — earlier filings are unstructured (not parsed).
³ BOUNDED by deliberate decision: full history is a firehose with little signal; window covers the useful range. Cron keeps current.

---

## Summary by status

- **BACKFILLED (full historical mirror): 23 tools** — the bulk of the surface, complete to source.
- **BOUNDED (deliberate recent window): 4** — sec_fails_to_deliver (3yr), nport_filings (2yr), nport_holdings (1yr), federal_register (10yr).
- **REFERENCE (complete current catalog/snapshot): 5** — legislators, fec candidates/committees, ofac_sdn, screening_list.
- **PASSTHROUGH (don't mirror the firehose): 4** — federal_contracts, federal_grants, fec_contributions, consumer_complaints.
- **THIN (coverage gap): 2** — roll_call_votes, cftc_cot_reports.
- **Meta: 1** — unified_search.

## Open follow-ups
- **Passthrough wiring** — make the live-API passthrough uniform across the 4 (federal_contracts + consumer_complaints are Firestore-only today; grants + fec_contributions partial). Deploy-gated.
- **THIN backfills** — roll_call_votes (Senate XML), cftc_cot_reports (decades of weekly COT) if we want depth.
- **Going-forward date-typo correction** in form4.ts (cron path) — low-urgency mirror of the FEC/insider cleanup already applied to stored data.
