/**
 * REPROCESS-HOUSE-EXCHANGES — recover exchange (E) rows that the OLD parser
 * silently dropped from filings KeyVex ALREADY has.
 *
 * Context: until the 2026-06-08 fix, both the text parser and the vision/OCR
 * mapper dropped Exchange ("E") transactions. Filings that were entirely
 * exchange-only vanished (those are handled by backfill-house-complete, since
 * they're "missing"). But filings that had a buy/sell AND an exchange were
 * SAVED — minus their exchange row. A missing-filing backfill can't see those
 * because the filing is "present." This script finds them by re-parsing the
 * filings we already have and writing back the now-captured exchange rows.
 *
 * Strategy (idempotent, no duplicates/orphans):
 *   - For each PRESENT House filing in the chosen years, re-fetch + re-parse
 *     with the fixed parser (text layer; optional --ocr for scanned).
 *   - If the fresh parse yields >= 1 exchange row, REPLACE that filing's rows:
 *     delete every existing doc with ptr_id == docId, then insert the fresh
 *     full parse. Replace (not merge) is bulletproof against row renumbering
 *     and OCR non-determinism.
 *   - Filings with no exchange are left untouched (no write).
 *
 * Default is a READ-ONLY dry run that just COUNTS hidden exchanges so the
 * volume is known before anything is written.
 *
 *   npx tsx scripts/reprocess-house-exchanges.ts --years=2015-2026            # dry run, text-only
 *   npx tsx scripts/reprocess-house-exchanges.ts --years=2022 --max=50        # quick sample
 *   npx tsx scripts/reprocess-house-exchanges.ts --years=2015-2026 --save     # write (text)
 *   npx tsx scripts/reprocess-house-exchanges.ts --years=2015-2026 --ocr --save  # incl scanned re-OCR
 */
import "../src/load-secrets.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as mupdf from "mupdf";
import {
  fetchHousePtrIndex,
  parseHousePtrText,
  type PtrIndexEntry,
} from "../src/scrapers/house.js";
import { getLiveDb, saveCongressionalTrades } from "../src/firestore.js";
import { extractTradesFromImage, detectRotation } from "./lib/ocr-vision.js";
import { visionRowsToTrades } from "./lib/house-trade-map.js";
import type { CongressionalTrade } from "../src/types.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const TMP = ".tmp/reprocess-exch";
mkdirSync(TMP, { recursive: true });

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SAVE = process.argv.includes("--save");
const OCR = process.argv.includes("--ocr");
const MAX = arg("max") ? parseInt(arg("max")!, 10) : Infinity;
const CONC = arg("concurrency") ? parseInt(arg("concurrency")!, 10) : 4;
const yearsArg = arg("years") ?? "2015-2026";
const YEARS = yearsArg.includes("-")
  ? (() => {
      const [a, b] = yearsArg.split("-").map(Number);
      const out: number[] = [];
      for (let y = a!; y <= b!; y++) out.push(y);
      return out;
    })()
  : yearsArg.split(",").map(Number);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let _pdf: ((b: ArrayBuffer) => Promise<{ text: string }>) | null = null;
async function pdfText() {
  if (_pdf) return _pdf;
  const m = (await import("pdf-parse")) as any;
  _pdf = async (b: ArrayBuffer) => m.default(Buffer.from(b));
  return _pdf;
}

async function fetchBuf(url: string): Promise<ArrayBuffer | null> {
  for (let a = 0; a < 4; a++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (a + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.arrayBuffer();
    } catch {
      if (a === 3) return null;
      await sleep(1500 * (a + 1));
    }
  }
  return null;
}

function renderUpright(doc: any, idx: number, rotCW: number, tag: string): string {
  const page = doc.loadPage(idx);
  const b = page.getBounds();
  const scale = 1568 / Math.max(b[2] - b[0], b[3] - b[1]);
  let mtx = mupdf.Matrix.scale(scale, scale);
  const mr = (360 - (rotCW % 360)) % 360;
  if (mr) mtx = mupdf.Matrix.concat(mtx, mupdf.Matrix.rotate(mr));
  const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
  const p = `${TMP}/${tag}_p${idx}.png`;
  writeFileSync(p, pix.asPNG());
  return p;
}

