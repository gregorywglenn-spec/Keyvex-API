/**
 * One-time honest seed for the HHS-OIG exclusions job's /meta doc.
 *
 * The collection was first populated by a manual `oig --save` CLI run (Day 9)
 * that didn't write /meta/oigExclusionsSync, and the monthly cron (fires the
 * 5th) hasn't come around since deploy — so the health-check reports
 * "no successful run on record." This does a REAL scrape→save→meta pass,
 * identical to scrapeOigExclusionsMonthly, so the cleared status reflects a
 * genuine successful run, not a phantom timestamp.
 *
 *   npx tsx scripts/seed-oig-meta.ts
 */
import { scrapeOigExclusions } from "../src/scrapers/oig-exclusions.js";
import { saveOigExclusions, writeJobMeta } from "../src/firestore.js";

async function main() {
  const started = Date.now();
  console.log("[seed-oig] scraping HHS-OIG LEIE exclusions CSV...");
  const exclusions = await scrapeOigExclusions();
  console.log(`[seed-oig] scraped ${exclusions.length} exclusions; saving...`);
  const result = await saveOigExclusions(exclusions);
  console.log(`[seed-oig] saved ${result.saved} to ${result.collection}`);
  await writeJobMeta("oigExclusionsSync", { started, docsWritten: result.saved });
  console.log(`[seed-oig] wrote /meta/oigExclusionsSync (lastSyncedAt=now, docsWritten=${result.saved})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
