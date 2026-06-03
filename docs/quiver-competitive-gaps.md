# Quiver Quantitative — Competitive Gap Tracker

**Purpose:** running list of what Quiver does that KeyVex doesn't (and vice-versa), so we
can decide what's worth closing vs. deliberately skipping.

**Method:** seeded 2026-06-03 from a read of Quiver's **Trader-tier Datasets menu** +
live KeyVex MCP checks. Depth/coverage of each Quiver dataset to be **confirmed via the
Quiver API** (Trader tier) — menu names alone don't tell us how deep each goes.

**Categories:**
- **CLOSE** — a real public-disclosure gap KeyVex could/should close.
- **MAYBE** — in-vertical and buildable, but needs a value/effort call.
- **POSTURE** — deliberately NOT doing it (pure-publisher: no derived signals/scores/strategies).
- **OUT-OF-SCOPE** — alt-data outside KeyVex's federal-public-disclosure vertical.
- **PRODUCT** — a product-form difference (UI vs. agent-native MCP), not a data gap.

---

## Quiver HAS — KeyVex DOESN'T

| Quiver dataset | KeyVex status | Category | Notes |
|---|---|---|---|
| **Donald Trump Stock Trades** | **NOT live** (verified 0 on prod 2026-06-03) | **CLOSE** | President/VP 278-T. Deferred to Track B (OCR — their PDFs have a corrupted text layer). This is Quiver's headline draw; closing it is the #1 disclosure gap. KeyVex *does* have Cabinet/appointee 278-T (Bessent, Lutnick, Burgum, Austin) which Quiver lacks → complementary today. |
| Patents | none | MAYBE | USPTO is public-record, arguably in-vertical (was on the roadmap). Buildable. |
| Revenue Breakdowns | partial (XBRL has data, not productized) | MAYBE | Segment revenue. KeyVex has raw XBRL; doesn't expose a segment-breakdown view. |
| Risk Factors | none | MAYBE | 10-K risk-factor text extraction. KeyVex has filings metadata, not parsed risk text. |
| Stock Splits | none | MAYBE | Corporate action; derivable from filings. Low value? |
| DC Insider Score | none | POSTURE | Derived score — pure-publisher posture says no. |
| Behind The Curtain | none | POSTURE | Derived analysis. |
| Strategies (backtested portfolios) | none | POSTURE | Derived/backtested signals — deliberate non-goal. |
| Analyst Ratings | none | OUT-OF-SCOPE | Sell-side alt-data. |
| CNBC Stock Picks | none | OUT-OF-SCOPE | Media alt-data. |
| Jim Cramer Tracker | none | OUT-OF-SCOPE | Media alt-data. |
| App Ratings | none | OUT-OF-SCOPE | Consumer alt-data. |
| Google Trends | none | OUT-OF-SCOPE | Search alt-data. |
| Retail web UI / watchlists / email alerts / Premium articles | none (MCP only) | PRODUCT | KeyVex is agent-native infra, no consumer UI. Different buyer. |

## KeyVex HAS — Quiver DOESN'T (no matching dataset in their menu)

- **Executive-branch Cabinet/appointee 278-T** (Bessent, Lutnick, Burgum, Austin…) — Quiver has *Trump* but no general Cabinet trades.
- **Sanctions & screening:** OFAC SDN, Consolidated Screening List.
- **FARA** (foreign-agent registrations).
- **Enforcement** across 6 regulators (SEC/DOJ/CFTC/OCC/FDIC/FTC).
- **Full SEC ownership-form suite:** Form 144 (planned sales), Form 3 (baselines), 13D/G (activist), Form D (private placements), S-1/S-3 (registrations), tender offers, N-PORT (fund holdings).
- **Markets/macro:** Treasury auctions, CFTC Commitments of Traders, SEC fails-to-deliver, BLS/FRED/EIA indicators, XBRL fundamentals.
- **Compliance/consumer:** HHS-OIG exclusions, CFPB complaints, FDA/CPSC recalls.
- **Reference/regulatory:** Federal Register, GovInfo publications.
- **`unified_search` federation** (one identifier → 12+ collections in one call).
- **Agent-native MCP delivery** + source-faithful provenance URL on every record.

## To confirm via Quiver API (don't trust the menu alone)

- [ ] Congress Trading — fields, history depth, freshness vs. KeyVex `get_congressional_trades`.
- [ ] "Donald Trump Stock Trades" — exactly what it covers (just Trump? other execs?), so it scopes Track B.
- [ ] Insider / Institutional / ETF Holdings — depth vs. KeyVex Form 4 / 13F / N-PORT.
- [ ] Gov Contracts / Lobbying / Election contributions — coverage vs. KeyVex equivalents.
- [ ] Whether any Quiver dataset is raw-disclosure (CLOSE-able) vs. derived (POSTURE — skip).

## ⚠️ 2026-06-03 — Quiver shipped an MCP server

Confirmed from their API portal nav (`api.quiverquant.com` → "MCP Server"). Web search
didn't surface its docs (only Quiver's PR *about other* companies' MCP launches), so the
tool list / coverage is **TBD — read their MCP Server page directly**.

**Strategic impact (tell it straight):** "agent-native MCP" is **no longer a KeyVex
differentiator** — the protocol is now table stakes on both sides. KeyVex's moat moves to
*what's behind* the protocol:
- **Breadth of federal public-disclosure** Quiver has no dataset for (OFAC/CSL sanctions,
  FARA, 6-regulator enforcement, the full SEC ownership-form suite, Treasury, CFTC COT,
  SEC FTD, HHS-OIG, CFPB, recalls, Federal Register, GovInfo).
- **`unified_search` federation** (one identifier → 12+ collections in one call) — confirm
  whether Quiver's MCP federates or is per-dataset tools.
- **Pure-publisher / source-faithful + provenance URLs** vs. Quiver's derived-signal layer
  (their congress rows already carry ExcessReturn/PriceChange/SPYChange).

**To capture:** read Quiver's "MCP Server" page — tool count, which datasets it exposes,
auth model, whether it federates. Then re-score every row above for "does their MCP expose
this too?"

**Pricing/access gate (verified 2026-06-03):** Quiver's **API + MCP sit behind a separate
paid add-on — $75/mo month-to-month (or $62.50/mo ≈ $750/yr on an annual commit), on top
of the Trader web tier**, on a distinct portal
(`api.quiverquant.com`) that doesn't even accept the main site's Google sign-in. So an AI
agent can only reach Quiver's data through a **premium, password-gated** subscription.
→ **KeyVex positioning edge:** KeyVex's MCP is **authless/open in preview** — any agent can
query `mcp.keyvex.com` today, no account, no key, no paywall. "Agent access is open" vs.
"agent access is a $60+/mo premium gate" is a real differentiator even now that both have MCP.

## Open question

- **Trump "fix":** Greg recalls Trump trades were fixed "yesterday," but prod returns 0 for
  trump/donald in `executive_trades`. Locate where any Trump ingestion landed (branch /
  collection / different session) — grep codebase + query Firestore. Until then: NOT live.
