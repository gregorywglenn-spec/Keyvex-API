# KeyVex Distribution Playbook — Where to List

**Status (Day 9 / 2026-05-12):** all pre-submission prerequisites complete. Drafts below are ready to copy-paste-and-send. Strategy is **list everywhere KeyVex can plausibly fit**, in parallel, sequenced by engineering effort (lowest first). Each listing is a free inbound funnel — the downside is bounded engineering time, the upside is uncapped.

| Prereq | Status |
|---|---|
| `mcp.keyvex.com` live + TLS | ✅ |
| `keyvex.com` apex + `www.keyvex.com` live | ✅ |
| GitHub repo `gregorywglenn-spec/Keyvex-API` | ✅ |
| README polished for 21-tool state | ✅ |
| `contact@keyvex.com` operational (Gmail forward) | ✅ |
| Privacy Policy at `keyvex.com/privacy` | ✅ |
| Health check returns version + 21 tools | ✅ |
| GIF / screenshot showing real tool call | 🟡 nice-to-have |

---

## Two channel categories

KeyVex fits in **two distinct distribution worlds**. Each reaches a different buyer segment. We're listing in both.

| Category | Audience reached | Engineering cost | Effort per listing |
|---|---|---|---|
| **MCP-native registries** | Indie devs + agent builders + Claude / Cursor / Anthropic ecosystem | Zero — paperwork only | ~30 min each |
| **Data marketplaces** | AI training labs + enterprise data teams + analytics buyers | Small — wrapping our data in their delivery format | ~2-3 days each (one-time setup; tiny ongoing maintenance) |

Total engineering effort to list in ALL 9+ venues: roughly **1-2 weeks of focused work spread across them**, plus paperwork time. None of this is blocking. Submit in any order.

---

# PART A — MCP-native registries (paperwork only)

## A1. Anthropic Official MCP Directory (highest priority)

**What it is:** First-party registry powering Claude Desktop / claude.ai "Connectors" UI. Listed servers can be one-click installed by users. Highest legitimacy signal.

**Submission:** GitHub PR to `https://github.com/anthropics/mcp-servers` (verify exact path + contributing guide before opening — Anthropic occasionally restructures).

**Approval timeline:** 5-15 business days.

**Audience:** Claude users (consumer + developer) who browse the in-app connector list. Heaviest reach for the indie-dev + agent-builder segment.

### Draft entry (YAML — per their template)

```yaml
- name: keyvex
  display_name: KeyVex
  description: |
    The MCP server for US public financial disclosures. 21 tools across
    22+ official US government sources — congressional trades, executive
    insider transactions (Form 4), institutional holdings (13F), mutual
    fund holdings (N-PORT), activist stakes (13D/G), planned insider sales
    (Form 144), tender offers (Schedule TO), IPO + shelf registrations
    (S-1/S-3), private placements (Form D), federal contracts (USAspending),
    lobbying spend (LDA), material events (8-K), member profiles +
    committee assignments, FEC campaign finance, congressional bills +
    roll-call votes, FINRA OTC dark-pool volume, SEC + DOJ enforcement
    actions, OFAC sanctions, and Federal Register documents. Designed for
    AI agents from the ground up — agent-native tool descriptions, rich
    filter parameters, single Bearer-authenticated endpoint. Pure-publisher
    posture; no derived signals.
  category: Finance
  url: https://mcp.keyvex.com
  homepage: https://keyvex.com
  documentation: https://github.com/gregorywglenn-spec/Keyvex-API#readme
  privacy_policy: https://keyvex.com/privacy
  authentication:
    type: bearer
    header: Authorization
  pricing: freemium
  free_tier: 5000 calls/month
  contact: contact@keyvex.com
  tools:
    - get_insider_transactions
    - get_institutional_holdings
    - get_congressional_trades
    - get_planned_insider_sales
    - get_activist_stakes
    - get_federal_contracts
    - get_member_profile
    - get_material_events
    - get_lobbying_filings
    - get_annual_financial_disclosures
    - get_fec_candidate_profile
    - get_tender_offers
    - get_bills
    - get_roll_call_votes
    - get_otc_market_weekly
    - get_private_placements
    - get_enforcement_actions
    - get_nport_filings
    - get_registration_statements
    - get_ofac_sdn
    - get_federal_register_documents
```

