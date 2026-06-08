/**
 * RECOVER-ONE-PTR — re-OCR a single House PTR at an explicit rotation and
 * (optionally) insert its trades into congressional_trades.
 *
 * Built for the 79 scanned filings the batch OCR returned nothing for: the
 * batch's rotation auto-detect sometimes picks the wrong angle, so the page is
 * read sideways and yields zero rows. Here the rotation is supplied explicitly
 * (the angle we confirmed upright in the viewer), so the read is clean.
 *
 *   npx tsx scripts/recover-one-ptr.ts <docId> <year> --rot=270            # read only, show rows
 *   npx tsx scripts/recover-one-ptr.ts <docId> <year> --rot=270 --save     # insert
 *
 * --rot defaults to auto-detect (Sonnet) if omitted.
 * Save is per-filing replace: delete existing ptr_id docs, insert fresh set.
 */
import "../src/load-secrets.js";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import * as mupdf from "mupdf";
import { fetchHousePtrIndex, type PtrIndexEntry } from "../src/scrapers/house.js";
import { extractTradesFromImage, detectRotation } from "./lib/ocr-vision.js";
import { visionRowsToTrades } from "./lib/house-trade-map.js";
import { saveCongressionalTrades, getLiveDb } from "../src/firestore.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const TMP = ".tmp/recover-one";
mkdirSync(TMP, { recursive: true });

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const docId = process.argv[2];
const year = Number(process.argv[3]);
const SAVE = process.argv.includes("--save");
const MODEL = arg("model") ?? "claude-sonnet-4-6";
const rotArg = arg("rot");

if (!docId || !year) {
  console.error("usage: recover-one-ptr <docId> <year> [--rot=270] [--save]");
  process.exit(1);
}

function houseDateToISO(mdY: string): string {
  if (!mdY) return "";
  const [m, d, y] = mdY.split("/");
  if (!m || !d || !y) return "";
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const RENDER_PX = arg("scale") ? parseInt(arg("scale")!, 10) : 1568;
function renderPage(doc: any, idx: number, rotCW: number, tag: string): string {
  const page = doc.loadPage(idx);
  const b = page.getBounds();
  const scale = RENDER_PX / Math.max(b[2] - b[0], b[3] - b[1]);
  let mtx = mupdf.Matrix.scale(scale, scale);
  const r = ((rotCW % 360) + 360) % 360;
  if (r) mtx = mupdf.Matrix.concat(mtx, mupdf.Matrix.rotate(r));
  const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
  const p = `${TMP}/${tag}_p${idx}.png`;
  writeFileSync(p, pix.asPNG());
  return p;
}

(async () => {
  const idx = await fetchHousePtrIndex(year);
  const ptr: PtrIndexEntry | undefined = idx.find((p) => p.doc_id === docId);
  if (!ptr) {
    console.error(`PTR ${docId} not in ${year} index`);
    process.exit(1);
  }
  console.error(`[recover] ${ptr.first} ${ptr.last} (${ptr.state_district}) — ${ptr.pdf_url}`);

  const buf = await (
    await fetch(ptr.pdf_url, { headers: { "User-Agent": UA } })
  ).arrayBuffer();
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
  const n = doc.countPages();

  let rot: number;
  if (rotArg !== undefined) {
    rot = parseInt(rotArg, 10) || 0;
    console.error(`[recover] using explicit rotation ${rot}°`);
  } else {
    const probe = renderPage(doc, 0, 0, `${docId}probe`);
    rot = await detectRotation(probe).catch(() => 0);
    rmSync(probe, { force: true });
    console.error(`[recover] auto-detected rotation ${rot}°`);
  }

  const pngs: string[] = [];
  for (let p = 0; p < n; p++) pngs.push(renderPage(doc, p, rot, docId));
  const res = await extractTradesFromImage(pngs, MODEL);
  for (const p of pngs) rmSync(p, { force: true });

  console.error(`[recover] OCR: nil=${res.nil}, rows=${res.rows.length}`);
  if (res.notes) console.error(`[recover] notes: ${res.notes}`);

  const trades = visionRowsToTrades(
    res.rows,
    {
      first: ptr.first,
      last: ptr.last,
      state: ptr.state,
      state_district: ptr.state_district,
      filing_date_iso: houseDateToISO(ptr.filing_date),
    },
    ptr.doc_id,
    ptr.pdf_url,
  );

  console.error(`\n[recover] ${trades.length} trade(s) extracted:`);
  for (const t of trades) {
    console.error(
      `   ${t.transaction_type.padEnd(8)} ${(t.ticker || t.asset_name).slice(0, 34).padEnd(34)} ${t.transaction_date}  ${t.amount_range}  owner=${t.owner}  ${t.comment ? "| " + t.comment.slice(0, 40) : ""}`,
    );
  }

  if (!SAVE) {
    console.error(`\n[recover] read-only (no --save). Re-run with --save to insert.`);
    process.exit(0);
  }
  if (trades.length === 0) {
    console.error(`\n[recover] nothing to insert (no rows). Not writing.`);
    process.exit(0);
  }

  // Per-filing replace: delete existing ptr_id docs the fresh set won't re-emit.
  const db = await getLiveDb();
  const existing = await db
    .collection("congressional_trades")
    .where("ptr_id", "==", ptr.doc_id)
    .get();
  const freshIds = new Set(trades.map((t) => t.id));
  const batch = db.batch();
  let del = 0;
  for (const d of existing.docs)
    if (!freshIds.has(d.id)) {
      batch.delete(d.ref);
      del++;
    }
  if (del) await batch.commit();
  const { saved } = await saveCongressionalTrades(trades);
  console.error(`\n[recover] inserted ${saved} trade(s) (deleted ${del} stale). Done.`);
  process.exit(0);
})().catch((e) => {
  console.error("[recover] FATAL:", e);
  process.exit(1);
});
