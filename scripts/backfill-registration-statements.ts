/**
 * REGISTRATION STATEMENTS BACKFILL — SEC Form S-1 / S-1/A / S-3 / S-3/A,
 * full EDGAR full-text-search history (2001 → today), month by month.
 *
 *   npx tsx scripts/backfill-registration-statements.ts             # full 2001→now, --save NOT set = dry
 *   npx tsx scripts/backfill-registration-statements.ts --save      # write to registration_statements
 *   npx tsx scripts/backfill-registration-statements.ts --only=2024-06   # one month
 *   npx tsx scripts/backfill-registration-statements.ts --start=2020-01 --end=2021-12 --save
 *
 * WHY MONTHLY: EDGAR FTS hard-caps a query at 10,000 hits and returns ONE hit
 * per document (primary + every exhibit), so a busy IPO month can approach the
 * cap on raw hits even though unique canonical filings are far fewer. Monthly
 * windows stay safely under the cap; each window paginates via `from`.
 *
 * Mirrors src/scrapers/registration-statements.ts normalization EXACTLY
 * (same KEEP_FILE_TYPES filter, same field mapping). Dedup key = filing_id
 * (= accession) — IDENTICAL to saveRegistrationStatements' doc(filing.filing_id),
 * so this backfill MERGES cleanly with the daily cron.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveRegistrationStatements } from "../src/firestore.js";
import type { RegistrationStatement } from "../src/types.js";

const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_URL = "https://www.sec.gov";
const PAGE = 100;
const RATE_MS = 200;

const SAVE = process.argv.includes("--save");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const START = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1];
const END = process.argv.find((a) => a.startsWith("--end="))?.split("=")[1];

// --forms=A,B,C overrides the default set. Used to backfill ONLY the newly-added
// form codes (S-3ASR / S-8 / S-8 POS) across history without re-fetching the
// S-1/S-3 history that's already in the collection. The default set mirrors
// src/scrapers/registration-statements.ts CONFIG.FORM_CODES exactly.
const FORMS_OVERRIDE = process.argv
  .find((a) => a.startsWith("--forms="))
  ?.split("=")[1];
const FORM_CODES = FORMS_OVERRIDE
  ? FORMS_OVERRIDE.split(",").map((s) => s.trim()).filter(Boolean)
  : ["S-1", "S-1/A", "S-3", "S-3/A", "S-3ASR"];
const KEEP_FILE_TYPES = new Set(FORM_CODES);

// A filing is an amendment if its form ends in "/A" or is a post-effective
// amendment (anything carrying "POS", e.g. "S-8 POS", "POS AM").
const isAmendmentType = (ft: string): boolean =>
  ft.endsWith("/A") || ft.includes("POS");

// Scope the month-progress file to the form set so an override run tracks its
// own progress independently of the default full-history run.
const PROG_SLUG = FORMS_OVERRIDE
  ? "-" + FORMS_OVERRIDE.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 40)
  : "";
const PROG = `.tmp/regstmt-backfill-progress${PROG_SLUG}.json`;
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

// ── month list "YYYY-MM" from 2001-01 → current month (or --start/--end) ──
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

function parseDisplayName(raw: string): { name: string; ticker: string } {
  const withoutCik = raw.replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
  const tm = withoutCik.match(/\(([A-Z][A-Z0-9.]{0,4})\)\s*$/);
  if (tm) return { name: withoutCik.replace(/\([A-Z][A-Z0-9.]{0,4}\)\s*$/, "").trim(), ticker: tm[1] ?? "" };
  return { name: withoutCik, ticker: "" };
}

function normalizeHit(hit: any, scrapedAt: string): RegistrationStatement | null {
  const src = hit._source;
  if (!src) return null;
  const accession = src.adsh ?? "";
  if (!accession) return null;
  const fileType = src.file_type ?? "";
  if (!KEEP_FILE_TYPES.has(fileType)) return null;
  const ciks = src.ciks ?? [];
  const archiveCik = (ciks[0] ?? "").replace(/^0+/, "");
  const filerCik = (ciks[0] ?? "").padStart(10, "0");
  const display = parseDisplayName(src.display_names?.[0] ?? "");
  const idParts = (hit._id ?? "").split(":");
  const primaryDoc = idParts[1] ?? "";
  if (!archiveCik || !primaryDoc) return null;
  const accNoDash = formatAccession(accession);
  return {
    filing_id: accession,
    filing_type: fileType,
    is_amendment: isAmendmentType(fileType),
    file_date: src.file_date ?? "",
    filer_name: display.name,
    filer_cik: filerCik,
    filer_ticker: display.ticker,
    sec_file_number: src.file_num?.[0] ?? "",
    filer_state: src.biz_states?.[0] ?? "",
    inc_state: src.inc_states?.[0] ?? "",
    sic_codes: src.sics ?? [],
    primary_document_url: `${EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${primaryDoc}`,
    filing_url: `${EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${accession}-index.htm`,
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
      if (a === 5) { console.error(`[regstmt] net give-up ${url}: ${e?.cause?.code ?? e}`); return null; }
      console.error(`[regstmt] net "${e?.cause?.code ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

async function doMonth(ym: string) {
  if (done[ym] && !ONLY) { console.error(`[regstmt] skip ${ym}`); return; }
  const { startdt, enddt } = monthBounds(ym);
  const byAccession = new Map<string, RegistrationStatement>();
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
      if (from >= 10000) { console.error(`[regstmt] ${ym} ${form}: HIT 10k FTS CAP — month too dense, results truncated`); break; }
    }
  }
  const recs = Array.from(byAccession.values());
  console.error(`[regstmt] ${ym}: ${recs.length} unique canonical S-1/S-3 filings`);
  if (!SAVE) {
    if (recs[0]) console.error("  sample: " + JSON.stringify(recs[0]).slice(0, 500));
    return;
  }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) saved += (await saveRegistrationStatements(recs.slice(i, i + 400))).saved;
  done[ym] = true; writeFileSync(PROG, JSON.stringify(done));
  console.error(`[regstmt] ${ym} DONE: saved ${saved}`);
}

async function main() {
  const months = ONLY ? [ONLY] : monthList();
  console.error(`[regstmt] ${months.length} months${SAVE ? "" : " (DRY — no --save)"}, forms: ${FORM_CODES.join(", ")}`);
  for (const ym of months) await doMonth(ym);
  console.error("[regstmt] COMPLETE");
}
main().then(() => process.exit(0)).catch((e) => { console.error("[regstmt] FATAL", e); process.exit(1); });
