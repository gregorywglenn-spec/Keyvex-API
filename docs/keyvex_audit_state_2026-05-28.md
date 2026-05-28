# KeyVex Audit State — 2026-05-28

Dated session snapshot. Successor sessions create `keyvex_audit_state_YYYY-MM-DD.md`
and this file becomes historical record — do not overwrite. Audit-trail voice;
provenance is marked per item (firsthand this session vs. carried forward from the
2026-05-28 Director audit).

---

## 1. Production HEAD + what was last deployed

**Live endpoint:** `https://mcp.keyvex.com/` — health check returns
`version: 0.52.1`, `tools: 38`, `status: ok`, `auth: none` (verified firsthand
this session via GET /).

**Git state at session close:**
- `origin/main` = `01ccac3` ("Catch main up to feature branch f433759 …").
- Local `main` is **ahead of origin by 4 commits, unpushed** (5 once the
  inheritance-docs commit lands). Push is held for Greg's explicit authorization
  as one coherent batch.

**The unpushed commits (oldest → newest):**

| Commit | What it did | Deployed? |
|---|---|---|
| `378f146` | docs(handoff): Phase 2b deploy carryover + CLAUDE.md staleness flag | doc only |
| `6e16fc4` | firestore: reconcile indexes file to production (250) + 2 congressional_trades indexes (DESC twins) | ✅ `firebase deploy --only firestore:indexes` |
| `24cf234` | firestore: ASC-twin indexes for bioguide+ticker+transaction_type combos | ✅ `firebase deploy --only firestore:indexes` |
| `22f9e93` | tools: `destructiveHint: false` on all 38 read-only tools (§5.E) | ✅ `firebase deploy --only functions:mcp` |

**Important provenance note for successors:** production was deployed from the
local working tree, so **production is currently AHEAD of `origin/main`.** The
254-index Firestore state and the v0.52.1 / 38-tool / destructiveHint MCP function
are live in production but their source commits are not yet on origin. Pushing the
batch reconciles git with what is already deployed. Until the push lands, do not
assume `origin/main` reflects production.

**Firestore composite indexes:** 254 deployed (verified firsthand via Firestore
Admin API). The file `firestore.indexes.json` is now a verbatim mirror of
production + the session's additions (see §3 drift finding).

---

## 2. May 25 failure scorecard — status as of 2026-05-28

Items 1–6 carried forward from the 2026-05-28 Director live-MCP audit (not
re-verified firsthand this session unless noted). Item 7 added + verified
firsthand this session.

| # | May 25 failure | 2026-05-28 status | Provenance |
|---|---|---|---|
| 1 | OFAC `ent_num` desc sort capped at 11,598 of 26,503 | ✅ Fixed — top result 57,795, descending correct | Director audit |
| 2 | Lobbying income-sort + quarter/code filter → INDEX_MISSING | ✅ Fixed — 10 records, income-sorted, has_more:true | Director audit |
| 3 | Wells Fargo CFPB 90-day silent empty | ✅ Fixed + upgraded — empty now carries explicit coverage_warning naming the exact window | Director audit + **firsthand reconfirmed** (see Example 3) |
| 4 | Planned sales date+value sort INDEX_MISSING w/ leaked project name | ✅ Fixed — clean INVALID_QUERY explains structural issue + workarounds | Director audit |
| 5 | WFC institutional_holdings 0 results (broken ticker→CUSIP join) | ✅ Join fixed — 3 holders surface (Vanguard $27.6B, BlackRock $15B + $20.7B). Ingestion DEPTH (only 3 vs hundreds known) is a separate open item, not a code bug | Director audit |
| 6 | OFAC missing designation_date (structural) | 🟡 Honestly documented as v1.1 in tool description; query still structurally impossible but no longer pretends otherwise | Director audit |
| 7 | Congressional INDEX_MISSING on bioguide+ticker+transaction_type+date sort (Example 1 demo) | ✅ Fixed — 4 new composite indexes (DESC + ASC twins, both date fields); all four sort_by × sort_order combinations now serve | **firsthand this session** |

