# MCP Registry Submissions — Prep Notes

**Status:** ready-to-submit drafts. None of these have been submitted yet. Submit in the order below; each has its own approval lag.

**Why submit now (pre-LLC):** registry listings are free, don't display pricing, and don't require any legal entity. Approval lag is the long pole — start the clock now so we're listed when launch happens.

**Why NOT submit before custom domain mapping:** registries link directly to your endpoint URL. Submitting with the bare Cloud Functions URL works but looks unprofessional. **Recommend doing the `mcp.keyvex.com` domain mapping first** (~30 min including DNS propagation), then submitting registry entries pointing at the clean URL.

---

## 1. Anthropic Official MCP Directory (highest priority)

**What it is:** The first-party registry that powers the "Connectors" UI in claude.ai and Claude Desktop. Listed servers can be one-click installed by users. Highest legitimacy signal there is.

**Submission process:** GitHub PR to Anthropic's MCP server repository.

**URL:** https://github.com/anthropics/mcp-servers (verify exact path before submitting — Anthropic occasionally moves things)

**Approval timeline:** typically 5-15 business days. Anthropic reviews each submission for security + correctness + tool-description quality.

**What we submit:** A new entry in their server catalog YAML/JSON. Format varies; check the contributing guide in the repo.

**Draft entry:**

```yaml
- name: keyvex
  description: |
    US public financial disclosures as agent-native tools — congressional
    trades, insider transactions (Form 4), institutional holdings (13F),
    activist stakes (13D/G), planned insider sales (Form 144), federal
    contracts, lobbying disclosures, 8-K material events, and member
    profiles + committee assignments. Pure-publisher posture; no derived
    signals. 13 sources combined into one queryable surface.
  category: Financial
  url: https://mcp.keyvex.com
  homepage: https://keyvex.com
  documentation: https://github.com/<TBD>/keyvex#readme
  authentication:
    type: bearer
    header: Authorization
  pricing: freemium
  free_tier: 5000 calls/month
  contact: contact@keyvex.com
  tools:
    - get_insider_transactions
    - get_institutional_holdings
    - get_congressional_trades
    - get_planned_insider_sales
    - get_activist_stakes
    - get_federal_contracts
    - get_member_profile
    - get_material_events
    - get_lobbying_filings
```

**Pre-submission checklist:**

- [ ] Custom domain `mcp.keyvex.com` is mapped + serving HTTPS
- [ ] GitHub repo renamed `CapitalEdge-API` → `keyvex` (or pick final repo name)
- [ ] README is polished (the rewrite from v0.15.0 is a good start)
- [ ] `contact@keyvex.com` email is operational
- [ ] Health check at GET / returns clean version + tool list (already does)
- [ ] At least one demo (screenshot or recording) showing tool calls in action
- [ ] Privacy Policy exists at a public URL (Anthropic may require this for paid tiers; not strictly required for free preview)

**Risk:** if our endpoint is rate-limit-fragile or has uptime issues, Anthropic may reject or delist later. Our autonomous-pipeline + Cloud Functions setup is solid; this shouldn't be an issue.

---

## 2. Smithery (https://smithery.ai)

**What it is:** Third-party MCP registry. Popular with indie agent builders. Lower legitimacy than Anthropic's directory but faster approval and broader reach into experimental projects.

**Submission process:** Web form on smithery.ai. Some submissions are auto-approved if metadata is correct; others go through manual review.

**Approval timeline:** typically 1-3 business days for auto-approved; longer for manual review.

**Required metadata:**

- Server name: `keyvex`
- Display name: `KeyVex`
- Short description (1 sentence): `MCP server for US public financial disclosures — congressional trades, insider trades, 13F, lobbying, federal contracts, 8-K filings, member profiles.`
- Category: `Finance` or `Government Data` (pick the closest match in their taxonomy at submission time)
- URL: `https://mcp.keyvex.com`
- Authentication: Bearer token
- Pricing model: Freemium
- Source repo (optional): GitHub link
- Tags: `finance`, `sec-edgar`, `congress`, `insider-trading`, `lobbying`, `government-data`, `agent-tools`

**Pre-submission checklist:**

- [ ] All Anthropic-directory pre-submission items
- [ ] Smithery account created (free)

**Strategy:** submit 1-2 days after the Anthropic submission. If Anthropic approves first, the Smithery entry can reference Anthropic-Connector status which boosts trust signal.

---

## 3. PulseMCP (https://www.pulsemcp.com)

**What it is:** Aggregator that crawls and lists MCP servers from many sources. Self-submission is fast; auto-discovery is also possible if you're listed elsewhere first.

**Submission process:** simpler than Smithery — typically a single form with name, description, URL, tags.

**Approval timeline:** usually within 24 hours.

**Strategy:** submit last. Once Anthropic + Smithery have us, PulseMCP's discovery is partly automatic via their crawler — we may show up without active submission.

---

## 4. Awesome-MCP GitHub list

**What it is:** A community-curated list of MCP servers, structured as a markdown file in a GitHub repo. Lower-effort listing; high SEO value because the repo gets a lot of stars.

**URL:** https://github.com/punkpeye/awesome-mcp-servers (verify before submitting — the canonical "awesome-mcp" repo can shift)

**Submission process:** GitHub PR adding a one-line entry to the appropriate category section.

**Draft entry:**

```markdown
- [KeyVex](https://keyvex.com) - US public financial disclosures (congressional trades, insider trades, 13F, lobbying, federal contracts, 8-K filings, member profiles) — 13 data sources combined into one MCP server. Pure-publisher posture, no derived signals.
```

**Approval timeline:** depends on the maintainer. Typically days, sometimes weeks. Easy to check the open PR list to see if the repo is actively maintained.

**Strategy:** submit alongside Smithery. Low effort, decent SEO upside.

---

## Submission order

1. **Today / this week:** map `mcp.keyvex.com` domain + verify endpoint serves cleanly
2. **Same day after domain works:** rename GitHub repo if doing it; polish README hero example
3. **Day 1:** Anthropic MCP directory (PR submitted)
4. **Day 2-3:** Smithery + Awesome-MCP submissions
5. **Day 5+:** PulseMCP (or wait for auto-discovery)

Total elapsed: ~1 week of submission work, then 1-3 weeks of approval lag. Plan for full registry coverage by ~3 weeks from first submission.

---

## What NOT to do

- **Don't submit to multiple registries with different metadata.** Pick one canonical description / category / tag list and reuse it everywhere. Inconsistent metadata across registries makes you look hasty / low-quality.

- **Don't submit before the custom domain is mapped.** A `*.cloudfunctions.net` URL in a registry listing reads as "developer's hobby project," not "real product."

- **Don't submit before the LLC is formed if any registry asks about the operating company.** Most don't, but read the submission form before filling it out.

- **Don't list inflated record counts or feature claims.** Registries that catch this delist or mark you down.

- **Don't link to a placeholder landing page.** If `keyvex.com` shows the registrar parking page, fix that first. The domain mapping is wasted if the domain is empty.

---

## After submissions are in

While waiting for approvals, the high-leverage parallel work is:

- **Write the launch posts** (Twitter thread, Show HN, Reddit) — drafts ready to go the moment Anthropic approval lands
- **Build a 3-5 minute Loom demo video** showing the political-alpha cross-source query
- **DM target list** — 10-20 specific accounts (AI-tool builders, fintech-AI Twitter, niche newsletter writers) to outreach the moment we have something to point at

These three together drive the actual launch traffic. Registry listings make you findable; launch posts drive people to be findable.