/** Re-parse one present filing → its full fresh row set (text, or OCR if --ocr). */
async function reparse(ptr: PtrIndexEntry): Promise<CongressionalTrade[]> {
  const buf = await fetchBuf(ptr.pdf_url);
  if (!buf) return [];
  let text = "";
  try {
    text = (await (await pdfText())(buf)).text ?? "";
  } catch {
    text = "";
  }
  if (text.trim()) {
    try {
      const t = parseHousePtrText(text, ptr);
      for (const x of t) x.extraction_method = "text_layer";
      return t;
    } catch {
      return [];
    }
  }
  // No text layer → scanned. Only re-OCR when --ocr is set (cost control).
  if (!OCR) return [];
  try {
    const doc = mupdf.Document.openDocument(buf, "application/pdf");
    const n = doc.countPages();
    const probe = renderUpright(doc, 0, 0, `${ptr.doc_id}probe`);
    let rot = 0;
    try {
      rot = await detectRotation(probe);
    } catch {
      /* assume 0 */
    }
    rmSync(probe, { force: true });
    const rows: any[] = [];
    for (let p = 0; p < n; p++) {
      const png = renderUpright(doc, p, rot, ptr.doc_id);
      try {
        const res = await extractTradesFromImage(png, "claude-sonnet-4-6");
        rows.push(...res.rows);
      } catch {
        /* skip page */
      } finally {
        rmSync(png, { force: true });
      }
    }
    if (!rows.length) return [];
    return visionRowsToTrades(
      rows,
      {
        first: ptr.first,
        last: ptr.last,
        state: ptr.state,
        state_district: ptr.state_district,
        filing_date_iso: ptr.filing_date.includes("/")
          ? (() => {
              const [m, d, y] = ptr.filing_date.split("/");
              return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
            })()
          : ptr.filing_date,
      },
      ptr.doc_id,
      ptr.pdf_url,
    );
  } catch {
    return [];
  }
}

/** Replace one filing's rows: delete existing ptr_id docs, insert fresh set. */
async function replaceFiling(
  db: FirebaseFirestore.Firestore,
  docId: string,
  fresh: CongressionalTrade[],
): Promise<void> {
  const existing = await db
    .collection("congressional_trades")
    .where("ptr_id", "==", docId)
    .get();
  const freshIds = new Set(fresh.map((t) => t.id));
  // Delete only the existing docs that the fresh parse does NOT re-emit (avoids
  // a delete+recreate churn on stable ids; removes any now-orphaned old ids).
  const batch = db.batch();
  let deletes = 0;
  for (const d of existing.docs) {
    if (!freshIds.has(d.id)) {
      batch.delete(d.ref);
      deletes++;
    }
  }
  if (deletes > 0) await batch.commit();
  // Insert/overwrite the fresh full set (idempotent set+merge in saver).
  await saveCongressionalTrades(fresh);
}

(async () => {
  const db = await getLiveDb();
  console.error(`[reprocess] loading present House ptr_ids…`);
  const have = new Set<string>(
    (
      await db
        .collection("congressional_trades")
        .where("chamber", "==", "house")
        .select("ptr_id")
        .get()
    ).docs.map((d) => (d.data() as any).ptr_id),
  );
  console.error(`[reprocess] ${have.size} present House filings`);

  // Build worklist: present filings in chosen years.
  const work: PtrIndexEntry[] = [];
  for (const y of YEARS) {
    let idx: PtrIndexEntry[];
    try {
      idx = await fetchHousePtrIndex(y);
    } catch (e: any) {
      console.error(`[reprocess] index ${y} err: ${e?.message}`);
      continue;
    }
    for (const p of idx) if (have.has(p.doc_id)) work.push(p);
  }
  const queue = work.slice(0, MAX === Infinity ? work.length : MAX);
  console.error(
    `[reprocess] ${queue.length} present filings to re-parse (${SAVE ? "WRITE" : "DRY-RUN"}, ${OCR ? "text+OCR" : "text-only"}, conc ${CONC})`,
  );

  let filingsWithExch = 0;
  let exchRows = 0;
  let written = 0;
  let done = 0;
  const samples: string[] = [];

  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= queue.length) return;
      const ptr = queue[i]!;
      await sleep(50);
      let fresh: CongressionalTrade[] = [];
      try {
        fresh = await reparse(ptr);
      } catch {
        fresh = [];
      }
      const exch = fresh.filter((t) => t.transaction_type === "exchange");
      if (exch.length > 0) {
        filingsWithExch++;
        exchRows += exch.length;
        if (samples.length < 20) {
          samples.push(
            `${ptr.doc_id} ${ptr.first} ${ptr.last} (${ptr.year}): ${exch.length} exch — ${exch[0]!.ticker || exch[0]!.asset_name.slice(0, 24)} ${exch[0]!.amount_range}`,
          );
        }
        if (SAVE) {
          try {
            await replaceFiling(db, ptr.doc_id, fresh);
            written += exch.length;
          } catch (e: any) {
            console.error(`[reprocess] write FAIL ${ptr.doc_id}: ${e?.message}`);
          }
        }
      }
      done++;
      if (done % 100 === 0) {
        console.error(
          `[reprocess] ${done}/${queue.length} | filings w/ exch: ${filingsWithExch} | exch rows: ${exchRows}${SAVE ? ` | written: ${written}` : ""}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  console.error(`\n[reprocess] DONE. re-parsed ${done} present filings.`);
  console.error(`[reprocess] filings containing a dropped exchange: ${filingsWithExch}`);
  console.error(`[reprocess] total hidden exchange rows: ${exchRows}`);
  if (SAVE) console.error(`[reprocess] exchange rows written back: ${written}`);
  else console.error(`[reprocess] DRY-RUN — nothing written. Re-run with --save to write.`);
  console.error(`[reprocess] samples:`);
  for (const s of samples) console.error(`   ${s}`);
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[reprocess] FATAL:", e);
    process.exit(1);
  });
