/**
 * COMPREHENSIVE LOBBYING BACKFILL — 10-year window (default), resumable.
 *
 *   npx tsx scripts/backfill-lobbying.ts            # 10 years back → present
 *   npx tsx scripts/backfill-lobbying.ts 2010       # custom start year
 *
 * Pulls EVERY LDA filing for each year (no 5,000 cap), newest year first,
 * streaming each page straight to Firestore (idempotent on filing_uuid).
 * Writes a checkpoint after each completed year, so a crash/sleep just
 * resumes at the next unfinished year. ~30 min/year at 2 req/sec.
 */
import "../src/load-secrets.js"; // load secrets/.env → process.env.LDA_API_KEY
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { backfillLobbyingByYear } from "../src/scrapers/lobbying.js";
import { saveLobbyingFilings } from "../src/firestore.js";
import type { LobbyingFiling } from "../src/types.js";

if (!process.env.LDA_API_KEY) {
  console.error("[backfill-lobbying] ABORT: LDA_API_KEY not set. Anonymous rate (15/min) makes this a ~40h crawl. Add LDA_API_KEY to secrets/.env first.");
  process.exit(1);
}

const NOW_YEAR = 2026; // current year (context date 2026-06)
const startYear = process.argv[2] ? parseInt(process.argv[2], 10) : NOW_YEAR - 10; // 2016→2026, 10 years back
const PROG = ".tmp/lobbying-backfill-progress.json";

mkdirSync(".tmp", { recursive: true });
const done: number[] = existsSync(PROG)
  ? (JSON.parse(readFileSync(PROG, "utf8")).done ?? [])
  : [];

let buf: LobbyingFiling[] = [];
let savedTotal = 0;
async function flush(): Promise<void> {
  if (buf.length === 0) return;
  const r = await saveLobbyingFilings(buf);
  savedTotal += r.saved;
  buf = [];
}

async function main(): Promise<void> {
  console.error(`[backfill-lobbying] window ${startYear}–${NOW_YEAR}; already done: [${done.join(",")}]`);
  for (let y = NOW_YEAR; y >= startYear; y--) {
    if (done.includes(y)) {
      console.error(`[backfill-lobbying] skip ${y} (checkpointed done)`);
      continue;
    }
    const t0 = Date.now();
    console.error(`[backfill-lobbying] ===== YEAR ${y} starting =====`);
    const res = await backfillLobbyingByYear(y, async (filings, pageNum, total) => {
      buf.push(...filings);
      if (buf.length >= 400) await flush();
      if (pageNum % 25 === 0) {
        console.error(`[backfill-lobbying]   ${y} page ${pageNum} · pulled so far this year ~${pageNum * 25}/${total} · saved overall ${savedTotal}`);
      }
    });
    await flush();
    done.push(y);
    writeFileSync(PROG, JSON.stringify({ done }, null, 2));
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.error(`[backfill-lobbying] ===== YEAR ${y} DONE: pulled ${res.pulled}/${res.total} in ${mins}m · saved overall ${savedTotal} =====`);
  }
  console.error(`[backfill-lobbying] COMPLETE. Years ${startYear}–${NOW_YEAR}. Total saved this run: ${savedTotal}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[backfill-lobbying] FATAL:", e); process.exit(1); });
