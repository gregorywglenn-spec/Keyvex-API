/**
 * INSIDER FORM 4 BACKFILL — high-interest watchlist, full 10-year history.
 *
 *   npx tsx scripts/backfill-form4.ts                 # whole watchlist, 2016+
 *   npx tsx scripts/backfill-form4.ts --ticker=AAPL
 *   npx tsx scripts/backfill-form4.ts --dry --ticker=AAPL
 *
 * Walks EDGAR submissions (recent + older shards) per company to get the FULL
 * Form 4 history, not just the recent window. Ticker comes straight from the
 * filing XML (issuerTradingSymbol) — no OpenFIGI, so no rate-limit fragility.
 * Network-retry, resumable per accession, idempotent. SEC EDGAR family →
 * runs in PARALLEL with lobbying (LDA) under the supervisor.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getTickerInfo, parseForm4Xml } from "../src/scrapers/form4.js";
import { saveInsiderTransactions } from "../src/firestore.js";

const START_YEAR = 2016;
const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--ticker="))?.split("=")[1];
const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://data.sec.gov";
const ARCH = "https://www.sec.gov";
const PROG = ".tmp/form4-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WATCHLIST = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","V","MA","UNH","HD","PG","JNJ",
  "XOM","CVX","LLY","AVGO","COST","WMT","BAC","KO","PEP","MRK","ADBE","CRM","NFLX","AMD",
  "INTC","CSCO","DIS","BA","GE","PFE","T","VZ","WFC","ORCL","ABBV","TMO",
];

async function fetchRetry(url: string, json: boolean): Promise<any> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(160);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return json ? res.json() : res.text();
    } catch (e: any) {
      if (a === 5) throw e;
      console.error(`[form4-bf] net error "${e?.cause?.code ?? e}" on ${url} — retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
}
const fmtAcc = (a: string) => a.replace(/-/g, "");

// Pull form-4 accessions from one submissions block (recent or a shard file).
function collectForm4(block: any, cikRaw: string, out: Array<{ acc: string; fd: string; url: string }>) {
  const form = block.form || [], acc = block.accessionNumber || [], fd = block.filingDate || [], pd = block.primaryDocument || [];
  for (let i = 0; i < form.length; i++) {
    if (form[i] !== "4" && form[i] !== "4/A") continue;
    if (parseInt(String(fd[i]).slice(0, 4), 10) < START_YEAR) continue;
    const accNo = fmtAcc(acc[i]);
    // Strip the XSL-render prefix (e.g. "xslF345X06/form4.xml" → "form4.xml") so we
    // fetch the RAW XML, not SEC's rendered HTML. Without this, parse yields 0 trades.
    const doc = String(pd[i] ?? "").replace(/^xsl[A-Za-z0-9]+\//, "");
    out.push({ acc: acc[i], fd: fd[i], url: `${ARCH}/Archives/edgar/data/${cikRaw}/${accNo}/${doc}` });
  }
}

async function backfillTicker(ticker: string) {
  const info = await getTickerInfo(ticker);
  if (!info) { console.error(`[form4-bf] no CIK for ${ticker}`); return; }
  const subs: any = await fetchRetry(`${SEC}/submissions/CIK${info.cik}.json`, true);
  if (!subs) { console.error(`[form4-bf] no submissions for ${ticker}`); return; }
  const targets: Array<{ acc: string; fd: string; url: string }> = [];
  collectForm4(subs.filings?.recent ?? {}, info.cikRaw, targets);
  for (const f of subs.filings?.files ?? []) {           // older shards
    const shard: any = await fetchRetry(`${SEC}/submissions/${f.name}`, true);
    if (shard) collectForm4(shard, info.cikRaw, targets);
  }
  console.error(`[form4-bf] ===== ${ticker} (${info.name}): ${targets.length} Form 4 filings ${START_YEAR}+ =====`);
  let saved = 0, fdone = 0;
  for (const t of targets) {
    const key = `${info.cik}-${t.acc}`;
    if (done[key]) { fdone++; continue; }
    try {
      const xml: string = await fetchRetry(t.url, false);
      if (!xml) { done[key] = true; continue; }
      const trades = parseForm4Xml(xml, { accession: t.acc, companyCik: info.cikRaw, filedAt: t.fd, url: t.url } as any);
      if (!DRY) { const res = await saveInsiderTransactions(trades); saved += res.saved; }
      else if (trades.length) console.error(`[form4-bf] DRY ${ticker} ${t.acc}: ${trades.length} trades (${trades[0].ticker} ${trades[0].officer_name})`);
      done[key] = true; fdone++; writeFileSync(PROG, JSON.stringify(done));
    } catch (e) { console.error(`[form4-bf] FAIL ${ticker} ${t.acc}: ${String(e)}`); }
  }
  console.error(`[form4-bf] ${ticker} complete: ${fdone}/${targets.length} filings, saved ${saved} trades`);
}

async function main() {
  const list = ONLY ? [ONLY] : WATCHLIST;
  console.error(`[form4-bf] watchlist: ${list.length} tickers${DRY ? " (DRY)" : ""}`);
  for (const t of list) await backfillTicker(t);
  console.error(`[form4-bf] COMPLETE`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("[form4-bf] FATAL", e); process.exit(1); });
