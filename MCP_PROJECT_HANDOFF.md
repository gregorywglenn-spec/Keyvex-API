# Capital Edge API + MCP — Handoff to New Cowork Session

**Move this file to `C:\CapitalEdge-API\HANDOFF_NEXT_SESSION.md` after Cowork project is created.**

Source: Discovery + scoping session, April 28 2026 evening
Author: Claude (research session, chat interface)
For: Capital Edge API + MCP build, new Cowork project, Day 1

---

## TL;DR — read this first if nothing else

Greg is building a **second commercial product** alongside the Capital Edge dashboard app. This product sells the **raw output of the same scrapers** that feed Capital Edge to a different audience: developers and AI agents.

**Two delivery surfaces, one data layer:**

1. **MCP server** (ships first) — exposes the disclosure datasets as tools designed natively for AI agents. New paradigm. Wedge against existing financial-data MCPs which are all REST-retrofits.
2. **REST API** (ships 2-3 months after MCP) — same data, conventional REST endpoints. Picks up the FMP/Quiver-API-style customer who wants programmatic access in their own code.

**Sequence locked in: MCP first. REST API second. Capital Edge dashboard app stays a separate product entirely.** No convergence score in either of these products — that stays exclusive to the dashboard app.

This handoff exists because chat-interface friction was tripling build time. Greg is moving to Cowork (Anthropic Max plan) with one project per build, separate folders, separate workspaces. New session has no chat history — overdocument.

---

## Scope decision and the load-bearing argument

The scope question this conversation answered: **MCP only, MCP first then REST, or both at once?**

Greg picked Option 2 (MCP first, REST as same-data second surface 2-3 months later). The reasoning that drove that decision matters for any future temptation to re-litigate it:

**Why MCP first (not REST first):**
- All existing financial-data MCPs (Unusual Whales, FMP, Alpha Vantage) are REST APIs with thin MCP wrappers bolted on. UW's "MCP" is essentially a `skill.md` system prompt telling the LLM to please not hallucinate endpoints. FMP and Alpha Vantage auto-generated 250+ tool dumps from their REST endpoints, then patched them with "dynamic tool discovery" because agents got overwhelmed. None designed MCP-native from the ground up.
- The wedge is being the only one designed for the agent as the customer, not for legacy REST endpoints. That advantage evaporates the moment focus splits.
- REST is downstream-easy. Once the data layer and MCP tools exist, exposing the same data as REST endpoints is a weekend, not a project.
- Greg builds fast. Shipping MCP alone in v1 lets paying-customer signal inform the REST API's shape rather than guessing.

**Why not MCP-only forever:**
- REST customers are real and known-paying. FMP claims 100K+ customers including Franklin Templeton, Ark Invest, Trading212, Perplexity, Hubspot, RBC. Quiver API has hobbyist ($10) and trader ($75) tiers and 5+ years of validation. Abandoning that segment for an emerging one is a real cost.
- The data layer doesn't care which surface consumes it. Building MCP alone leaves money on the table that costs almost nothing to capture later.

**Why not both at launch:**
- Positioning at launch is the moment positioning matters most. "MCP-native financial data for AI agents" is a sentence that converts. "Financial data via MCP and REST API" is a feature list. Sentences win launches.
- Splitting docs, marketing, support, and pricing across two customer types from day one means building a mediocre version of each instead of a great version of one.
- The discipline carries: when MCP succeeds and REST gets added in month 4, the REST API is positioned as "the same data, also available via REST" — clearly downstream of the main thing. That works. Equal billing on day one doesn't.

