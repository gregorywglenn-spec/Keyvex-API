# KeyVex Architecture: Identity, Billing, and Stateless MCP Tier Enforcement

**Status:** Draft — verified against authoritative WorkOS, Stripe, and MCP-spec docs as of 2026-05-20. Items marked `[VERIFIED]` carry a citation; items marked `[VERIFY]` are genuine open questions to resolve during implementation.

**Why this file exists:** to avoid assumption-driven rewrites later. Several earlier proposed architectures (Firebase Stripe extension, OIDC federation into Firebase Auth) made plausible-sounding claims that did not survive contact with the actual docs. This file is the canonical reference; reopen it before re-litigating any decision below.

---

## 1. Core architectural pillars

| Layer | Component | Strict responsibility |
|---|---|---|
| **Identity & Auth Server** | **WorkOS** | Human dashboard login (AuthKit). OAuth 2.1 + PKCE authorization for MCP clients via WorkOS Connect. Source of truth for user identity. |
| **Billing engine** | **Stripe Billing** | Hosted Checkout (subscription creation), hosted Customer Portal (upgrades / downgrades / cancellations), recurring invoicing, payment-method handling. |
| **Resource layer** | **KeyVex MCP Cloud Function** (`mcp.keyvex.com`) | OAuth 2.1 *resource server*. Validates tokens from WorkOS JWKS, reads tier claim from JWT, gates tool execution. Per-customer state lives in the token, not in a database lookup. |

Firebase Auth is **not** in the identity layer. See section 4.

---

## 2. End-to-end lifecycles

### 2A. Customer registration and subscription

1. Customer visits `keyvex.com`, signs up via **WorkOS AuthKit** hosted login flow.
2. Customer is now authenticated with a WorkOS user record. Their identifier is the WorkOS user ID (format: `user_01HGH...`).
3. Customer clicks "Subscribe" → KeyVex backend creates a **Stripe Checkout Session**, passing the WorkOS user ID as Stripe's `client_reference_id` so the eventual webhook can map back to the right user.
4. Customer completes payment on Stripe's hosted page. Stripe creates a subscription and the trial begins (Pro tier, 14-day trial set via `subscription_data.trial_period_days: 14` on the Checkout Session — *not* on the price, since Stripe's price-level trial field is now Legacy).

### 2B. Tier sync — Stripe → WorkOS metadata → next token carries the new tier

1. Stripe emits one of: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, or `invoice.payment_failed`.
2. KeyVex webhook handler (Firebase Cloud Function) catches the event. It verifies the Stripe webhook signature, extracts `client_reference_id` (the WorkOS user ID), and determines the new tier (`pro` / `builder` / `free`) from the subscription's active price.
3. Webhook handler calls the WorkOS Node SDK to update the user's metadata:

   ```ts
   // [VERIFIED] WorkOS Node SDK — user-management update
   // Source: https://workos.com/docs/reference (user-management update endpoint)
   await workos.userManagement.updateUser({
     userId: workosUserId,
     metadata: { tier: 'pro' },
   });
   ```

4. WorkOS evaluates its **JWT Template** when issuing the *next* access token to any OAuth client (Claude Desktop, Cursor, the dashboard SPA). The template injects the current value of `user.metadata.tier`:

   ```json
   {
     "sub": "user_01HGH...",
     "keyvex_tier": "{{ user.metadata.tier | default: 'free' }}"
   }
   ```

