# KeyVex — Launch Post Drafts

> **REVIEW NOTES (not for posting yet)**
>
> Tone target: **builder-honest** — first-person, concrete, no marketing words, willing to admit tradeoffs.
> Voice: Greg's, posting as the founder.
>
> **Account assignments:**
> - **Show HN + r/MCP + r/aiagents posts** — from Greg's PERSONAL accounts (HN: existing personal account; Reddit: existing personal account with karma history). Brand-new accounts get auto-removed by Reddit anti-spam and downvoted on HN. Personal-founder voice also reads as more authentic.
> - **X thread** — from `@keyvex_` (the official brand account, just created)
> - **`u/KeyVex_`** — Reddit brand account, reserved for: replying to comments under the launch threads, following people who engage, future official posts. NOT used for the launch posts themselves.
>
> **Channels & posting order (recommendation):**
>
> 1. **Show HN** — Tuesday or Wednesday morning ~7-8am ET. Best HN traction window. One shot.
> 2. **Reddit r/MCP** — same day, after HN.
> 3. **Reddit r/aiagents** — same day or next, slightly retuned.
> 4. **X thread** — same day, after HN traction starts. Threads compound when one or two early tweets get reposted.
> 5. **Optional**: r/algotrading, r/learnprogramming, r/fintech — only if first round lands well.
>
> **Pre-launch checklist before any of these go up:**
> - [ ] Privacy Policy live (banner-stripped version) at `keyvex.com/privacy`
> - [x] X account `@keyvex_` created (bare `@keyvex` was taken; underscore variant grabbed)
> - [x] Reddit account `u/KeyVex_` created (brand-protective only; not used for launch posts)
> - [ ] X profile finalized (KeyVex logo as avatar — currently placeholder; bio + `keyvex.com` link set)
> - [ ] u/KeyVex_ profile filled in (logo as avatar, bio, link)
> - [ ] Greg's personal Reddit account confirmed in good standing for r/MCP + r/aiagents posting (karma, no shadowban)
> - [ ] Greg's personal HN account confirmed for Show HN posting
> - [ ] Free tier signup flow working end-to-end
> - [ ] Anthropic MCP directory submission filed (in PR queue)
> - [ ] Loom demo video uploaded
> - [ ] DM target list pinged 24h before public post
>
> **What to change after Greg's review:**
> - Lock pricing language (currently a single one-liner near the end of each)
> - X handle locked: `@keyvex_` (underscore variant — bare `@keyvex` was taken)
> - Confirm signup URL (currently `keyvex.com` — may want a deeper link like `keyvex.com/signup`)
> - Confirm whether to mention Derek + Capital Edge dashboard sibling, or keep KeyVex standalone

---

## 1. Show HN

**Title** *(80 chars max — HN truncates)*:

```
Show HN: KeyVex – MCP server for US public financial disclosures
```

**Body** *(plain text, no markdown — HN strips most formatting)*:

