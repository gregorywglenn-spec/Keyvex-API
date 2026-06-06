# KeyVex — Access Control, Anti-Theft & Billing (one system)

_Captured 2026-06-06. Status: **plan only — activate with Stripe, "really soon," not yet.**_

The key idea: **protecting the product and billing for it are the same machinery.** The API key that identifies a paying customer is the same key that rate-limits them, caps their results, and gets revoked if they abuse it. Build it once, at the Stripe rollout.

---

## The principle (why this is the shape)

We can't own the underlying facts — SEC/FEC/congressional data is public, and facts aren't copyrightable (*Feist*, 1991). Anyone may re-scrape the sources; that's KeyVex's own premise. So we don't protect the *facts* — we protect **the service, the compiled/cleaned work, and access to it.** Three layers:

1. **Legal** — Terms of Service (lawyer-drafted) prohibiting redistribution, resale, republishing, bulk extraction, and building a competing DB from KeyVex output. Our value-adds (ticker resolution, schema unification, dedup, date-correction interpretations) are protectable work product.
2. **Technical** — per-customer API keys + tiered rate limits + result caps + usage metering. This is the actual door.
3. **Proof** — fingerprinting/canaries to *prove* copying when it happens.

---

## The integrated architecture

```
Customer signs up (accepts ToS) ──► Stripe Checkout / subscription
        │
        ▼  Stripe webhook (Cloud Function)
   customer.subscription.created/updated/deleted
        │
        ▼  provision / update / revoke
   Firestore  customers/{id} = { keyHash, tier, stripeCustomerId,
                                 stripeSubId, status, createdAt }
        │
        ▼  every request to mcp.keyvex.com
   auth middleware: validate key → load tier → enforce limits → meter usage
```

### Components to build
1. **Tiers** — free / pro / business / enterprise. Each defines: requests/min + /month, max result size per call, which tools, passthrough access. (Config object, not code-per-tier.)
2. **API keys** — per customer, store only a **hash** in `customers/{id}`. Issued on payment.
3. **Auth middleware in `mcp`** — read `Authorization: Bearer <key>` → look up → attach tier → enforce. (The function already has `mcpApiKey` defined-but-unmounted from the 2026-05-22 authless decision — this is where it comes back, per-customer.)
4. **Rate limiting** — per-key for paid; per-IP for the free tier. (Firestore or in-memory token bucket.)
5. **Usage metering** — `meta/usage/{customerId}/{YYYY-MM}` counter; powers quotas + usage-based billing + bulk-extraction detection (anomalous paging spikes).
6. **Stripe** — Checkout (require ToS checkbox), products/prices per tier, **webhook handler** Cloud Function that provisions/updates/revokes keys on subscription events + handles `past_due`/`canceled` → suspend.
7. **Fingerprinting / canaries** — KeyVex already emits source-unique artifacts (`date_corrected`, `expenditure_date_source`, `source_metadata`, our specific ticker choices). If those appear in someone else's product, it's near-proof of copying. Add a few deliberate **canary records** (mapmaker "trap streets") for clean evidence. This layer is independent of billing — cheap insurance, can add anytime.

---

## The authless tension (must resolve at activation)

`mcp.keyvex.com` is **authless today** (Anthropic Directory requires auth type `none` for discoverability). Authless = the open door for bulk extraction. Resolution at Stripe time:

- **Free tier stays authless OR low-friction-keyed, but TIGHTLY limited** — low rate, small result caps (enough to evaluate, not to mirror). Keeps directory discoverability + lets agents try it.
- **Paid tiers = keyed**, full limits, passthrough access, bound by ToS.

So the directory keeps working; the value (and the bulk surface) sits behind keys.

---

## Phasing — decouple urgent anti-theft from the slower Stripe/bank dependency

- **Phase 0 (buildable now, no Stripe needed):** keyed auth + tiers + rate limits + usage metering + the tight free-tier caps. Keys issued **manually** at first. *This is the anti-theft layer and it can go live before billing is wired* — closes the open door immediately.
- **Phase 1 (when Stripe account is live):** Stripe Checkout + webhook → **automate** key issuance + subscription gating on top of the Phase-0 plumbing. Billing turns the manual key process automatic.

This matters: the *protection* doesn't have to wait on the bank-account → Stripe-account chain. If theft risk gets real before billing's ready, ship Phase 0 with manual keys.

---

## Dependencies (gating)
- ✅ LLC formed
- ⬜ Business bank account — pending (Greg + Derek)
- ⬜ Stripe account — needs the bank account
- ⬜ ToS — lawyer draft (pairs with the existing pure-publisher legal posture)

## Rough build estimate (engineering only, once we start)
- Phase 0 (auth + tiers + rate limit + metering + free-tier caps): ~1–2 focused sessions.
- Phase 1 (Stripe Checkout + webhook + automation): ~1–2 sessions once the Stripe account exists.
- Fingerprinting/canaries: a few hours, anytime.

**When we activate: read this doc first, then build Phase 0, then Phase 1 with Stripe.**