### PR description draft

(Same as before — see archived earlier version in git history at `bd38004`. Hero example with the LMT cross-source query + pure-publisher posture explanation.)

---

## A2. Smithery (https://smithery.ai)

**What it is:** Third-party MCP registry, popular with indie agent builders. Lower legitimacy than Anthropic, faster approval, broader reach into experimental projects.

**Submission:** Web form on smithery.ai. Some auto-approved; others manual review.

**Approval timeline:** 1-3 business days for auto-approved.

**Audience:** Hobbyist + early-adopter agent builders.

### Form fields to fill

| Field | Value |
|---|---|
| Server name | `keyvex` |
| Display name | `KeyVex` |
| Short description | The MCP server for US public financial disclosures — 21 tools across 22+ government sources covering congressional trades, insider activity, institutional holdings, lobbying spend, federal contracts, FEC campaign finance, bills + roll-call votes, dark-pool volume, OFAC sanctions, Federal Register, and more. |
| Category | `Finance` or `Government Data` (pick whichever exists in their current taxonomy) |
| URL | `https://mcp.keyvex.com` |
| Homepage | `https://keyvex.com` |
| Documentation | `https://github.com/gregorywglenn-spec/Keyvex-API#readme` |
| Authentication | Bearer token (`Authorization: Bearer <KEY>`) |
| Pricing | Freemium (5,000 calls/month free) |
| Source repo | `https://github.com/gregorywglenn-spec/Keyvex-API` |
| Contact | `contact@keyvex.com` |
| Tags | `finance`, `sec-edgar`, `congress`, `insider-trading`, `lobbying`, `government-data`, `agent-tools`, `dark-pool`, `fec`, `ofac`, `federal-register` |

---

## A3. Awesome-MCP GitHub list (https://github.com/punkpeye/awesome-mcp-servers)

**What it is:** Community-curated markdown list of MCP servers. Low effort, decent SEO upside (repo has many GitHub stars).

**Submission:** GitHub PR adding a one-line entry to the appropriate category section.

**Approval timeline:** Maintainer-dependent. Days, sometimes weeks.

### Draft entry

```markdown
- [KeyVex](https://keyvex.com) - The MCP server for US public financial disclosures: 21 tools across 22+ official US government sources (SEC EDGAR forms, USAspending, FEC, congress.gov, Senate eFD + House Clerk PTRs, FINRA OTC dark-pool, OFAC sanctions, Federal Register, SEC+DOJ enforcement). Pure-publisher posture, no derived signals.
```

---

## A4. PulseMCP (https://www.pulsemcp.com)

**What it is:** Aggregator that crawls + lists MCP servers from many sources. Self-submission is fast; auto-discovery often picks us up after we're on other registries.

**Submission:** Single form with name, description, URL, tags. **Same field values as Smithery — reuse verbatim.**

**Approval timeline:** Usually < 24 hours.

**Strategy:** Submit last. May be picked up automatically once Anthropic + Smithery list us.

---

# PART B — Data marketplaces (engineering required)

These reach buyers KeyVex would otherwise never see — AI training labs, enterprise data teams, analytics buyers. The "lift" is wrapping our existing Firestore-backed data in their native delivery format.

## B1. Defined.ai (https://defined.ai)

**What it is:** Marketplace specifically connecting data providers with AI training labs. Sells curated datasets to research teams at AI companies.

**Audience:** AI / ML research teams at labs and AI-first startups.

**Submission:** Data-provider onboarding form on their site. They accept flexible formats (CSV, JSON, API endpoints).

**Engineering effort:** **~half a day to a day.** Fill out their data-provider application, point them at either (a) our existing MCP endpoint with a key, or (b) a recurring CSV/Parquet dump from Firestore.

**Fit:** Strong. KeyVex's data (regulatory text, structured filings, congressional behavior, lobbying disclosures) is exactly the kind of domain-expert training material vertical-AI labs want.

