/**
 * NEEDS-OCR DETECTION SWEEP — find scanned / image-only / corrupted-text-layer
 * filings and RECORD references to them in the `needs_ocr` Firestore collection
 * so they can be OCR'd later in one batch (and so we get a hard COUNT for
 * pricing math).
 *
 * THIS SCRIPT DOES NOT OCR ANYTHING. It only fetches each PDF, runs pdf-parse,
 * applies the needsOcr() density heuristic, and (with --save) writes a small
 * reference record per flagged filing. Re-runs MERGE (dedup key = sanitized
 * filing_url), never duplicate.
 *
 * USAGE (default is DRY — real writes require --save, matching the
 * registration-statements backfill convention):
 *
 *   # small dry-test (House only, last 45 days) — recommended first run
 *   npx tsx scripts/detect-ocr-needed.ts --source=house --start=2026-04-21 --end=2026-06-05
 *
 *   # full 3-year sweep, all sources, WRITE refs to Firestore
 *   npx tsx scripts/detect-ocr-needed.ts --save
 *
 *   # one source over an explicit window
 *   npx tsx scripts/detect-ocr-needed.ts --source=oge --start=2023-06-05 --end=2026-06-05 --save
 *
 * FLAGS:
 *   --save                write refs to Firestore (otherwise DRY: detect + count only)
 *   --source=house|senate|oge|all   default all
 *   --start=YYYY-MM-DD     window start (default: 3 years ago)
 *   --end=YYYY-MM-DD       window end   (default: today)
 *   --max=N               cap PDFs fetched per source (testing)
 *
 * Resumable: per-filing progress recorded in .tmp/needs-ocr-progress.json so an
 * interrupted sweep skips already-checked filings on restart. Network fetches
 * retry with backoff. Supervisor-compatible (Form-D backfill template style).
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  fetchHousePtrIndex,
  type PtrIndexEntry,
} from "../src/scrapers/house.js";
import {
  fetchSenatePtrRefs,
  isPaperPtr,
  type SenatePtrRef,
} from "../src/scrapers/senate.js";
import { fetchOge278tIndex } from "../src/scrapers/oge278t.js";
import { needsOcr, realWordCount } from "../src/needs-ocr.js";
import { saveNeedsOcr, needsOcrDocId, countNeedsOcr } from "../src/firestore.js";
import type { NeedsOcr } from "../src/types.js";

// ─── args ────────────────────────────────────────────────────────────────────
const SAVE = process.argv.includes("--save");
const SOURCE = (
  process.argv.find((a) => a.startsWith("--source="))?.split("=")[1] ?? "all"
).toLowerCase();
const MAX = (() => {
  const v = process.argv.find((a) => a.startsWith("--max="))?.split("=")[1];
  return v ? parseInt(v, 10) : Infinity;
})();
const today = new Date();
const threeYearsAgo = new Date();
threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const START =
  process.argv.find((a) => a.startsWith("--start="))?.split("=")[1] ??
  isoOf(threeYearsAgo);
const END =
  process.argv.find((a) => a.startsWith("--end="))?.split("=")[1] ?? isoOf(today);

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const NOW = new Date().toISOString();
const RATE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── resumable progress ───────────────────────────────────────────────────────
const PROG = ".tmp/needs-ocr-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};
const markDone = (key: string) => {
  done[key] = true;
};
const flushProgress = () => writeFileSync(PROG, JSON.stringify(done));

// ─── pdf-parse (lazy, CJS interop) ─────────────────────────────────────────────
let _extract: ((buf: ArrayBuffer) => Promise<{ text: string; numpages: number }>) | null =
  null;
async function getExtractor() {
  if (_extract) return _extract;
  const mod = (await import("pdf-parse")) as unknown as {
    default: (b: Buffer) => Promise<{ text: string; numpages: number }>;
  };
  _extract = async (buf: ArrayBuffer) => mod.default(Buffer.from(buf));
  return _extract;
}

// ─── network fetch with retry/backoff ──────────────────────────────────────────
async function fetchBuf(url: string): Promise<ArrayBuffer | null> {
  for (let a = 0; a < 5; a++) {
    try {
      await sleep(RATE_MS);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e: any) {
      if (a === 4) {
        console.error(`[ocr] net give-up ${url}: ${e?.message ?? e}`);
        return null;
      }
      console.error(`[ocr] net "${e?.cause?.code ?? e?.message ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

// ─── ISO helpers ───────────────────────────────────────────────────────────────
const inWindow = (iso: string): boolean => !iso || (iso >= START && iso <= END);
function houseDateToISO(mdY: string): string {
  if (!mdY) return "";
  const [m, d, y] = mdY.split("/");
  if (!m || !d || !y) return "";
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// ─── running counts ────────────────────────────────────────────────────────────
const stats: Record<string, { checked: number; flagged: number; skipped: number }> =
  {
    house: { checked: 0, flagged: 0, skipped: 0 },
    senate: { checked: 0, flagged: 0, skipped: 0 },
    oge: { checked: 0, flagged: 0, skipped: 0 },
  };

// Buffer flagged refs and flush in chunks so we don't hold thousands in memory
// on a full sweep.
let pending: NeedsOcr[] = [];
async function emit(rec: NeedsOcr) {
  console.error(
    `[ocr]   FLAG ${rec.source} ${rec.doc_id} "${rec.filer_name}" ${rec.filing_date} — ` +
      `${rec.reason} (${rec.real_word_count} words / ${rec.page_count ?? "?"} pages, ${rec.extracted_chars} chars)`,
  );
  if (SAVE) {
    pending.push(rec);
    if (pending.length >= 200) {
      await saveNeedsOcr(pending);
      pending = [];
    }
  }
}

// ─── House sweep ───────────────────────────────────────────────────────────────
async function sweepHouse() {
  const extract = await getExtractor();
  const startYear = parseInt(START.slice(0, 4), 10);
  const endYear = parseInt(END.slice(0, 4), 10);
  let count = 0;
  for (let year = endYear; year >= startYear; year--) {
    let index: PtrIndexEntry[];
    try {
      index = await fetchHousePtrIndex(year);
    } catch (e: any) {
      console.error(`[ocr] house index ${year} failed: ${e?.message ?? e}`);
      continue;
    }
    const inRange = index.filter((p) =>
      inWindow(houseDateToISO(p.filing_date)),
    );
    console.error(
      `[ocr] house ${year}: ${inRange.length} PTRs in window (of ${index.length})`,
    );
    for (const ptr of inRange) {
      if (count >= MAX) return;
      const key = `house:${ptr.pdf_url}`;
      if (done[key]) continue;
      const buf = await fetchBuf(ptr.pdf_url);
      if (!buf) {
        stats.house.skipped++;
        markDone(key);
        continue;
      }
      let text = "";
      let pages = 1;
      try {
        const r = await extract(buf);
        text = r.text ?? "";
        pages = r.numpages || 1;
      } catch (e: any) {
        // A pdf-parse crash on a malformed/image PDF is itself a strong
        // needs-OCR signal — flag it as scanned_no_text_layer.
        console.error(`[ocr] house ${ptr.doc_id} parse-err: ${e?.message ?? e}`);
        await emit({
          id: needsOcrDocId(ptr.pdf_url),
          source: "house",
          filing_url: ptr.pdf_url,
          filer_name: `${ptr.first} ${ptr.last}`.trim(),
          filing_date: houseDateToISO(ptr.filing_date),
          doc_id: ptr.doc_id,
          page_count: null,
          extracted_chars: 0,
          real_word_count: 0,
          reason: "scanned_no_text_layer",
          detected_at: NOW,
        });
        stats.house.checked++;
        stats.house.flagged++;
        count++;
        markDone(key);
        continue;
      }
      stats.house.checked++;
      count++;
      if (needsOcr(text, pages)) {
        stats.house.flagged++;
        await emit({
          id: needsOcrDocId(ptr.pdf_url),
          source: "house",
          filing_url: ptr.pdf_url,
          filer_name: `${ptr.first} ${ptr.last}`.trim(),
          filing_date: houseDateToISO(ptr.filing_date),
          doc_id: ptr.doc_id,
          page_count: pages,
          extracted_chars: text.length,
          real_word_count: realWordCount(text),
          reason: "scanned_no_text_layer",
          detected_at: NOW,
        });
      }
      markDone(key);
      if (stats.house.checked % 25 === 0) {
        flushProgress();
        console.error(
          `[ocr] house running: ${stats.house.checked} checked, ${stats.house.flagged} flagged, ${stats.house.skipped} skipped`,
        );
      }
    }
  }
}

// ─── Senate sweep (paper-PTR amendments only) ──────────────────────────────────
async function sweepSenate() {
  let refs: SenatePtrRef[];
  let session: { fetch: typeof fetch; csrfToken: string };
  try {
    const r = await fetchSenatePtrRefs(START, END);
    refs = r.refs;
    session = r.session;
  } catch (e: any) {
    console.error(`[ocr] senate list failed: ${e?.message ?? e}`);
    return;
  }
  console.error(`[ocr] senate: ${refs.length} PTRs in window`);
  let count = 0;
  for (const ref of refs) {
    if (count >= MAX) return;
    const key = `senate:${ref.detailUrl}`;
    if (done[key]) continue;
    let html = "";
    try {
      await sleep(RATE_MS);
      const res = await session.fetch(ref.detailUrl, {
        headers: { "User-Agent": UA, Referer: "https://efdsearch.senate.gov/search/" },
      });
      if (!res.ok) {
        stats.senate.skipped++;
        markDone(key);
        continue;
      }
      html = await res.text();
    } catch (e: any) {
      console.error(`[ocr] senate ${ref.ptrId} fetch-err: ${e?.message ?? e}`);
      stats.senate.skipped++;
      markDone(key);
      continue;
    }
    stats.senate.checked++;
    count++;
    // Senate electronic PTRs are HTML tables (no text-layer problem). Only the
    // "paper PTR" amendments (HTML wrapper around a scanned PDF embed) need OCR.
    if (isPaperPtr(html)) {
      stats.senate.flagged++;
      await emit({
        id: needsOcrDocId(ref.detailUrl),
        source: "senate",
        filing_url: ref.detailUrl,
        filer_name: `${ref.firstName} ${ref.lastName}`.trim(),
        filing_date: ref.dateFiled,
        doc_id: ref.ptrId,
        page_count: null,
        extracted_chars: 0,
        real_word_count: 0,
        reason: "paper_ptr",
        detected_at: NOW,
      });
    }
    markDone(key);
    if (stats.senate.checked % 25 === 0) {
      flushProgress();
      console.error(
        `[ocr] senate running: ${stats.senate.checked} checked, ${stats.senate.flagged} flagged, ${stats.senate.skipped} skipped`,
      );
    }
  }
}

// ─── OGE 278 sweep ─────────────────────────────────────────────────────────────
async function sweepOge() {
  const extract = await getExtractor();
  let refs;
  try {
    refs = await fetchOge278tIndex();
  } catch (e: any) {
    console.error(`[ocr] oge index failed: ${e?.message ?? e}`);
    return;
  }
  const inRange = refs.filter((r) => inWindow(r.filing_date));
  console.error(`[ocr] oge: ${inRange.length} filings in window (of ${refs.length})`);
  let count = 0;
  for (const ref of inRange) {
    if (count >= MAX) return;
    const key = `oge:${ref.pdf_url}`;
    if (done[key]) continue;
    const buf = await fetchBuf(ref.pdf_url);
    if (!buf) {
      stats.oge.skipped++;
      markDone(key);
      continue;
    }
    let text = "";
    let pages = 1;
    try {
      const r = await extract(buf);
      text = r.text ?? "";
      pages = r.numpages || 1;
    } catch (e: any) {
      console.error(`[ocr] oge ${ref.filename} parse-err: ${e?.message ?? e}`);
      await emit({
        id: needsOcrDocId(ref.pdf_url),
        source: "oge",
        filing_url: ref.pdf_url,
        filer_name: ref.filer_name,
        filing_date: ref.filing_date,
        doc_id: ref.filename,
        page_count: null,
        extracted_chars: 0,
        real_word_count: 0,
        reason: "corrupted_text_layer",
        detected_at: NOW,
      });
      stats.oge.checked++;
      stats.oge.flagged++;
      count++;
      markDone(key);
      continue;
    }
    stats.oge.checked++;
    count++;
    if (needsOcr(text, pages)) {
      stats.oge.flagged++;
      // OGE corruption is a broken font encoding (text present but garbled),
      // distinct from a true raster scan — label it corrupted_text_layer.
      await emit({
        id: needsOcrDocId(ref.pdf_url),
        source: "oge",
        filing_url: ref.pdf_url,
        filer_name: ref.filer_name,
        filing_date: ref.filing_date,
        doc_id: ref.filename,
        page_count: pages,
        extracted_chars: text.length,
        real_word_count: realWordCount(text),
        reason: "corrupted_text_layer",
        detected_at: NOW,
      });
    }
    markDone(key);
    if (stats.oge.checked % 25 === 0) {
      flushProgress();
      console.error(
        `[ocr] oge running: ${stats.oge.checked} checked, ${stats.oge.flagged} flagged, ${stats.oge.skipped} skipped`,
      );
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.error(
    `[ocr] sweep source=${SOURCE} window=${START}..${END} ${SAVE ? "SAVE" : "DRY (no writes)"}` +
      (MAX !== Infinity ? ` max=${MAX}/source` : ""),
  );

  if (SOURCE === "house" || SOURCE === "all") await sweepHouse();
  if (SOURCE === "senate" || SOURCE === "all") await sweepSenate();
  if (SOURCE === "oge" || SOURCE === "all") await sweepOge();

  if (SAVE && pending.length > 0) {
    await saveNeedsOcr(pending);
    pending = [];
  }
  flushProgress();

  const totChecked =
    stats.house.checked + stats.senate.checked + stats.oge.checked;
  const totFlagged =
    stats.house.flagged + stats.senate.flagged + stats.oge.flagged;
  console.error("\n[ocr] ===== SWEEP SUMMARY =====");
  for (const s of ["house", "senate", "oge"] as const) {
    console.error(
      `[ocr] ${s.padEnd(7)} checked=${stats[s].checked} flagged=${stats[s].flagged} skipped=${stats[s].skipped}`,
    );
  }
  console.error(`[ocr] TOTAL  checked=${totChecked} flagged=${totFlagged}`);
  if (SAVE) {
    const total = await countNeedsOcr();
    console.error(`[ocr] needs_ocr collection now holds ${total} ref(s).`);
  } else {
    console.error(`[ocr] DRY RUN — no refs written. Re-run with --save to persist.`);
  }
})().catch((e) => {
  console.error("[ocr] FATAL:", e);
  process.exit(1);
});
