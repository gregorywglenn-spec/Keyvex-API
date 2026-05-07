# KeyVex

The Model Context Protocol (MCP) server for **US public financial disclosures**.

Congressional trades, executive insider transactions, institutional holdings, activist stakes, federal contracts, lobbying spend, material events, and member profiles — every tool callable from Claude, Cursor, or any MCP-compatible agent through one Bearer-authenticated endpoint. Designed for AI agents from the ground up: fewer tools, smarter parameters, descriptions that help the agent decide *when* to use each one — not yet another REST API with MCP bolted on top.

---

## Why KeyVex

Every other financial-data MCP today wraps a pre-existing REST API and ends up with 100–250 tools that overflow agent context windows. KeyVex starts from the agent: nine entity-based tools, rich filter parameters, no separate `get_X` and `get_X_by_ticker` and `get_recent_X` variants.

**The wedge — one conversation, five sources, zero stitching:**

```
Agent: get_congressional_trades(ticker:"LMT", since:"2026-01-01")
→ 23 trades by senators and reps in Lockheed Martin

Agent: get_member_profile(bioguide_id:"<each trader's id>")
→ party, state, committees — including who sits on Armed Services

Agent: get_federal_contracts(recipient_name:"Lockheed Martin", since:"2026-01-01")
→ 1,247 LMT contracts awarded by DoD

Agent: get_material_events(ticker:"LMT", item_codes:["1.01","2.01"])
→ Lockheed's recent material-agreement and acquisition 8-K filings

Agent: get_lobbying_filings(client_name:"Lockheed Martin", filing_year:2026)
→ LMT's lobbying spend, what issues, what agencies contacted
```

Five separate disclosure sources joined by `ticker` + `bioguide_id` + `recipient_name`. Triangulation that takes a Bloomberg terminal and an analyst, in a single AI agent and a few seconds.

---

## Tools

| Tool | Source | Refresh cadence |
|---|---|---|
| `get_insider_transactions` | SEC Form 4 (open-market insider trades) | Every 30 min |
| `get_institutional_holdings` | SEC 13F-HR (quarterly fund holdings) | Every 4 hours |
| `get_congressional_trades` | Senate eFD + House Clerk PTRs | Daily 6 AM ET |
| `get_planned_insider_sales` | SEC Form 144 (planned-sale notices) | Hourly |
| `get_activist_stakes` | SEC 13D / 13G (5%+ ownership) | Hourly |
| `get_federal_contracts` | USAspending.gov (federal awards) | Daily |
| `get_member_profile` | Current senators + reps + committee assignments | Weekly |
| `get_material_events` | SEC 8-K (M&A, exec changes, earnings) | Hourly |
| `get_lobbying_filings` | Senate LDA quarterly filings | Daily |

`get_insider_transactions` accepts `include_baseline:true` to fold in matching SEC Form 3 initial-ownership rows in the same call (Form 4 = deltas, Form 3 = starting positions).

---

## Public endpoint

```
https://us-central1-capitaledge-api.cloudfunctions.net/mcp
```

A custom domain (`mcp.keyvex.com`) will be mapped on top of this URL once DNS work completes.

### Health check (no auth)

```bash
curl https://us-central1-capitaledge-api.cloudfunctions.net/mcp
```

Returns server version + tool count as JSON.

### List tools (auth required)

```bash
curl -X POST https://us-central1-capitaledge-api.cloudfunctions.net/mcp \
  -H "Authorization: Bearer <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Call a tool

```bash
curl -X POST https://us-central1-capitaledge-api.cloudfunctions.net/mcp \
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
- **Scrapers:** 12 scheduled Cloud Functions, each owning one data source, writing to its own Firestore collection. No human in the loop.

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
├── src/index.ts           — Firebase Cloud Functions entry: 12 scheduled scrapers + the `mcp` HTTP function + a `scheduledHealthCheck` Slack pinger
├── package.json           — minimal deps; rest bundled by esbuild
└── tsconfig.json          — extends parent, includes ../src
```

---

## Pure-publisher posture

KeyVex returns raw, normalized public-record data. **No derived signals, no convergence scores, no "buy"/"sell" language, no investment advice.** That keeps the product cleanly outside investment-advisor territory under the publisher's exemption (Lowe v. SEC, 1985). Agent consumers can layer their own analysis on top.

The Firebase project ID `capitaledge-api` is permanent infrastructure (Google does not allow renaming project IDs). The KeyVex brand is independent of that internal identifier; everything customer-facing reads as KeyVex.

---

## Status

Production. All 12 scrapers running autonomously on cron schedules in the `capitaledge-api` Firebase project. MCP server deployed as an authenticated HTTPS endpoint. Bioguide back-fill at 100% on congressional trades. Cross-project health-check pings Slack with `[capitaledge-api]` prefix once daily.

Custom domain (`mcp.keyvex.com`), public registry submissions (Anthropic / Smithery / Awesome-MCP / PulseMCP), and self-serve API key issuance are the next milestones.

---

## License

Private. No license declared. Reach out if you'd like preview access.

## Contact

`contact@capitaledge.app` (until `contact@keyvex.com` is operational).
