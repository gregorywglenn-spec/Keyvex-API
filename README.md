# KeyVex

The Model Context Protocol (MCP) server for **US public financial disclosures**.

Congressional trades, executive insider transactions, institutional holdings, activist stakes, federal contracts, lobbying spend, material events, member profiles, FEC campaign finance, congressional bills, roll-call votes, OFAC sanctions, Federal Register rules, tender offers, private placements, mutual fund holdings, SEC enforcement, OTC dark-pool volume — every tool callable from Claude, Cursor, or any MCP-compatible agent through one Bearer-authenticated endpoint. Designed for AI agents from the ground up: fewer tools, smarter parameters, descriptions that help the agent decide *when* to use each one — not yet another REST API with MCP bolted on top.

![KeyVex unified_search demo — one tool call, ten collections, sub-second cross-source query](https://raw.githubusercontent.com/gregorywglenn-spec/Keyvex-API/main/marketing/site/demo.svg)

---

## Why KeyVex

Every other financial-data MCP today wraps a pre-existing REST API and ends up with 100–250 tools that overflow agent context windows. KeyVex starts from the agent: 28 entity-based tools, rich filter parameters, no separate `get_X` and `get_X_by_ticker` and `get_recent_X` variants. One of those tools — `unified_search` — fans out across the entire disclosure surface in one call (the demo above is real).

**The wedge — one conversation, every source that matters:**

```
Agent: get_congressional_trades(ticker:"LMT", since:"2026-01-01")
→ 23 trades by senators and reps in Lockheed Martin

Agent: get_member_profile(bioguide_id:"<each trader's id>")
→ party, state, committees — including who sits on Armed Services

Agent: get_roll_call_votes(legislation_type:"HR", since:"2026-01-01")
→ what defense-related bills those members actually voted on

Agent: get_federal_contracts(recipient_name:"Lockheed Martin", since:"2026-01-01")
→ 1,247 LMT contracts awarded by DoD

Agent: get_lobbying_filings(client_name:"Lockheed Martin", filing_year:2026)
→ LMT's lobbying spend, what issues, what agencies contacted

Agent: get_fec_candidate_profile(candidate_name:"<member name>", state:"<state>")
→ that member's FEC candidate ID + principal campaign committee
```

Six separate disclosure sources joined by `ticker` + `bioguide_id` + `recipient_name` + name. Or `unified_search(ticker:"LMT")` does the same fan-out in one call. Triangulation that takes a Bloomberg terminal and an analyst, in a single AI agent and a few seconds. No other MCP server combines these.

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
| `get_annual_financial_disclosures` | SEC Form 278 / Public Financial Disclosure (Senate eFD; House v1.1) | Weekly |
| `get_fec_candidate_profile` | FEC candidates + linked committees | Weekly Sunday |
| `get_tender_offers` | SEC Schedule TO (third-party + issuer tender offers) | Daily |
| `get_bills` | Congress.gov bills + resolutions (all 8 types) | Daily |
| `get_roll_call_votes` | House roll-call votes (Senate v1.1) | Daily |
| `get_otc_market_weekly` | FINRA OTC Transparency (ATS dark-pool volume) | Weekly Sunday |
| `get_private_placements` | SEC Form D (Reg D exempt offerings) | Daily |
| `get_enforcement_actions` | SEC + DOJ + CFTC + OCC + FDIC press releases | Daily |
| `get_nport_filings` | SEC Form N-PORT (mutual fund monthly holdings) | Daily |
| `get_registration_statements` | SEC Form S-1 / S-3 (IPO + shelf registrations) | Daily |
| `get_ofac_sdn` | US Treasury OFAC sanctions list | Daily |
| `get_federal_register_documents` | Federal Register (rules, proposed rules, notices, presidential documents) | Daily |
| `get_proxy_filings` | SEC Schedule 14A (DEF 14A annual / DEFM14A merger / DEFA / DEFR) | Daily 7:15 AM |
| `get_treasury_auctions` | US Treasury Bills / Notes / Bonds / TIPS / FRN auctions | Daily 7:30 AM |
| `get_economic_indicators` | BLS (employment / CPI / PPI / productivity) + FRED (rates / GDP / PCE / Fed balance sheet / sentiment) | Daily 8:45 AM (BLS) + 9 AM (FRED) |
| `get_oig_exclusions` | HHS-OIG List of Excluded Individuals/Entities (LEIE) | Monthly 5th |
| `get_consumer_complaints` | CFPB Consumer Complaint Database | Daily 8 AM |
| `get_fundamentals` | SEC EDGAR XBRL — income statement / balance sheet / cash flow per 10-K + 10-Q | Weekly Sunday 4 AM |
| `unified_search` | Cross-collection fan-out by ticker / bioguide_id / company_cik / recipient_uei | (federated, hits other tools' data) |

**28 tools, 28+ distinct disclosure sources.** All refresh autonomously on cron — no human in the loop.

### Notable tool extensions

`get_insider_transactions` accepts `include_baseline:true` to fold in matching SEC Form 3 initial-ownership rows in the same call (Form 4 = deltas, Form 3 = starting positions).

`get_fec_candidate_profile` accepts `include_committees:true` (default) to enrich each candidate with their linked FEC committees, principal campaign committee first — bridges a member name to the committee_id needed for (v1.1) Schedule A contributions lookups.

`get_annual_financial_disclosures` returns filing METADATA in v1A (filer, date, URL to the report PDF). Agents follow `report_url` to read asset / liability / income schedules. PDF parsing for net-worth roll-up lands in v1.1.

Several other tools follow the same v1A-metadata / v1.1-substantive-content split — `get_nport_filings`, `get_registration_statements`, `get_tender_offers`, `get_enforcement_actions`. Agents follow `primary_document_url` or `url` for the prose.

---

## Public endpoint

```
https://mcp.keyvex.com         — MCP API endpoint
https://keyvex.com             — landing page
```

Auto-managed TLS via Let's Encrypt on both. The canonical Cloud Functions URL (`https://us-central1-capitaledge-api.cloudfunctions.net/mcp`) still works and serves the same backend as `mcp.keyvex.com`.

### Health check (no auth)

```bash
curl https://mcp.keyvex.com
```

Returns server version + tool count as JSON.

### List tools (auth required)

```bash
curl -X POST https://mcp.keyvex.com \
  -H "Authorization: Bearer <YOUR_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Call a tool

```bash
curl -X POST https://mcp.keyvex.com \
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
- **Auth:** API keys in Google Secret Manager (`MCP_API_KEY` for the public endpoint, `FEC_API_KEY` for upstream api.data.gov calls)
- **Scrapers:** 20+ autonomous scrapers running on cron across the unified KeyVex operation. SEC EDGAR (Form 3 / 4 / 144 / 13D-G / 13F / 8-K / D / NPORT / S-1+S-3 / Schedule TO / Form 278), USAspending, Senate LDA, Senate eFD + House Clerk PTRs, bioguide + historical legislators, congress.gov (bills + roll-call votes), FEC (candidates + committees), FINRA OTC Transparency, OFAC sanctions, Federal Register, SEC + DOJ press releases. No human in the loop.

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
npx tsx src/scrape.ts form-d 2

# Pull and save to Firestore:
npx tsx src/scrape.ts senate 7 --save
npx tsx src/scrape.ts 8k-feed 1 --save
npx tsx src/scrape.ts ofac-sdn --save
npx tsx src/scrape.ts federal-register 3 --save

# Run a battle test across all 28 MCP tools:
npx tsx scripts/battle-test.ts

# Run the stdio MCP server (for Claude Desktop wiring):
npm run dev
```

For Firestore connectivity locally, drop a service account JSON at `secrets/service-account.json` (path is gitignored). The same code auto-detects the Cloud Functions runtime via `K_SERVICE` env var and uses Application Default Credentials there instead.

---

## Architecture

```
src/
├── tools/                 — one file per MCP tool (28 tools — definition + handler)
├── scrapers/              — one file per data source (SEC EDGAR forms, congress.gov, FEC, FINRA, OFAC, Federal Register, ...)
├── server-setup.ts        — shared MCP-server tool-registration logic (used by both stdio and HTTP entries)
├── firestore.ts           — data layer with stub/live mode auto-detection
├── types.ts               — shared types
├── scrape.ts              — local CLI for invoking scrapers
└── index.ts               — stdio entry point (Claude Desktop)

functions/
├── src/index.ts           — Firebase Cloud Functions entry: 18+ scheduled scraper functions
│                            (hourly SEC EDGAR + daily Congress/FEC/LDA/USAspending/Form D/
│                            Form 278/Schedule TO/Enforcement/NPORT/S-1+S-3/OFAC/Federal Register +
│                            weekly bioguide/FINRA OTC/FEC committees + monthly bioguide historical),
│                            the `mcp` HTTP function, and a `scheduledHealthCheck` Slack pinger.
├── package.json           — minimal deps; rest bundled by esbuild
└── tsconfig.json          — extends parent, includes ../src

scripts/
├── battle-test.ts         — 59-query battle test across all 28 MCP tools (re-runnable QA harness)
├── smoke-*.ts             — per-tool smoke tests using real-data IDs
├── count-*.ts             — per-collection Firestore counters
└── inspect-*.ts           — diagnostic scripts for data-state debugging
```

---

## Pure-publisher posture

KeyVex returns clean, normalized, query-ready data — parsed, ticker-resolved, schema-unified, shaped for direct use by your agent. **What we don't add: derived signals, convergence scores, "buy"/"sell" language, investment advice.** That keeps the product cleanly outside investment-advisor territory under the publisher's exemption (Lowe v. SEC, 1985). Agent consumers can layer their own analysis on top.

**Source-faithful, byte-exact, auditable.** Beyond not adding derived signals, KeyVex doesn't silently alter what SEC published. The source data carries its own quirks — perpetual-instrument sentinels (a `2050-12-31` on an instrument that has no calendar expiration), filer data-entry typos that SEC's primary filings accepted and that flow through the bulk extract. KeyVex preserves these byte-for-byte from SEC's record; runtime annotation via a `source_metadata` block on flagged rows labels the quirks as KeyVex's interpretation, never SEC's. **A consumer can audit any KeyVex record against EDGAR and find a byte-for-byte match.** A 19-row stratified spot-check against SEC primary XML returned 22/22 matches — strong directional evidence, not a census; see [`docs/handoff-phase-a-v4-count-check-arc-2026-05-25.md`](docs/handoff-phase-a-v4-count-check-arc-2026-05-25.md) Amendment 2 for the verification record.

What this looks like in a response:

```json
{
  "ticker": "...",
  "exercise_date": "2050-12-31",
  "expiration_date": "2050-12-31",
  "source_metadata": {
    "exercise_date":  ["sec_perpetual_sentinel"],
    "expiration_date": ["sec_perpetual_sentinel"]
  }
}
```

Read `exercise_date` and you get SEC's literal byte value; read `source_metadata.exercise_date` and you learn KeyVex's interpretation — assertive for known SEC conventions (`sec_perpetual_sentinel`), calibrated for inferred filer errors (`anomalous_year_likely_filer_entry`). Clean rows omit `source_metadata` entirely — presence is the signal. Each tool's description catalogs the conventions that apply to it; `get_insider_transactions` is the canonical example.

The Firebase project ID `capitaledge-api` is permanent infrastructure (Google does not allow renaming project IDs). The KeyVex brand is independent of that internal identifier; everything customer-facing reads as KeyVex.

---

## Status

Production. **28 MCP tools, 20+ autonomous scrapers** running on cron. MCP server deployed as an authenticated HTTPS endpoint at `https://mcp.keyvex.com` (TLS via Let's Encrypt). Cross-project health-check pings Slack with `[capitaledge-api]` prefix once daily.

A 59-query battle test across all 28 tools currently passes 0-error, 0-empty. Re-runnable via `npx tsx scripts/battle-test.ts`.

Custom domain (`mcp.keyvex.com`), public registry submissions (Anthropic / Smithery / Awesome-MCP / PulseMCP), and self-serve API key issuance are the next milestones. SEC Form 13H (large trader registration) is intentionally NOT covered — it's filed confidentially under SEA Rule 13h-1 with FOIA-exempt status and is not publicly indexed by EDGAR.

---

## License

Private. No license declared. Reach out if you'd like preview access.

## Contact

`contact@keyvex.com`
