/**
 * N-PORT FILINGS BACKFILL (METADATA ONLY) — SEC Form NPORT-P / NPORT-P/A via
 * EDGAR full-text search, month by month. BOUNDED to a 2-year window by default.
 *
 *   npx tsx scripts/backfill-nport-filings.ts                       # last 24 months, --save NOT set = dry
 *   npx tsx scripts/backfill-nport-filings.ts --save                # write to nport_filings
 *   npx tsx scripts/backfill-nport-filings.ts --only=2026-05        # one month
 *   npx tsx scripts/backfill-nport-filings.ts --start=2024-06 --end=2026-05 --save
 *
 * SCOPE — METADATA ONLY. One row per FILING (filer, dates, accession, URL) into
 * the nport_filings collection. This script does NOT fetch primary_doc.xml and
 * does NOT extract per-security holdings (nport_holdings). Full-history holdings
 * would be tens of millions of rows — a firehose we deliberately do NOT mirror.
 *
 * Dedup key = filing_id (= EDGAR accession). IDENTICAL to the cron's
 * saveNportFilings doc(filing.filing_id) and to scrapeNportLiveFeed's normalizeHit
 * (filing_id: accession). So this backfill MERGES cleanly with the daily cron.
 *
 * WHY MONTHLY: EDGAR FTS hard-caps a query at 10,000 hits + 100/page. N-PORT
 * filings cluster at month-end (some single days carry 3,000+ filings), so a
 * wide window would blow the cap. Monthly sub-ranges per form stay safely under
 * it; each window paginates via `from` with a 10k truncation warning.
 *
 * Mirrors src/scrapers/nport.ts normalizeHit EXACTLY (same NPORT-P prefix filter,
 * same field mapping, same rawXmlPath strip).
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveNportFilings } from "../src/firestore.js";
import type { NportFiling } from "../src/types.js";

const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_URL = "https://www.sec.gov";
const FORM_CODES = ["NPORT-P", "NPORT-P/A"];
const PAGE = 100;
const RATE_MS = 200;

const SAVE = process.argv.includes("--save");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const START = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1];
const END = process.argv.find((a) => a.startsWith("--end="))?.split("=")[1];
const PROG = ".tmp/nport-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

const formatAccession = (a: string): string => a.replace(/-/g, "");

/** Strip the xsl<schema>/ prefix from primaryDocument paths — same gotcha as
 *  every SEC ownership/structured form. Matches nport.ts rawXmlPath. */
function rawXmlPath(primaryDoc: string): string {
  return primaryDoc.replace(/^xsl[A-Z0-9_]+\//, "");
}

/** Display name format: "WisdomTree Trust  (CIK 0001350487)" → drop the CIK suffix. */
function parseFilerName(displayName: string): string {
  return displayName.replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
}

// ── month list "YYYY-MM": default = (today - 24 months) → current month ──
function monthList(): string[] {
  const now = new Date();
  let first = START;
  if (!first) {
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    s.setUTCMonth(s.getUTCMonth() - 24);
    first = `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}`;
  }
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeHit(hit: any, scrapedAt: string): NportFiling | null {
  const src = hit._source;
  if (!src) return null;
  const accession = src.adsh ?? "";
  if (!accession) return null;
  const formType = src.form ?? src.file_type ?? "";
  // Only the actual NPORT-P / NPORT-P/A filings (skip ancillary NPORT-EX attachments).
  if (!formType.startsWith("NPORT-P")) return null;

  const ciks = src.ciks ?? [];
  const archiveCik = (ciks[0] ?? "").replace(/^0+/, "");
  const filerCik = (ciks[0] ?? "").padStart(10, "0");
  const filerName = parseFilerName(src.display_names?.[0] ?? "");
  const idParts = (hit._id ?? "").split(":");
  const primaryDoc = rawXmlPath(idParts[1] ?? "");
  if (!archiveCik || !primaryDoc) return null;

  const accNoDash = formatAccession(accession);
  return {
    filing_id: accession,
    filing_type: formType,
    is_amendment: formType.endsWith("/A"),
    file_date: src.file_date ?? "",
    period_ending: src.period_ending ?? "",
    filer_name: filerName,
    filer_cik: filerCik,
    sec_file_number: src.file_num?.[0] ?? "",
    filer_state: src.biz_states?.[0] ?? "",
    inc_state: src.inc_states?.[0] ?? "",
    primary_document_url: `${EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${primaryDoc}`,
    filing_url: `${EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${accession}-index.htm`,
    scraped_at: scrapedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJson(url: string): Promise<any | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(RATE_MS);
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      if (a === 5) { console.error(`[nport-bf] net give-up ${url}: ${e?.cause?.code ?? e}`); return null; }
      console.error(`[nport-bf] net "${e?.cause?.code ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

async function doMonth(ym: string) {
  if (done[ym] && !ONLY) { console.error(`[nport-bf] skip ${ym}`); return; }
  const { startdt, enddt } = monthBounds(ym);
  const byAccession = new Map<string, NportFiling>();
  for (const form of FORM_CODES) {
    const fe = encodeURIComponent(form);
    let from = 0;
    while (true) {
      const url = `${SEARCH_URL}?q=%22%22&forms=${fe}&dateRange=custom&startdt=${startdt}&enddt=${enddt}&hits=${PAGE}&from=${from}`;
      const data = await fetchJson(url);
      if (!data) break;
      const hits = data.hits?.hits ?? [];
      for (const h of hits) { const r = normalizeHit(h, NOW); if (r) byAccession.set(r.filing_id, r); }
      if (hits.length < PAGE) break;
      from += PAGE;
      if (from >= 10000) { console.error(`[nport-bf] ${ym} ${form}: HIT 10k FTS CAP — month too dense, results truncated`); break; }
    }
  }
  const recs = Array.from(byAccession.values());
  console.error(`[nport-bf] ${ym}: ${recs.length} unique NPORT-P / NPORT-P/A filings (metadata only)`);
  if (!SAVE) {
    if (recs[0]) console.error("  sample: " + JSON.stringify(recs[0]).slice(0, 600));
    return;
  }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) saved += (await saveNportFilings(recs.slice(i, i + 400))).saved;
  done[ym] = true; writeFileSync(PROG, JSON.stringify(done));
  console.error(`[nport-bf] ${ym} DONE: saved ${saved} (nport_filings)`);
}

async function main() {
  const months = ONLY ? [ONLY] : monthList();
  console.error(`[nport-bf] ${months.length} months${SAVE ? "" : " (DRY — no --save)"}, forms: ${FORM_CODES.join(", ")} — METADATA ONLY, no holdings`);
  for (const ym of months) await doMonth(ym);
  console.error("[nport-bf] COMPLETE");
}
main().then(() => process.exit(0)).catch((e) => { console.error("[nport-bf] FATAL", e); process.exit(1); });