**What got ruled out along the way:**
- Running MCP and REST as two separate companies (Greg explored this; it's worse — same focus problem with double the legal/ops/infra overhead).
- Selling the convergence score via this product (kept exclusive to Capital Edge dashboard — removes legal complexity here, preserves dashboard differentiation).
- Selling normalized data with any signal/advice language layered on top (this product sells facts; "due diligence alert" framing belongs to the Capital Edge app, not here).
- Including Canada SEDI and UK RNS scrapers (Canada SEDI ToS prohibits commercial scraping; UK RNS is behind LSEG paywall; both need licensing deals or skip entirely).
- "10-20x undercut FMP" pricing framing (FMP is already near floor at $22; competing on price loses to incumbents with 5+ year head start; competing on MCP-native design wins).

---

## Architecture decisions made (subject to refinement, but here's where we landed)

### Transport
**Remote MCP server** is the leading candidate. HTTPS endpoint, hosted by Greg, customers connect via URL with auth token. Matches Firebase/Cloudflare hosting infrastructure already in place for Capital Edge. Matches modern MCP convention (FMP, UW, Alpha Vantage all do this; 80% of most-searched MCPs are remote per MCP Manager 2026 stats).

Local stdio (npm-installable server) is the alternate path — friendlier for power users who want everything on their own machine. Worth offering eventually as a second deployment option, but remote ships first.

**Status:** Not locked. Day-1 decision for new session: confirm remote-first.

### Auth
**Bearer token in headers** is the leading candidate. UW's pattern. Cleaner than URL-embedded API keys (FMP's pattern), better security posture, easier to rotate. Generated per-customer at signup, validated against Firestore on every tool call.

**Status:** Not locked. Day-1 decision: confirm Bearer token vs URL key.

### Stack
**Node/TypeScript** is the leading candidate. Matches Capital Edge codebase (scrapers are .js). Same Firebase Admin SDK, same Firestore client, same deploy pipeline. Greg's existing scrapers can be imported directly — no rewrite.

Python is more common in MCP land but means a separate codebase and rebuilding the data layer. Cost outweighs benefit unless there's a specific Python-only library needed.

**Status:** Strongly recommend Node. Day-1 decision: confirm.

### Hosting
**Firebase Functions or Cloud Run.** Greg already runs Firebase for Capital Edge. Same Firebase project or sibling project — open question, see "Open Questions" below. Blaze tier required either way (already planned for Capital Edge commercial launch).

### Data layer
**Read-only access to the existing Firestore collections that Capital Edge writes to.** Same `congressional_trades`, `insider_trades`, `institutional_holdings` collections. MCP server queries them; never writes. This is the "shared scrapers, two products" pattern from `C:\CapitalEdge\DATA_STRATEGY.md`.

CUSIP-based join pattern for institutional holdings (AAPL = 037833100) — see `CONGRESS_DATA_PIPELINE.md` and the `TICKER_CUSIP_MAP` in `C:\CapitalEdge\run-scraper.js`. Mirror this pattern in any MCP tool returning institutional holdings.

### Schema posture
**Jurisdiction-agnostic naming from day one.** Even though v1 is US-only, all tools and fields are named to fit international data later without renaming.

- Tool: `get_insider_transactions` (not `get_form_4_filings`)
- Field: `jurisdiction: "us"` on every record (default present even when not strictly needed in v1)
- Adding Japan EDINET or Korea DART later means adding `"jp"` / `"kr"` values, not refactoring schema

Foundation decision that costs nothing now and saves weeks later.

### Pricing tiers (sketch, not locked)
Following the rough shape suggested by the market:

- **Free tier** — limited calls/day, recent data only (developer testing, onboarding)
- **Hobbyist / Indie** — ~$15-25/mo, low-volume access, full history (Quiver Hobbyist comp = $10, FMP Starter = $22)
- **Pro / Trader** — ~$75-100/mo, higher volume, all datasets (Quiver Trader = $75, UW Standard = $48)
- **Institutional** — custom pricing, unlimited or near-unlimited (Quiver custom, UW Premium = $110)

Same pricing applies whether the customer accesses via MCP or REST. The data is the data; transport doesn't change value.

**Status:** Sketch only. Lock during commercial launch prep, not before. Reference Capital Edge's `DATA_STRATEGY.md` Phase 2 plan for the original $49/$149/$299 tiers — those were drafted before the UW competitive scan and need re-evaluation against UW's $48-110 bundle.

---

## Competitive landscape

### Direct competitors with shipped MCP servers (all retrofits)

**Unusual Whales** — most direct competitor for the data overlap.
- 100+ REST endpoints exposed via "MCP" that's actually a `skill.md` system prompt telling the LLM what's real and what's hallucinated
- Covers congressional trades, insider transactions, 13F holdings (the same three datasets we have)
- Plus options flow, dark pool, Greek exposure, prediction markets — much broader than us
- Pricing: $48 Standard / $110 Premium (consumer dashboard tiers; API/MCP bundled in)
- 100K+ retail brand, hard to compete on community
- Their MCP is a wrapper, not a native design — gap exists