```
Hi HN,

I built KeyVex because every existing financial-data MCP server I tried
was a thin shim over a pre-existing REST API. They ended up with
100-250 tools (one per endpoint), and any agent connecting to them
spent 30-50% of its context window just on tool definitions before it
could answer a single question.

KeyVex goes the other way. 12 tools. Each one is entity-based with
rich filters — get_insider_transactions, get_congressional_trades,
get_activist_stakes, get_federal_contracts, get_lobbying_filings,
etc. The agent picks a tool by what kind of thing it wants, not by
which URL slug to hit.

The 12 tools cover 13 distinct US public-disclosure sources:

  - SEC EDGAR: Form 4 (insider trades), Form 144 (planned sales),
    Form 3 (initial ownership), 13F (institutional holdings),
    Schedule 13D/13G (5%+ activist stakes), 8-K (material events),
    Form 278 (annual financial disclosure)
  - Congressional trades from Senate eFD + House Clerk PTRs
  - Federal contracts from USAspending.gov
  - Lobbying disclosures from the Senate LDA database
  - Current and historical legislators (1789-present) from the
    unitedstates/congress-legislators YAML

About 165,000 records across the collections, kept fresh by 13
autonomous Cloud Functions on Firebase. The data is normalized but
intentionally NOT scored — KeyVex is a publisher, not an investment
adviser. There's no convergence index, no "buy" rating, no derived
intelligence. You get the raw filings; you decide what to do with
them.

The thing I'm proudest of is the cross-source query pattern. An
agent can do this in one conversation:

  1. get_congressional_trades(ticker: "LMT")     # who traded LMT?
  2. get_member_profile(bioguide_id: <returned>)  # what committees?
  3. get_federal_contracts(recipient_name:
                            "Lockheed Martin")    # awards that
                                                  # followed?
  4. get_material_events(ticker: "LMT",
                         item_codes: ["1.01"])    # material agreements
                                                  # disclosed?

Four data sources, one conversation. With most existing MCP servers
this would either be impossible or require the agent to chain tens of
narrow API calls and lose context along the way.

What KeyVex doesn't do (yet):

  - No PDF asset/liability extraction from Form 278 (it's the next
    big v1.1 — extracting Schedule A line items would be unique
    coverage)
  - House Form 278 not yet scraped, only Senate
  - Some pre-2024 13D/G filings predate the structured-XML mandate
    and emit zero rows
  - Only ~25% historical coverage on smaller-cap activist filings
    (large-cap big-name coverage is solid: Vanguard's 9.47% AAPL
    13G/A from July 2025 is queryable)

Auth is bearer-token. There's a free tier (no credit card) for
exploration; paid tiers for production usage are tracked but not yet
billed (LLC formation in progress).

API endpoint: https://mcp.keyvex.com/api
Landing page: https://keyvex.com
Privacy policy: https://keyvex.com/privacy

Happy to answer questions about the architecture, the design choices
on tool surface, or anything else.
```

---

## 2. Reddit — r/MCP

**Title**:

```
Built an MCP server for US public financial disclosures (12 tools, 13 sources, agent-native by design)
```

**Body**:

```
A few months ago I started experimenting with the financial-data MCP
servers that already exist (Unusual Whales, FMP via wrappers, a couple
hobbyist ones). They all suffered from the same shape: a pre-existing
REST API got translated 1-to-1 into MCP tools, ending up at 100-250
tools per server. My agent's context filled up just listing tool
definitions.

KeyVex is my attempt at the opposite design. 12 entity-based tools
with rich filter parameters. Examples:

- `get_insider_transactions` — Form 4 trades, optionally with
  `include_baseline:true` to fold in matching Form 3 starting
  positions in the same response (so the agent gets deltas + anchor
  in one round trip).
- `get_congressional_trades` — merges Senate eFD + House Clerk PTRs
  into one tool with a `chamber` filter (mirrors how every aggregator
  including CapitolTrades, WhaleWisdom, Bloomberg presents this data —
  separating them was a Quiver-shaped antipattern).
- `get_activist_stakes` — Schedule 13D + 13G + amendments, with
  `is_activist` boolean to separate true activist filings from the
  passive Vanguard/BlackRock 13G firehose.

Each tool's description includes the kind of context an LLM actually
needs to make a good filter decision (e.g., the tool description for
`get_member_profile` includes the Thomas committee-code conventions
inline so an agent can compose `committee_id: "HSAS"` queries cold).

13 distinct disclosure sources covered, ~165K records:

  Form 4 / Form 144 / Form 3 / 13F / 13D-G / 8-K / Form 278 (Senate
  only for now), congressional trades both chambers, USAspending
  contracts, LDA lobbying filings, current + historical legislators.

Stack: TypeScript + MCP SDK + Firebase. Stateless HTTPS transport.
Bearer auth via Google Secret Manager. 13 autonomous Cloud Functions
keep the data fresh. esbuild bundle ~15MB on cold start.

Pure-publisher posture: no derived intelligence in tool outputs. No
convergence score, no "buy" signal. Just normalized filings.

API endpoint: https://mcp.keyvex.com/api (bearer auth)
Product page: https://mcp.keyvex.com
Landing: https://keyvex.com (free tier, no card)
Source-side notes: https://github.com/gregorywglenn-spec/Keyvex-API

Curious what the r/MCP audience thinks of the entity-based design.
Happy to dig into any specific tool's surface.
```

