/**
 * Honest one-time seed of /meta/executiveTradesSync after the manual CLI
 * backfill (3,267 trades). The CLI scraper doesn't write job telemetry; the
 * scheduled scrapeOge278tDaily cron does. Until its first fire (06:20 ET),
 * the health-check would report "no successful run on record" → false alert.
 * The backfill WAS a real successful run, so recording it is faithful.
 *
 *   npx tsx scripts/seed-exec-meta.ts
 */
import { getDbIfLive, writeJobMeta } from "../src/firestore.js";

const db = await getDbIfLive();
if (!db) {
  console.error("stub mode — no creds; aborting");
  process.exit(1);
}
const snap = await db.collection("executive_trades").count().get();
const n = snap.data().count;
await writeJobMeta("executiveTradesSync", { started: Date.now(), docsWritten: n });
console.log(`seeded /meta/executiveTradesSync (docsWritten=${n})`);
process.exit(0);
