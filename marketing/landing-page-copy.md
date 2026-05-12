# KeyVex — Landing Page Copy (Draft v1)

**Status:** working draft — pricing numbers reflect Greg's Claude's recommendation, swap when Greg + Derek lock final numbers.

**Tone:** technical, matter-of-fact. Speaks to indie devs primarily, fintech professionals secondarily. Avoids retail-investor framing.

**Audience priority:** indie devs building AI agents > small fintech firms / quants > broader financial researchers.

**Posture:** pre-launch / early-access. No live billing yet. CTA collects email for when paid tiers go live.

---

## Hero section

**Headline:**
> The MCP server for US public financial disclosures.

**Subheadline:**
> 13 distinct disclosure sources — congressional trades, insider transactions, institutional holdings, lobbying spend, federal contracts, member profiles, financial disclosures, and material events — all queryable by AI agents through one Bearer-authenticated endpoint.

**Primary CTA:**
> [ Get free preview access ] *(email signup form)*

**Secondary line under CTA:**
> 5,000 calls / month free. Paid tiers from $29/mo. No credit card required for preview.

---

## Section 1 — What KeyVex is

**Heading:** *One queryable surface for every public US financial disclosure that matters.*

KeyVex normalizes 13 distinct US public-record sources into a clean Model Context Protocol (MCP) server. Connect it to Claude, Cursor, your custom agent, or any MCP-compatible client. No scraping, no parsing, no schema-wrangling on your end.

**The 13 sources:**

1. **SEC Form 4** — open-market insider trades by officers, directors, and 10%+ holders
2. **SEC Form 144** — planned-sale notices (insider sells *before* they happen)
3. **SEC Form 3** — initial-ownership baselines (anchors Form 4 deltas to a starting position)
4. **SEC 13F** — quarterly institutional fund holdings
5. **SEC 13D / 13G** — activist + passive 5%+ ownership disclosures
6. **SEC 8-K** — material-event filings (M&A, exec changes, earnings, restructurings)
7. **Federal contract awards** — USAspending.gov data
8. **Lobbying disclosures** — Senate LDA quarterly filings
9. **Senate Periodic Transaction Reports** — eFD-filed senator + spouse + dependent trades
10. **House Periodic Transaction Reports** — Clerk-filed representative + spouse + dependent trades
11. **Current member catalog** — every sitting senator and representative, with full committee + subcommittee assignments
12. **Historical legislators** — every member who has ever served Congress (1789→present)
13. **Form 278 annual financial disclosures** — net-worth statements covering members' assets, liabilities, and outside income

Refreshed continuously by autonomous schedulers. No human in the loop.

---

## Section 2 — The cross-source play (the demo)

**Heading:** *One conversation. Five sources. Zero stitching.*

Most financial-data APIs give you one narrow view. KeyVex's tools are designed to chain. Here's a real query an agent can run in a single conversation:

```
Agent: get_congressional_trades(ticker:"LMT", since:"2026-01-01")
→ returns 23 trades by senators and reps in Lockheed Martin stock

Agent: get_member_profile(bioguide_id:"<each trader's id>")
→ returns party, state, committees — including who sits on Armed Services

Agent: get_federal_contracts(recipient_name:"Lockheed Martin", since:"2026-01-01")
→ returns 1,247 LMT contracts awarded by DoD

Agent: get_material_events(ticker:"LMT", item_codes:["1.01","2.01"])
→ returns Lockheed's recent material-agreement and acquisition 8-K filings

Agent: get_lobbying_filings(client_name:"Lockheed Martin", filing_year:2026)
→ returns LMT's lobbying spend, what issues, what agencies contacted
```

Five separate data sources, joined by ticker + bioguide_id + recipient_name. Triangulation that takes a Bloomberg terminal and an analyst would now takes a single AI agent and a few seconds.

No other MCP server exposes this combined surface today.

---

## Section 3 — How it works

**Heading:** *Connect in under five minutes.*

KeyVex is a stateless Streamable HTTP MCP server. Authentication is a Bearer token in the `Authorization` header. That's it.

**Endpoint:**
```
https://mcp.keyvex.com
```

**Health check (no auth required):**
```
curl https://mcp.keyvex.com
```

