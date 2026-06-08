/**
 * CATCH-UP Form D 2026 — recover the ~8,245 filings the old FTS cron dropped,
 * using the FIXED daily-index scraper. Wide lookback covers 2026 Q2 (the window
 * past the bulk backfill's Q1 cutoff). Idempotent (savePrivatePlacements merges
 * on filing_id) — re-fetching the ones we already have is harmless.
 *
 *   npx tsx scripts/catchup-form-d-2026.ts [--days=70]
 */
import "../src/load-secrets.js";
import { scrapeFormDLiveFeed } from "../src/scrapers/form-d.js";
import { savePrivatePlacements } from "../src/firestore.js";

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const days = arg("days") ? parseInt(arg("days")!, 10) : 70;

(async () => {
  console.error(`[catchup-formd] scraping last ${days} days via daily-index…`);
  const records = await scrapeFormDLiveFeed({ lookbackDays: days });
  console.error(`[catchup-formd] ${records.length} records parsed; saving…`);
  const res = await savePrivatePlacements(records);
  console.error(`[catchup-formd] saved ${res.saved} to ${res.collection}`);
  process.exit(0);
})().catch((e) => {
  console.error("[catchup-formd] FATAL:", e);
  process.exit(1);
});
