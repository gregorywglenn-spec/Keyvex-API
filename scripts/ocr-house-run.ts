/**
 * OCR-HOUSE-RUN — the vision half of the scanned-House-PTR pipeline.
 *
 * For each unprocessed `needs_ocr` House record:
 *   1. download the PDF,
 *   2. detect page orientation (scans arrive rotated 0/90/180/270),
 *   3. render each page UPRIGHT at ~1568px long edge (Anthropic's image cap),
 *   4. read each page with Claude Sonnet vision -> structured rows,
 *   5. aggregate into one extraction object per filing.
 *
 * Output: an extractions JSON array (same shape ingest-house-ocr.ts consumes).
 * This stays SEPARATE from the save step so the JSON can be eyeballed before
 * anything is written to congressional_trades.
 *
 *   npx tsx scripts/ocr-house-run.ts --doc=8219808            # one filing, dry
 *   npx tsx scripts/ocr-house-run.ts --max=10 --out=.tmp/ocr/batch1.json
 *   npx tsx scripts/ocr-house-run.ts --max=10 --skip-multipage # sparse first
 *
 * Then save:
 *   npx tsx scripts/ingest-house-ocr.ts .tmp/ocr/batch1.json --save
 *
 * Progress: .tmp/ocr-house-progress.json (processed doc_ids). Resumable.
 */
import "../src/load-secrets.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import * as mupdf from "mupdf";
import { getLiveDb } from "../src/firestore.js";
import {
  extractTradesFromImage,
  detectRotation,
  type VisionRow,
} from "./lib/ocr-vision.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const MODEL = "claude-sonnet-4-6";
const TMP = ".tmp/ocrwork";
mkdirSync(TMP, { recursive: true });

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const has = (k: string) => process.argv.includes(`--${k}`);
const MAX = arg("max") ? parseInt(arg("max")!, 10) : Infinity;
const CONCURRENCY = arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 5;
const ONLY_DOC = arg("doc");
const OUT = arg("out") ?? ".tmp/ocrwork/extractions.json";
const SKIP_MULTI = has("skip-multipage");
const MAXPAGES = arg("maxpages") ? parseInt(arg("maxpages")!, 10) : Infinity;

const PROG = ".tmp/ocr-house-progress.json";
const progress: { processed: Record<string, any> } = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : { processed: {} };
const saveProgress = () => writeFileSync(PROG, JSON.stringify(progress, null, 2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPdf(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e: any) {
      if (a === 3) {
        console.error(`[run] fetch give-up ${url}: ${e?.message}`);
        return null;
      }
      await sleep(2000 * (a + 1));
    }
  }
  return null;
}

/** Render one PDF page UPRIGHT at ~1568px long edge; returns the PNG path. */
function renderUpright(
  doc: any,
  pageIdx: number,
  rot: number,
  outPath: string,
): { w: number; h: number } {
  const page = doc.loadPage(pageIdx);
  const b = page.getBounds(); // [x0,y0,x1,y1]
  const wPts = b[2] - b[0],
    hPts = b[3] - b[1];
  const longPts = Math.max(wPts, hPts);
  const scale = 1568 / longPts;
  let mtx = mupdf.Matrix.scale(scale, scale);
  // `rot` is CLOCKWISE degrees (the model's convention). mupdf.Matrix.rotate
  // is counter-clockwise, so convert: CW θ == mupdf rotate (360-θ).
  const mupdfRot = (360 - (rot % 360)) % 360;
  if (mupdfRot) mtx = mupdf.Matrix.concat(mtx, mupdf.Matrix.rotate(mupdfRot));
  const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
  writeFileSync(outPath, pix.asPNG());
  return { w: pix.getWidth(), h: pix.getHeight() };
}

interface NeedsOcrRec {
  doc_id: string;
  filing_url: string;
  filer_name: string;
  filing_date: string;
  page_count: number | null;
}

