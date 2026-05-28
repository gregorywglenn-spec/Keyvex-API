# KeyVex — Three Working Examples (Submission Package Source of Truth)

Satisfies Anthropic Software Directory Policy §3.E: *"Developers must provide at
least three working examples of prompts or use cases that demonstrate core
functionality."*

All three were locked and **verified firsthand against the live authless endpoint**
`https://mcp.keyvex.com/` on 2026-05-28 (POST JSON-RPC `tools/call`, SSE response).
Each example records the locked prompt, the exact tool call(s), the verified
response shape, why it demonstrates core functionality, and how to re-verify it.

Note on stability: Example 1 is built on historical filings and is stable. Examples
2 and 3 exercise rolling-window collections, so exact counts/dates drift with daily
ingestion — the **demonstrated behavior** is the stable claim, not the specific
numbers. Each example's verification protocol says which is which.

---

## Example 1 — Single-source depth + audit-grade provenance

**Locked prompt:**
> "What did Senator Markwayne Mullin sell from his Texas Instruments position in 2025? I want to see each sale with the source filing, in chronological order."

**Tool call:**
```json
get_congressional_trades({
  "bioguide_id": "M001190",
  "ticker": "TXN",
  "transaction_type": "sell",
  "since": "2025-01-01",
  "until": "2025-12-31",
  "sort_by": "transaction_date",
  "sort_order": "asc"
})
```

**Verified response (2026-05-28):** `count: 2`, `has_more: false`, no coverage_warning. Two records, chronological by `transaction_date`:

| transaction_date | ticker | type | amount | owner | chamber | source filing |
|---|---|---|---|---|---|---|
| 2025-04-08 | TXN | sell | $15,001 – $50,000 | Joint | senate | efdsearch.senate.gov/search/view/ptr/c658a976-635f-4d9d-9254-8594ae0ad310/ |
| 2025-09-24 | TXN | sell | $15,001 – $50,000 | Joint | senate | efdsearch.senate.gov/search/view/ptr/f53ff465-1c6b-4a71-82b6-a7245a6a53b1/ |

Both records carry full provenance: `report_url` to the authoritative Senate eFD
filing, plus `bioguide_id: M001190`, `party: Republican`, `state: OK`, `owner: Joint`,
`chamber: senate`.

**Why this demonstrates core functionality (§3.E):** Demonstrates audit-grade
provenance — every record traces to its authoritative source filing URL at
efdsearch.senate.gov, so a subscriber can verify KeyVex's data against the
government record of truth. It also demonstrates that the query surface supports
natural subscriber phrasings end-to-end: filtering by member + ticker + direction +
year and returning results in chronological order (`sort_order: asc`) all serve
against indexed queries.

**Verification protocol:** Re-run the exact call above. Expect the same 2 historical
records in the same chronological order with intact `report_url` provenance. These
are settled 2025 filings — if the count or records change, investigate (possible
re-scrape side effect or data regression). This query depends on the composite
index `bioguide_id ASC + ticker ASC + transaction_type ASC + transaction_date ASCENDING`
(deployed 2026-05-28, commit `24cf234`); an `INDEX_MISSING` here means an index
regression.

---

## Example 2 — Cross-source synthesis with honest coverage

**Locked prompt:**
> "Show me defense committee members who traded any defense stock in the past 30 days, alongside any $100M+ defense contracts modified in the past 7 days."

**Tool calls (multi-step; agent composes):**
```json
// 1. Defense-committee rosters
get_member_profile({ "committee_id": "HSAS" })   // House Armed Services
get_member_profile({ "committee_id": "SSAS" })   // Senate Armed Services

// 2. Congressional trades, past 30 days, all members
get_congressional_trades({
  "since": "2026-04-28",
  "limit": 500,
  "sort_by": "disclosure_date",
  "sort_order": "desc"
})

// 3. DoD $100M+ contracts, past 7 days
get_federal_contracts({
  "awarding_agency": "Department of Defense",
  "min_amount": 100000000,
  "since": "2026-05-21"
})

// 4. Client-side: intersect trade records' bioguide_id against the roster
```