> **[VERIFIED]** JWT Templates render against current user/organization context *at the moment of token issuance*. Quote from the WorkOS docs: *"JWT templates are comprised of a template string which is rendered with the user and organization context after a user successfully authenticates."*
> Source: [WorkOS JWT Templates docs](https://workos.com/docs/authkit/jwt-templates)

> **[VERIFIED]** WorkOS user metadata supports partial updates via the Node SDK. *"Updates to metadata are partial, meaning that you only need to include the metadata attributes that you want to update."*
> Source: [WorkOS user metadata docs](https://workos.com/docs/user-management/metadata/introduction)

### 2C. MCP tool-call authorization (the AI layer)

1. Customer opens Claude Desktop (or Cursor, or another MCP client) and adds the KeyVex connector.
2. The MCP client fetches KeyVex's `/.well-known/oauth-protected-resource` metadata endpoint, discovers WorkOS as the authorization server, and initiates an OAuth 2.1 authorization code flow with PKCE against WorkOS.
3. WorkOS prompts the customer to authorize the specific MCP client (Claude Desktop) to act on their behalf. **Consent is per-client-app**, not per-account — connecting from Cursor later will require a separate consent flow for Cursor as a distinct client.
4. WorkOS issues a short-lived access token. The token's payload includes the compiled `keyvex_tier` claim from the JWT Template (whatever tier the customer was at the moment of issuance).
5. The MCP client calls a KeyVex tool. The `mcp.keyvex.com` Cloud Function:
   - Validates the JWT signature against WorkOS JWKS.
   - Reads `payload.keyvex_tier` directly from the verified token. No database round-trip.
   - Gates tool execution: Pro-tier tools require `keyvex_tier === 'pro'`; Builder-tier tools require `keyvex_tier in ('builder', 'pro')`.

This is the "stateless tier resolution" property: the tier is in the token, so the MCP server never needs to query Firestore on the hot path.

> **[VERIFIED]** Both **CIMD** (Client ID Metadata Document — added to the MCP spec in November 2025) and **DCR** (Dynamic Client Registration) are supported by WorkOS for MCP clients. Both are enabled in the **WorkOS Dashboard → Connect → Configuration** panel. CIMD is off by default; we will enable it. DCR is enabled alongside it for backwards-compat with MCP clients that have not yet adopted CIMD.
> Source: [WorkOS AuthKit MCP docs](https://workos.com/docs/authkit/mcp)

---

## 3. The Stripe-side configuration (already built in sandbox)

| Object | Value |
|---|---|
| Stripe account | `acct_1TYw9pLQfk9leLGn` (sandbox) |
| Pricing model | Flat rate · Recurring · Prebuilt Checkout (Stripe-hosted) |
| Product: **KeyVex MCP — Builder** | `prod_UY4Ggn9XMeQEoE` · $29 / month (Default price) + $290 / year |
| Product: **KeyVex MCP — Pro** | `prod_UY4NELcDq4pldC` · $199 / month + $1,990 / year |
| Trial | **Set in Checkout Session code** (`subscription_data.trial_period_days: 14`), *not* on the price. Stripe's price-level trial is now a Legacy field. |
| Customer Portal | Plan-switching enabled between Builder ↔ Pro. Cancellations effective at period end. |
| Enterprise | Contact-Sales, no Stripe product yet. |
| Stripe Tax | Product enabled, configuration deferred to CPA. |

The mapping back to WorkOS is via **`client_reference_id`** on the Checkout Session — KeyVex's webhook reads it to know which WorkOS user the subscription belongs to.

---

## 4. Explicitly rejected: Firebase Stripe Extension

We evaluated the [`invertase/firestore-stripe-payments`](https://extensions.dev/extensions/stripe/firestore-stripe-payments) extension and **rejected it.** The reasoning, recorded so future-us doesn't reopen it:

1. **Identity coupling.** The extension is hard-coupled to Firebase Auth: it reads and writes paths at `customers/{firebase_uid}/...`, sets `stripeRole` custom claims on Firebase Auth tokens, and assumes the user is already authenticated through Firebase Auth.
2. **WorkOS is the OAuth AS for MCP, not Firebase Auth.** The MCP spec requires OAuth 2.1 with user-consent flow — Firebase Auth alone does not satisfy this for third-party MCP clients. WorkOS does. So WorkOS *must* be in the stack.
3. **Forcing both creates a sync nightmare.** If we use the extension, we have to bridge tier claims out of Firebase Auth custom claims and into WorkOS user metadata anyway — because the MCP function validates WorkOS-issued tokens, not Firebase-issued tokens. That bridge is essentially the custom webhook we'd write without the extension. The extension stops adding value once you write the bridge.
4. **A custom webhook is small.** The webhook handler that updates WorkOS metadata from Stripe events is on the order of 100–200 lines of TypeScript. The extension would save maybe 50 lines net once the bridge is factored in. Not worth the architectural drag.

**Conclusion:** the extension is the right tool for Firebase-Auth-native stacks. KeyVex is not one. We write the webhook directly.

---

## 5. Implementation `[VERIFY]` checklist

These are honest unknowns that need resolution during the implementation phase. None of them invalidate the architecture; they're refinements.

### `[VERIFY 1]` Tier-change propagation delay

**The question:** when a customer downgrades from Pro to Builder mid-session, their WorkOS metadata updates instantly via the webhook. But their *currently-issued* MCP access token still carries `keyvex_tier: 'pro'` until it expires (WorkOS default is ~15 minutes for access tokens, longer for refresh-based sessions).

**The options:**
- (A) Accept the grace window (industry-standard practice — most SaaS lets active sessions ride to expiry).
- (B) Implement a revocation list in the MCP function (Redis-backed or Firestore-backed) so `mcp.keyvex.com` can deny a token whose user has downgraded, even if the JWT is still cryptographically valid.

**Resolution path:** start with (A) for v1. Revisit if customer feedback or abuse patterns surface.

### `[VERIFY 2]` CIMD vs DCR client behavior in practice

**The question:** when Claude Desktop (or Cursor) connects to KeyVex, does it use CIMD (the modern Nov 2025 spec) or DCR (the older mechanism)? This affects whether the user sees any unexpected client-registration prompts.

**Resolution path:** during pre-launch testing, connect from at least three MCP clients (Claude Desktop, Cursor, one other) and observe which mechanism each uses. With both CIMD and DCR enabled in WorkOS Connect, every current client should work — but we want to *see* it work, not just assume.

### `[VERIFY 3]` Webhook idempotency under retry

**The question:** Stripe retries failed webhooks. If KeyVex's handler partially succeeds (e.g., updates WorkOS metadata but fails to write a local audit record), the retry could re-run the WorkOS update. WorkOS metadata updates are idempotent on the value (setting `tier: 'pro'` twice is harmless), but any per-event side effects (e.g., logging) need explicit idempotency guards.

**Resolution path:** store processed Stripe event IDs in Firestore at the start of the handler; skip if already seen. Standard pattern.

### `[VERIFY 4]` Exact JWT Template syntax for the tier claim

**The question:** WorkOS JWT templates use Liquid-like syntax. The example I gave above uses `{{ user.metadata.tier | default: 'free' }}` — the exact filter / null-handling syntax needs to match WorkOS's actual template engine (per the docs, null-evaluating expressions are *removed* from the output rather than defaulting, so the explicit `default` filter may not be necessary).

**Resolution path:** when configuring the template in the WorkOS Dashboard, test both the populated case (paid user) and the null case (free user / no metadata set) and confirm the resulting JWT shape on both.

### `[VERIFY 5]` Trial-period downgrade behavior with the Customer Portal

**The question:** if a customer signs up on Pro with a 14-day trial, switches to Builder via the Customer Portal on day 7, what does Stripe actually do at day 14? Does the trial extend to Builder, end early, or convert at the Builder price? This shapes the trial UX and our communication.

**Resolution path:** test this exact scenario in the Stripe sandbox before going live. Inspect the resulting subscription state and the webhook events emitted.

---

## 6. Open question intentionally outside this doc

Per-customer **API key issuance** (the long-tail alternative for customers who want programmatic access without going through an OAuth flow each session) is a related but separate concern. WorkOS is the OAuth path for MCP clients; if we add programmatic API keys for direct REST consumers, those are managed separately (likely also in WorkOS as long-lived tokens, or via a custom key-management table keyed by WorkOS user ID). Decide when there's actual demand.

---

## 7. References (all verified URLs)

- [WorkOS JWT Templates — AuthKit docs](https://workos.com/docs/authkit/jwt-templates)
- [WorkOS user metadata — User Management docs](https://workos.com/docs/user-management/metadata/introduction)
- [WorkOS AuthKit MCP support](https://workos.com/docs/authkit/mcp)
- [WorkOS API reference (Node SDK)](https://workos.com/docs/reference)
- [Stripe Checkout Session `client_reference_id`](https://stripe.com/docs/api/checkout/sessions/create)
- [Stripe webhook events for subscriptions](https://stripe.com/docs/api/events)
- [MCP authorization spec (2025-11-25 revision)](https://modelcontextprotocol.io/specification/draft/basic/authorization)

---

## Document history

- **2026-05-20** — Initial draft. Verified the core load-bearing claims (JWT Templates dynamic-at-issuance, user-metadata API shape, CIMD + DCR support in WorkOS) against the WorkOS docs cited above. Rejected the Firebase Stripe extension with reasoning. Five honest `[VERIFY]` items remain — all implementation-detail, none architectural.
