/**
 * INSTITUTIONAL 13F BACKFILL — tracked funds, full holdings, 10-year history.
 *
 *   npx tsx scripts/backfill-13f.ts                 # all tracked funds, 2016+
 *   npx tsx scripts/backfill-13f.ts --fund=berkshire
 *   npx tsx scripts/backfill-13f.ts --dry --fund=berkshire   # parse only, no write
 *
 * Reliable for UNATTENDED running:
 *  - tickers resolved from the cusip_map CACHE only (NO live OpenFIGI calls —
 *    that API is rate-limited and would be a fragile point in a long run).
 *    Cache-miss CUSIPs are stored with blank ticker, fillable in a later pass.
 *  - network-retry on dropped sockets / 429 / 5xx (the lesson from lobbying).
 *  - resumable: checkpoints each (fund, accession); idempotent writes.
 *  - SOURCE family = SEC EDGAR (independent rate budget from lobbying's LDA),
 *    so it runs in PARALLEL under the supervisor.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse13FXml, resolveFund, listTrackedFunds } from "../src/scrapers/13f.js";
import { saveInstitutionalHoldings, getLiveDb } from "../src/firestore.js";

// 2014 matches the collection's earliest data + the sec-13f-tracked
// reconcile floor (was 2016).
const START_YEAR = 2014;
const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--fund="))?.split("=")[1];
const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC = "https://data.sec.gov";
const ARCH = "https://www.sec.gov";
const PROG = ".tmp/13f-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string, json: boolean): Promise<any> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(160); // ~6 req/sec — polite for SEC
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return json ? res.json() : res.text();
    } catch (e: any) {
      if (a === 5) throw e;
      const code = e?.cause?.code ?? String(e);
      console.error(`[13f-bf] net error "${code}" on ${url} — retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
}

async function loadCusipCache(): Promise<Map<string, string>> {
  const db = await getLiveDb();
  const snap = await db.collection("cusip_map").get();
  const m = new Map<string, string>();
  snap.forEach((d: any) => { const t = d.get("ticker"); if (t) m.set(d.id, t); });
  return m;
}

const fmtAcc = (a: string) => a.replace(/-/g, "");

async function backfillFund(alias: string, cache: Map<string, string>) {
  const fund: any = resolveFund(alias);
  if (!fund) { console.error(`[13f-bf] unknown fund ${alias}`); return; }
  const subs: any = await fetchRetry(`${SEC}/submissions/CIK${fund.cik}.json`, true);
  const targets: Array<{ acc: string; fd: string; period: string }> = [];
  const collectBlock = (r: any) => {
    if (!r?.form) return;
    for (let i = 0; i < r.form.length; i++) {
      if (r.form[i] === "13F-HR" || r.form[i] === "13F-HR/A") {
        const fd = r.filingDate[i];
        if (parseInt(String(fd).slice(0, 4), 10) >= START_YEAR) {
          targets.push({ acc: r.accessionNumber[i], fd, period: r.reportDate[i] });
        }
      }
    }
  };
  collectBlock(subs.filings?.recent);
  // Heavy filers (BlackRock, Vanguard) overflow the recent-1000 block — their
  // older 13F-HRs live in paginated chunk files. Skipping these was why the
  // 2026-06-04 run found "3 filings" for BlackRock (caught by the
  // sec-13f-tracked reconcile 2026-06-10).
  for (const f of subs.filings?.files ?? []) {
    if (!f?.name) continue;
    const to = parseInt(String(f.filingTo ?? "9999").slice(0, 4), 10);
    if (Number.isFinite(to) && to < START_YEAR) continue;
    const older: any = await fetchRetry(`${SEC}/submissions/${f.name}`, true);
    collectBlock(older);
  }
  if (targets.length === 0) { console.error(`[13f-bf] no filings ${alias}`); return; }
  console.error(`[13f-bf] ===== ${alias}: ${targets.length} 13F-HR filings ${START_YEAR}+ =====`);
  let savedF = 0, doneF = 0;
  for (const t of targets) {
    const key = `${fund.cik}-${t.acc}`;
    if (done[key]) { doneF++; continue; }
    try {
      const accNo = fmtAcc(t.acc);
      const base = `${ARCH}/Archives/edgar/data/${fund.cikRaw}/${accNo}`;
      const idx: any = await fetchRetry(`${base}/index.json`, true);
      const xmls = (idx.directory?.item ?? []).filter((f: any) => f.name.endsWith(".xml"));
      const hf = xmls.find((f: any) => f.name.toLowerCase().includes("infotable"))
        ?? xmls.find((f: any) => !f.name.toLowerCase().includes("primary_doc"));
      if (!hf) { console.error(`[13f-bf] no holdings xml in ${t.acc}`); done[key] = true; continue; }
      const xml: string = await fetchRetry(`${base}/${hf.name}`, false);
      const meta = { fundName: fund.name, fundCik: fund.cik, accession: t.acc, filingDate: t.fd, period: t.period, url: `${base}/${hf.name}`, infoTableEntryTotal: null, tableValueTotal: null };
      const { holdings } = parse13FXml(xml, meta as any);
      let resolved = 0;
      for (const h of holdings) { if (!h.ticker && h.cusip) { const tk = cache.get(h.cusip); if (tk) { h.ticker = tk; resolved++; } } }
      if (!DRY) {
        const res = await saveInstitutionalHoldings(holdings);
        savedF += res.saved;
        // Checkpoint ONLY on real saves. A --dry run used to checkpoint too —
        // which made the subsequent REAL run skip everything it had
        // "previewed" (Berkshire: 45/45 skipped, saved 0; caught by the
        // 2026-06-10 sec-13f-tracked reconcile).
        done[key] = true; writeFileSync(PROG, JSON.stringify(done));
      } else {
        console.error(`[13f-bf] DRY ${alias} ${t.period}: ${holdings.length} holdings, ${resolved} tickers from cache, sample=[${holdings.slice(0, 4).map((h) => h.ticker || h.cusip).join(", ")}]`);
      }
      doneF++;
    } catch (e) { console.error(`[13f-bf] FAIL ${alias} ${t.acc}: ${String(e)}`); }
  }
  console.error(`[13f-bf] ${alias} complete: ${doneF}/${targets.length} filings, saved ${savedF} holdings`);
}

async function main() {
  const cache = await loadCusipCache();
  console.error(`[13f-bf] cusip cache loaded: ${cache.size} tickers${DRY ? " (DRY RUN — no writes)" : ""}`);
  const funds = ONLY ? [ONLY] : listTrackedFunds().map((f) => f.alias);
  for (const a of funds) await backfillFund(a, cache);
  console.error(`[13f-bf] COMPLETE`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("[13f-bf] FATAL", e); process.exit(1); });
