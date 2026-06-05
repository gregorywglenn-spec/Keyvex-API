/**
 * FEDERAL REGISTER (bounded 10-year) BACKFILL — federalregister.gov REST API.
 *
 *   npx tsx scripts/backfill-federal-register.ts                          # last 10yr, DRY (no save)
 *   npx tsx scripts/backfill-federal-register.ts --save                   # last 10yr, real save
 *   npx tsx scripts/backfill-federal-register.ts --start=2016-01-01 --end=2026-06-05 --save
 *   npx tsx scripts/backfill-federal-register.ts --dry --start=2026-05-01 --end=2026-05-31
 *
 * WRITE CONVENTION: this loader is SAFE-BY-DEFAULT — it does NOT write unless you pass
 * --save. (Opposite of the Form D bulk loader, which writes by default + --dry to suppress.)
 * Passing --dry is the same as omitting --save.
 *
 * Source = federalregister.gov/api/v1/documents. No auth. Coverage back to 1994.
 * The API caps each query at 2000 results (page * per_page <= 2000) and per_page <= 100,
 * so a single query exposes at most 20 pages. We loop MONTH-BY-MONTH (a calendar month of
 * Federal Register publications is well under 2000 docs) and paginate each month, exactly
 * like the EDGAR FTS sub-range backfills.
 *
 * Dedup: MERGES into federal_register_documents keyed by document_number (e.g. "2026-09385")
 * via the cron's own saveFederalRegisterDocuments() — same key the daily cron uses, so a
 * backfill re-run and the daily cron never collide.
 *
 * Resumable: per-month progress in .tmp/fedreg-backfill-progress.json. Re-running skips
 * months already completed.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveFederalRegisterDocuments } from "../src/firestore.js";
import type { FederalRegisterDocument } from "../src/types.js";

const UA = process.env.FEDREG_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const BASE = "https://www.federalregister.gov/api/v1/documents";
const RATE_LIMIT_MS = 200;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_MONTH = 20; // API hard cap: page*per_page <= 2000

const SAVE = process.argv.includes("--save");
const DRY = !SAVE || process.argv.includes("--dry");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

const PROG = ".tmp/fedreg-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

// ---- window ----------------------------------------------------------------
function defaultStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 10);
  return d.toISOString().slice(0, 10);
}
function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}
const START = arg("start") ?? defaultStart();
const END = arg("end") ?? defaultEnd();

// ---- month sub-ranges ------------------------------------------------------
/** Build [{key, gte, lte}] calendar-month windows covering [START, END] inclusive. */
function months(start: string, end: string): { key: string; gte: string; lte: string }[] {
  const out: { key: string; gte: string; lte: string }[] = [];
  const sd = new Date(`${start}T00:00:00Z`);
  const ed = new Date(`${end}T00:00:00Z`);
  let y = sd.getUTCFullYear();
  let m = sd.getUTCMonth(); // 0-based
  while (y < ed.getUTCFullYear() || (y === ed.getUTCFullYear() && m <= ed.getUTCMonth())) {
    const first = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0)); // day 0 of next month = last day
    const gte = first.toISOString().slice(0, 10);
    const lte = last.toISOString().slice(0, 10);
    // clamp to the requested window edges
    out.push({
      key: `${y}-${String(m + 1).padStart(2, "0")}`,
      gte: gte < start ? start : gte,
      lte: lte > end ? end : lte,
    });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

// ---- normalize (mirrors federal-register.ts normalize() exactly) -----------
interface RawAgency { raw_name?: string; name?: string; slug?: string; id?: number }
interface RawDocument {
  document_number?: string; title?: string; type?: string; abstract?: string | null;
  publication_date?: string; html_url?: string; pdf_url?: string;
  public_inspection_pdf_url?: string; agencies?: RawAgency[]; excerpts?: string | null;
}
interface ApiResponse { count?: number; total_pages?: number; next_page_url?: string | null; results?: RawDocument[] }

function normalize(raw: RawDocument, scrapedAt: string): FederalRegisterDocument | null {
  if (!raw.document_number) return null;
  const agencies = Array.isArray(raw.agencies) ? raw.agencies : [];
  return {
    document_number: raw.document_number,
    title: raw.title ?? "",
    document_type: raw.type ?? "",
    abstract: raw.abstract ?? "",
    publication_date: raw.publication_date ?? "",
    html_url: raw.html_url ?? "",
    pdf_url: raw.pdf_url ?? "",
    public_inspection_pdf_url: raw.public_inspection_pdf_url ?? "",
    agency_names: agencies.map((a) => a.name ?? a.raw_name ?? "").filter(Boolean),
    agency_slugs: agencies.map((a) => a.slug ?? "").filter(Boolean),
    excerpts: raw.excerpts ?? "",
    scraped_at: scrapedAt,
  };
}