---

## 3. Reddit — r/aiagents (or r/AIAgents)

**Title**:

```
KeyVex: an MCP server that lets your agent triangulate public-disclosure data across 13 sources
```

**Body**:

```
Most US public-disclosure data is technically free — SEC EDGAR is
public, congressional trades are public, federal contracts are
public — but it lives in 13 different government systems with 13
different schemas and zero cross-referencing. If you want your agent
to ask "did this senator buy LMT before Lockheed got a big contract?"
you have to wire up multiple scrapers, normalize the data, and write
all the cross-source logic yourself.

KeyVex packages that into one MCP server. Connect it to Claude Desktop
(or any MCP client), authenticate with a bearer token, and your agent
can do this kind of thing in a single conversation:

> "Has anything weird happened with Lockheed Martin lately? Cross-check
>  congressional trades, federal contract awards, material disclosures,
>  and lobbying spend."

Behind the scenes, that one prompt fans out to four KeyVex tools:

  - get_congressional_trades(ticker: "LMT")
  - get_federal_contracts(recipient_name: "Lockheed Martin")
  - get_material_events(ticker: "LMT", item_codes: ["1.01", "8.01"])
  - get_lobbying_filings(client_name: "Lockheed Martin")

The agent assembles the picture. KeyVex just returns the raw filings.

Other things agents typically ask:

  - Find every Form 4 sale by Tim Cook over $1M in the last year
  - Show me Pelosi's most recent option-exercise PTRs
  - Who has 5%+ of NVDA right now? (returns Vanguard's recent 13G/A)
  - Pull all 8-K item 5.02 (executive change) filings from this week
  - Find every senator who sits on Banking Committee and has held
    Goldman Sachs in their disclosure

12 tools total, 13 disclosure sources, ~165K records. Free tier with
no credit card; paid tiers in flight.

I built this because every existing financial MCP I tried had been
bolted onto a pre-existing REST API and ended up with 100-250 tools
that filled my agent's context before it could even reason. KeyVex
is designed agent-first — tool surface deliberately small, each tool
deeply parameterized.

API endpoint: https://mcp.keyvex.com/api
Site: https://keyvex.com

Would love feedback from people building agents against this kind of
data. What query patterns are you running into?
```

---

## 4. X thread

