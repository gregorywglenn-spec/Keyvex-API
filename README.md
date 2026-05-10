# KeyVex

The Model Context Protocol (MCP) server for **US public financial disclosures**.

Congressional trades, executive insider transactions, institutional holdings, activist stakes, federal contracts, lobbying spend, material events, planned insider sales, ownership baselines, annual financial disclosures, current and historical legislators with full committee assignments — every tool callable from Claude, Cursor, or any MCP-compatible agent through one Bearer-authenticated endpoint. Designed for AI agents from the ground up: fewer tools, smarter parameters, tool descriptions that help the agent decide *when* to use each one — not yet another REST API with MCP bolted on top.

**API endpoint:** `https://mcp.keyvex.com/api` (POST, Bearer auth) · **Health:** `https://mcp.keyvex.com/health` (no auth) · **Product page:** [mcp.keyvex.com](https://mcp.keyvex.com) · **Privacy:** [keyvex.com/privacy](https://keyvex.com/privacy)

---

## Why KeyVex

Every other financial-data MCP today wraps a pre-existing REST API and ends up with 100–250 tools that overflow agent context windows. KeyVex starts from the agent: **12 entity-based tools** with rich filter parameters — no separate `get_X` and `get_X_by_ticker` and `get_recent_X` variants.

**The wedge — one conversation, five sources, zero stitching:**

```
Agent: get_congressional_trades(ticker:"LMT", since:"2026-01-01")
→ 23 trades by senators and reps in Lockheed Martin
   (each row carries the trader's bioguide_id)

Agent: get_member_profile(bioguide_id:"C001035")  // Susan Collins, e.g.
→ party, state, district, committees, cross-reference IDs (FEC,
   OpenSecrets, ICPSR, Wikipedia)

Agent: get_federal_contracts(recipient_name:"Lockheed Martin", since:"2026-01-01")
→ 1,247 LMT contracts awarded by DoD, NAICS-coded

Agent: get_material_events(ticker:"LMT", item_codes:["1.01","2.01"])
→ Lockheed's recent material-agreement and acquisition 8-K filings

Agent: get_lobbying_filings(client_name:"Lockheed Martin", filing_year:2026)
→ LMT's lobbying spend, what issues, what agencies contacted
```

Five separate disclosure sources joined by `ticker` + `bioguide_id` + `recipient_name`. Triangulation that takes a Bloomberg terminal and an analyst — in a single AI agent and a few seconds.

---

## Tools

| Tool | Source | Refresh cadence |
|---|---|---|
| `get_insider_transactions` | SEC Form 4 (open-market insider trades) | Every 30 min |
| `get_initial_ownership_baselines` | SEC Form 3 (initial ownership baselines) | Hourly |
| `get_planned_insider_sales` | SEC Form 144 (planned-sale notices) | Hourly |
| `get_institutional_holdings` | SEC 13F-HR (quarterly fund holdings) | Every 4 hours |
| `get_activist_stakes` | SEC 13D / 13G + amendments (5%+ ownership) | Hourly |
| `get_material_events` | SEC 8-K (M&A, exec changes, earnings) | Hourly |
| `get_annual_financial_disclosures` | SEC Form 278 / Public Financial Disclosure (Senate eFD; House v1.1) | Weekly |
| `get_congressional_trades` | Senate eFD + House Clerk PTRs (chamber filter) | Daily 6 AM ET |
| `get_federal_contracts` | USAspending.gov (federal awards) | Daily |
| `get_lobbying_filings` | Senate LDA quarterly filings | Daily |
| `get_member_profile` | Current senators + reps with full committee assignments + cross-reference IDs (FEC, OpenSecrets, ICPSR, Wikipedia, etc.) | Weekly |
| `get_historical_member` | ~12,230 historical legislators 1789-present, with chronological terms | Monthly |

**12 tools, 13 disclosure sources.** Agents query by ticker, CIK, member name, bioguide ID, committee code (Library of Congress Thomas codes — e.g., `HSAS` for House Armed Services, `SSBK` for Senate Banking), date range, dollar threshold, and more.

A few design notes:

- **`get_insider_transactions` accepts `include_baseline:true`** to fold in matching SEC Form 3 initial-ownership rows in the same call (Form 4 = deltas, Form 3 = starting positions). One round trip; both pieces of context returned together.
- **`get_congressional_trades` merges Senate + House** into one tool with a `chamber` filter — mirrors how every aggregator (CapitolTrades, WhaleWisdom, Bloomberg) presents the data. Each row's `data_source` field discloses provenance (`SENATE_EFD_PTR` vs `HOUSE_CLERK_PTR`).
- **`get_annual_financial_disclosures` returns filing METADATA** in v1A (filer, date, URL to the report PDF). Agents follow `report_url` to read the asset / liability / income schedules. PDF parsing for net-worth roll-up lands in v1.1.
- **`get_member_profile` 0-hits fallback:** if a `bioguide_id` lookup returns 0 results, the member may have left office and exists only in `legislators_historical` — try `get_historical_member` instead.

---

## Public endpoint

| URL | Purpose | Auth |
|---|---|---|
| `https://mcp.keyvex.com` | Product landing page (HTML, browser-friendly) | — |
| `https://mcp.keyvex.com/api` | MCP JSON-RPC API endpoint (POST) | Bearer |
| `https://mcp.keyvex.com/health` | JSON status / tool count | — |

Auto-managed TLS via Let's Encrypt. The canonical Cloud Functions URL (`https://us-central1-capitaledge-api.cloudfunctions.net/mcp`) still works and serves the same backend.

### Health check (no auth)

```bash
curl https://mcp.keyvex.com/health
```

Returns server version + tool count + API endpoint as JSON.

### List tools (auth required)

```bash
curl -X POST https://mcp.keyvex.com/api \
  -H "Authorization: Bearer <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Call a tool

```bash
curl -X POST https://mcp.keyvex.com/api \
  -H "Authorization: Bearer <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/call",
    "params":{
      "name":"get_congressional_trades",
      "arguments":{"ticker":"NVDA","since":"2026-01-01","limit":25}
    }
  }'
