/**
 * BACKFILL-HOUSE-COMPLETE — get EVERY House PTR the Clerk index lists.
 *
 * Completeness, not best-effort. For each filing in the official Clerk index
 * (per year) that KeyVex does not already have:
 *   1. fetch the PDF,
 *   2. try the TEXT parser (parseHousePtrText) — most filings have a text layer,
 *   3. if that yields nothing, fall back to VISION OCR (Sonnet) — the scanned ones,
 *   4. if still nothing, record it as nil / unreadable (so it's accounted for,
 *      never silently dropped).
 * Then save. At the end, coverage against the source index is measured so we
 * can PROVE completeness instead of asserting it.
 *
 *   npx tsx scripts/backfill-house-complete.ts --years=2015-2026          # all
 *   npx tsx scripts/backfill-house-complete.ts --years=2022 --max=20      # test
 *   npx tsx scripts/backfill-house-complete.ts --years=2015-2026 --concurrency=4
 *
 * Resumable via .tmp/backfill-house-complete-progress.json. Idempotent saves.
 */
import "../src/load-secrets.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import * as mupdf from "mupdf";
import {
  fetchHousePtrIndex,
  parseHousePtrText,
  type PtrIndexEntry,
} from "../src/scrapers/house.js";
import { getLiveDb, saveCongressionalTrades } from "../src/firestore.js";
import {
  extractTradesFromImage,
  detectRotation,
} from "./lib/ocr-vision.js";
import { visionRowsToTrades } from "./lib/house-trade-map.js";
import type { CongressionalTrade } from "../src/types.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const TMP = ".tmp/bf-house";
mkdirSync(TMP, { recursive: true });
const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const MAX = arg("max") ? parseInt(arg("max")!, 10) : Infinity;
const CONC = arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 4;
const yearsArg = arg("years") ?? "2015-2026";
const YEARS = (() => {
  if (yearsArg.includes("-")) {
    const [a, b] = yearsArg.split("-").map(Number);
    const out: number[] = [];
    for (let y = a!; y <= b!; y++) out.push(y);
    return out;
  }
  return yearsArg.split(",").map(Number);
})();

// --fresh ignores any prior progress file and writes to a separate one. Needed
// after a parser fix: filings the OLD parser marked "nil" (e.g. exchange-only
// PTRs whose E rows were dropped) must be REprocessed, not skipped on the stale
// outcome. The have-set still prevents redundant work for filings truly saved.
const FRESH = process.argv.includes("--fresh");
const PROG =
  arg("progress") ??
  (FRESH
    ? ".tmp/backfill-house-recovery-progress.json"
    : ".tmp/backfill-house-complete-progress.json");
const progress: { processed: Record<string, { method: string; trades: number }> } =
  !FRESH && existsSync(PROG)
    ? JSON.parse(readFileSync(PROG, "utf8"))
    : { processed: {} };
const flushProg = () => writeFileSync(PROG, JSON.stringify(progress));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let _ex: ((b: ArrayBuffer) => Promise<{ text: string; numpages: number }>) | null =
  null;
async function pdfText() {
  if (_ex) return _ex;
  const m = (await import("pdf-parse")) as any;
  _ex = async (b: ArrayBuffer) => m.default(Buffer.from(b));
  return _ex;
}

async function fetchBuf(url: string): Promise<ArrayBuffer | null | "404"> {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return "404";
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e: any) {
      if (a === 3) return null;
      await sleep(2000 * (a + 1));
    }
  }
  return null;
}

