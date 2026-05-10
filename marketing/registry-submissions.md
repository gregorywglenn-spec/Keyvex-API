# MCP Registry Submissions — Drafts & Submission Plan

> **REVIEW NOTES (not for submission yet)**
>
> Four registries to hit. Pre-staged drafts below for each. Order matters — submit Anthropic first, others follow.
>
> **Submission gate:** all prerequisites are now done as of May 10, 2026:
> - [x] Custom domain `mcp.keyvex.com` LIVE with auto-managed TLS
> - [x] Landing page LIVE at `keyvex.com` with designed wordmark + lizard mascot
> - [x] Privacy Policy LIVE at `keyvex.com/privacy` (with review banner — strip before submitting)
> - [x] `contact@keyvex.com` email forwarding operational + Gmail Send-mail-as configured
> - [x] GitHub repo renamed `CapitalEdge-API` → `Keyvex-API` (canonical URL: `https://github.com/gregorywglenn-spec/Keyvex-API`)
> - [x] @keyvex_ X account created
> - [x] u/KeyVex_ Reddit account created
> - [x] Health-check endpoint `https://mcp.keyvex.com/health` returns version + 12 tools; product landing page at `https://mcp.keyvex.com/`; MCP JSON-RPC API at `https://mcp.keyvex.com/api`
> - [x] 12 MCP tools live (server v0.18.0)
> - [x] Battle-tested at 84% data hit / 0 failures / sub-1s latency
>
> **Open items before any registry submission:**
> - [ ] **Strip the Privacy Policy review banner** (`<aside class="review-banner">` block + the matching CSS rules in privacy.html) and redeploy. Registries link directly to your Privacy URL — don't submit pointing at a page with a green "REVIEW NOTES" banner on it.
> - [ ] **Final review of GitHub repo README** — make sure the README hero example uses `mcp.keyvex.com` as the endpoint and the install instructions are clean.
> - [ ] **Optional: make the GitHub repo public** if it's currently private. Anthropic's directory specifically values open-source servers; private servers can still list but get less visibility.
> - [ ] **Confirm Loom video URL** if recorded — some registries accept a demo video link in their submission. Optional.
>
> **Submission order recommendation (1 week of work, then 1-3 weeks approval lag):**
> 1. Anthropic MCP directory (highest legitimacy; longest lag)
> 2. Smithery (1-3 day approval; broad reach)
> 3. Awesome-MCP GitHub list (PR; depends on maintainer)
> 4. PulseMCP (often auto-discovers from #1-3 anyway)
>
> **What to change after Greg + Derek's review:**
> - Confirm the canonical 1-sentence description (currently: "MCP server for US public financial disclosures — congressional trades, insider trades, 13F, lobbying, federal contracts, 8-K filings, member profiles.")
> - Confirm the tag/category choices for each registry's taxonomy
> - Confirm whether to mention Derek + Capital Edge sibling project anywhere (recommend: keep KeyVex standalone in registry listings)

---

## 1. Anthropic Official MCP Directory (highest priority)

**What it is:** The first-party registry that powers the "Connectors" UI in claude.ai and Claude Desktop. Listed servers can be one-click-installed by Claude users. Highest legitimacy signal there is in the MCP ecosystem.

**Submission process:** GitHub PR to Anthropic's MCP servers repository.

**URL to submit to:** verify the current canonical Anthropic MCP submissions repo before opening a PR. Currently believed to be `https://github.com/modelcontextprotocol/servers` or `https://github.com/anthropics/mcp-servers`. Read the repo's CONTRIBUTING.md for the exact format expected.

**Approval timeline:** typically 5-15 business days. Anthropic reviews each submission for security + correctness + tool-description quality.

**Draft entry** *(YAML format — actual format may differ; verify against repo CONTRIBUTING.md)*:

```yaml
- name: keyvex
  display_name: KeyVex
  description: |
    The MCP server for US public financial disclosures.

    Twelve agent-native tools spanning thirteen government data sources:
    SEC EDGAR (Form 4 insider trades, Form 144 planned sales, Form 3
    initial ownership, 13F institutional holdings, Schedule 13D/13G
    activist stakes, 8-K material events, Form 278 annual financial
    disclosures), congressional trades from both Senate eFD and House
    Clerk PTRs, federal contracts via USAspending.gov, lobbying
    disclosures via the Senate LDA database, current and historical
    legislators with full committee assignments.

    Designed agent-first — entity-based tools with rich filter
    parameters, not 100+ narrow REST-style endpoints. Cross-source
    queries (e.g., congressional trades + federal contracts + 8-K
    material events for a single ticker) compose naturally in one
    agent conversation.

    Pure-publisher posture: raw normalized filings, no derived
    intelligence, no proprietary signals or scores. The agent (or the
    human reading the agent's output) decides what to do with the data.
  category: Finance
  tags:
    - finance
    - sec-edgar
    - congress
    - insider-trading
    - lobbying
    - federal-contracts
    - government-data
    - public-disclosures
    - agent-tools
  endpoint: https://mcp.keyvex.com/api
  homepage: https://keyvex.com
  documentation: https://github.com/gregorywglenn-spec/Keyvex-API#readme
  privacy_policy: https://keyvex.com/privacy
  source_code: https://github.com/gregorywglenn-spec/Keyvex-API
  authentication:
    type: bearer
    header: Authorization
    description: |
      Bearer token issued at signup via keyvex.com. Free tier requires
      no credit card. Tokens are passed in the standard
      Authorization: Bearer <key> header.
  transport: streamable-http
  pricing: freemium
  free_tier:
    description: 5,000 calls per month
    requires_credit_card: false
  contact:
    email: contact@keyvex.com
    website: https://keyvex.com
  tools:
    - name: get_insider_transactions
      description: Form 4 insider trades with optional include_baseline for Form 3 starting positions
    - name: get_planned_insider_sales
      description: Form 144 planned-sale notices including 10b5-1 plan adoption metadata
    - name: get_initial_ownership_baselines
      description: Form 3 initial-ownership filings (the baseline anchor for Form 4 deltas)
    - name: get_institutional_holdings
      description: 13F holdings with quarter-over-quarter position-change calculation
    - name: get_activist_stakes
      description: Schedule 13D/13G beneficial ownership disclosures (activist + passive 5%+)
    - name: get_material_events
      description: 8-K material event filings with item-code OR-semantic filtering
    - name: get_annual_financial_disclosures
      description: Form 278 annual financial disclosures (Senate; House coming v1.1)
    - name: get_congressional_trades
      description: Senate eFD + House Clerk PTRs unified with chamber filter
    - name: get_federal_contracts
      description: USAspending.gov federal contract awards by recipient + agency + NAICS/PSC
    - name: get_lobbying_filings
      description: Senate LDA quarterly filings by registrant, client, or issue code
    - name: get_member_profile
      description: Current legislators with full committee assignments and cross-reference IDs
    - name: get_historical_member
      description: Historical legislators 1789-present (~12K members) with chronological terms
```

**Pre-submission checklist for Anthropic specifically:**

- [x] Custom domain LIVE with TLS
- [x] Privacy Policy LIVE
- [x] Health check endpoint clean
- [x] Authentication mechanism documented
- [ ] **Strip Privacy review banner before submitting** (the banner is fine for Derek's review; not fine for a registry-listed Privacy URL)
- [ ] README polished and pointing at `mcp.keyvex.com` as canonical endpoint
- [ ] Loom demo video URL ready (optional, but adds significant trust signal)

**Risk flags:**
- If the repo is private at submission time, Anthropic may delay or downgrade the listing. Consider making the repo public before submitting (the codebase is the agent-tool surface — making it open is consistent with the "we're a publisher" posture).
- If our endpoint has any uptime issue during review, Anthropic may reject. Watch the health check during the review window.

---

## 2. Smithery (https://smithery.ai)

**What it is:** Third-party MCP registry/marketplace. Popular with indie agent builders. Lower legitimacy bar than Anthropic's directory but faster approval and broader experimental-project reach.

**Submission process:** Web form on smithery.ai (likely needs an account first — sign up free with `contact@keyvex.com`).

**Approval timeline:** typically 1-3 business days for auto-approved; longer for manual review of paid/featured listings.

**Required metadata (paste into Smithery's form fields):**

- **Server name:** `keyvex`
- **Display name:** `KeyVex`
- **Short description (1 sentence, ≤120 chars):**
  ```
  MCP server for US public financial disclosures — congressional trades, insider trades, 13F, lobbying, federal contracts, 8-K filings, and member profiles.
  ```
- **Long description (paragraph):**
  ```
  Twelve entity-based tools spanning thirteen government disclosure sources. SEC EDGAR (Form 4, Form 144, Form 3, 13F, 13D/G, 8-K, Form 278), congressional trades from Senate eFD and House Clerk PTRs, federal contracts from USAspending, Senate LDA lobbying filings, current and historical legislators with committee assignments. Designed agent-first — cross-source queries (e.g., political-alpha plays joining congressional trades to federal contracts to 8-K disclosures) compose naturally in one agent conversation. Pure-publisher posture: raw normalized filings, no derived signals.
  ```
- **Category:** `Finance` (or `Government Data` if Smithery has it as a separate category)
- **Endpoint URL:** `https://mcp.keyvex.com/api`
- **Homepage:** `https://keyvex.com`
- **Privacy Policy URL:** `https://keyvex.com/privacy`
- **Source repo:** `https://github.com/gregorywglenn-spec/Keyvex-API`
- **Authentication:** Bearer token
- **Pricing model:** Freemium
- **Free tier:** 5,000 calls/month, no credit card
- **Tags:** `finance`, `sec-edgar`, `congress`, `insider-trading`, `lobbying`, `federal-contracts`, `government-data`, `agent-tools`, `public-disclosures`
- **Contact email:** `contact@keyvex.com`

**Pre-submission checklist:**

- [x] All Anthropic-pre-submission items
- [ ] Smithery account created at `smithery.ai` using `contact@keyvex.com`
- [ ] Profile filled in (logo = lizard mascot or wordmark; bio = 1-paragraph description)

**Strategy note:** submit ~24 hours after the Anthropic PR is opened. If Anthropic approves first, the Smithery entry can reference Anthropic-Connector status which is a meaningful trust signal in the indie-builder community.

---

## 3. Awesome-MCP GitHub List

**What it is:** Community-curated list of MCP servers, structured as a markdown file in a popular GitHub repo. Lower-effort listing; high SEO value because the repo accumulates GitHub stars and tends to rank well for MCP-related searches.

**Canonical repo:** `https://github.com/punkpeye/awesome-mcp-servers` (the most-starred awesome-mcp list as of May 2026 — verify it's still actively maintained before opening a PR. Check the recent-PR-merge cadence).

**Submission process:** GitHub PR adding a one-line entry to the appropriate category section. Their CONTRIBUTING.md will specify exact format and which section to add to (likely "Finance" or "Government Data").

**Draft entry** *(adjust to their exact format)*:

```markdown
- [KeyVex](https://keyvex.com) - MCP server for US public financial disclosures: congressional trades, insider trades (Form 4), planned insider sales (Form 144), institutional holdings (13F), activist stakes (13D/G), 8-K material events, Form 278 annual disclosures, federal contracts, lobbying filings, and current/historical legislators. 13 sources, 12 tools, agent-first design.
```

**If they prefer shorter (1-line max ~160 chars):**

```markdown
- [KeyVex](https://keyvex.com) - US public financial disclosures (SEC, Congress, federal contracts, lobbying) — 13 sources, 12 tools, agent-native MCP.
```

**Approval timeline:** depends entirely on the maintainer's bandwidth. Typically 1-7 days for active repos; sometimes weeks. Easy to gauge by looking at the open PR list and how recently other PRs were merged.

**Pre-submission checklist:**

- [ ] Verify `punkpeye/awesome-mcp-servers` is still the canonical awesome-mcp repo (a fork/replacement may have emerged)
- [ ] Read their CONTRIBUTING.md for line-format specifics
- [ ] Identify the correct category section to add to (Finance? Government? Data Aggregation?)
- [ ] If they require a logo or screenshot in the entry, have those ready

**Strategy:** submit alongside Smithery. Low effort, decent SEO upside, costs nothing to be in.

---

## 4. PulseMCP (https://www.pulsemcp.com)

**What it is:** Aggregator that crawls and lists MCP servers from many sources. Self-submission is fast; auto-discovery is also possible — once we're listed in Anthropic + Smithery + Awesome-MCP, PulseMCP's crawler may pick us up automatically.

**Submission process:** simpler than Smithery — typically a single form with name, description, URL, tags. Sometimes accepts auto-discovery from other registries.

**Required metadata** *(paste into PulseMCP's form)*:

- **Name:** `KeyVex`
- **Description:**
  ```
  MCP server for US public financial disclosures. 12 tools, 13 government data sources (SEC EDGAR, Congress, federal contracts, lobbying). Designed agent-first.
  ```
- **Endpoint:** `https://mcp.keyvex.com`
- **Homepage:** `https://keyvex.com`
- **Source code:** `https://github.com/gregorywglenn-spec/Keyvex-API`
- **Tags:** `finance`, `sec-edgar`, `congress`, `insider-trading`, `government-data`

**Approval timeline:** usually within 24 hours.

**Strategy:** submit last (after Anthropic + Smithery + Awesome-MCP have been filed). PulseMCP's discovery is partly automatic; we may show up without active submission once we're in the other three. If they haven't picked us up after 7 days, submit manually.

---

## Submission timeline (recommended)

```
Day 0 (today)        : Strip Privacy review banner + redeploy
                       Polish README
                       Make GitHub repo public (if currently private)
Day 1                : Anthropic MCP directory PR opens
Day 2                : Smithery submission (web form)
Day 2                : Awesome-MCP GitHub PR opens
Day 7                : PulseMCP submission (or wait for auto-discovery)
Day 8-15             : Anthropic review window — be responsive to feedback
                       on the PR; fix anything they flag fast
Day 21-30            : All four listings live (typical worst case)
```

Full registry-coverage delivered approximately 3 weeks from first submission.

---

## What NOT to do

- **Don't submit with the Privacy Policy review banner still on the page.** The banner is intentionally visible during review; registries linking to it would see "REVIEW NOTES — Not Visible to Public" prominently displayed. Strip first.

- **Don't submit with inconsistent metadata across registries.** Pick one canonical 1-sentence description, one 1-paragraph description, one tag list. Reuse exactly across all four submissions. Inconsistent metadata across registries reads as hasty/unpolished.

- **Don't submit before the GitHub repo is well-organized.** README hero example, clear authentication docs, contact info — Anthropic specifically reviews repo quality.

- **Don't list inflated record counts or feature claims.** Registries that catch this delist or flag.

- **Don't link to a placeholder landing page or a Privacy Policy URL that 404s.** The current `keyvex.com` and `keyvex.com/privacy` both return 200 with real content — confirmed live as of submission day.

- **Don't submit before the LLC is formed if any registry asks about the operating company in a binding way.** Most don't (registry listings aren't legal contracts). Read each form before filling it out. If asked, "individual / sole-prop while LLC formation in progress" is a legitimate answer.

- **Don't open multiple submissions in the same hour.** Stagger by ~24 hours so the launch story builds (Day 1 Anthropic, Day 2 Smithery + Awesome, Day 7 PulseMCP) rather than registries seeing identical metadata land simultaneously.

---

## After submissions are in (parallel work)

While waiting for approvals (which is days-to-weeks), the high-leverage parallel work that drives launch traffic:

1. **Record the Loom demo video** — script ready in `marketing/loom-script.md`. Once recorded, the URL goes into the Anthropic submission as a demo link, the Smithery submission as a media reference, and gets pinned on the @keyvex_ X profile.

2. **Polish the launch posts** — drafts ready in `marketing/launch-posts.md`. The plan is to post them when Anthropic listing approval lands, since that's the strongest legitimacy signal we'll have. Don't post launch threads before that.

3. **DM target list** — the seed list in `launch-posts.md` needs Greg + Derek's review to mark which contacts are warm vs cold. Reach out 24h before the Show HN goes up.

4. **Build a stripe-flow / signup polish** post-LLC. Free tier currently uses bearer-token-issuance; make sure the signup flow is genuinely 30-second-fast for indie devs trying it during launch.

These four items together drive the actual launch traffic. **Registry listings make us findable; launch posts drive people to be findable.**

---

## Appendix: canonical brand metadata

Use this exact wording everywhere unless a registry's form forces shorter:

**1-sentence description (≤120 chars):**
```
MCP server for US public financial disclosures — congressional trades, insider trades, 13F, lobbying, federal contracts, 8-K filings, and member profiles.
```

**Tagline (≤60 chars):**
```
The MCP server for US public financial disclosures.
```

**1-paragraph description:**
```
Twelve entity-based MCP tools spanning thirteen US government disclosure sources: SEC EDGAR (Form 4, Form 144, Form 3, 13F, 13D/G, 8-K, Form 278), congressional trades from both Senate eFD and House Clerk, federal contracts from USAspending, Senate LDA lobbying filings, current and historical legislators with committee assignments. Designed agent-first — cross-source queries compose naturally in one agent conversation. Pure-publisher posture: raw normalized filings, no derived signals.
```

**Tags (canonical list):**
```
finance · sec-edgar · congress · insider-trading · lobbying · federal-contracts · government-data · public-disclosures · agent-tools
```

**Free-tier copy:**
```
5,000 calls/month free tier. No credit card required.
```

**Brand contact:** `contact@keyvex.com`

**Brand X handle:** `@keyvex_`

**Brand Reddit handle:** `u/KeyVex_`
