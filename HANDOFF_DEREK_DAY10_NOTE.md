# Day 10 update note for Derek

**Subject:** KeyVex Day 10 scrapers — 5 new + 2 enhancements (May 14, 2026)

Derek,

Pushed Day 10 additions to `gregorywglenn-spec/Keyvex-API`. Full catalog is in `HANDOFF_DEREK_SCRAPERS.md` (updated through Day 10 — 24 scrapers now). Commit: `af93807`.

## 5 new scrapers — port these:

| # | Scraper | Source | Cadence | Collection |
|---|---|---|---|---|
| 20 | FEC Schedule A (contributions) | api.open.fec.gov | Daily 7:30 AM | `fec_contributions` |
| 21 | FEC Schedule E (super PAC ads) | api.open.fec.gov | Daily 7:45 AM | `fec_independent_expenditures` |
| 22 | USAspending Grants | api.usaspending.gov | Daily 6:12 AM | `federal_grants` |
| 23 | CFTC Commitments of Traders | publicreporting.cftc.gov | Weekly Sat 7 AM | `cftc_cot_reports` |
| 24 | SEC Fails-to-Deliver | sec.gov bi-monthly zips | 1st + 16th 5 AM | `sec_fails_to_deliver` |

## 2 enhancements on existing scrapers:

- `enforcement-actions.ts` — added **FTC** as 6th source (`ftc.gov/feeds/press-release.xml`, RSS, no auth)
- `congress-legislation.ts` — added **Senate** roll-call votes via senate.gov XML (api.congress.gov has no Senate vote endpoint, confirmed 404)

## Hard Lessons your Claude needs before porting (saved your team 2-4 hrs of debug)

1. **FEC Schedule A/E silently ignores `page=N` pagination** past ~10K rows — uses cursor pagination via `last_index` + `last_<sort_field>` from `pagination.last_indexes`. Without this you'll get the same first 100 rows N times with no error.
2. **`link_id` is filing-level, not row-level** — use `sub_id` for FEC contribution doc IDs. Using `link_id` collapses entire filings into one Firestore doc.
3. **SEC FTD posting lag is 2-3 weeks, not 1 week** — bake auto-fallback that walks backward up to 6 half-months on 404 until a published file is found.
4. **Senate `vote_date` is `DD-MMM` with no year** — parse + assemble using parent `<congress_year>`.
5. **CFTC field-name typos are official** — `noncomm_postions_spread_all` (missing 'i') and `change_in_noncomm_spead_all` (missing 'r') are CFTC's actual field names. Don't fix in raw normalization.

## 3 audit gaps flagged for v1.1 (NOT shipped — heads up if you want to take any)

- **Form 4 derivative table not ingested** (option exercises silently dropped, ~2-3 hr lift)
- **N-PORT primary-doc XML not parsed** (per-holding derivatives invisible, ~2-3 hr lift)
- **CBOE put/call deferred** (Cloudflare 403s; real options chains require paid OPRA license — not feasible without revenue)

## Other notes

- **New dep on KeyVex side:** `adm-zip` (for SEC FTD bi-monthly zip parsing). Add to dashboard if porting FTD.
- **Closes the political-alpha loop** with the FEC trio: donations → trades → votes → contracts → enforcement. 33 MCP tools at `mcp.keyvex.com` v0.42.0 now. Battle-tested green (live wire 13/13 + local 101/105).
- **Backfill volumes seeded:**
  - FEC Schedule A: 5,000 rows (180-day, $2.5K+, cycle 2026)
  - FEC Schedule E: 1,000 rows
  - USAspending grants: 167 rows (7-day window)
  - CFTC COT: 1,106 rows (4 weeks)
  - SEC FTD: 49,844 rows (April 2026 first-half alone)

— Greg