async function processFiling(rec: NeedsOcrRec): Promise<any | null> {
  const buf = await fetchPdf(rec.filing_url);
  if (!buf) {
    console.error(`[run] ${rec.doc_id} fetch failed — skip`);
    return null;
  }
  const doc = mupdf.Document.openDocument(buf, "application/pdf");
  const n = doc.countPages();

  // Orientation: detect once on page 1 (native), apply to all pages.
  const probePath = `${TMP}/${rec.doc_id}_probe.png`;
  renderUpright(doc, 0, 0, probePath);
  let rot = 0;
  try {
    rot = await detectRotation(probePath);
  } catch (e: any) {
    console.error(`[run] ${rec.doc_id} orient err: ${e?.message} — assume 0`);
  }

  const pagesToRead = Math.min(n, MAXPAGES);
  // Render every page upright to disk first, then read them with a bounded
  // concurrency pool (we are not rate-limited at 1; ~5 concurrent collapses a
  // 56-page filing from ~7 min to ~90s). Results kept in page order.
  const pagePaths: string[] = [];
  for (let p = 0; p < pagesToRead; p++) {
    const pngPath = `${TMP}/${rec.doc_id}_p${p}.png`;
    renderUpright(doc, p, rot, pngPath);
    pagePaths.push(pngPath);
  }
  const perPageRows: VisionRow[][] = new Array(pagesToRead).fill(null);
  const failedPages: number[] = [];
  let next = 0;
  async function worker() {
    while (true) {
      const p = next++;
      if (p >= pagesToRead) return;
      try {
        const res = await extractTradesFromImage(pagePaths[p]!, MODEL);
        perPageRows[p] = res.rows;
      } catch (e: any) {
        console.error(`[run] ${rec.doc_id} p${p + 1} vision err: ${e?.message}`);
        perPageRows[p] = [];
        failedPages.push(p + 1);
      } finally {
        rmSync(pagePaths[p]!, { force: true });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pagesToRead) }, () => worker()),
  );
  rmSync(probePath, { force: true });
  const rows: VisionRow[] = perPageRows.flat();

  const nil = rows.length === 0;
  console.error(
    `[run] ${rec.doc_id} ${rec.filer_name} (${n}pg, rot${rot}) -> ${rows.length} row(s)${nil ? " [NIL]" : ""}${failedPages.length ? ` !!FAILED pages ${failedPages.join(",")}` : ""}`,
  );
  return {
    doc_id: rec.doc_id,
    filing_url: rec.filing_url,
    filer_name: rec.filer_name,
    filing_date: rec.filing_date,
    nil,
    confidence: "vision_sonnet",
    page_count: n,
    failed_pages: failedPages,
    rows: rows.map((r) => ({
      asset_name: r.asset_name,
      ticker: r.ticker ?? "",
      asset_type: r.asset_type ?? "",
      owner: r.owner ?? "Self",
      type: r.type,
      tx_date: r.tx_date,
      notif_date: r.notif_date ?? "",
      amount_col: r.amount_col,
      comment: r.comment ?? "",
    })),
  };
}

(async () => {
  const db = await getLiveDb();
  const snap = await db.collection("needs_ocr").where("source", "==", "house").get();
  let recs: NeedsOcrRec[] = snap.docs.map((d) => d.data() as NeedsOcrRec);
  // smallest first (quick wins, cheaper) unless a single doc is requested
  recs.sort((a, b) => (a.page_count ?? 1) - (b.page_count ?? 1));
  if (ONLY_DOC) recs = recs.filter((r) => r.doc_id === ONLY_DOC);
  if (SKIP_MULTI) recs = recs.filter((r) => (r.page_count ?? 1) <= 2);

  // Crash-safe incremental output: append each filing to a JSONL sibling as
  // it completes, and only mark progress AFTER the line is flushed. The .json
  // array is rebuilt from the JSONL at the end for the ingest step.
  const JSONL = OUT.replace(/\.json$/, "") + ".jsonl";
  const out: any[] = [];
  let count = 0;
  for (const rec of recs) {
    if (count >= MAX) break;
    if (progress.processed[rec.doc_id] && !ONLY_DOC && !has("force")) continue;
    const ex = await processFiling(rec);
    if (!ex) continue;
    appendFileSync(JSONL, JSON.stringify(ex) + "\n");
    out.push(ex);
    // A filing with failed pages is NOT marked done, so a later --force-free
    // re-run picks it up again and fills the gap.
    if ((ex.failed_pages?.length ?? 0) === 0) {
      progress.processed[rec.doc_id] = {
        trades: ex.rows.length,
        nil: ex.nil,
        at: "vision",
      };
      saveProgress();
    } else {
      console.error(
        `[run] ${rec.doc_id} left UNMARKED (failed pages ${ex.failed_pages.join(",")}) — will re-run`,
      );
    }
    count++;
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2));
  const totalRows = out.reduce((s, f) => s + f.rows.length, 0);
  console.error(
    `\n[run] DONE: ${out.length} filing(s), ${totalRows} row(s) -> ${OUT}`,
  );
  console.error(
    `[run] processed total: ${Object.keys(progress.processed).length}/185`,
  );
  console.error(`[run] review ${OUT}, then: npx tsx scripts/ingest-house-ocr.ts ${OUT} --save`);
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[run] FATAL:", e);
    process.exit(1);
  });