```

A `Bearer <YOUR_KEY>` token is required for `tools/list` and `tools/call`. API keys are not yet self-serve; reach out for one during the preview period.

---

## Connect from Claude Desktop

The local stdio entry works today for development:

```json
{
  "mcpServers": {
    "keyvex-local": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/keyvex/src/index.ts"]
    }
  }
}
```

Drop that into your `claude_desktop_config.json` (location varies by install — Microsoft Store builds use `%LOCALAPPDATA%\Packages\Claude_<hash>\LocalCache\Roaming\Claude\claude_desktop_config.json`; standard installs use `%APPDATA%\Claude\claude_desktop_config.json`).

For the remote endpoint, one-click installation through Anthropic's MCP directory will be available once review completes.

---

## Stack

- **Language:** TypeScript on Node 20+
- **MCP SDK:** `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport for HTTP, StdioServerTransport for Claude Desktop)
- **Data layer:** Google Firestore via `firebase-admin`
- **Hosting:** Firebase Cloud Functions Gen 2, region `us-central1`
- **Auth:** API key in Google Secret Manager (`MCP_API_KEY`) for the public HTTP endpoint
- **Scrapers:** 13 autonomous Cloud Functions on cron — SEC EDGAR forms (4, 144, 3, 13F, 13D/G, 8-K, 278), Senate eFD + House Clerk PTRs, USAspending federal contracts, Senate LDA lobbying filings, current legislators YAML, historical legislators YAML. No human in the loop.

---

## Local development

```bash
npm install

# Verify Firestore credentials wire up correctly:
npx tsx src/scrape.ts ping

# Pull recent filings without saving:
npx tsx src/scrape.ts 8k AAPL
npx tsx src/scrape.ts senate 7
npx tsx src/scrape.ts house 7 --extract

# Pull and save to Firestore:
npx tsx src/scrape.ts senate 7 --save
npx tsx src/scrape.ts 8k-feed 1 --save

# Run the stdio MCP server (for Claude Desktop wiring):
npm run dev
```

For Firestore connectivity locally, drop a service account JSON at `secrets/service-account.json` (path is gitignored). The same code auto-detects the Cloud Functions runtime via `K_SERVICE` env var and uses Application Default Credentials there instead.

---

## Architecture

```
src/
├── tools/                 — one file per MCP tool (definition + handler)
├── scrapers/              — one file per data source (Senate, House, EDGAR forms, USAspending, LDA, ...)
├── server-setup.ts        — shared MCP-server tool-registration logic (used by both stdio and HTTP entries)
├── firestore.ts           — data layer with stub/live mode auto-detection
├── types.ts               — shared types
├── scrape.ts              — local CLI for invoking scrapers
└── index.ts               — stdio entry point (Claude Desktop)

functions/
├── src/index.ts           — Firebase Cloud Functions entry: 13 scheduled scraper functions + the `mcp` HTTP function + a `scheduledHealthCheck` Slack pinger
├── package.json           — minimal deps; rest bundled by esbuild
└── tsconfig.json          — extends parent, includes ../src
```

---

## Pure-publisher posture

KeyVex returns raw, normalized public-record data. **No derived signals, no convergence scores, no "buy"/"sell" language, no investment advice.** That keeps the product cleanly outside investment-advisor territory under the publisher's exemption (Lowe v. SEC, 1985). Agent consumers can layer their own analysis on top.

The Firebase project ID `capitaledge-api` is permanent infrastructure (Google does not allow renaming project IDs). The KeyVex brand is independent of that internal identifier; everything customer-facing reads as KeyVex.

---

## Status

Production. **12 MCP tools** at server v0.18.0, **13 autonomous scrapers** running on cron, **~165,000 records** across 13 Firestore collections.

- **API endpoint** `https://mcp.keyvex.com/api` — auto-managed TLS via Let's Encrypt. Stateless Streamable HTTP transport. Bearer auth via Google Secret Manager. Product landing page at `https://mcp.keyvex.com`; JSON health at `/health`.
- **Landing page** `https://keyvex.com` (apex + `www`) — auto-managed TLS.
- **Autonomous data freshness** — 13 Cloud Functions Gen 2 keep collections current on cadences from every 30 minutes (Form 4) to monthly (historical legislators). Cross-project health-check pings Slack daily.
- **Battle-tested** — 200+ randomized realistic-load queries at 84% data hit / 0 query failures / sub-1s avg latency. Big-cap activist coverage (Vanguard's 9.47% AAPL 13G/A from July 2025, etc.) verified via targeted issuer-CIK backfill.
- **Pre-launch** — public registry submissions (Anthropic / Smithery / Awesome-MCP / PulseMCP) and self-serve API key issuance are the immediate next milestones. Free preview tier available on request.

---

## Demo

> Loom walkthrough coming with launch — political-alpha cross-source query, ~5 minutes.

---

## License

Private. No license declared. Reach out if you'd like preview access.

## Contact

[contact@keyvex.com](mailto:contact@keyvex.com) · [keyvex.com](https://keyvex.com) · [@keyvex_](https://x.com/keyvex_) on X · [u/KeyVex_](https://www.reddit.com/user/KeyVex_) on Reddit