*(11 tweets total. Each ≤ 280 chars. Numbered for clarity, but don't include the numbers when posting.)*

```
1/ Just shipped KeyVex — a Model Context Protocol server for US public
financial disclosures.

12 tools. 13 government sources. 165,000 records. Designed agent-first
from the ground up.

Why? Most existing financial MCPs are 100-250 tools and overwhelm
agent context. ↓
```

```
2/ Try this prompt with any MCP client connected to KeyVex:

  "Has anything weird happened with Lockheed Martin lately?"

The agent fans out across 4 KeyVex tools in one conversation:
- congressional trades
- federal contracts
- material 8-Ks
- lobbying filings

One question. Triangulated answer. ↓
```

```
3/ Sources covered (the 13):

SEC: Form 4 · Form 144 · Form 3 · 13F · 13D/G · 8-K · Form 278
Congress: Senate eFD + House Clerk PTRs · current + historical
  legislators (back to 1789)
Federal: USAspending contracts · LDA lobbying

All raw filings. All bearer-authenticated. ↓
```

```
4/ The wedge is the tool design.

Every existing financial-data MCP I tried bolted MCP onto a
pre-existing REST API. Result: 100-250 tools, one per endpoint, half
the agent's context burned just on tool definitions.

KeyVex is 12 entity-based tools. Each deeply parameterized. ↓
```

```
5/ Concrete example — `get_insider_transactions` accepts:

ticker, company_cik, officer_name (substring), transaction_type,
min_value, since, until, sort_by, sort_order, limit,
include_baseline (← folds in Form 3 starting positions in the same
response, no second tool call)

One tool replaces ~8 narrow REST endpoints. ↓
```

```
6/ Pure-publisher posture. No derived intelligence in any tool
output.

No convergence score. No "buy" rating. No proprietary signal weight.

Just normalized public filings. The agent (or the human reading the
agent's output) decides what to do with them.

Different product than Bloomberg. Cleaner legal posture. ↓
```

```
7/ Stack: TypeScript + MCP SDK + Firebase. Stateless HTTPS transport.
13 autonomous Cloud Functions keep data fresh. Bearer auth via Secret
Manager. esbuild bundle ~15MB cold.

Battle-tested across 7+ randomized realistic-load runs at ~85% data
hit rate, 0 query failures. ↓
```

```
8/ What's NOT there yet (being honest):

- Form 278 PDF asset extraction (next v1.1 — would be unique coverage)
- House Form 278 (Senate only for now)
- Pre-2024 13D/G filings (paper format, parser emits 0 rows)
- ~25% historical gap on small-cap activist filings (big-caps solid)
↓
```

```
9/ Free tier: no credit card, instant API key, 1k requests/month.
Paid tiers tracked but not yet billed (LLC formation in flight).

API endpoint: https://mcp.keyvex.com/api
Landing: https://keyvex.com
Privacy: https://keyvex.com/privacy
↓
```

```
10/ I'm Greg, building KeyVex.

Updates from @keyvex_ going forward.

Open to questions about the architecture, the cross-source query
patterns, or what data you wish was in there.
↓
```

```
11/ If you build agents that need US public-disclosure data — please
poke at it. Free tier is real; signup takes 30 seconds.

Endpoint again: https://keyvex.com

If you find a question your agent can't answer, that's the kind of
feedback I most want.

— end thread —
```

---

## 5. DM target list (seed — to expand)

> **REVIEW NOTES**: this is a starting cut. Goal: 10-20 indie-dev / fintech-AI / niche-newsletter accounts to reach out to *24 hours before* the public Show HN post. Not paid sponsorships — just heads-up to people who post about MCP / agents / fintech tooling, asking if they want a preview. Some will quote-tweet the thread or write a one-paragraph mention on their newsletter; that's how bottom-up launches compound.

**MCP / Anthropic ecosystem:**
- @AnthropicAI (general account — official channel)
- Mahesh Murag (Anthropic, original MCP designer — for genuine product feedback, not endorsement)
- Prompt engineering / agent-tool builders posting about MCP

**Fintech-AI / agent-builder accounts:**
- Anyone publishing on agentic finance use cases (signals, earnings, congressional)
- Quiver Quantitative team — they're in the same space (REST API not MCP) and friendly to coverage from adjacent products
- Founders of similar MCP-server projects (Slack MCP, Notion MCP, etc.) — peer-of-peer support

**Newsletters:**
- Latent Space (swyx) — picks up tooling launches
- TLDR AI — short blurb potential
- Ben Thompson / Stratechery — long shot but if they cover it, worth the long shot
- Niche fintech newsletters: Net Interest, Matt Levine (Bloomberg) — for signal-heavy uses
- AI coding newsletters: AI Tinkerers, Pragmatic Engineer

**Subreddits to brief mods (ask permission before posting):**
- r/algotrading mod team — confirm before posting
- r/quantfinance — confirm
- r/MCP and r/aiagents — should be fine without explicit pre-brief

**Ad-hoc:**
- Existing Capital Edge dashboard contacts (check with Derek)

> **Action item for Greg**: review which of these you'd actually feel comfortable DMing. Some require warm intros, some are cold-but-fine. We can tier this list once you've added/removed names.

---

## 6. Pre-launch warm-up post (optional, 1 week before)

If you want to soft-launch and build anticipation before the full Show HN, a 1-tweet teaser 5-7 days ahead of launch works well. Sample:

```
Building an MCP server for US public financial disclosures.

12 tools. 13 government sources. ~165K records. Cross-source queries
in one agent conversation.

Beta access free, soft-launching next week. DM me for early API key.

https://keyvex.com
```

This is purely optional — most successful launches just go cold straight to Show HN.
