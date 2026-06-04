/**
 * INSIDER FORM 4/5 BULK BACKFILL — SEC "Insider Transactions Data Sets".
 *
 *   npx tsx scripts/backfill-form4-bulk.ts            # 2016q1 → 2026q1, all companies
 *   npx tsx scripts/backfill-form4-bulk.ts --dry --only=2024q1
 *
 * Downloads SEC's quarterly insider-transaction flat-file ZIPs (one per quarter,
 * ~14 MB) — every Form 3/4/5 for EVERY company, already parsed into TSV tables —
 * joins SUBMISSION + REPORTINGOWNER + (NON)DERIV_TRANS, and loads clean records
 * into insider_trades. Vastly better than per-filing XML scraping: all companies,
 * clean dates, complete history, one file per quarter.
 *
 * Network-retry, resumable per quarter, idempotent (doc id = accession-SK).
 * data_source tags bulk-sourced rows; clean YYYY-MM-DD dates replace the messy
 * recent-feed records on the same accession+SK.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import AdmZip from "adm-zip";
import { saveInsiderTransactions } from "../src/firestore.js";
import type { InsiderTransaction } from "../src/types.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const BASE = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets";
const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const PROG = ".tmp/form4-bulk-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUARTERS: string[] = [];
for (let y = 2016; y <= 2026; y++) for (let q = 1; q <= 4; q++) { if (y === 2026 && q > 1) break; QUARTERS.push(`${y}q${q}`); }

const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
function isoDate(d: string): string {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec((d || "").trim().toUpperCase());
  if (!m) return "";
  const yr = parseInt(m[3], 10);
  if (yr < 1900 || yr > 2100) return ""; // drop the garbage years (0023, 2034…)
  return `${m[3]}-${MON[m[2]] ?? "01"}-${m[1]}`;
}
const num = (s: string): number => { const n = parseFloat((s || "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };

async function fetchZip(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(200);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e: any) { if (a === 5) throw e; console.error(`[f4-bulk] net "${e?.cause?.code ?? e}" — retry ${a + 1}`); await sleep(3000 * (a + 1)); }
  }
  return null;
}

// Parse a TSV into array of row-objects keyed by header. Returns [] if missing.
function parseTsv(zip: AdmZip, name: string): Record<string, string>[] {
  const e = zip.getEntry(name); if (!e) return [];
  const lines = e.getData().toString("utf8").split(/\r?\n/);
  const cols = (lines[0] ?? "").split("\t");
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) { if (!lines[i]) continue; const v = lines[i].split("\t"); const o: Record<string, string> = {}; for (let c = 0; c < cols.length; c++) o[cols[c]] = v[c] ?? ""; out.push(o); }
  return out;
}

async function doQuarter(q: string) {
  if (done[q]) { console.error(`[f4-bulk] skip ${q} (done)`); return; }
  const url = `${BASE}/${q}_form345.zip`;
  console.error(`[f4-bulk] ===== ${q}: downloading =====`);
  const buf = await fetchZip(url);
  if (!buf) { console.error(`[f4-bulk] ${q}: no ZIP (404) — skipping`); done[q] = true; writeFileSync(PROG, JSON.stringify(done)); return; }
  const zip = new AdmZip(buf);
  // submission map: accession → {ticker, issuer, cik, filed, doctype}
  const sub = new Map<string, { tk: string; nm: string; cik: string; filed: string; dt: string }>();
  for (const r of parseTsv(zip, "SUBMISSION.tsv")) sub.set(r.ACCESSION_NUMBER, { tk: (r.ISSUERTRADINGSYMBOL || "").toUpperCase().replace(/^.*\//, "").trim(), nm: r.ISSUERNAME || "", cik: r.ISSUERCIK || "", filed: isoDate(r.FILING_DATE), dt: r.DOCUMENT_TYPE || "" });
  // owner map: accession → joined names + isDirector + title
  const own = new Map<string, { name: string; dir: boolean; title: string }>();
  for (const r of parseTsv(zip, "REPORTINGOWNER.tsv")) {
    const prev = own.get(r.ACCESSION_NUMBER);
    const nm = r.RPTOWNERNAME || ""; const isDir = /director/i.test(r.RPTOWNER_RELATIONSHIP || "");
    if (prev) own.set(r.ACCESSION_NUMBER, { name: prev.name + " / " + nm, dir: prev.dir || isDir, title: prev.title || r.RPTOWNER_TITLE || "" });
    else own.set(r.ACCESSION_NUMBER, { name: nm, dir: isDir, title: r.RPTOWNER_TITLE || "" });
  }
  const recs: InsiderTransaction[] = [];
  const build = (r: Record<string, string>, deriv: boolean, sk: string) => {
    const s = sub.get(r.ACCESSION_NUMBER); if (!s) return;
    if (s.dt !== "4" && s.dt !== "4/A" && s.dt !== "5" && s.dt !== "5/A") return; // transactions only (skip Form 3)
    const o = own.get(r.ACCESSION_NUMBER);
    const ad = (r.TRANS_ACQUIRED_DISP_CD || "").trim().toUpperCase();
    const code = (r.TRANS_CODE || "").trim().toUpperCase();
    const ttype: "buy" | "sell" = ad === "A" ? "buy" : ad === "D" ? "sell" : /^[PAMXC]$/.test(code) ? "buy" : "sell";
    const td = isoDate(r.TRANS_DATE);
    const shares = num(r.TRANS_SHARES); const pps = num(r.TRANS_PRICEPERSHARE);
    recs.push({
      id: `${r.ACCESSION_NUMBER}-${sk}`, ticker: s.tk, company_name: s.nm || null, company_cik: s.cik,
      officer_name: o?.name || "unknown", officer_title: o?.title || "", is_director: o?.dir ?? null,
      transaction_type: ttype, transaction_code: code, security_title: r.SECURITY_TITLE || null,
      is_derivative: deriv, underlying_security_title: deriv ? (r.UNDLYNG_SEC_TITLE || null) : null,
      underlying_security_shares: deriv ? num(r.UNDLYNG_SEC_SHARES) || null : null,
      conversion_or_exercise_price: deriv ? num(r.CONV_EXERCISE_PRICE) || null : null,
      transaction_date: td, disclosure_date: s.filed, reporting_lag_days: null,
      shares, price_per_share: pps, total_value: deriv ? num(r.TRANS_TOTAL_VALUE) : shares * pps,
      shares_owned_after: num(r.SHRS_OWND_FOLWNG_TRANS) || null, acquired_disposed: ad === "A" ? "A" : ad === "D" ? "D" : null,
      accession_number: r.ACCESSION_NUMBER, sec_filing_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=&accession=${r.ACCESSION_NUMBER}`,
      data_source: s.dt.startsWith("5") ? "SEC_EDGAR_FORM5" : "SEC_EDGAR_FORM4",
    });
  };
  for (const r of parseTsv(zip, "NONDERIV_TRANS.tsv")) build(r, false, r.NONDERIV_TRANS_SK);
  for (const r of parseTsv(zip, "DERIV_TRANS.tsv")) build(r, true, r.DERIV_TRANS_SK);
  console.error(`[f4-bulk] ${q}: built ${recs.length} transactions`);
  if (DRY) {
    for (const t of ["AAPL", "NVDA"]) { const ex = recs.find((r) => r.ticker === t); if (ex) console.error(`   sample ${t}: ${ex.officer_name} | ${ex.transaction_type} | ${ex.shares}@${ex.price_per_share} | ${ex.transaction_date} | ${ex.data_source}`); }
    return;
  }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) { const r = await saveInsiderTransactions(recs.slice(i, i + 400)); saved += r.saved; }
  done[q] = true; writeFileSync(PROG, JSON.stringify(done));
  console.error(`[f4-bulk] ${q} DONE: saved ${saved}`);
}

async function main() {
  const qs = ONLY ? [ONLY] : QUARTERS;
  console.error(`[f4-bulk] ${qs.length} quarters${DRY ? " (DRY)" : ""}`);
  for (const q of qs) await doQuarter(q);
  console.error("[f4-bulk] COMPLETE");
}
main().then(() => process.exit(0)).catch((e) => { console.error("[f4-bulk] FATAL", e); process.exit(1); });
