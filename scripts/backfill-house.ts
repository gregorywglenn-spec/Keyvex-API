/**
 * COMPREHENSIVE HOUSE CONGRESSIONAL-TRADES BACKFILL — 10-year window, resumable.
 *
 *   npx tsx scripts/backfill-house.ts            # 10 years back → present
 *   npx tsx scripts/backfill-house.ts 2014       # custom start year
 *
 * Walks the House Clerk yearly PTR index (FilingType "P" only), fetches every
 * PTR PDF, extracts + parses the trade rows, and streams them to Firestore
 * (idempotent on the house-<docId>-<row> doc id). Checkpoints after each
 * completed year, so a crash/sleep resumes at the next unfinished year.
 *
 * DIFFERENT SOURCE from the lobbying (LDA) backfill — House Clerk has its own
 * rate budget, so the two run in parallel at full speed. ~250ms/PDF, polite.
 *
 * KNOWN LIMITATION (tracked on the board): the PDF parser skips some rows
 * (the Khanna/McCaul-style holes). This backfill massively widens coverage
 * (recent-only → 10 years); the parser-skip rate gets measured + hardened at
 * verification time, and the Senate half is a separate follow-up.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  fetchHousePtrIndex,
  fetchHousePtrText,
  parseHousePtrText,
} from "../src/scrapers/house.js";
import { saveCongressionalTrades } from "../src/firestore.js";
import type { CongressionalTrade } from "../src/types.js";

const NOW_YEAR = 2026; // context date 2026-06
const startYear = process.argv[2] ? parseInt(process.argv[2], 10) : NOW_YEAR - 10; // 2016
const PDF_DELAY_MS = 250; // polite pacing for House Clerk (unmetered, be courteous)
const PROG = ".tmp/house-backfill-progress.json";

mkdirSync(".tmp", { recursive: true });
const done: number[] = existsSync(PROG)
  ? (JSON.parse(readFileSync(PROG, "utf8")).done ?? [])
  : [];

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let buf: CongressionalTrade[] = [];
let savedTotal = 0;
async function flush(): Promise<void> {
  if (buf.length === 0) return;
  const r = await saveCongressionalTrades(buf);
  savedTotal += r.saved;
  buf = [];
}

async function main(): Promise<void> {
  console.error(
    `[backfill-house] window ${startYear}–${NOW_YEAR}; already done: [${done.join(",")}]`,
  );
  for (let y = NOW_YEAR; y >= startYear; y--) {
    if (done.includes(y)) {
      console.error(`[backfill-house] skip ${y} (checkpointed done)`);
      continue;
    }
    const t0 = Date.now();
    let ptrs;
    try {
      ptrs = await fetchHousePtrIndex(y);
    } catch (e) {
      console.error(`[backfill-house] ${y} index FAILED (skipping year): ${String(e)}`);
      continue;
    }
    console.error(`[backfill-house] ===== YEAR ${y}: ${ptrs.length} PTRs =====`);
    let processed = 0;
    let skipped = 0;
    let trades = 0;
    for (const ptr of ptrs) {
      try {
        await sleep(PDF_DELAY_MS);
        const text = await fetchHousePtrText(ptr);
        const rows = parseHousePtrText(text, ptr);
        trades += rows.length;
        buf.push(...rows);
        if (buf.length >= 400) await flush();
      } catch {
        skipped++;
      }
      processed++;
      if (processed % 200 === 0) {
        console.error(
          `[backfill-house]   ${y} ${processed}/${ptrs.length} PTRs · ${trades} trades parsed · ${skipped} PTRs skipped · saved overall ${savedTotal}`,
        );
      }
    }
    await flush();
    done.push(y);
    writeFileSync(PROG, JSON.stringify({ done }, null, 2));
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.error(
      `[backfill-house] ===== YEAR ${y} DONE: ${processed} PTRs, ${trades} trades, ${skipped} skipped, ${mins}m · saved overall ${savedTotal} =====`,
    );
  }
  console.error(
    `[backfill-house] COMPLETE. Years ${startYear}–${NOW_YEAR}. Total saved this run: ${savedTotal}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[backfill-house] FATAL:", e);
    process.exit(1);
  });
