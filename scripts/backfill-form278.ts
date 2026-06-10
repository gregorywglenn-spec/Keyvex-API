/**
 * FORM 278 HISTORICAL BACKFILL — closes the gaps found by the 2026-06-10
 * reconcile (docs/reconciliation/form278-G1.html: 12.12% coverage).
 *
 *   npx tsx scripts/backfill-form278.ts              # full plan, SAVES
 *   npx tsx scripts/backfill-form278.ts --dry        # scrape+count only
 *   npx tsx scripts/backfill-form278.ts --only=house-2024
 *   npx tsx scripts/backfill-form278.ts --no-parse   # metadata-only (fast)
 *
 * Units (resumable via .tmp/form278-backfill-progress.json):
 *   - senate-2012..2015  — the pre-backfill-floor years (467 missing)
 *   - senate-2019        — one missing paper filing (Manchin)
 *   - senate-2026        — current-year catch-up (7 recent missing)
 *   - house-2015..2026   — House Clerk INDEX years, full report family
 *     {O,A,C,H,T}; "O" (annual originals) was excluded from ingestion
 *     entirely before 2026-06-10, and no House historical backfill ever ran
 *     (~15.6K missing).
 *
 * Doc ids (`senate-{subtype}-{id}` / `house-fd-{docId}`) are the SAME the
 * weekly cron writes, so re-runs and cron overlap MERGE, never duplicate.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  scrapeSenateForm278,
  scrapeHouseForm278,
} from "../src/scrapers/form278.js";
import { saveForm278Filings } from "../src/firestore.js";

const DRY = process.argv.includes("--dry");
const NO_PARSE = process.argv.includes("--no-parse");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];

const PROG = ".tmp/form278-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};

interface Unit {
  key: string;
  run: () => Promise<number>;
}

const parseContent = !NO_PARSE;
const units: Unit[] = [];

for (const y of [2012, 2013, 2014, 2015, 2019, 2026]) {
  units.push({
    key: `senate-${y}`,
    run: async () => {
      const filings = await scrapeSenateForm278({
        startDate: `${y}-01-01`,
        endDate: `${y}-12-31`,
        parseContent,
      });
      if (!DRY && filings.length > 0) {
        const r = await saveForm278Filings(filings);
        return r.saved;
      }
      return filings.length;
    },
  });
}

for (let y = 2015; y <= 2026; y++) {
  units.push({
    key: `house-${y}`,
    run: async () => {
      const filings = await scrapeHouseForm278({
        indexYears: [y],
        parseContent,
      });
      if (!DRY && filings.length > 0) {
        const r = await saveForm278Filings(filings);
        return r.saved;
      }
      return filings.length;
    },
  });
}

let total = 0;
for (const u of units) {
  if (ONLY && u.key !== ONLY) continue;
  if (done[u.key] && !ONLY) {
    console.error(`[bf278] skip ${u.key} (already done)`);
    continue;
  }
  console.error(`[bf278] === ${u.key} (parseContent=${parseContent}, dry=${DRY}) ===`);
  try {
    const n = await u.run();
    total += n;
    console.error(`[bf278] ${u.key}: ${n} filings ${DRY ? "found" : "saved"}`);
    if (!DRY) {
      done[u.key] = true;
      writeFileSync(PROG, JSON.stringify(done, null, 1));
    }
  } catch (err) {
    console.error(`[bf278] ${u.key} FAILED: ${(err as Error).message}`);
    // keep going — progress file lets a re-run retry just the failures
  }
}
console.error(`[bf278] DONE — ${total} filings ${DRY ? "found" : "saved"} this run`);