**Financial Modeling Prep (FMP)** — broadest competitor by data volume.
- 250+ tools auto-generated from REST endpoints
- Patched with "dynamic tool discovery" because agents get overwhelmed
- Pricing: $22 Starter (US-only) / $59 Premium (adds UK/Canada) / $149 Ultimate (global)
- 100K+ customers including Franklin Templeton, Ark Invest, Trading212, Perplexity, Hubspot, RBC
- Their MCP is a generated dump, not a thoughtful design — gap exists

**Alpha Vantage** — oldest player, most retrofit.
- 100+ tools using literal REST function names like `TIME_SERIES_DAILY`, `RSI`
- Same "progressive tool discovery" patches as FMP
- Pricing: free tier + paid (lower than FMP at low volume)
- Their MCP reads like a database catalog, not an agent toolkit — biggest gap

### The pattern across all three
- All bolt MCP onto pre-existing REST APIs designed for human developers
- Tool naming follows REST/database conventions (`TIME_SERIES_DAILY`), not natural-language intent (`get_daily_prices`)
- 100-250 tool dumps overwhelm agent context windows
- Compose at the agent level, not the tool level (agents have to chain 5 tools to answer one question)
- Tool descriptions are one-line REST doc fragments, not designed for agent reasoning

### The wedge for this product
**Fewer tools, smarter design, agent-native from the ground up.** 10-20 tools that compose well, named for what agents actually ask, with descriptions that tell the agent when to use each one and how to chain them. Same data the incumbents have, dramatically better delivery layer.

### Demand context
Financial data MCPs are not in the top 50 most-searched MCPs as of March 2026 (the top categories are documentation injection, code/repos, browser automation, search, reasoning/memory, databases, productivity, web scraping, DevOps, CRM). The total market for financial-data MCPs is a niche — probably hundreds to low thousands of paying customers across all vendors today, not tens of thousands. Realistic size for this business: lifestyle ($50-200K ARR) to solid niche ($200-700K ARR) in years 1-2. Breakout to $1-2M ARR is possible but should not be assumed.

---

## Legal posture

**This product sells facts, not signals or opinions. No disclaimers needed.** Same posture as FMP, Alpha Vantage, or EDGAR itself selling raw fundamentals — they don't disclaim "this is not advice" because it isn't, and they don't have to.

Field names stay clean and factual: `transaction_amount`, `filing_date`, `member_name`. No interpretation, no derived signals, no advice-adjacent language anywhere in the API/MCP surface.

This is **deliberately different from the Capital Edge dashboard app**, which sells the convergence score and uses "due diligence alert" framing under the publisher's exemption (Lowe v. SEC, 1985). That legal complexity belongs to the dashboard. This product avoids it entirely by selling normalized data without any derived signals layered on top.

Two products, two legal postures:

| Product | What it sells | Legal posture | Disclaimer language |
|---|---|---|---|
| MCP / REST API (this project) | Raw filings | Pure publishing — same as Bloomberg, EDGAR | None needed |
| Capital Edge app (separate project) | Convergence score + UI | Publisher exemption — same as Quiver Smart Score | "Due diligence alert, not advice" |

Don't blur the line. The moment this product starts surfacing a "score" or a "signal" or any derived interpretation, it inherits the legal complexity of the dashboard app and loses its own clean posture.