**Draft description:** "Recurring US public financial disclosure feed — 22+ government sources covering SEC filings, congressional activity, FEC campaign finance, lobbying spend, federal contracts, sanctions, and Federal Register documents. Designed for training vertical-AI models in finance, regulatory compliance, and political-economy domains."

**Action item:** verify submission form is open + apply via their data-provider portal.

---

## B2. Scale AI (https://scale.com)

**What it is:** Same category as Defined.ai — pairs data providers with AI labs. Better-known brand, possibly higher bar to list.

**Audience:** Same as Defined.ai — research teams at large + mid-size AI companies.

**Submission:** Partner / data-provider intake form on their site.

**Engineering effort:** Same as Defined.ai — half a day to a day.

**Fit:** Strong. Same logic as Defined.ai.

**Action item:** apply via their data-supplier portal.

---

## B3. Narrative.io (https://narrative.io)

**What it is:** Data subscription marketplace. Lower bar than Snowflake / AWS Data Exchange. Smaller buyer pool but easier to list.

**Audience:** Mid-market data teams + adtech + research.

**Submission:** Data-provider onboarding via their platform.

**Engineering effort:** Half a day to a day. Similar setup pattern to Defined.ai.

**Fit:** Medium. Their main audience leans more toward adtech / consumer data, but our financial-disclosure data should fit their "alternative data" category.

---

## B4. Snowflake Marketplace (https://app.snowflake.com/marketplace)

**What it is:** Gold-standard enterprise data marketplace. Big companies subscribe to "Data Shares" they can query directly via SQL from inside Snowflake.

**Audience:** Enterprise data teams — investment banks, hedge funds, large analytics shops, compliance teams.

**Submission:** Become a Snowflake provider, publish a "Data Share" via their UI, submit for marketplace listing.

**Engineering effort:** **~2-3 days end-to-end.**
- Sign up for Snowflake (free tier exists for setup; pricing kicks in only when buyers consume)
- One-time ETL: Firestore → Snowflake tables. Can use Snowflake's native connector or a Cloud Function that runs daily.
- Configure the "Data Share" in Snowflake's UI
- Submit for marketplace listing — review window is days to weeks

**Fit:** **Strong for enterprise reach.** Our data is the exact shape Snowflake buyers consume — structured tables they can JOIN against their internal databases. Biggest single distribution channel for enterprise buyers.

**Strategic note:** This is the heaviest lift on the list. Worth doing because enterprise buyers can pay 100× what an indie dev pays — even one enterprise customer makes the engineering effort pay for itself many times over.

---

## B5. AWS Data Exchange (https://aws.amazon.com/data-exchange)

**What it is:** Same shape as Snowflake — distributes data products through AWS. Reaches AWS-native data teams.

**Audience:** AWS-native enterprise data teams (different pool from Snowflake, often the same buyer at a different layer of their stack).

**Submission:** Become an AWS Data Exchange provider, publish data as S3-hosted files with manifest, submit data product for AWS approval.

