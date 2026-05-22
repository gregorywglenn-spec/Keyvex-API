# Auth Decision Memo — 2026-05-22 (rewritten)

**For Greg, after 14 hours of OAuth pain that didn't need to happen.** This is the second draft. The first draft (which still led with OAuth options and treated `none` as an afterthought) was wrong. This one is built from the raw Anthropic auth doc pulled verbatim and read line by line.

---

## Bottom line

**KeyVex doesn't need OAuth.** Go authless (`none`). 2-3 hours of engineering. The WorkOS / Descope / Clerk chase was solving a requirement that doesn't exist. Anthropic's Connectors Directory supports authless servers out of the box, and KeyVex is the textbook fit for it.

---

## The source of truth (quote it; don't paraphrase it)

`https://claude.com/docs/connectors/building/authentication.md` — Anthropic publishes raw markdown of every doc page at `<url>.md`. The table below is copy-pasted directly from that file (fetched 2026-05-22, 14:24 UTC):

> | Type | Description | Availability |
> |---|---|---|
> | `oauth_dcr` | OAuth 2.0 with Dynamic Client Registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) | Supported out of the box |
> | `oauth_cimd` | OAuth 2.0 with [Client ID Metadata Document](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents) | Supported out of the box |
> | `oauth_anthropic_creds` | OAuth 2.0 with Anthropic-held client credentials | Contact `mcp-review@anthropic.com` |
> | `custom_connection` | Custom URL or credentials supplied at connection time (for example, Snowflake-style) | Contact `mcp-review@anthropic.com` |
> | `none` | No authentication (authless server) | Supported. An optional partial-auth mode is experimental. |
>
> User-pasted bearer tokens (`static_bearer`) are **not yet supported**.

That last line — "static_bearer not yet supported" — is the only part of the table the prior architecture doc got right. Everything else (DCR mandatory, no escape hatches) was assumption.

---

## Why `none` is the recommended path for KeyVex

KeyVex meets all three of the criteria that make authless the right shape:

- ✅ **All data is public.** Every record we serve is from SEC EDGAR, USAspending, FEC, congress.gov, FINRA, OFAC, FRED, etc. There's nothing user-specific to gate on. A query from an authenticated user and a query from an anonymous user return identical results.
- ✅ **No per-user accounts.** Today's `MCP_API_KEY` is a single shared key used by Greg, the founders, and anyone we've handed it to. It's a rate-limit/abuse token, not a tenant identifier.
- ✅ **No tier-gated tools in v1.** All 38 tools are available to anyone with the key. There's no Pro-only tool or Builder-only filter. The architecture-billing-and-auth.md doc planned that tiering as future work, not v1.

The OAuth pivot was building infrastructure for a problem KeyVex doesn't have today and may never have at the Directory tier.

---

## The 2-3 hour transition plan

### 1. Drop the bearer-key check in `functions/src/index.ts`

The current `mcp` `onRequest` handler rejects any request without `Authorization: Bearer <MCP_API_KEY>`. For `none`, that check becomes a no-op. Concretely (this is the diff shape — exact line numbers from current main):

```typescript
// REMOVE the constant-time key comparison + 401 short-circuit
// REMOVE the `mcpApiKey` reference from secrets:[...] (Secret Manager) — but
//   leave the secret itself in place; we may want it back for the paid tier
// KEEP the health-check at GET / (no auth either way)
// KEEP everything below the auth check: createMcpServer + applyToolHandlers
//   + StreamableHTTPServerTransport + transport.handleRequest(req, res, req.body)
```

### 2. Add abuse mitigation (this is the real work)

Without the key check, anyone on the internet can hammer `mcp.keyvex.com`. Cloud Run bills per request. Three layers, each cheap to add:

- **Cloud Run per-instance request limits** — already configurable in the `onRequest` options (`concurrency: 10` is already set). Drop `maxInstances` if it isn't already, or set it explicitly to cap blast radius.
- **Firebase App Check** — gates the function so only legitimate Claude clients (or any client with a valid Anthropic-issued attestation) can call. Strong defense, minimal end-user friction.
- **Per-IP rate limit via middleware** — `express-rate-limit` or equivalent. 100 requests / minute / IP is plenty for legitimate agent use; abuse hits the wall fast.

Pick two of three (App Check + per-IP is enough; per-instance cap is belt-and-suspenders).

### 3. Update the response shape (probably nothing)

`none` doesn't require RFC 9728 protected-resource metadata, doesn't require `WWW-Authenticate` headers on 401s (there are no auth 401s anymore), and doesn't require any new `/.well-known/*` endpoints. Less code, not more.

### 4. Submit to the Directory

Form at `https://clau.de/mcp-directory-submission`. Fields needed (from `submission.md` lines 119-132):