**Bonus observation (Director audit):** recent 13F filings now carry a
`verification_status: "VERIFIED"` field with `verification_expected` /
`verification_actual` matching — a post-May-25 honesty-layer addition. Deployment
breadth across collections not yet mapped.

---

## 3. New findings this session (2026-05-28)

Firsthand unless noted.

**a. Firestore index file/deployed drift (firsthand; RESOLVED this session).**
`firestore.indexes.json` declared 201 composite indexes while production had 250
deployed — 49 had drifted in via console "create index" URLs (which the honest
`INDEX_MISSING` errors hand out) and the Day-10 parallel-worktree divergence.
Resolved by regenerating the file as a verbatim mirror of `firebase
firestore:indexes` output (stripping implicit `__name__` field entries + the
`density` key) so deploys are purely additive. Discipline note added to CLAUDE.md
Hard Lessons in `6e16fc4`. **Operational rule going forward: index changes go
through the file + `firebase deploy`, never the console URL.**

**b. Sort-direction index requirement (firsthand).** The reverse-index
optimization (one index serving both sort directions when leading fields are
equality-pinned) does NOT apply when the query carries a range filter
(`since`/`until`) on the orderBy field — Firestore then requires an index whose
direction matches the orderBy direction. This is why Example 1 needed an explicit
`transaction_date ASCENDING` twin even though a DESC index existed. Prior Phase-A
work already hit this for ticker-prefixed shapes (explicit ASC variants exist in
production). Any future congressional_trades query with `sort_order:asc` + date
range needs an ASC-direction index.

**c. PDF parser bleed on House Clerk PTRs (carried forward — Director audit).**
Filer commentary contaminating the `asset_name` field; surfaced on Torres (NY15)
and Whitesides (CA27) records in the TXN probe. Scope across collections not yet
mapped. Goal 1 concern (§2.B description-vs-behavior) and Goal 2 concern (clean
data for subscribers). **Director-accepted as next priority after the submission
package ships.**

**d. Member-lookup completeness for departed members (carried forward).** Empty
`bioguide_id` on a John Curtis 2023 record (Curtis left Congress in 2023).
Coverage-completeness item, not a silent-failure item. Backfill or document the gap.

**e. Phase A retroactive classification policy (carried forward).** The
`transaction_nature` field is present only on records ingested Phase A v0.52.0
onward (May 2026+); older rows are unclassified. Honest annotation already exists
(`include_non_open_market` default behavior), so this is a uniformity-polish item,
not a critical gap. Decide: backfill historical rows or document the cutoff.

