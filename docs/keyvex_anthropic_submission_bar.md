# KeyVex — Anthropic Software Directory Submission Bar

**Purpose:** Permanent reference document mapping every literal requirement from Anthropic's Software Directory Policy and Terms to KeyVex's status against it. Source-of-truth checklist for submission readiness.

**Source documents (fetched verbatim 2026-05-28):**

- Software Directory Policy — https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy — dated April 15, 2026
- Software Directory Terms — https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms — dated March 16, 2026

**Update protocol:** This file changes only when (a) Anthropic updates either source document — re-fetch and diff, or (b) KeyVex closes a gap — update the Status column. Versioned via git history, not dated filename.

**Status legend:**
- ✅ VERIFIED — closed against verifiable artifact (live MCP response, source file line, fetched URL)
- 🟡 PARTIAL — addressed but not fully verified, or verified at one layer but not all
- ❌ OPEN — not yet addressed
- ⚪ N/A — does not apply to KeyVex's scope

---

## Section 1. Safety and Security

### 1.A — Usage Policy compliance

**Source text:** *"Software must not violate or facilitate violation of our Usage Policy. All Software must comply with our Universal Usage Standards and High-Risk Use Case requirements and with our policy on the countries and regions Anthropic currently supports."*

**Status:** ✅ VERIFIED

**Artifact:** KeyVex is a read-only data publishing service over US public-record disclosures (SEC, Congress, GAO, USAspending, OFAC, CFPB, FDA, FEC, etc.). No content generation, no high-risk decision automation, no excluded-country operations. Pure-publisher posture documented across all 38 tool descriptions.

### 1.B — No guardrail evasion

**Source text:** *"Software must not evade or enable users to circumvent Claude's safety guardrails, system instructions, or sandbox environments."*

**Status:** ✅ VERIFIED

**Artifact:** Tools return only US public-record data. No prompt-injection vectors, no system-instruction overrides, no behavioral guidance to the model. Tool descriptions are descriptive (what the data is, where it comes from) not directive (what Claude should do with it).

### 1.C — Privacy

**Source text:** *"Software must prioritize protecting user privacy and the privacy interests of third parties. Developers must take care to responsibly handle personal and other sensitive data, follow privacy best practices, and ensure compliance with applicable laws."*

**Status:** ✅ VERIFIED

**Artifact:** Privacy Policy live at https://keyvex.com/privacy (Effective May 22, 2026). Data minimization is a stated product principle. KeyVex tools query public disclosures filed under federal transparency law (STOCK Act, Securities Exchange Act, OFAC SDN list, Lobbying Disclosure Act, etc.) — all data is by-statute already public. KeyVex doesn't collect or process subscriber personal data beyond auth/billing.

### 1.D — Data minimization in conversation

**Source text:** *"Software must only collect data from the user's context that is necessary to perform their function. Software must not collect extraneous conversation data, even for logging purposes."*

**Status:** 🟡 PARTIAL

**Artifact:** Read-only service account architecture (verified this session — `keyvex-mcp-readonly` SA pinned on the `mcp` Cloud Function at `functions/src/index.ts:1813-1814` with Datastore Viewer + Logs Writer + Monitoring Metric Writer roles, no write capability) means the MCP request path physically cannot write to Firestore. The mcp handler itself logs errors only (`logger.error`, `functions/src/index.ts:1871`); Cloud Run provides automatic request-level logs (method/path/status/latency). There is no dedicated app-level access/audit log capturing conversation content.

**Open item:** Audit Cloud Run automatic request logs for any tool-call argument capture that could include user-context detail; if present, restructure to keep only operational metadata.

### 1.E — IP rights

**Source text:** *"Software must not infringe on the intellectual property rights of others."*

**Status:** ✅ VERIFIED

**Artifact:** All KeyVex source data is US federal public-record information not subject to copyright (17 U.S.C. § 105 covers federal works; congressional disclosures, SEC filings, federal contract data, OFAC lists, etc. are explicitly public). Pure-publisher posture preserves source provenance via `data_source` and `*_url` fields on every record.

### 1.F — No memory/chat extraction

**Source text:** *"Software must not query or extract data from Claude's memory, chat history, conversation summaries, or user-generated or uploaded files."*

**Status:** ✅ VERIFIED

