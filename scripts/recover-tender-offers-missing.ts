/**
 * RECOVER-TENDER-OFFERS-MISSING — ingest the 31 SC TO filings the FTS backfill
 * dropped (it hit EDGAR FTS's 10k-results-per-query cap on busy windows). The
 * EDGAR full-index reconciler (G1) found them; here we re-query FTS NARROWLY
 * (per CIK + form, which returns a handful) and run each hit through the same
 * normalizeHit the scraper uses, so the recovered records are byte-identical in
 * shape. Idempotent (saveTenderOffers keys on accession_number).
 *
 *   npx tsx scripts/recover-tender-offers-missing.ts            # dry run
 *   npx tsx scripts/recover-tender-offers-missing.ts --save
 */
import "../src/load-secrets.js";
import { readFileSync } from "node:fs";
import { normalizeHit } from "../src/scrapers/tender-offers.js";
import { saveTenderOffers } from "../src/firestore.js";
import type { TenderOffer } from "../src/types.js";

const SAVE = process.argv.includes("--save");
const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Parse the G1 missing list: ptr_id(=accession),year,member(label w/ form),class?,url
function loadMissing(): { acc: string; cik: string; form: string }[] {
  const lines = readFileSync(
    "docs/reconciliation/sec-tender-offers-G1.csv",
    "utf8",
  )
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean);
  const out: { acc: string; cik: string; form: string }[] = [];
  for (const line of lines) {
    // url is the last field; CIK is in edgar/data/{cik}/...
    const acc = line.split(",")[0]!;
    const formM = line.match(/\((SC TO-[TI](?:\/A)?)\)/);
    const cikM = line.match(/edgar\/data\/(\d+)\//);
    if (acc && formM && cikM) out.push({ acc, cik: cikM[1]!, form: formM[1]! });
  }
  return out;
}

async function ftsByCikForm(cik: string, form: string): Promise<any[]> {
  const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=${encodeURIComponent(form)}&ciks=${cik.padStart(10, "0")}&hits=100`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`FTS HTTP ${res.status}`);
  const j = (await res.json()) as { hits?: { hits?: any[] } };
  return j.hits?.hits ?? [];
}

(async () => {
  const missing = loadMissing();
  console.error(`[rto] ${missing.length} missing accessions to recover`);
  const scrapedAt = new Date().toISOString();
  const recovered: TenderOffer[] = [];
  const notFound: string[] = [];

  // Group by cik+form to minimize queries; cache hits per group.
  const cache = new Map<string, any[]>();
  for (const m of missing) {
    const key = `${m.cik}|${m.form}`;
    let hits = cache.get(key);
    if (!hits) {
      try {
        await sleep(200);
        hits = await ftsByCikForm(m.cik, m.form);
        cache.set(key, hits);
      } catch (e) {
        console.error(`[rto] ${m.acc}: FTS error ${e instanceof Error ? e.message : e}`);
        notFound.push(m.acc);
        continue;
      }
    }
    const hit = hits.find((h) => (h._source?.adsh ?? "") === m.acc);
    if (!hit) {
      notFound.push(m.acc);
      console.error(`[rto] ${m.acc}: NOT in FTS (cik ${m.cik} ${m.form})`);
      continue;
    }
    const offer = normalizeHit(hit, scrapedAt);
    if (!offer) {
      notFound.push(m.acc);
      console.error(`[rto] ${m.acc}: normalizeHit returned null`);
      continue;
    }
    recovered.push(offer);
    console.error(`[rto] ${m.acc}: ${offer.form_type} ${offer.target_name} ${offer.filing_date}`);
  }

  console.error(`\n[rto] recovered ${recovered.length}/${missing.length}; not found ${notFound.length}`);
  if (notFound.length) console.error(`[rto] not found: ${notFound.join(", ")}`);
  if (SAVE && recovered.length) {
    const res = await saveTenderOffers(recovered);
    console.error(`[rto] saved ${res.saved}`);
  } else if (!SAVE) {
    console.error(`[rto] DRY-RUN — nothing written. Re-run with --save.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error("[rto] FATAL:", e);
  process.exit(1);
});
