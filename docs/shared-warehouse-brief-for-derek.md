# Shared Data Warehouse — Plan & Heads-Up for Derek

**From:** Greg (KeyVex / `capitaledge-api`)
**Re:** Both projects drawing raw government data from one shared store instead of scraping it twice
**Date:** 2026-06-03

## The short version
We're going to **stock the raw government data ONCE, in KeyVex's database (`capitaledge-api`), and have your project read from it** — instead of both of us running duplicate scrapers and keeping two copies. Your dashboard and your derived work (convergence scores, tax engine, all your secret sauce) stay 100% on your side; you just pull the *raw filings* from our shelves instead of scraping them yourself.

## Why (the honest backstory)
We just did a hard, source-by-source audit of KeyVex's data against the actual government sources, and found our scraped collections were badly incomplete — often **~1% of what the real source holds** (e.g. our lobbying table had 1 of Costco's 13 real filings; 12 of Lockheed's 673,000 contracts). The scrapers were only ever grabbing recent slices, never the full history. We're now fixing that properly: comprehensive backfills from the government bulk sources, each one verified against the source before it's called done.

That backfill makes the database **much larger**. It makes zero sense for both of us to store, scrape, and pay for the same massive dataset twice — so we consolidate the raw layer into one warehouse.

## How it works (plain version)
- A database lives inside one project — ours. Your project gets a **read-only key** (a service account with read access) and queries our collections like they were your own.
- **One set of scrapers** (ours) fills the shelves and keeps them topped off. Both storefronts — KeyVex's MCP and your dashboard — read from the same shelves.
- **Clean boundary:**
  - **KeyVex owns + fills + maintains the raw collections** (SEC filings, congressional trades, lobbying, contracts, FEC, etc.).
  - **You own everything derived** — convergence scores, tax engine, dashboard tables — computed *from* the raw shelves and stored in **your** project. We don't touch your collections; you read (not write) ours.
- Billing is already merged to the KeyVex account, so the cost of the shared warehouse is one pocket, not a split-the-bill problem.

## What changes for you
- You can **retire your duplicate raw-data scrapers** (the ones pulling the same SEC / congress / lobbying / contracts data we'll be maintaining).
- Point your dashboard's raw-data reads at our Firestore.
- Keep building your product on top — nothing about your derived layer changes.

## Important: sequencing — don't cut over yet
KeyVex's data is mid-repair. **Don't switch your dashboard to read from us until a given dataset is verified-complete on our side** — otherwise you'd just be reading from the same holes we're fixing. The plan:
1. KeyVex backfills + verifies each dataset against the source, foundation-first (no new features until the data is real).
2. As each dataset hits "verified-complete," we tell you, and you switch that one over.
3. Repeat until your dashboard runs entirely off our shared raw layer.

## The one honest tradeoff
This makes your product **depend on our data layer** — if our warehouse has a bad day, your dashboard feels it. In exchange, you stop scraping, storing, and paying for a second copy of identical data, and you get data that's actually complete and source-verified. Given the data is identical and about to get huge, we think that's clearly the right trade — but flagging it so you're in with eyes open.

## A couple of technical notes (for your Claude)
- Warehouse = `capitaledge-api` Firestore (region `us-central1`). Your project (`capital-edge-d5038`) is `nam5` — cross-region reads work fine, just slightly higher latency; not a real issue for a dashboard.
- For the genuinely massive set (federal contracts — hundreds of millions of rows), Firestore may not be the cheapest home; we may put the giant items in a cheaper bulk store and keep Firestore for the rest. We'll flag which is which as we go.
- Access will be least-privilege read-only (same pattern as KeyVex's own read-only MCP service account).

## What we need from you
1. Your **OK on the plan** and the boundary (you read raw, keep derived on your side).
2. Your project's **service-account details** so we can grant read access when the first dataset is ready.
3. A quick list of **which raw datasets your dashboard actually uses**, so we prioritize stocking those first.

— Greg