**Tool call (auth required):**
```
curl -X POST https://mcp.keyvex.com \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Connect from Claude Desktop:** add KeyVex to your `claude_desktop_config.json` as a remote MCP server with your bearer token. We'll have one-click installation through Anthropic's MCP directory once review completes.

---

## Section 4 — Pricing

**Heading:** *Pay for what you actually use. Generous free tier. No surprise overages.*

| | Hacker | Builder | Pro | Enterprise |
|---|---|---|---|---|
| **Price** | Free | $29/mo | $199/mo | Custom |
| **API calls / month** | 5,000 | 50,000 | 500,000 | Unlimited |
| **All 13 tools** | ✓ | ✓ | ✓ | ✓ |
| **Same data freshness as paid** | ✓ | ✓ | ✓ | ✓ |
| **Support** | Community | Email (48h) | Priority email (24h) | Dedicated + SLA |
| **Custom rate limits** | — | — | ✓ | ✓ |
| **Optional white-label** | — | — | — | ✓ |
| **Annual discount (2 mo free)** | — | $290/yr | $1,990/yr | Custom |

**Hard quotas, no overage charges.** When you hit your limit, requests are politely rejected until the next month or you upgrade. No bill shock.

**Same data, every tier.** We don't gate freshness or which tools you can call. The only difference between tiers is your monthly call quota and support response time.

> *(Note for Greg + Derek: numbers above are working defaults. Adjust before publishing.)*

---

## Section 5 — Who it's for

**Heading:** *Built for the people building tools, not for the people watching tickers.*

KeyVex isn't a dashboard. It isn't a stock-picker. It isn't an investing newsletter. It's pure data infrastructure for the people building the *next* generation of financial-research tools and AI agents.

**You'll like KeyVex if you're:**

- An indie dev building an AI agent that reasons over public financial disclosures
- A small fintech firm that needs clean, normalized SEC + congressional data without standing up your own scraping pipeline
- A quant researcher prototyping signals across multiple disclosure sources
- A product team adding regulatory-data context to an AI assistant
- An academic studying insider trading, congressional behavior, or market structure

**KeyVex is probably not for you if you want:**

- A pretty web dashboard with charts (try our sister product *(eventually)*)
- Real-time intraday market data (we cover *disclosed* trades, not live exchange feeds)
- Trading signals or buy/sell recommendations (pure-publisher posture — we provide facts, not opinions)
- Pre-built backtests (we're the data layer; you build on top)

---

## Section 6 — What we don't do (the honest list)

**Heading:** *Pure-publisher posture. Public-record data only. No opinions.*

KeyVex returns clean, normalized, query-ready data from official US government sources — parsed, ticker-resolved, schema-unified, and shaped for direct use by your agent. What we don't do is add derived signals on top:

- Generate trading signals, buy/sell recommendations, or "alpha scores"
- Provide investment advice of any kind
- Aggregate, score, or rank securities by inferred attractiveness
- Make claims about future performance

This isn't a marketing distinction — it's a deliberate legal posture (Lowe v. SEC, 1985) that keeps KeyVex cleanly outside investment-advisor territory. We do the data work; what you build on top of it is yours.

If you need derived intelligence (convergence scores, signal weights, ranked lists), our sister product *(coming)* layers analytics on top of the same data. KeyVex's API stays clean.

---

## Section 7 — FAQ

**Q: How fresh is the data?**

A: Most sources update within hours of being filed. SEC Form 4 (insider trades) within 30 minutes. 8-K material events hourly. Congressional PTRs daily at 6 AM ET. Lobbying disclosures daily. Quarterly filings (13F, lobbying) on their natural cadence with sub-day latency once filed.

**Q: Where does the data come from?**

A: Official US government sources only — SEC EDGAR, USAspending.gov, Senate eFD, House Clerk Office, Senate LDA, the unitedstates/congress-legislators public catalog. All public-record data. No paid data partnerships, no scraped paywalled content.

**Q: Is the data delayed for the free tier?**

A: No. All tiers get the same data freshness. Tiers differ only in monthly call quota and support response time.

**Q: Can I get historical data?**

A: We currently keep recent windows of each source in our queryable warehouse. Deeper historical backfills (multi-year) for specific tickers or agencies are an Enterprise-tier conversation — contact us.

**Q: What happens if I exceed my call quota?**

A: Requests are rejected with a 429 response until your quota resets at the start of the next month, or you upgrade. We don't auto-bill overages — no surprises.

**Q: How do I cancel?**

A: Self-serve cancellation from your account page. No phone calls, no retention specialists. Cancellation takes effect at the end of your current billing period.

**Q: Do I need a credit card to try the free tier?**

A: No. Email signup, get an API key, start querying. Credit card only required for paid tiers.

**Q: Is there an SLA?**

A: Best-effort uptime for Hacker / Builder / Pro tiers — we run on Google Cloud Functions Gen 2 with autonomous failover, but no formal SLA. Enterprise tier includes a contractual uptime commitment.

**Q: Can I self-host or get an export?**

A: Not currently. Enterprise customers can discuss custom-deployment options.

---

## Footer

**Email:** `contact@keyvex.com`

**API status:** [https://mcp.keyvex.com](https://mcp.keyvex.com) *(returns JSON; live status indicator coming)*

**Documentation:** [github.com/gregorywglenn-spec/Keyvex-API](https://github.com/gregorywglenn-spec/Keyvex-API) *(currently private; will be made public alongside launch)*

**Legal:** Terms of Service · Privacy Policy *(coming with LLC formation)*

**KeyVex is operated by [Company Name] LLC** *(pending formation)*. KeyVex is a data publisher, not an investment advisor. Nothing on this site or in API responses is investment advice. Use of this service is subject to our Terms of Service.

---

## Notes for Greg + Derek to discuss before publishing

**Things to lock in:**

1. **Final pricing numbers** — current draft uses Greg's Claude recommendation (Free 5k, Builder $29 / 50k, Pro $199 / 500k). Adjust as discussed.
2. **The "sister product" reference in Section 5 + 6** — should this name the dashboard explicitly (e.g., "KeyVex Dashboard"), describe it generically ("our analytics product"), or remove the reference until launch?
3. **Endpoint URL placeholder** — currently shows the real Cloud Functions URL alongside the future `mcp.keyvex.com` mapping. Once domain mapping is live, simplify to just `mcp.keyvex.com`.
4. **Email** — flipped to `@keyvex.com` (the `@capitaledge.app` inbox was retired on Day 8).
5. **Company name in footer** — "[Company Name] LLC" — fill in once the LLC paperwork lands.
6. **Make the GitHub repo public** — currently private; flip to public when ready for the world to read source. Repo URL is `Keyvex-API` (renamed 2026-05-07; old `CapitalEdge-API` URL still redirects).

**Things deliberately NOT included:**

- Customer testimonials (we have none yet — don't fake)
- Performance benchmarks vs. competitors (not relevant pre-launch)
- Specific record counts (those grow daily; quoting numbers makes the page age fast)
- The 14 MB function bundle / 5-10 sec cold-start details (technical implementation, not customer-facing)
- Anything requiring a UI screenshot we don't have