// ---- network-retry fetch ---------------------------------------------------
async function fetchJson(url: string): Promise<ApiResponse | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(RATE_LIMIT_MS);
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ApiResponse;
    } catch (e: any) {
      if (a === 5) throw e;
      console.error(`[fedreg] net "${e?.cause?.code ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

let GRAND_TOTAL = 0;

/** Add `n` days (can be negative) to a YYYY-MM-DD date, return YYYY-MM-DD. */
function addDays(d: string, n: number): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Fetch every document in [gte, lte] inclusive, splitting the range in half (by day)
 * whenever the API's count for the range exceeds the 2000 hard cap. The cap is
 * page*per_page<=2000 (max 20 pages of 100). A single calendar month can exceed it
 * (May 2026 had 2290), so adaptive splitting guarantees no silent drops.
 */
async function fetchRange(gte: string, lte: string): Promise<FederalRegisterDocument[]> {
  // Probe page 1 to learn the total count for this range.
  const probe = new URL(BASE);
  probe.searchParams.set("format", "json");
  probe.searchParams.set("order", "newest");
  probe.searchParams.set("per_page", String(PAGE_SIZE));
  probe.searchParams.set("page", "1");
  probe.searchParams.set("conditions[publication_date][gte]", gte);
  probe.searchParams.set("conditions[publication_date][lte]", lte);
  const first = await fetchJson(probe.toString());
  if (!first) return [];
  const total = first.count ?? (first.results?.length ?? 0);

  // If the range is over the cap AND spans more than one day, split it.
  if (total > PAGE_SIZE * MAX_PAGES_PER_MONTH && gte < lte) {
    const sd = new Date(`${gte}T00:00:00Z`).getTime();
    const ed = new Date(`${lte}T00:00:00Z`).getTime();
    const midTime = sd + Math.floor((ed - sd) / 2);
    const mid = new Date(midTime).toISOString().slice(0, 10);
    console.error(`[fedreg]   split [${gte}..${lte}] (count=${total}) → [${gte}..${mid}] + [${addDays(mid, 1)}..${lte}]`);
    const left = await fetchRange(gte, mid);
    const right = await fetchRange(addDays(mid, 1), lte);
    return left.concat(right);
  }

  // Range fits under the cap (or is a single day we can't split further): paginate it.
  const recs: FederalRegisterDocument[] = [];
  for (const raw of first.results ?? []) {
    const n = normalize(raw, NOW);
    if (n) recs.push(n);
  }
  if (total > recs.length && first.next_page_url) {
    let page = 2;
    while (page <= MAX_PAGES_PER_MONTH) {
      const url = new URL(BASE);
      url.searchParams.set("format", "json");
      url.searchParams.set("order", "newest");
      url.searchParams.set("per_page", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));
      url.searchParams.set("conditions[publication_date][gte]", gte);
      url.searchParams.set("conditions[publication_date][lte]", lte);
      const data = await fetchJson(url.toString());
      if (!data) break;
      for (const raw of data.results ?? []) {
        const n = normalize(raw, NOW);
        if (n) recs.push(n);
      }
      if (!data.next_page_url) break;
      page++;
    }
  }
  if (total > recs.length) {
    // Single day over the cap — extraordinarily rare; surface it loudly rather than drop silently.
    console.error(`[fedreg]   ⚠ [${gte}..${lte}] single-range over cap: count=${total}, captured=${recs.length} (${total - recs.length} unreachable)`);
  }
  return recs;
}

async function doMonth(win: { key: string; gte: string; lte: string }) {
  if (done[win.key]) { console.error(`[fedreg] skip ${win.key}`); return; }
  const recs = await fetchRange(win.gte, win.lte);
  GRAND_TOTAL += recs.length;
  console.error(`[fedreg] ${win.key} [${win.gte}..${win.lte}]: ${recs.length} docs`);

  if (DRY) {
    if (recs[0]) console.error("  sample: " + JSON.stringify(recs[0]).slice(0, 600));
    return;
  }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) {
    saved += (await saveFederalRegisterDocuments(recs.slice(i, i + 400))).saved;
  }
  done[win.key] = true;
  writeFileSync(PROG, JSON.stringify(done));
  console.error(`[fedreg] ${win.key} DONE: saved ${saved}`);
}

async function main() {
  const wins = months(START, END);
  console.error(
    `[fedreg] window ${START} → ${END} = ${wins.length} months${DRY ? " (DRY — no save; pass --save to write)" : " (SAVE)"}`,
  );
  for (const w of wins) await doMonth(w);
  console.error(`[fedreg] COMPLETE — ${GRAND_TOTAL} docs across ${wins.length} months`);
  if (DRY && wins.length > 0) {
    const perMonth = GRAND_TOTAL / wins.length;
    console.error(`[fedreg] per-month avg: ${perMonth.toFixed(0)} → projected 120-month (10yr) total: ${Math.round(perMonth * 120).toLocaleString()}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("[fedreg] FATAL", e); process.exit(1); });
