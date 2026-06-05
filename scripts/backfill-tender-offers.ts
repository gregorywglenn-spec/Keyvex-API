/**
 * TENDER OFFERS BACKFILL — SEC Schedule TO (SC TO-T / SC TO-T/A / SC TO-I /
 * SC TO-I/A), full EDGAR full-text-search history (2001 → today), month by month.
 *
 *   npx tsx scripts/backfill-tender-offers.ts             # full 2001→now, dry (no --save)
 *   npx tsx scripts/backfill-tender-offers.ts --save      # write to tender_offers
 *   npx tsx scripts/backfill-tender-offers.ts --only=2024-06
 *   npx tsx scripts/backfill-tender-offers.ts --start=2018-01 --end=2020-12 --save
 *
 * WHY MONTHLY: EDGAR FTS hard-caps a query at 10,000 hits. Schedule TO is modest
 * per month but full-history per-form counts cap, so monthly windows are the safe
 * granularity; each window paginates via `from`.
 *
 * Mirrors src/scrapers/tender-offers.ts normalizeHit EXACTLY (target/bidder
 * display-name split, all_ciks, URL builders). Dedup key = accession_number —
 * IDENTICAL to saveTenderOffers' doc(offer.accession_number), so this backfill
 * MERGES cleanly with the daily cron.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveTenderOffers } from "../src/firestore.js";
import type { TenderOffer } from "../src/types.js";

const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_URL = "https://www.sec.gov";
const FORM_CODES = ["SC TO-T", "SC TO-T/A", "SC TO-I", "SC TO-I/A"];
const PAGE = 100;
const RATE_MS = 200;

const SAVE = process.argv.includes("--save");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const START = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1];
const END = process.argv.find((a) => a.startsWith("--end="))?.split("=")[1];
const PROG = ".tmp/tenderoffers-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

function monthList(): string[] {
  const first = START ?? "2001-01";
  const now = new Date();
  const last = END ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const out: string[] = [];
  let [y, m] = first.split("-").map((x) => parseInt(x, 10));
  const [ly, lm] = last.split("-").map((x) => parseInt(x, 10));
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function monthBounds(ym: string): { startdt: string; enddt: string } {
  const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { startdt: `${ym}-01`, enddt: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

const formatAccession = (a: string): string => a.replace(/-/g, "");

interface ParsedDisplayName { name: string; ticker: string; cik: string; }
function parseDisplayName(raw: string): ParsedDisplayName {
  const cikMatch = raw.match(/\(CIK\s+(\d+)\)\s*$/i);
  const cik = cikMatch ? (cikMatch[1] ?? "").padStart(10, "0") : "";
  const withoutCik = raw.replace(/\(CIK\s+\d+\)\s*$/i, "").trim();
  const tm = withoutCik.match(/\(([A-Z][A-Z0-9.]{0,4})\)\s*$/);
  let ticker = "", name = withoutCik;
  if (tm) { ticker = tm[1] ?? ""; name = withoutCik.replace(/\([A-Z][A-Z0-9.]{0,4}\)\s*$/, "").trim(); }
  return { name, ticker, cik };
}

function buildPrimaryDocUrl(cik: string, accession: string, filename: string): string {
  return `${EDGAR_URL}/Archives/edgar/data/${cik.replace(/^0+/, "")}/${formatAccession(accession)}/${filename}`;
}
function buildFilingIndexUrl(cik: string, accession: string): string {
  return `${EDGAR_URL}/Archives/edgar/data/${cik.replace(/^0+/, "")}/${formatAccession(accession)}/${accession}-index.htm`;
}

function normalizeHit(hit: any, scrapedAt: string): TenderOffer | null {
  const src = hit._source;
  if (!src) return null;
  const accession = src.adsh ?? "";
  if (!accession) return null;
  const formType = src.form ?? src.file_type ?? "";
  const isAmendment = formType.endsWith("/A");
  const isIssuerTender = formType.startsWith("SC TO-I");
  const names = src.display_names ?? [];
  const ciks = src.ciks ?? [];
  const parsed = names.map(parseDisplayName);
  let target: ParsedDisplayName = { name: "", ticker: "", cik: "" };
  let bidder: ParsedDisplayName = { name: "", ticker: "", cik: "" };
  if (parsed.length === 0) return null;
  if (isIssuerTender) { target = parsed[0] ?? target; bidder = parsed[0] ?? bidder; }
  else { target = parsed[0] ?? target; bidder = parsed[1] ?? parsed[0] ?? bidder; }
  if (!target.cik && ciks[0]) target.cik = ciks[0].padStart(10, "0");
  if (!bidder.cik && ciks[isIssuerTender ? 0 : 1]) bidder.cik = (ciks[isIssuerTender ? 0 : 1] ?? "").padStart(10, "0");
  const idParts = (hit._id ?? "").split(":");
  const filename = idParts[1] ?? "";
  const archiveCik = ciks[0] ?? target.cik;
  return {
    accession_number: accession,
    form_type: formType,
    is_amendment: isAmendment,
    is_issuer_tender: isIssuerTender,
    filing_date: src.file_date ?? "",
    target_name: target.name,
    target_cik: target.cik,
    target_ticker: target.ticker,
    bidder_name: bidder.name,
    bidder_cik: bidder.cik,
    bidder_ticker: bidder.ticker,
    all_ciks: ciks.map((c: string) => c.padStart(10, "0")),
    file_number: (src.file_num ?? [])[0] ?? "",
    filing_url: buildFilingIndexUrl(archiveCik, accession),
    primary_document_url: filename ? buildPrimaryDocUrl(archiveCik, accession, filename) : "",
    inc_states: src.inc_states ?? [],
    sic_codes: src.sics ?? [],
    scraped_at: scrapedAt,
  };
}

async function fetchJson(url: string): Promise<any | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(RATE_MS);
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      if (a === 5) { console.error(`[tender] net give-up ${url}: ${e?.cause?.code ?? e}`); return null; }
      console.error(`[tender] net "${e?.cause?.code ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

async function doMonth(ym: string) {
  if (done[ym] && !ONLY) { console.error(`[tender] skip ${ym}`); return; }
  const { startdt, enddt } = monthBounds(ym);
  const byAccession = new Map<string, TenderOffer>();
  for (const form of FORM_CODES) {
    const fe = encodeURIComponent(form);
    let from = 0;
    while (true) {
      const url = `${SEARCH_URL}?q=&forms=${fe}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&hits=${PAGE}&from=${from}`;
      const data = await fetchJson(url);
      if (!data) break;
      const hits = data.hits?.hits ?? [];
      for (const h of hits) { const r = normalizeHit(h, NOW); if (r) byAccession.set(r.accession_number, r); }
      if (hits.length < PAGE) break;
      from += PAGE;
      if (from >= 10000) { console.error(`[tender] ${ym} ${form}: HIT 10k FTS CAP — results truncated`); break; }
    }
  }
  const recs = Array.from(byAccession.values());
  console.error(`[tender] ${ym}: ${recs.length} unique Schedule TO filings`);
  if (!SAVE) {
    if (recs[0]) console.error("  sample: " + JSON.stringify(recs[0]).slice(0, 500));
    return;
  }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) saved += (await saveTenderOffers(recs.slice(i, i + 400))).saved;
  done[ym] = true; writeFileSync(PROG, JSON.stringify(done));
  console.error(`[tender] ${ym} DONE: saved ${saved}`);
}

async function main() {
  const months = ONLY ? [ONLY] : monthList();
  console.error(`[tender] ${months.length} months${SAVE ? "" : " (DRY — no --save)"}, forms: ${FORM_CODES.join(", ")}`);
  for (const ym of months) await doMonth(ym);
  console.error("[tender] COMPLETE");
}
main().then(() => process.exit(0)).catch((e) => { console.error("[tender] FATAL", e); process.exit(1); });