**f. federal_contracts coverage scope (firsthand reconfirmed; see Example 2).**
The collection holds a rolling ~7-day window of recently-modified contract actions.
Historical mega-contracts without a recent modification are absent regardless of
size. The cross-source "congressional trades meets historical federal contracts"
ambition is structurally limited on the contracts side. The tool returns an honest
`coverage_warning` and points to usaspending.gov. **Resolution path: Option A1
(scheduled recipient-backfill mode) — see §6.** A0 (pre-backfilling only demo
recipients) was considered and **rejected** (creates a coverage asymmetry a
subscriber can't see — a data-honesty violation).

---

## 4. Worry-list status (Greg's frame; carried forward from Director audit)

- ~~Form 4 data empty~~ — RESOLVED (bulk download; verified via Sara Jacobs probe + broad query).
- ~~Congressional trades missing lots of data~~ — REFUTED volumetrically (AMD probe 50 records / 12 members / 28-month coverage; TXN probe 50 records / 14 members / 31-month coverage).
- **Scraper health** — partially resolved. Verified working: Form 4 ✓, House PTR ✓, Senate eFD ✓, OFAC ✓, lobbying ✓, planned insider sales ✓, institutional holdings (join ✓, coverage depth = open item), CFPB (rolling window ✓, documented honestly), federal_contracts (rolling window ✓, documented honestly, depth = §6 A1). Remaining ~25 collections untested; the 7-axis sweep was designed for that systematic verification.

---

## 5. Standing locks (carry forward UNCHANGED)

- **Phase B / `heal-worker.ts`** — LOCKED. Code in production but INERT.
- **Backfill / reconstruction** — permanently CLOSED.
- **Axis-7 Issue B** (5,000-cap, 30 sites) — PARKED for the B3 tokenized-index architectural pass.
- **Re-ingest** — NOT authorized.
- **CIK swap** — NOT authorized.
- **Orphan cleanup** — NOT authorized.

---

## 6. Open items ranked against the dual goal

Dual goal: (1) Anthropic Connectors Directory submission; (2) consumer-ready
retail launch. See `keyvex_anthropic_submission_bar.md` for the per-requirement
policy mapping.

**Closed this session:**
- §5.E annotations — `destructiveHint: false` on all 38 tools, verified on the live wire (38/38). DONE.
- §3.E three working examples — locked + live-verified; source of truth in `keyvex_three_working_examples.md`. DONE.
- Example 1 composite-index gap — DONE (4 new indexes).
- Index file/deployed drift — DONE (reconciled).

**Hard blockers (gate submission):** see submission_bar; none introduced this session.

**Soft blockers / audit follow-ups (ranked):**
1. **PDF parser bleed on House PTRs** (finding c) — Director-designated next priority after submission package. Goal 1 + Goal 2.
2. **federal_contracts A1 — scheduled recipient-backfill mode.** The `scrapeContractsByRecipient` scraper already exists (`src/scrapers/usaspending.ts`) and is wired to a save-capable CLI (`usaspending <RECIPIENT> [days] --save`). What's missing for autonomous coverage: a watchlist + scheduled Cloud Function + raise the 1000-record page cap. Est. ~0.5–1 day. **Constraint: the `mcp` function runs as a read-only service account, so backfill CANNOT be triggered from the MCP request path — it must run in a write-capable scheduled/CLI context.** Build before any marketing copy leans on the federal_contracts cross-source claim.
3. **Member-lookup gap for departed members** (finding d) — coverage-completeness polish.
4. **Phase A retro classification uniformity** (finding e) — polish.

**Deferred / rejected:**
- Sibling index `ticker+transaction_type+transaction_date` (no bioguide) — held pending Example 2 reframed wording.
- A0 demo-recipient pre-backfill — rejected (data-honesty asymmetry).

---

## 7. Build-time data point — Firestore composite-index builds on `congressional_trades`

**Observed this session: composite-index builds on `congressional_trades` take ~15–20 minutes, NOT the 2–5 minutes Firebase docs imply.**

Evidence:
- Round 1 (DESC twins, `6e16fc4`): still `INDEX_MISSING` when probed at +3, +7, +12 minutes after deploy. Exact completion not measured.
- Round 2 (ASC twins, `24cf234`): deploy/build start ~21:13 UTC; first successful live-MCP query at ~21:29 UTC ≈ **16 minutes**.

`congressional_trades` is a mid-tens-of-thousands-of-rows collection, which is the
likely driver. **Operational implication for successors: don't probe a new
congressional_trades index before ~15 minutes; plan verification windows
accordingly.** Index build state is observable via the Firestore Admin API
(`collectionGroups/<group>/indexes`, `state` field = CREATING / READY / NEEDS_REPAIR)
— the `firebase firestore:indexes` CLI listing does NOT include `state`; mint a
bearer via `src/firebase-rest.ts token` and call the Admin API directly.

---

## Verification primitives (for re-confirmation by successors)

- Live health: `curl https://mcp.keyvex.com/` → version/tools/status.
- Deployed index count: `firebase firestore:indexes` → 254 collectionGroup entries.
- Index build state: Admin API `…/collectionGroups/congressional_trades/indexes`, `state` field.
- Authless tool calls: POST JSON-RPC `tools/call` to `https://mcp.keyvex.com/` with `Accept: application/json, text/event-stream` (response is SSE; parse the `data:` line).
