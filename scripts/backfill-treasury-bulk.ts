/**
 * TREASURY AUCTIONS BULK BACKFILL — TreasuryDirect / fiscaldata, 1979+ → present.
 *
 *   npx tsx scripts/backfill-treasury-bulk.ts            # full history → Firestore
 *   npx tsx scripts/backfill-treasury-bulk.ts --dry      # pull + report, no save
 *   npx tsx scripts/backfill-treasury-bulk.ts --since=1979-01-01 --until=2026-12-31
 *
 * Reuses the production scraper (scrapeTreasuryAuctions) so the dedup doc-ID key is
 * IDENTICAL to the daily cron: `${cusip}-${auction_date}` (TreasuryAuction.id, set in
 * the scraper's normalize()). MERGES into treasury_auctions via saveTreasuryAuctions —
 * same save fn the cron uses, dedup-safe. The auctions dataset is small (~11K rows back
 * to 1979), so a single wide-window pull covers all history. Resumable .tmp progress flag.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { scrapeTreasuryAuctions } from "../src/scrapers/treasury-auctions.js";
import { saveTreasuryAuctions } from "../src/firestore.js";

const DRY = process.argv.includes("--dry");
const SINCE = process.argv.find((a) => a.startsWith("--since="))?.split("=")[1] ?? "1979-01-01";
const UNTIL = process.argv.find((a) => a.startsWith("--until="))?.split("=")[1];
const PROG = ".tmp/treasury-bulk-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};

async function main() {
  const key = `${SINCE}_${UNTIL ?? "open"}`;
  if (done[key] && !DRY) {
    console.error(`[treasury-bulk] skip ${key} (already done)`);
    process.exit(0);
  }

  console.error(`[treasury-bulk] pulling auctions since=${SINCE} until=${UNTIL ?? "(open)"}${DRY ? " (DRY)" : ""}`);
  // maxRecords very high so the wide window is never capped; the dataset is ~11K rows.
  const auctions = await scrapeTreasuryAuctions({
    sinceDate: SINCE,
    untilDate: UNTIL,
    maxRecords: 1_000_000,
  });
  console.error(`[treasury-bulk] pulled ${auctions.length} normalized auction records`);

  if (auctions.length > 0) {
    const dates = auctions.map((a) => a.auction_date).sort();
    console.error(`[treasury-bulk] auction_date range: ${dates[0]} → ${dates[dates.length - 1]}`);
    console.error(`[treasury-bulk] sample doc-id (dedup key): ${auctions[0].id}`);
    console.error(`[treasury-bulk] sample record: ${JSON.stringify(auctions[0]).slice(0, 500)}`);
  }

  if (DRY) {
    console.error("[treasury-bulk] DRY — not saving");
    process.exit(0);
  }

  let saved = 0;
  for (let i = 0; i < auctions.length; i += 400) {
    const result = await saveTreasuryAuctions(auctions.slice(i, i + 400));
    saved += result.saved;
    console.error(`[treasury-bulk]   saved ${saved}/${auctions.length}`);
  }
  done[key] = true;
  writeFileSync(PROG, JSON.stringify(done));
  console.error(`[treasury-bulk] COMPLETE: saved ${saved} to treasury_auctions`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[treasury-bulk] FATAL", e);
    process.exit(1);
  });
