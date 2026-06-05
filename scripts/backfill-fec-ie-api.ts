/**
 * FEC SCHEDULE E (INDEPENDENT EXPENDITURES) HISTORICAL BACKFILL — 2016+.
 *
 *   npx tsx scripts/backfill-fec-ie-api.ts                 # 2016-01 → present, month-by-month
 *   npx tsx scripts/backfill-fec-ie-api.ts --dry --only=2016-01   # one month, no save
 *   npx tsx scripts/backfill-fec-ie-api.ts --only=2020          # whole year 2020
 *   npx tsx scripts/backfill-fec-ie-api.ts --min-amount=0       # include sub-$1k rows
 *
 * SOURCE: FEC API schedule_e endpoint (api.open.fec.gov/v1/schedules/schedule_e/).
 *
 *   WHY THE API, NOT THE BULK FILE: the FEC bulk "Independent Expenditures"
 *   CSV (fec.gov/.../independent_expenditure_<YYYY>.csv) carries columns
 *   CAN_ID / SPE_ID / TRA_ID / FILE_NUM / IMA_NUM ... but it has NO `sub_id`
 *   column. The daily cron (saveFecIndependentExpenditures) keys every doc by
 *   `sub_id`. Using the bulk file would force a synthesized doc-id that would
 *   NOT match the cron's sub_id docs → duplicate rows for the same expenditure.
 *   The API returns `sub_id` directly (verified live: e.g. "4122620071083100039",
 *   distinct from link_id "4121920071082979728" — the row-level vs filing-level
 *   distinction). So we use the API to keep the dedup key identical to the cron.
 *
 * This script REUSES the production scraper (scrapeFecScheduleE) and the
 * production save fn (saveFecIndependentExpenditures) verbatim — identical
 * normalization, identical sub_id doc-id key, MERGE-safe. We only drive it
 * with month-bounded windows so the cursor pagination stays reliable.
 *
 *   WHY MONTH-BY-MONTH: schedule_e is sorted by -expenditure_date and
 *   cursor-paginated on last_expenditure_date. Many rows have null
 *   expenditure_date (unitemized / amended), which can stall a date-cursor on
 *   large unbounded pulls. Bounding each segment to one month keeps every
 *   segment small (well under the page cap) and lets the cursor terminate
 *   cleanly. Resumable per month via .tmp progress file. Idempotent (MERGE on
 *   sub_id) so a re-run of a partially-done month is harmless.
 *
 * RATE LIMITS: requires a real FEC_API_KEY (1,000 req/hr personal key) in
 * secrets/.env or the environment. DEMO_KEY (40 req/hr) is NOT enough for a
 * full backfill — the scraper warns and falls back to it but will rate-limit.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { scrapeFecScheduleE } from "../src/scrapers/fec-schedule-e.js";
import { saveFecIndependentExpenditures } from "../src/firestore.js";
import type { FecIndependentExpenditure } from "../src/types.js";

const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const MIN_AMOUNT = Number(
  process.argv.find((a) => a.startsWith("--min-amount="))?.split("=")[1] ?? "1000",
);

const PROG = ".tmp/fec-ie-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};

// ─── Build the month list 2016-01 → current month ────────────────────────────
const START_YEAR = 2016;
const now = new Date();
const END_YEAR = now.getUTCFullYear();
const END_MONTH = now.getUTCMonth() + 1; // 1-12

function monthsOfYear(y: number): string[] {
  const out: string[] = [];
  const lastM = y === END_YEAR ? END_MONTH : 12;
  for (let m = 1; m <= lastM; m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}

const ALL_MONTHS: string[] = [];
for (let y = START_YEAR; y <= END_YEAR; y++) ALL_MONTHS.push(...monthsOfYear(y));

// Resolve --only into a month list: "2020" → all of 2020; "2020-03" → that month.
function resolveOnly(only: string): string[] {
  if (/^\d{4}$/.test(only)) return monthsOfYear(Number(only));
  if (/^\d{4}-\d{2}$/.test(only)) return [only];
  throw new Error(`--only must be YYYY or YYYY-MM, got "${only}"`);
}

function monthBounds(ym: string): { minDate: string; maxDate: string } {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day
  return {
    minDate: `${ym}-01`,
    maxDate: `${ym}-${String(last).padStart(2, "0")}`,
  };
}

async function doMonth(ym: string): Promise<void> {
  if (done[ym] && !DRY) {
    console.error(`[fec-ie] skip ${ym}`);
    return;
  }
  const { minDate, maxDate } = monthBounds(ym);
  console.error(`[fec-ie] ${ym}: pulling ${minDate}..${maxDate} (min_amount=$${MIN_AMOUNT})`);

  // Reuse the production scraper. maxPages high enough to drain a heavy month
  // (a busy presidential month can exceed 10k rows → 100+ pages of 100).
  const ies: FecIndependentExpenditure[] = await scrapeFecScheduleE({
    minDate,
    maxDate,
    minAmount: MIN_AMOUNT,
    maxPages: 5000,
  });

  console.error(`[fec-ie] ${ym}: ${ies.length} unique IEs (keyed by sub_id)`);

  if (DRY) {
    const sample = ies[0];
    console.error(`[fec-ie] DRY — sample sub_id=${sample?.sub_id ?? "(none)"}`);
    console.error("  " + JSON.stringify(sample ?? {}, null, 2).slice(0, 1200));
    return;
  }

  let saved = 0;
  for (let i = 0; i < ies.length; i += 400) {
    saved += (await saveFecIndependentExpenditures(ies.slice(i, i + 400))).saved;
  }
  done[ym] = true;
  writeFileSync(PROG, JSON.stringify(done));
  console.error(`[fec-ie] ${ym} DONE: saved ${saved}`);
}

async function main(): Promise<void> {
  const months = ONLY ? resolveOnly(ONLY) : ALL_MONTHS;
  console.error(
    `[fec-ie] ${months.length} month(s)${DRY ? " (DRY — no save)" : ""}; ` +
      `min_amount=$${MIN_AMOUNT}; range ${months[0]}..${months[months.length - 1]}`,
  );
  for (const ym of months) await doMonth(ym);
  console.error("[fec-ie] COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[fec-ie] FATAL", e);
    process.exit(1);
  });