**Verified response (2026-05-28; counts illustrative — drift with daily ingestion):**
- **Rosters:** HSAS 50 members, SSAS 27 members → **77 unique bioguides** (union).
- **Trades (past 30 days):** 329 total; **112 by defense-committee members** across 7 members — Gilbert Cisneros (94), William R. Keating (8), John McGuire (3), Gary C. Peters (3), Sara Jacobs (2), Richard McCormick (1), M. Michael Rounds (1). Tickers traded by those members include defense-relevant names (QCOM, NVDA, MSFT, PLTR, AMD, IBM, AMZN) among a broader set. *(The precise "how many touch defense names" count depends on a client-side ticker-set definition, which is an analytic choice on the agent side, not a KeyVex output.)*
- **DoD $100M+ contracts (past 7 days):** **0 results** plus an explicit `coverage_warning`:
  > "Coverage note: federal_contracts holds a rolling slice of recently-modified contract actions (scraper runs daily on a 7-day action_date window via USAspending API). Historical multi-year mega-contracts that haven't had a recent modification will NOT be in this collection regardless of recipient size … For full historical coverage of a recipient or program, use the USAspending advanced search at https://www.usaspending.gov/search. v1.1 will add a recipient-backfill mode."
- **Cross-reference:** honestly empty — no overlap in this window between recently-modified DoD contract recipients and tickers traded by committee members.

**Why this demonstrates core functionality (§3.E):** Demonstrates genuine
cross-source federation across two independent government sources — STOCK Act PTRs
(`get_congressional_trades`) joined to a curated committee roster
(`get_member_profile`) joined to USAspending contract awards
(`get_federal_contracts`). It also demonstrates the data-honesty layer: when one
collection's coverage scope cannot support the question's full ambition, KeyVex
states the limit explicitly via `coverage_warning` and points to the authoritative
source rather than fabricating depth. The honest empty result IS the differentiator.

**Verification protocol:** The *behavior* is the stable claim, not the counts. Re-run
and confirm: (a) both `get_member_profile` calls return non-empty rosters;
(b) `get_congressional_trades` returns a populated 30-day window with a non-zero
subset attributable to roster bioguides; (c) `get_federal_contracts` with the
`min_amount`/`since` filters returns its `coverage_warning` (0 results is acceptable
and expected given the rolling window). Exact counts (329 / 112 / per-member) will
drift — do not treat a count change as failure. **If federal_contracts A1
(recipient-backfill mode) ships, this example can be reframed to the original
ambition** ("…before Lockheed received a $100M+ contract"); until then this
coverage-honest framing is the locked version.

---

## Example 3 — Coverage-honest empty result

**Locked prompt:**
> "Show me consumer complaints filed against Wells Fargo in the past 90 days, sorted by recency."

**Tool call:**
```json
get_consumer_complaints({
  "company": "wells fargo",
  "since": "2026-02-27",          // ~90 days before today
  "sort_by": "date_received",
  "sort_order": "desc"
})
```

**Verified response (2026-05-28):** `count: 0`, `has_more: false`, plus `coverage_warning`:
> "Returned 0 results in the requested range (since 2026-02-27); this collection currently holds 2026-05-10 to 2026-05-27. The requested window extends beyond the collection's coverage on the older side. Widen the range, omit the date filter, or email contact@keyvex.com for exact coverage info."

**Why this demonstrates core functionality (§3.E):** The most direct demonstration
of the data-honesty differentiator. Rather than returning a bare empty array (which
a subscriber could mistake for "Wells Fargo has no complaints"), KeyVex names the
collection's actual coverage window (both bounds), restates what was asked vs. what
is available, offers concrete next steps, and gives a contact path. Empty results
carry signal, not silence.

**Verification protocol:** The *behavior* is the stable claim. Re-run with `since`
set ~90 days before the current date and confirm: a 0-result (or small-result)
response that carries a `coverage_warning` naming the collection's current window
with both bounds. The window dates ARE dynamic — `consumer_complaints` is a
rolling-window collection refreshed by a daily scraper, so the exact "holds X to Y"
bounds shift over time. A failure is the *absence* of the coverage_warning on an
out-of-window empty result (that would be the May-25 silent-empty regression), not a
change in the dates.

---

## Cross-cutting notes for the submission

- All three run against the **authless** public endpoint (`auth: "none"`), consistent with the Anthropic Directory `none` auth type — no credential setup needed for a reviewer to reproduce.
- All tools involved are annotated `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true` (verified on the live wire 2026-05-28, 38/38 tools).
- The three examples deliberately span the product's range: single-source depth (1), multi-source federation (2), and coverage-honest empty (3) — and two of the three foreground the data-honesty posture that is KeyVex's stated differentiator.