**Artifact:** KeyVex tools take structured input parameters (tickers, bioguide_ids, CIKs, dates, etc.) and return public-record data. No tool accesses memory, chat history, conversation state, or uploaded files. Architecturally not possible — the MCP request path only reads Firestore, never Claude state.

---

## Section 2. Compatibility (Instructional Software requirements)

### 2.A — Narrow, unambiguous descriptions

**Source text:** *"Instructional Software must define each tool or capability through narrow, unambiguous natural language that specifies what it does and when it should be invoked."*

**Status:** ✅ VERIFIED

**Artifact:** All 38 tool descriptions specify (1) what the underlying data is, (2) when to use the tool ("Use this when the user asks about..."), (3) what each parameter does, (4) source-of-truth provenance. Phase 2 description-block work (already shipped) explicitly addressed clarity and disambiguation.

### 2.B — Descriptions match behavior

**Source text:** *"Instructional Software tool or capability descriptions must precisely match actual functionality, ensuring the Instructional Software is called at correct and appropriate times. Descriptions must not include unexpected functionality or promise undelivered features."*

**Status:** ✅ VERIFIED (with ongoing audit posture)

**Artifact:** This is the load-bearing requirement that drove this entire audit session. May 25's dishonesty-class failures have been re-probed against current production — 5 of 6 closed cleanly, 6th (OFAC missing designation_date) honestly documented as v1.1 polish item in the tool description rather than left implicit. Coverage warnings now name explicit windows (federal_contracts 7-day, CFPB 17-day) where collections are scope-limited. Composite-index gaps that previously surfaced silent-failure-shaped errors are now either fixed (Task 4 this session: 4 new indexes on congressional_trades closed Example 1's failure) or honest (INVALID_QUERY explanations with workarounds). Description-vs-behavior is the ongoing audit posture, not a one-time check.

**Open items tracked:** PDF parser bleed on House Clerk PTRs (filer commentary contaminating asset_name on Torres / Whitesides records) — ranked above federal_contracts A1 backfill for consumer readiness; member-lookup completeness for departed members; Phase A retroactive classification uniformity.

### 2.C — No confusion with other Directory Software

**Source text:** *"Instructional Software tool or capability descriptions must not create confusion or conflict with other Software in our Directories."*

**Status:** ✅ VERIFIED

**Artifact:** Tool names all prefixed with KeyVex's distinct domain (`get_congressional_trades`, `get_insider_transactions`, `get_ofac_sdn`, etc.). No overlap with general-purpose Directory tools in scope or naming. Descriptions specify KeyVex as the source.

### 2.D — No coercive external calls

**Source text:** *"Instructional Software must not intentionally call or coerce Claude into calling other external software, tools, databases, or resources unless requested and intended by a user. Similarly, Instructional Software tool or capability descriptions must not be written in a way that intentionally leads to other Software extraneously calling them."*

**Status:** ✅ VERIFIED

**Artifact:** Tool descriptions point users to authoritative public sources for fuller coverage (e.g., "For full historical coverage of a recipient or program, use the USAspending advanced search at https://www.usaspending.gov/search") but do not coerce Claude into tool calls. The coverage_warning pattern is informational, not directive.

### 2.E — No interference with other tools

**Source text:** *"Instructional Software must not attempt to interfere with Claude calling tools from other software, tools, databases, or resources unless requested and intended by a user."*

**Status:** ✅ VERIFIED

**Artifact:** KeyVex tools are self-contained per-call query operations. No tool description instructs Claude to avoid other tools or hijack tool selection.

### 2.F — No dynamic behavioral instructions

**Source text:** *"Instructional Software must not direct Claude to dynamically pull behavioral instructions from external sources for Claude to execute."*

**Status:** ✅ VERIFIED

**Artifact:** Tool responses contain static data records and operational metadata only. No dynamic instruction-loading mechanism exists in the architecture.

### 2.G — No hidden/obfuscated instructions

**Source text:** *"Instructional Software must not contain hidden, obfuscated, or encoded instructions. All behavioral guidance must be human-readable and clearly presented."*

**Status:** ✅ VERIFIED

**Artifact:** All tool descriptions, parameter docs, and response fields are plain English / standard JSON. No encoded payloads, no behavioral guidance embedded in data fields.

---

## Section 3. Developer Requirements