**Engineering effort:** **~2-3 days engineering + ~1 week wall-clock for AWS review.**
- Set up an AWS account (we don't have one yet — half a day)
- Configure recurring data publication to S3 (Cloud Functions can push cross-cloud from Google to AWS)
- Submit data product through their provider portal
- AWS review typically ~1 week

**Fit:** Strong for AWS-native enterprise buyers. Complements Snowflake (some buyers prefer one cloud, some the other).

---

## B6. Bright Data partner program (https://brightdata.com)

**What it is:** Top-tier data wholesaler. They have a partner / data-supplier program where they distribute niche datasets.

**Audience:** Bright Data's existing enterprise customer base.

**Submission:** Apply via their partner portal.

**Engineering effort:** Application + review process — exact effort unknown until we apply.

**Fit:** Speculative. They mostly distribute their own scraped data, but they do partner with niche suppliers.

**Strategic note:** Low-cost to apply. Worth a shot.

---

# Submission order + timeline

Sequence by engineering effort. All can happen in parallel.

| Week | Action |
|---|---|
| **Today (Week 0)** | Submit all 4 MCP registries — Anthropic PR, Smithery form, Awesome-MCP PR, PulseMCP form. Pure paperwork, ~half a day total. |
| **Week 0** | Apply to Defined.ai, Scale AI, Narrative.io, Bright Data — data-provider onboarding forms. ~half a day total. |
| **Week 1-2** | Snowflake Marketplace setup: Firestore → Snowflake ETL + Data Share config. ~2-3 days engineering. |
| **Week 1-2** | AWS Data Exchange setup: AWS account + S3 manifest + provider submission. ~2-3 days engineering. |
| **Week 1-4** | Approval lags arriving across all venues — Anthropic ~2 weeks, Smithery / PulseMCP / Awesome-MCP within days, data marketplaces ~1-3 weeks depending on platform. |

Total elapsed: ~3 weeks of submission + ~3 weeks of approval lag = launches arriving over the first month.

---

# Submission checklist (work through in any order)

Pure paperwork (do in any 1-hour block):

- [ ] Anthropic MCP directory PR opened
- [ ] Smithery form submitted
- [ ] Awesome-MCP PR opened
- [ ] PulseMCP form submitted

Data-provider applications (do in any 1-hour block):

- [ ] Defined.ai data-provider application
- [ ] Scale AI data-supplier application
- [ ] Narrative.io data-provider onboarding
- [ ] Bright Data partner program application

Engineering-required (each ~2-3 days):

- [ ] Snowflake Marketplace: ETL pipeline + Data Share published + listing submitted
- [ ] AWS Data Exchange: AWS account + S3 publication + provider submission

Nice-to-have:

- [ ] Animated GIF (20-30 sec) showing a real tool call — drops into README + Anthropic PR description + every launch post

---

# What NOT to do

- **Don't submit with inconsistent metadata across venues.** Pick the canonical description + tag list above. Reuse verbatim.
- **Don't list inflated record counts or feature claims.** Numbers in this doc are real and verifiable via `curl https://mcp.keyvex.com` or `npx tsx scripts/battle-test.ts`.
- **Don't sign exclusivity agreements** with any single marketplace. Each listing should be non-exclusive.
- **Don't link to anything still labeled "coming soon."** Footer mention of ToS "coming with LLC formation" is fine because it's about LLC paperwork, not the product itself.

---

# After submissions are in (parallel launch prep)

While approvals are pending:

- **Launch posts** — Twitter thread, Show HN, Reddit r/MCP / r/aiagents. Drafts ready to fire on Anthropic-approval day.
- **20-second GIF** — recorded via Peek on Ubuntu (`sudo apt install peek`). Drops into the README + landing page + every social post.
- **DM target list** — 10-20 specific accounts (AI-tool builders, fintech-AI Twitter, niche newsletter writers).

---

# Future exploration (post-launch, when these channels are running)

Greg's strategic note (Day 9): once these 9 channels are running, explore **other ways to capture, package, and distribute data** to whoever wants to buy it.

Candidate avenues to investigate later:

- **Direct enterprise sales** — once Snowflake / AWS Data Exchange surface inbound leads, offer custom enterprise tiers with SLAs, dedicated support, custom data slicing.
- **Vertical-AI training data licensing** — repackage subsets of our data (e.g., "10 years of congressional trades + matched bill votes") as one-time licensed datasets for AI labs training political-economy or regulatory-compliance models.
- **White-label data feeds** — companies that want our data piped into their own products without the KeyVex brand attached.
- **Newsletter / report subscriptions** — a separate brand layer that publishes derived insights from KeyVex's underlying data (would live with the dashboard product, not KeyVex, per pure-publisher posture).
- **Academic + research partnerships** — universities studying market structure, political economy, regulatory behavior often want our exact data. Free/discounted access in exchange for citation/co-publication.
- **API-as-a-product for non-MCP consumers** — a REST wrapper on top of the MCP endpoint for traditional API buyers who don't speak MCP. Same data, different envelope.

None of these are pre-launch work. They're channel-expansion options once the 9-venue foundation is producing inbound funnels.