Attorney consultation still required before either product takes paid subscribers (Greg's standing rule). Walk in with this framing already understood.

---

## Cross-references to Capital Edge

The Capital Edge dashboard project lives at `C:\CapitalEdge\` and is its own Cowork project. This MCP/API project is a sibling, not a child. Both projects share scrapers and Firestore data; neither owns the other.

**Files to read in `C:\CapitalEdge\` for context (in order of relevance):**

1. **`DATA_STRATEGY.md`** — the original dual-track business plan. Includes API tier pricing sketch ($49/$149/$299), Firestore schema design, build phases, competitor comparison, and the April 2026 repositioning around UW. The MCP/API project is essentially the "Track 2" of this document, executed as MCP-first instead of REST-first.

2. **`DATA_SOURCES_ROADMAP.md`** — additional data sources to consider for future expansion: Form 144 (proposed insider sales, faster than Form 4), 13D/13G (ownership crosses), committee assignments + LDA lobbying data, USAspending federal contracts, Form 8-K material events, N-PORT mutual fund holdings, FINRA short interest, OpenFIGI CUSIP→ticker enrichment, FRED macro layer. Each scored Tier 1/2/3 with rationale. Do not start any of these for the MCP product until v1 ships with the existing three datasets.

3. **`CONGRESS_DATA_PIPELINE.md`** — detailed spec for ingesting congress-legislators data (537 members, photos, committee assignments). Important hard-won gotchas inside (Cloudflare bot-challenge on theunitedstates.io, photo concurrency limits, JPEG magic-byte verification, bioguide_id as the join key). This is foundational for any tool that returns congressional trade data with member context.

4. **`HANDOFF_NEXT_SESSION.md`** — the Capital Edge dashboard's own handoff doc to its next session. Read for current state of the dashboard build, not for MCP guidance.

5. **`run-scraper.js`** — the working scraper runner. As of evening April 28 2026, it has successfully written real data to Firestore via service-account auth (bypasses CORS). 21 AAPL insider trades + 673 AAPL institutional holdings landed. Senate and House scrapers staged in code but not yet tested. Reference for how the data layer actually works in practice.

6. **`scrapers/`** directory — `congressional_scraper.js`, `form4_scraper.js`, `house_scraper.js`, `institutional_scraper.js`. These are the existing scrapers. The MCP product reads what they write; the MCP product does not own them.

**Files to read in `C:\CapitalEdge\` for schema specifically:**
- `firestore.rules` — current security rules (per-user paths, default-deny). MCP server will need its own service-account read access pattern, separate from the user-facing rules.
- `firestore.indexes.json` — composite indexes already configured.

**Coordination protocol:**
- The Capital Edge dashboard project is the **scraper owner**. New scrapers, schema changes, and data corrections happen there.
- This project is the **delivery surface owner**. Tool design, MCP tool descriptions, REST endpoint shapes, pricing, customer-facing docs happen here.
- When schema changes are needed for MCP/REST reasons, propose them in this project, then implement in Capital Edge after agreement. Don't write to the shared collections from the API project.

---

## Open questions for Day 1

These are blocking decisions for the new session. Greg's input needed.

1. **Same Firebase project or sibling project?**
   - Same project = shared service accounts, same console, simpler ops, but coupled blast radius if either product breaks something
   - Sibling project = clean separation, two consoles, more setup, but blast radius scoped to one product
   - Lean: sibling project. The whole point of separating the projects is independence. Firebase project per Cowork project keeps it consistent.

2. **Domain and brand identity for this product.**
   - It's not "Capital Edge" — that's the dashboard. This needs its own name and domain.
   - Considerations: the name should signal "data infrastructure for agents" not "trading app for retail." Examples for thinking, not recommendations: `disclosurefeed.dev`, `filingstream.io`, `publicwire.dev`, `agentwire.dev`. Greg picks.
   - Until named, working title in code can be `capital-edge-api` or `mcp-disclosure-server`.

3. **MCP registry submission strategy.**
   - PulseMCP, Smithery, Glama, FastMCP, MCP Manager, Anthropic's connector directory — five+ registries to submit to.
   - Submit to all on launch day, or roll out staged?
   - Lean: submit to all on launch day. Nothing to lose. Discovery is the bottleneck for an emerging-market product.

4. **First five MCP tools to design (the actual v1 surface).**
   - Sketch from this session, to be refined Day 1:
     - `get_recent_congressional_trades` — last N trades across all members, filter by date range
     - `get_congressional_trades_by_ticker` — who in Congress traded this stock
     - `get_recent_insider_transactions` — last N Form 4s across all companies
     - `get_insider_transactions_by_ticker` — Form 4s for a specific company
     - `get_institutional_holdings_by_ticker` — which 13F filers hold this stock (CUSIP-joined)
   - Tools 6-15 to design after first five are concrete and one prototype works end-to-end.

5. **Target customer profile for early validation.**
   - Who is the first paying customer? Need 5-10 specific names/profiles, not "AI agent builders" in the abstract.
   - Candidate types to brainstorm: indie devs building finance-focused agents, small fintech startups using AI for due diligence automation, finance-Twitter creators wanting agent-driven content workflows, quant hobbyists experimenting with LLM-orchestrated screens.
   - Validation move: before building beyond the first prototype, find five of these and ask if they'd pay $50/mo. If yes → build. If shrugs → re-scope.

6. **Free tier shape.**
   - Quiver does congressional-only on free tier. FMP does limited calls. UW doesn't really have a free tier.
   - Open question: which data on free, or all data with a low call cap?
   - Lean: low call cap on all data. Lets developers prototype with the full surface; rate limit forces upgrade for production use.

---

## Where to start Day 1 — specific first move

Not "consider X." Actual "do Y first."

**Day 1 first move: stand up a remote MCP server skeleton in Node/TypeScript that exposes one working tool — `get_insider_transactions_by_ticker` — backed by the existing `insider_trades` Firestore collection. End-to-end. From `claude.ai/desktop` or any MCP client → through the server → reading from Firestore → returning real Form 4 data for AAPL.**

This single move accomplishes:
- Validates the stack choice (Node + Firebase Admin SDK + MCP SDK works together)
- Validates the data layer (read-only access to Capital Edge's Firestore works from a separate project)
- Validates the auth model (Bearer token end-to-end)
- Produces the first tool description, response shape, and documentation example to react to
- Surfaces every infrastructure question (deploy where, what URL, how customers connect) by forcing them to be answered with code

**Recommended sequence within Day 1:**
1. `npm init` in `C:\CapitalEdge-API\`, install `@modelcontextprotocol/sdk`, `firebase-admin`, `express` or equivalent
2. Service-account JSON for read access to the Capital Edge Firestore (Greg generates from Firebase console; lean toward sibling project setup over reusing Capital Edge service account)
3. Write a single MCP tool definition for `get_insider_transactions_by_ticker` with a clean, agent-friendly description
4. Wire it to a Firestore query: `db.collection('insider_trades').where('ticker', '==', ticker).orderBy('disclosure_date', 'desc').limit(50)`
5. Run locally, connect to it from Claude Desktop or any MCP client, verify AAPL returns real data
6. Once the loop works end-to-end: deploy to Firebase Functions or Cloud Run as a remote MCP endpoint
7. Test the deployed version from a clean MCP client config — that's the v0.1 milestone

After v0.1 works: design tools 2-5, then validate with five real prospective customers before building tools 6-15.

---

## Standing rules from Greg

These apply to all his Claudes, copied here so the new session has them inline:

1. **Tell the ugly truth.** Especially about whether something will actually work. The instinct to confirm what's flattering is the failure mode. Push back, run actual diagnostics, report the true picture even when it complicates the plan.

2. **Don't quote in weeks what he ships in hours.** Greg builds dramatically faster than institutional time estimates assume. He project-manages 7-10 home builds in parallel for his day job and brings that pace to software. If you find yourself estimating a scraper at "2-4 weeks," you're wrong by an order of magnitude. Calibrate to his actual pace.

3. **Foundation before features. Always. No exceptions.** This is from Capital Edge's `claude.md`. Applies here too. v1 ships with three datasets done well, not ten datasets done shakily.

4. **Flag opportunity in the moment.** If you spot a genuine business opportunity adjacent to what you're working on, surface it without being asked. Greg is building a portfolio of AI products and wants opportunities seen, not hidden.

5. **Foundation work isn't optional even when momentum is high.** If the project is getting ahead of its foundation, flag it. The standing rule against shiny-object pivots applies — including pivots dressed up as logical extensions.

---

## What this handoff does NOT contain

- Code. No code was written this session. Day 1 work is the first code.
- Tool definitions in detail. Five tool names sketched; full descriptions, parameters, and response shapes are Day 1 work.
- Final pricing. Sketch only; lock during commercial launch prep.
- Marketing copy or landing page content. Day-30+ work.
- A detailed validation plan. Outline only ("find five prospective customers, ask if they'd pay $50/mo"); execution is Day 2-7.

---

## Last updated
April 28, 2026 — Claude (research session, chat interface), with Greg
For: New Cowork session, Day 1, project `C:\CapitalEdge-API\`