- Server basics — name, URL (`https://mcp.keyvex.com`), tagline, description, use cases
- Connection details — **auth type: `none`**, transport: Streamable HTTP, read/write: read-only
- Data & compliance — public-record data, no health data, category: Finance
- Tools list — 38 tools (all have `title` + `readOnlyHint: true` already per the v0.45.0 work; that effort wasn't wasted)
- Documentation — `keyvex.com/docs` already drafted on the `claude/gifted-ptolemy-cd665c` branch
- Privacy policy — `keyvex.com/privacy` is live
- Test credentials — for `none` this is just "the server URL works for anyone"
- Branding — logo + favicon (already wired into `marketing/site/`)

Review timeline per the doc: *"Review times vary with queue volume. The submission form is always open."* No SLA, but no OAuth-provider dependency either — once it ships, it ships.

---

## Documented fallbacks (only if `none` is somehow ruled out during review)

These are real options from the same doc, in order of preference:

1. **`oauth_anthropic_creds`** — vanilla OAuth 2.0 with NO DCR/CIMD. We create the `client_id` + `client_secret` in any OAuth 2.0 authorization server (Auth0, Keycloak, Firebase Auth + shim, even hand-rolled with `node-oauth2-server`), email them to Anthropic, Anthropic holds them and uses them in the user-consent flow. **The complexity that broke Descope (visual flow editor + DCR) doesn't exist on this path.** Email approval gate but documented and routine.

2. **`custom_connection`** — Snowflake-style. User pastes URL + credentials at connect time. Closest to our current bearer model. Also email approval.

3. **`oauth_dcr` / `oauth_cimd`** — what the WorkOS / Descope / Clerk pivots were targeting. Available out of the box if we needed it. We don't.

---

## What gets archived (do NOT merge these)

- **`claude/gifted-ptolemy-cd665c` branch** — carries the WorkOS v0.45.0 code (`functions/src/oauth.ts`, `functions/src/index.ts` dual-auth wire-up, `docs/architecture-billing-and-auth.md`). Some of it is salvageable (the public docs at `keyvex.com/docs`, tool annotations across all 38 tools, the architecture doc's general framing of identity vs billing). The OAuth-specific code is dead.

- **`docs/architecture-billing-and-auth.md`** — the source of the 14-hour cascade. Drafted 2026-05-20 without ever fetching the Anthropic auth doc. If kept, mark it `[DEPRECATED — see project_anthropic_directory_oauth.md memory file]` at the top.

- **The Clerk plan** — verified viable earlier today, but no longer needed. The notes I gathered (50K MAU free, DCR via dashboard toggle, JWT template syntax) are in the conversation history if a future paid-tier project ever needs them.

---

## What gets preserved from the WorkOS work

- ✅ **All 38 tool annotations** (`title` + `readOnlyHint`/`destructiveHint`) — required for Directory submission regardless of auth type
- ✅ **`marketing/site/docs/index.html`** — the public Auth section can be edited to describe the authless contract instead of OAuth, but the structure stays
- ✅ **README + landing-page copy** — describes 38 tools, the cross-source moat, the data sources. No auth-specific changes needed.

---

## What changed between this memo and the first draft

So you can see the verification gap:

| First draft (3 hours ago) | This draft (now) |
|---|---|
| Recommended OAuth or `custom_connection` (email approval gate) | Recommends `none` (out of the box) |
| Cited WebFetch summaries paraphrasing the Anthropic docs | Cites the raw markdown table from `authentication.md` verbatim |
| Treated `oauth_anthropic_creds` as just "another OAuth path" | Now flagged as the right fallback because it skips DCR/CIMD complexity (the thing that broke Descope) |
| Said `mcp.keyvex.com` could be in the Directory via `custom_connection` (special approval) | Now confirms `none` is out-of-the-box supported with zero approval gate |
| Bearer-token to non-Anthropic registries treated as the "ship today" win | Verified that those registries are independent of the Anthropic Directory and won't surface us in Claude (per `directory-vs-custom.md` line 80) |

What was missing on the first pass: I trusted the WebFetch summarizer instead of fetching the raw `.md` source. Three rounds of pushback from you forced me to the raw source. That pattern is now codified as a CORE PROTOCOL rule in memory and at the top of CLAUDE.md.

---

## Concrete next moves (in order, when you're ready)

1. **Confirm `none` is the right call.** If yes, the next four steps follow. If you want to keep the option of paid-tier OAuth open, the answer is still `none` for the public Directory listing — the paid tier lives on a separate URL anyway.

2. **Branch + commit the auth-removal change.** ~30 minutes of code. Drop the key check, add `express-rate-limit` or App Check (your call which), deploy to `mcp.keyvex.com`. The function will still be at v0.44.0 in the URL but the version constant bumps to v0.46.0 to mark the auth change.

3. **Smoke-test live.** `curl https://mcp.keyvex.com` with no Authorization header — should return health JSON, not 401. `curl -X POST https://mcp.keyvex.com -d '{"method":"tools/list",...}'` (same shape as before, minus the Bearer header) — should return the 38 tools.

4. **Submit to `https://clau.de/mcp-directory-submission`.** Fill the form per the field list above. Submit. Done.

5. **Email `mcp-review@anthropic.com`** as a courtesy: *"Submitted via the form today; KeyVex is `none`-type, serving 38 read-only public-data tools. Happy to provide context if it speeds review."* Not required, just helpful for queue visibility.

6. **Submit to the other 3 registries** (MCP Registry, Awesome-MCP, Smithery) as separate work — they don't surface us in Claude, but they reach Cursor / Continue / other agent ecosystems. Worth doing, just not the Anthropic-equivalent priority.

---

## The one rule that should never be bent again

**Before stating any fact that drives a decision, verify it with a tool call.** WebFetch summaries are paraphrases. Anthropic publishes raw `.md` for every doc page at `<url>.md` — fetch the raw source. Same for Stripe, Linear, Vercel, and most modern doc sites. Same principle for any other API, library, pricing page, or schema.

That rule is now anchored as the CORE PROTOCOL in `memory/feedback_verify_facts_dont_assume.md` and at the top of `CLAUDE.md`. The 14-hour cost is documented as the canonical failure case in both places so no future session can claim they didn't know what assumption-driven work costs you.
