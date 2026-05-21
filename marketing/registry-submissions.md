# KeyVex Distribution Playbook — Where to List

**Status (2026-05-16):** KeyVex is at **v0.44.0 — 38 MCP tools** live at `https://mcp.keyvex.com`.
Strategy is **list everywhere KeyVex can plausibly fit**, in parallel. Each listing is a free
inbound funnel — bounded engineering cost, uncapped upside.

**Verify the live state before submitting anything:** `curl https://mcp.keyvex.com` returns the
authoritative `version` + `tools` count + `tool_names` array. Every number in this doc must match
that response. As of 2026-05-16 it returns `version: 0.44.0`, `tools: 38`.

---

## ⚠️ Two things changed since the last version of this doc — read first

1. **The Anthropic submission is NOT a GitHub PR.** It is a **Google Form** (the "MCP Directory
   Server Review Form"). The old `anthropics/mcp-servers` PR path no longer applies. Remote MCP
   servers submit via `https://clau.de/mcp-directory-submission`.

2. **Two prerequisites the earlier doc marked "complete" were not:**
   - **Tool annotations** — Anthropic requires every tool to carry a `title` plus a
     `readOnlyHint`/`destructiveHint` annotation. ✅ **Fixed 2026-05-16** — all 38 KeyVex tools
     now carry `annotations: { title, readOnlyHint: true, openWorldHint: true }` (all KeyVex
     tools are read-only — pure-publisher posture).
   - **Authentication** — Anthropic's directory requires **OAuth 2.0 with a user-consent flow**
     for authenticated connectors. KeyVex's MCP endpoint currently uses a **single static shared
     Bearer token** (`MCP_API_KEY`). A pre-shared static key does not satisfy the OAuth
     requirement. ⛔ **This is an open blocker for the Anthropic directory only.** See A1 below.

---

## Prerequisite status

| Prereq | Status | Notes |
|---|---|---|
| `mcp.keyvex.com` live + TLS | ✅ | Auto-managed Let's Encrypt cert |
| `keyvex.com` apex + `www` live | ✅ | |
| GitHub repo `gregorywglenn-spec/Keyvex-API` | ✅ | |
| README polished for current tool count | 🟡 | Verify it says 38 tools before submitting |
| `contact@keyvex.com` operational | ✅ | Gmail forward |
| Privacy Policy at `keyvex.com/privacy` | ✅ | |
| Health check returns version + 38 tools | ✅ | `curl https://mcp.keyvex.com` |
| **Tool annotations** (`title` + `readOnlyHint`) | ✅ | All 38 tools — fixed 2026-05-16 |
| **OAuth 2.0 auth** (Anthropic directory only) | ⛔ | KeyVex uses static Bearer token — see A1 |
| GIF / screenshot of a real tool call | 🟡 | Nice-to-have for every venue |

---

## Recommended submission order

The earlier doc said "Anthropic first because it has the longest queue." That logic is **inverted**
— Anthropic has the *highest bar* of the four MCP registries (OAuth + annotations + manual review).
The other three accept Bearer-token auth today.

| Order | Venue | Blocked on | Action |
|---|---|---|---|
| 1 | Smithery | nothing | Submit now (web form) |
| 2 | Awesome-MCP | nothing | Submit now (GitHub PR) |
| 3 | PulseMCP | nothing | Submit now (web form) — may auto-discover us once 1+2 land |
| 4 | Anthropic Directory | OAuth 2.0 | Defer until OAuth flow is built (pairs with Stripe / per-customer-key work) |

---

# PART A — MCP-native registries (paperwork only)

Canonical metadata — **reuse verbatim across all venues** so listings stay consistent.

**Short description:**
> KeyVex is the MCP server for US public financial and government disclosures — 38 read-only
> tools spanning SEC EDGAR filings, congressional trades, FEC campaign finance, federal contracts
> and grants, lobbying, regulatory enforcement, sanctions screening, company fundamentals (XBRL),
> and macroeconomic indicators. Built agent-native: entity-based tools with rich filters, one
> Bearer-authenticated Streamable HTTP endpoint, and a unified cross-source search. Pure-publisher
> posture — clean, normalized public-record data; no derived signals or investment advice.

**Tags:** `finance`, `sec-edgar`, `congress`, `insider-trading`, `lobbying`, `campaign-finance`,
`government-data`, `agent-tools`, `enforcement`, `sanctions`, `fundamentals`, `dark-pool`

**Canonical URLs:**
- MCP endpoint: `https://mcp.keyvex.com`
- Homepage: `https://keyvex.com`
- Docs: `https://github.com/gregorywglenn-spec/Keyvex-API#readme`
- Privacy policy: `https://keyvex.com/privacy`
- Contact: `contact@keyvex.com`
- Source repo: `https://github.com/gregorywglenn-spec/Keyvex-API`

**The 38 tools** (paste from the live health check — do not hand-maintain this list):
```
get_insider_transactions          get_nport_filings
get_institutional_holdings        get_fund_holdings
get_congressional_trades          get_registration_statements
get_planned_insider_sales         get_sec_fails_to_deliver
get_activist_stakes               get_ofac_sdn
get_federal_contracts             get_federal_register_documents
get_federal_grants                get_proxy_filings
get_member_profile                get_treasury_auctions
get_material_events               get_economic_indicators
get_lobbying_filings              get_cftc_cot_reports
get_annual_financial_disclosures  get_oig_exclusions
get_fec_candidate_profile         get_consumer_complaints
get_fec_contributions             get_fundamentals
get_fec_independent_expenditures  get_government_publications
get_tender_offers                 get_foreign_agents
get_bills                         get_screening_list
get_roll_call_votes               unified_search
get_otc_market_weekly
get_private_placements
get_product_recalls
get_enforcement_actions
```

---

## A1. Anthropic Connectors Directory — DEFERRED (blocked on OAuth)

**What it is:** First-party registry powering Claude's "Connectors" UI. Highest legitimacy signal.

**Submission mechanism (current as of 2026-05-16):**
- Remote MCP servers → MCP Directory Server Review Form at **`https://clau.de/mcp-directory-submission`**
- Desktop extensions (MCPB bundles) → `https://clau.de/desktop-extention-submission`
- Firewall-access issues → email `mcp-review@anthropic.com`
- Review is **manual, ~2 weeks**.

**Hard requirements:**
1. **Tool annotations** — every tool needs `title` + `readOnlyHint`/`destructiveHint`.
   ✅ Done (all 38 KeyVex tools, 2026-05-16). Missing annotations cause ~30% of rejections.
2. **Transport** — Streamable HTTP over HTTPS. ✅ KeyVex has this.
3. **Authentication** — **OAuth 2.0 with user-consent flow.** Pure machine-to-machine /
   pre-shared-key auth is not accepted. ⛔ **KeyVex uses a static shared Bearer token.**
4. Test account credentials, server logo + favicon, branding assets, privacy-policy link,
   completed compliance checklist.

**Why deferred:** Building an OAuth 2.0 authorization server with a user-consent flow is real
multi-day engineering — and it is the *same* identity/metering layer needed for per-customer API
keys + Stripe billing (already a deferred open item, gated on LLC + Stripe setup). Building a
throwaway OAuth flow now and rebuilding it when billing lands is duplicated work. The right
sequence: build OAuth **together with** the billing layer — one job, done once — **then** submit
to Anthropic. The other three registries do not require OAuth and should go out now.

**When unblocked, the form will need:** the canonical metadata above, the 38-tool inventory with
annotations confirmed, a reviewer test account + a couple of example prompts that show KeyVex's
core value (the `unified_search` cross-source query is the best demo), logo + favicon, and the
`keyvex.com/privacy` link.

---

## A2. Smithery (https://smithery.ai)

**What it is:** Third-party MCP registry popular with indie agent builders. Faster approval,
broader experimental reach. **Accepts Bearer-token auth — no OAuth requirement.**

**Submission:** Web form on smithery.ai. Some listings auto-approved; others manual review,
1–3 business days.

### Form fields

| Field | Value |
|---|---|
| Server name | `keyvex` |
| Display name | `KeyVex` |
| Short description | (canonical short description above) |
| Category | `Finance` or `Government Data` (whichever exists in their taxonomy) |
| URL | `https://mcp.keyvex.com` |
| Homepage | `https://keyvex.com` |
| Documentation | `https://github.com/gregorywglenn-spec/Keyvex-API#readme` |
| Authentication | Bearer token (`Authorization: Bearer <KEY>`) |
| Pricing | Freemium |
| Source repo | `https://github.com/gregorywglenn-spec/Keyvex-API` |
| Contact | `contact@keyvex.com` |
| Tags | (canonical tag list above) |

---

## A3. Awesome-MCP GitHub list (https://github.com/punkpeye/awesome-mcp-servers)

**What it is:** Community-curated markdown list of MCP servers. Low effort, decent SEO upside.

**Submission:** GitHub PR adding a one-line entry to the appropriate category section. Verify the
current category headings and `CONTRIBUTING` guide before opening the PR.

### Draft entry

```markdown
- [KeyVex](https://keyvex.com) - The MCP server for US public financial and government disclosures: 38 read-only tools across dozens of official US government sources (SEC EDGAR forms, congressional trades + bills + votes, FEC campaign finance, USAspending contracts + grants, lobbying, FINRA OTC dark-pool, OFAC + screening lists, regulatory enforcement, company fundamentals via XBRL, macro indicators). Agent-native design, pure-publisher posture.
```

---

## A4. PulseMCP (https://www.pulsemcp.com)

**What it is:** Aggregator that crawls + lists MCP servers. Self-submission is fast; often
auto-discovers servers already listed elsewhere.

**Submission:** Single form — name, description, URL, tags. **Reuse the Smithery field values
verbatim.** Approval usually < 24 h.

**Strategy:** Submit last. May be picked up automatically once Smithery + Awesome-MCP list us.

---

# PART B — Data marketplaces (engineering required)

These reach buyers KeyVex would otherwise never see — AI training labs, enterprise data teams,
analytics buyers. The "lift" is wrapping KeyVex's existing Firestore-backed data in each
platform's native delivery format. None of this is blocking; submit in any order.

## B1. Defined.ai (https://defined.ai)

Marketplace connecting data providers with AI training labs. **Effort: ~half a day to a day** —
data-provider application; point them at the MCP endpoint with a key, or a recurring
CSV/Parquet dump from Firestore. **Fit: strong** — regulatory text, structured filings,
congressional behavior, lobbying disclosures are exactly what vertical-AI labs want.

## B2. Scale AI (https://scale.com)

Same category as Defined.ai, better-known brand, possibly higher bar. Partner / data-provider
intake form. **Effort: ~half a day to a day. Fit: strong.**

## B3. Narrative.io (https://narrative.io)

Data subscription marketplace, lower bar than Snowflake / AWS. **Effort: ~half a day to a day.
Fit: medium** — their audience leans adtech, but financial-disclosure data fits "alternative data."

## B4. Snowflake Marketplace (https://app.snowflake.com/marketplace)

Gold-standard enterprise data marketplace — buyers query "Data Shares" via SQL inside Snowflake.
**Effort: ~2–3 days** (Snowflake provider signup + Firestore→Snowflake ETL + Data Share config +
listing submission). **Fit: strong for enterprise reach** — one enterprise customer can pay 100×
an indie dev, so the engineering pays for itself.

## B5. AWS Data Exchange (https://aws.amazon.com/data-exchange)

Same shape as Snowflake, distributed through AWS. **Effort: ~2–3 days engineering + ~1 week AWS
review** (AWS account + recurring S3 publication + provider submission). **Fit: strong for
AWS-native enterprise buyers.**

## B6. Bright Data partner program (https://brightdata.com)

Top-tier data wholesaler with a partner / data-supplier program. **Effort: application + review,
unknown until applied. Fit: speculative** — low-cost to apply, worth a shot.

---

# Submission checklist

MCP registries — submittable today (Bearer auth accepted):

- [ ] Smithery form submitted
- [ ] Awesome-MCP PR opened
- [ ] PulseMCP form submitted

MCP registries — blocked:

- [ ] Anthropic directory — **deferred until OAuth 2.0 flow is built** (pairs with Stripe /
      per-customer-key work)

Data-provider applications (any 1-hour block):

- [ ] Defined.ai data-provider application
- [ ] Scale AI data-supplier application
- [ ] Narrative.io data-provider onboarding
- [ ] Bright Data partner program application

Engineering-required (each ~2–3 days):

- [ ] Snowflake Marketplace: ETL + Data Share + listing
- [ ] AWS Data Exchange: AWS account + S3 publication + provider submission

Nice-to-have:

- [ ] Animated GIF (20–30 s) of a real `unified_search` tool call — drops into README + every
      launch post + the Anthropic submission when it's unblocked

---

# What NOT to do

- **Don't submit inconsistent metadata across venues.** Use the canonical description + tag list
  above verbatim.
- **Don't list inflated counts.** Every number must match `curl https://mcp.keyvex.com`.
  As of 2026-05-16: 38 tools, v0.44.0.
- **Don't sign exclusivity agreements** with any single marketplace. Every listing is non-exclusive.
- **Don't link to anything labeled "coming soon."**
- **Don't submit to the Anthropic directory before OAuth 2.0 is in place** — their docs are
  explicit; a Bearer-token submission is a near-certain rejection that burns a 2-week review cycle.

---

# After submissions are in (parallel launch prep)

While approvals are pending:

- **Launch posts** — Twitter thread, Show HN, Reddit r/MCP / r/aiagents.
- **20–30 s GIF** of the `unified_search` cross-source query.
- **DM target list** — 10–20 AI-tool builders, fintech-AI accounts, niche newsletter writers.

---

# Future exploration (post-launch)

Once the channels above are running: direct enterprise sales (SLAs, custom slicing), vertical-AI
training-data licensing, white-label data feeds, academic/research partnerships, and a REST
wrapper for non-MCP API buyers (same data, different envelope). None are pre-launch work.