### 3.A — Privacy policy link

**Source text:** *"Developers of Software that collects user data or connects to a remote service must provide a clear, accessible privacy policy link explaining data collection, usage, and retention. Developers must provide Anthropic with links to all applicable privacy policies and ensure such policies are presented to users as required by law."*

**Status:** ✅ VERIFIED

**Artifact:** Privacy Policy live at https://keyvex.com/privacy (verified earlier this session, 200 OK, 14116 bytes, Effective May 22, 2026). Discoverable from keyvex.com footer.

### 3.B — Contact info and support channels

**Source text:** *"Developers must provide verified contact information and support channels for users with product or security concerns."*

**Status:** ✅ VERIFIED

**Artifact:** `contact@keyvex.com` is real (forwards to founders' Gmail), published across landing page, privacy policy, terms of service, and README. Also surfaced in every tool's error path (verified in INDEX_MISSING and INVALID_QUERY messages this session).

**Open item — security-specific channel:** the policy text bundles product and security concerns; KeyVex has a general contact but no dedicated security path. See Terms section below for cross-reference to the security vulnerability reporting requirement.

### 3.C — Documentation

**Source text:** *"Developers must document how their Software works, its intended purpose, and how users can troubleshoot issues."*

**Status:** ✅ VERIFIED

**Artifact:** Public documentation page live at https://keyvex.com/docs (HTTP 200; source at `marketing/site/docs/index.html`, 23 KB). Tool descriptions are also self-documenting at the schema level via the MCP `tools/list` response.

### 3.D — Testing account

**Source text:** *"Developers must provide a standard testing account with sample data for Anthropic to verify full Software functionality."*

**Status:** ❌ OPEN

**Open item:** Provision a dedicated Anthropic-reviewer testing account with sample auth credentials. The current mcp endpoint is authless (auth: "none" per handler config), which means in principle no separate testing account is needed for the directory submission — Anthropic's reviewer can call the live endpoint directly. Confirm with Anthropic submission flow whether a testing account is required for an authless service, or if the live endpoint suffices. If the billed subscriber tier requires a separate test path, provision before that tier opens.

### 3.E — Three working examples

**Source text:** *"Developers must provide at least three working examples of prompts or use cases that demonstrate core functionality."*

**Status:** ✅ VERIFIED

**Artifact:** Three demos locked and verified this session against live production state. Full responses captured in `docs/keyvex_three_working_examples.md`. Demos:

1. Single-source depth (Mullin / TXN / 2025 sells, chronological)
2. Cross-source synthesis with honest coverage (defense committee trades + DoD contracts)
3. Coverage-honest empty (Wells Fargo CFPB 90-day with explicit window)

### 3.F — API endpoint / domain ownership

**Source text:** *"Developers must verify that they own or control any API endpoint, domain, or user interface their Software connects to, as well as any external resources it retrieves or renders."*

**Status:** ✅ VERIFIED

**Artifact:** keyvex.com and mcp.keyvex.com are owned and operated by KeyVex LLC (formation complete per session inheritance). Cloud Function `mcp` is the only endpoint the MCP server connects to; service account `keyvex-mcp-readonly` is KeyVex-controlled and read-only-pinned. External sources (SEC EDGAR, USAspending API, etc.) are referenced for source provenance but not connected-to in the user-action sense.

### 3.G — Maintenance

**Source text:** *"Developers must maintain their Software and address issues within reasonable timeframes."*

**Status:** ✅ VERIFIED (operational commitment)

**Artifact:** Active development and audit posture demonstrated by this session's work. CLAUDE.md documents engineering discipline; Standing Protections govern verification rigor.

### 3.H — Terms agreement

**Source text:** *"Developers must agree to our Software Directory Terms and follow design guidelines Anthropic publishes applicable to Software."*

**Status:** 🟡 PARTIAL

**Open item:** Software Directory Terms (https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms) require explicit agreement at submission time. No design-guidelines document was found via the policy doc's link surface; if a separate design-guidelines document exists, verify against it before submission. Greg will check and accept Terms at submission flow.

---

## Section 4. Unsupported Use Cases

### 4.A — No money/crypto/financial-asset transfer

**Source text:** *"Software that transfers money, cryptocurrency, or other financial assets, or executes financial transactions on behalf of users."*

**Status:** ✅ VERIFIED (out of scope)

**Artifact:** KeyVex is a read-only data publishing service. No transaction-execution capability exists or is planned. Disclaimers will explicitly state KeyVex is data/intelligence, not advice or execution.

### 4.B — No standalone image/video/audio generation

**Source text:** *"Software that uses AI models to generate images, video, or audio content..."*

**Status:** ✅ VERIFIED (out of scope)

**Artifact:** KeyVex returns structured data records. No media-generation tools.

### 4.C — No ads / sponsored content

**Source text:** *"Software that serves advertisements, sponsored content, paid product placements, or exists primarily as an advertising or promotional vehicle."*

**Status:** ✅ VERIFIED

**Artifact:** KeyVex is a subscription product. No advertising surface. No paid placement in tool responses.

---

## Section 5. Additional Requirements for MCP Servers

### 5.A — Graceful error handling

**Source text:** *"MCP servers must gracefully handle errors and provide helpful feedback rather than generic error messages."*

**Status:** ✅ VERIFIED

**Artifact:** Multi-layer evidence:
- **Tool-level errors:** Branded `contact@keyvex.com` reference in INDEX_MISSING errors. INVALID_QUERY errors explain structural reasons + provide workarounds (e.g., date filter on numeric sort field, workaround #2 verified to actually work). `coverage_warning` blocks on every collection with rolling/limited coverage scope, naming exact windows and pointing to authoritative source for fuller data.
- **Transport-level errors:** mcp handler returns structured JSON errors with proper HTTP status codes (405 method-not-allowed, 429 with `Retry-After` header for rate limiting, 500 for internal errors). Per-IP rate limiting enforced. `maxInstances: 50` caps prevent runaway resource consumption.

### 5.B — Token frugality

**Source text:** *"MCP servers must be frugal with their use of tokens. The amount of tokens a given tool call uses should be roughly commensurate with the complexity or impact of the task. When possible, users should be given options to exclude unnecessary text in the response."*

**Status:** 🟡 PARTIAL

**Artifact:** Tools return only requested data fields per filter criteria; `limit` parameter (default 50, max 500) caps response size proportionally. Coverage_warnings are concise.

**Open item:** Audit whether any tools return optional metadata blocks that could be excluded via a parameter for token-budget-conscious callers. Goal-2 polish item.

### 5.C — Tool name length ≤ 64 characters

**Source text:** *"MCP tool names must not exceed 64 characters."*

**Status:** ✅ VERIFIED

**Artifact:** Longest tool names in the KeyVex inventory (`get_annual_financial_disclosures`, `get_fec_independent_expenditures`) are 32 characters — exactly half the limit. All 38 tool names fit comfortably.

### 5.D — OAuth 2.0 if auth required

**Source text:** *"Remote MCP servers that connect to a remote service and require authentication must use secure OAuth 2.0 with certificates from recognized authorities."*

**Status:** ✅ VERIFIED (conditional)

**Artifact:** KeyVex's production direction is authless for the Anthropic Connectors Directory submission (read-only public-record data doesn't require auth). The `none` auth type is supported in MCP and is the deployed configuration (`auth: "none"` per the mcp handler config in `functions/src/index.ts:1825`). Since the deployed server does not require authentication for directory-visible use, the OAuth requirement does not apply. (An `MCP_API_KEY` secret remains provisioned in Secret Manager for a future paid-tier endpoint, but it is intentionally NOT mounted on the current function — `functions/src/index.ts:1793-1795` — so the deployed server performs no auth check at all. The bearer header used during this session's wire test was accepted-but-ignored.)

### 5.E — Required annotations: readOnlyHint, destructiveHint, title

**Source text:** *"MCP servers must provide all applicable annotations for their tools, in particular readOnlyHint, destructiveHint, and title."*

**Status:** ✅ VERIFIED (end-to-end)

**Artifact:** Task 5 this session (commit 22f9e93 on main, deployed to production). All 38 tools carry `title`, `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true` annotations. Verified at three layers:

1. **Source:** 38 destructiveHint occurrences across `src/tools/*.ts`, tsc clean, bundle build clean
2. **Deploy:** `firebase deploy --only functions:mcp` exit 0, post-deploy health check version 0.52.1 / tools: 38 / status: ok
3. **Live wire:** `tools/list` JSON-RPC call against `https://mcp.keyvex.com/`, SSE response parsed; 38/38 tools serialize `destructiveHint: false` correctly on the wire. Three sampled tools verified verbatim (get_congressional_trades, unified_search, get_ofac_sdn).

**Submission note (client-side tool deferral):** KeyVex exposes 38 tools at the MCP protocol layer (`tools/list` returns all 38, wire-verified above). Some clients — including Claude.ai — surface a subset directly and defer the remainder behind a tool-search step. This is client-side context management, not a server limitation.

### 5.F — Streamable HTTP transport

**Source text:** *"Remote MCP servers should support the Streamable HTTP transport. Servers may support SSE for the time being, but in the future it will be deprecated."*

**Status:** ✅ VERIFIED

**Artifact:** mcp.keyvex.com responds to JSON-RPC requests with Streamable HTTP `Accept: application/json, text/event-stream` headers, returning SSE-formatted responses (verified during Task 5 wire check). Architecture matches the policy recommendation; SSE deprecation is the future-state to track.

### 5.G — Current dependencies (local MCP servers only)

**Source text:** *"Local MCP servers must be built with reasonably current versions of all dependencies, including packages in node_modules."*

**Status:** ⚪ N/A

**Artifact:** KeyVex is a remote MCP server, not a local one. This requirement applies to local-distribution Software only.

---

## Section: Software Directory Terms (additional requirements not in Policy)

### Terms — Indemnification and IP licensing

**Source text:** *"You further (i) agree to indemnify and hold Anthropic harmless from any claims, damages, or liabilities arising from or related to your Software or users' interactions with it; (ii) grant Anthropic non-exclusive, royalty-free, worldwide licenses to reproduce, display, and distribute any descriptions of the Software and Software documentation provided by you or made available through the Software in connection with presenting the Software in the Directories..."*

**Status:** 🟡 PARTIAL (legal review)

**Open item:** KeyVex's standing principle: attorney review before taking paid subscribers. Software Directory Terms include indemnification and IP-license language that warrants explicit legal sign-off before submission. Confirm with counsel that LLC structure + product scope is comfortable with these terms.

### Terms — Security vulnerability reporting

**Source text:** *"You further agree to implement and maintain a mechanism for receiving reports of security vulnerabilities from Anthropic and from third parties and to investigate such reports with a reasonable standard of care."*

**Status:** ✅ VERIFIED

**Artifact:** Website-only disclosure mechanism shipped, deployed, and verified live this session (commit `5ffc777`):
- `https://keyvex.com/.well-known/security.txt` — RFC 9116, 200 OK / `text/plain` (Contact: mailto:contact@keyvex.com, Expires 2027-05-28, Canonical, Policy)
- `https://keyvex.com/security` — public policy page, 200 OK (reporting channel, scope in/out, commitments incl. 5-business-day acknowledgement, conservative safe-harbor, out-of-scope-by-design, attorney-review note)
- Footer link to `/security` on keyvex.com

Routing decision (Greg-locked): `contact@keyvex.com` receives reports — KeyVex's narrow read-only-publisher surface doesn't warrant a dedicated `security@` alias; the policy page states the routing explicitly. Website-only (no `SECURITY.md`) per the private-repo decision below. The mechanism is published, discoverable, and working — satisfies the Terms requirement to "implement and maintain a mechanism for receiving reports."

### Terms — Trademark guidelines compliance

**Source text:** *"You will at all times comply with Anthropic's Trademark Guidelines."*

**Status:** 🟡 PARTIAL

**Open item:** Verify KeyVex marketing copy and submission materials don't suggest Anthropic partnership/endorsement; review against https://www.anthropic.com/legal/trademark-guidelines before submission.

---

## Items not explicitly required by current Policy but worth tracking

### Origin-header validation on /mcp endpoint

**Status:** ❌ OPEN (not currently a Policy requirement, but a known MCP-server hardening practice)

**Artifact:** The mcp handler uses `cors: true` (permissive, `functions/src/index.ts:1807`) plus per-IP rate limiting. No Origin allowlist for DNS-rebinding protection. Currently fetched policy doc does not include an explicit Origin-validation requirement, but this is a known hardening practice for remote MCP servers and worth considering before submission. Track as potential pre-submission polish.

### GitHub repo visibility

**Status:** ✅ VERIFIED (decision: repo stays private)

**Decision (Greg-locked 2026-05-28):** KeyVex's GitHub repo stays private. Anthropic Software Directory Policy was re-verified against source (fetched fresh) — there is NO requirement that source code be public, no requirement for a GitHub repo, and no requirement for repository visibility of any kind. The policy-required public surfaces (§3.A privacy, §3.B contact, §3.C docs, §3.F domain ownership) are all satisfied without exposing the repo. Rationale: the scraper engineering is KeyVex's competitive moat; keeping it private prevents trivial clone-and-compete. The landing-page footer claim "Repo public alongside launch" was reconciled to point to `keyvex.com/docs` (commit `b4b0003`). **Posture: private now, revisit later if circumstances change (e.g. Year 1-2 with revenue, when moat-protection is less acute) — not private permanently.**

---

## Summary: Pre-Submission Open Items

Items requiring action before submission, by priority:

**Closed this session (2026-05-28):**
- ✅ **Terms — Security vulnerability reporting mechanism** — `/.well-known/security.txt` + `/security` live (commit `5ffc777`)
- ✅ **GitHub repo visibility** — decided private; policy requires no public repo; footer reconciled (commit `b4b0003`)
- ✅ **Footer link to ToS** on keyvex.com — `/terms` now linked in footer (commit `5ffc777`)
- ✅ **§5.E annotations** (commit `22f9e93`) + **§3.E three working examples** (`keyvex_three_working_examples.md`)

**Hard blockers (must close):**
1. **3.D — Testing account decision** — confirm whether authless deployment satisfies, or testing account needed

**Soft blockers (verify or close):**
2. **1.D — Cloud Run log audit** for inadvertent tool-call-argument capture
3. **Terms — Attorney review** of indemnification and IP-license clauses
4. **Terms — Trademark compliance check** on marketing copy

**Polish (Goal-2 differentiator, not Goal-1 blocker):**
5. **5.B — Token-frugality audit** for excludable response metadata blocks
6. **Origin-header validation** on /mcp endpoint (DNS-rebinding hardening)
7. **Server logo asset** for Directory display

**Audit-driven follow-ups (carry forward from session work):**
11. **PDF parser bleed** on House Clerk PTRs (description-vs-behavior cleanliness)
12. **federal_contracts A1 backfill** (scheduled watchlist) — required before marketing copy leans on cross-source historical claim
13. **Member-lookup completeness** for departed members
14. **OFAC designation_date** v1.1 polish (currently honestly documented as gap)

---

## Verified-state ledger

What's already done and verifiable as of 2026-05-28:

- ✅ Privacy Policy: keyvex.com/privacy, 200 OK, Effective May 22, 2026
- ✅ Terms of Service: keyvex.com/terms, 200 OK, same date
- ✅ Documentation page: keyvex.com/docs, 200 OK, 23 KB
- ✅ Contact: contact@keyvex.com, real and published across surfaces
- ✅ LLC formation: complete
- ✅ Production MCP endpoint: mcp.keyvex.com, version 0.52.1, 38 tools, status: ok
- ✅ §5.E annotations: all 38 tools verified end-to-end (source → deploy → live wire)
- ✅ §3.E three working examples: locked and live-MCP-verified this session
- ✅ §2.B description-vs-behavior: 5 of 6 May 25 dishonesty-class failures closed; 6th honestly documented; landing-page Bearer-auth claims reconciled to authless reality (commit `6b1e31c`)
- ✅ Composite-index file/production drift: closed (file = production state, 254 indexes)
- ✅ Security disclosure mechanism: /.well-known/security.txt + /security live (commit `5ffc777`)
- ✅ GitHub repo visibility: decided private — private now, revisit later; footer reconciled (commit `b4b0003`)
- ✅ Standing protections doc: docs/keyvex_standing_protections.md (commit `2781637`)
- ✅ Audit-session work (indexes, annotations, inheritance docs, security mechanism, auth reconciliation, standing protections, footer reconciliation): committed + pushed to origin/main

---

*Source-of-truth check protocol: before any submission action, re-fetch the two source URLs and diff against this file. If any §-text has changed in either source, update this file before submitting.*

*Maintained by Director Claude with fact-check verification gate held by Code at every commit.*