function houseDateToISO(mdY: string): string {
  if (!mdY) return "";
  const [m, d, y] = mdY.split("/");
  if (!m || !d || !y) return "";
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function renderUpright(doc: any, idx: number, rotCW: number, tag: string): string {
  const page = doc.loadPage(idx);
  const b = page.getBounds();
  const scale = 1568 / Math.max(b[2] - b[0], b[3] - b[1]);
  let mtx = mupdf.Matrix.scale(scale, scale);
  const mr = (360 - (rotCW % 360)) % 360;
  if (mr) mtx = mupdf.Matrix.concat(mtx, mupdf.Matrix.rotate(mr));
  const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
  const p = `${TMP}/${tag}_p${idx}.png`; // unique per filing+page (concurrency-safe)
  writeFileSync(p, pix.asPNG());
  return p;
}

interface Outcome {
  method: "text" | "vision" | "nil" | "unreadable" | "404" | "error";
  trades: CongressionalTrade[];
}

async function processOne(ptr: PtrIndexEntry): Promise<Outcome> {
  const buf = await fetchBuf(ptr.pdf_url);
  if (buf === "404") return { method: "404", trades: [] };
  if (!buf) return { method: "error", trades: [] };

  // 1) TEXT path
  let text = "";
  try {
    const r = await (await pdfText())(buf);
    text = r.text ?? "";
  } catch {
    text = ""; // pdf-parse choke == strong scanned signal
  }
  if (text.trim()) {
    try {
      const t = parseHousePtrText(text, ptr);
      if (t.length > 0) {
        for (const x of t) x.extraction_method = "text_layer";
        return { method: "text", trades: t };
      }
      if (/nothing to report|no reportable|no transactions/i.test(text))
        return { method: "nil", trades: [] };
    } catch {
      /* fall through to vision */
    }
  }

  // 2) VISION path (scanned or text-parser-empty)
  try {
    const doc = mupdf.Document.openDocument(buf, "application/pdf");
    const n = doc.countPages();
    const tag = ptr.doc_id;
    const probe = renderUpright(doc, 0, 0, `${tag}probe`);
    let rot = 0;
    try {
      rot = await detectRotation(probe);
    } catch {
      /* assume 0 */
    }
    rmSync(probe, { force: true });
    const rows: any[] = [];
    for (let p = 0; p < n; p++) {
      const png = renderUpright(doc, p, rot, tag);
      try {
        const res = await extractTradesFromImage(png, "claude-sonnet-4-6");
        rows.push(...res.rows);
      } catch {
        /* skip page */
      } finally {
        rmSync(png, { force: true });
      }
    }
    if (rows.length > 0) {
      const meta = {
        first: ptr.first,
        last: ptr.last,
        state: ptr.state,
        state_district: ptr.state_district,
        filing_date_iso: houseDateToISO(ptr.filing_date),
      };
      return {
        method: "vision",
        trades: visionRowsToTrades(rows, meta, ptr.doc_id, ptr.pdf_url),
      };
    }
    return { method: "nil", trades: [] };
  } catch {
    return { method: "unreadable", trades: [] };
  }
}

(async () => {
  const db = await getLiveDb();
  console.error(`[bf] loading existing House ptr_ids…`);
  const have = new Set<string>(
    (await db.collection("congressional_trades").where("chamber", "==", "house").get()).docs.map(
      (d) => (d.data() as any).ptr_id,
    ),
  );

  // Build the missing worklist from the official index.
  const work: PtrIndexEntry[] = [];
  for (const y of YEARS) {
    let idx: PtrIndexEntry[];
    try {
      idx = await fetchHousePtrIndex(y);
    } catch (e: any) {
      console.error(`[bf] index ${y} err: ${e?.message}`);
      continue;
    }
    for (const p of idx)
      if (!have.has(p.doc_id) && !progress.processed[p.doc_id]) work.push(p);
  }
  console.error(
    `[bf] ${work.length} missing+unprocessed filings across ${YEARS[0]}-${YEARS[YEARS.length - 1]} (conc ${CONC})`,
  );

  const stats: Record<string, number> = {};
  let buffer: CongressionalTrade[] = [];
  // doc_ids whose trades are buffered but NOT yet saved — their progress is
  // committed ONLY after the save lands, so a crash can never mark a
  // trade-bearing filing "done" with its trades lost (it just reprocesses,
  // and the have-set already excludes anything truly saved).
  let pendingDocs: { docId: string; method: string; trades: number }[] = [];
  let savedTrades = 0;
  let done = 0;
  const queue = work.slice(0, MAX === Infinity ? work.length : MAX);

  async function flush() {
    const batch = buffer;
    const pend = pendingDocs;
    buffer = [];
    pendingDocs = [];
    if (batch.length) {
      const res = await saveCongressionalTrades(batch);
      savedTrades += res.saved;
    }
    for (const d of pend)
      progress.processed[d.docId] = { method: d.method, trades: d.trades };
    flushProg();
  }

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= queue.length) return;
      const ptr = queue[i]!;
      let outcome: Outcome;
      try {
        outcome = await processOne(ptr);
      } catch (e: any) {
        outcome = { method: "error", trades: [] };
      }
      stats[outcome.method] = (stats[outcome.method] ?? 0) + 1;
      if (outcome.trades.length) {
        // defer the progress mark until the trades are flushed
        buffer.push(...outcome.trades);
        pendingDocs.push({
          docId: ptr.doc_id,
          method: outcome.method,
          trades: outcome.trades.length,
        });
      } else {
        // 0-trade outcome (nil/404/error/unreadable): nothing to lose, mark now
        progress.processed[ptr.doc_id] = { method: outcome.method, trades: 0 };
      }
      done++;
      if (buffer.length >= 200 || pendingDocs.length >= 40) await flush();
      if (done % 25 === 0) {
        flushProg();
        console.error(
          `[bf] ${done}/${queue.length} | ${Object.entries(stats).map(([k, v]) => `${k}:${v}`).join(" ")} | saved ${savedTrades}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  await flush();
  flushProg();

  console.error(`\n[bf] DONE. ${done} filings processed.`);
  console.error(`[bf] outcomes: ${JSON.stringify(stats)}`);
  console.error(`[bf] trades saved this run: ${savedTrades}`);
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[bf] FATAL:", e);
    process.exit(1);
  });
