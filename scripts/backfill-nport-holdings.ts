/**
 * N-PORT HOLDINGS ERA CATCH-UP — closes the extraction backlog the 2026-06-10
 * reconcile found (heavy filing days blew the cron's 30-min budget and its
 * 2-day window slid past them: e.g. 2026-05-28 had 79/1,970 filings with
 * holdings rows).
 *
 *   npx tsx scripts/backfill-nport-holdings.ts            # full era catch-up, SAVES
 *   npx tsx scripts/backfill-nport-holdings.ts --dry      # count-only
 *   npx tsx scripts/backfill-nport-holdings.ts --max=200  # bounded run
 *
 * Era floor 2026-05-12 (when the holdings phase shipped — historical
 * holdings before that are a separate cost decision, not this script).
 * Chunked + resumable by construction: every chunk saves before the next
 * starts, and re-runs re-diff against Firestore, so killing it loses at
 * most one chunk of work. EDGAR-rate-limited via the scraper's own pacing.
 */
import "../src/load-secrets.js";
import { findNportHoldingsBacklog, saveNportHoldings } from "../src/firestore.js";
import { scrapeNportHoldings } from "../src/scrapers/nport.js";

const DRY = process.argv.includes("--dry");
const MAX = parseInt(process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? "100000", 10);
const ERA_FLOOR = "2026-05-12";
// Far-back period floor: era AMENDMENTS can cover periods years old; a
// narrow floor hid their saved rows from the diff (endless re-process
// churn, caught 2026-06-11).
const PERIOD_FLOOR = "2000-01-01";
const CHUNK = 100;

// Watchdog: this run silently froze 3x (log stops mid-cycle, process never
// exits — a hung gRPC/socket await somewhere with no timeout). Timers still
// fire while an await hangs, so a stall detector can self-terminate the
// process; exit(3) surfaces through the harness instead of freezing.
let lastProgressAt = Date.now();
const WATCHDOG_MS = 15 * 60 * 1000;
setInterval(() => {
  if (Date.now() - lastProgressAt > WATCHDOG_MS) {
    console.error(
      `[nport-cu] WATCHDOG: no progress for ${Math.round((Date.now() - lastProgressAt) / 60000)} min — self-terminating (resumable; relaunch to continue)`,
    );
    process.exit(3);
  }
}, 60_000).unref();

let processed = 0;
let rows = 0;
while (processed < MAX) {
  const { backlog, backlogTotal } = await findNportHoldingsBacklog(
    ERA_FLOOR,
    PERIOD_FLOOR,
    Math.min(CHUNK, MAX - processed),
  );
  if (backlog.length === 0) {
    console.error(`[nport-cu] backlog drained (total remaining: ${backlogTotal})`);
    break;
  }
  lastProgressAt = Date.now();
  console.error(
    `[nport-cu] chunk of ${backlog.length} (backlog total ${backlogTotal}, processed so far ${processed})`,
  );
  if (DRY) {
    console.error(`[nport-cu] DRY — would process ${backlogTotal} filings`);
    break;
  }
  const holdings = await scrapeNportHoldings(backlog);
  if (holdings.length > 0) {
    const r = await saveNportHoldings(holdings);
    rows += r.saved;
  }
  // Filings that legitimately parse to 0 rows stay in the diff forever —
  // count them so the loop can't spin. If a whole chunk yields nothing new,
  // surface and stop rather than loop on unparseables.
  if (holdings.length === 0) {
    console.error(
      `[nport-cu] entire chunk parsed to 0 rows — stopping; sample ids: ${backlog
        .slice(0, 5)
        .map((f) => f.filing_id)
        .join(", ")}`,
    );
    break;
  }
  processed += backlog.length;
}
console.error(`[nport-cu] DONE — processed ~${processed} filings, saved ${rows} rows ${DRY ? "(dry)" : ""}`);
