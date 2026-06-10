/**
 * ROLL-CALL VOTES HISTORICAL BACKFILL — Congresses 113→119 (~2013→2026).
 *
 *   npx tsx scripts/backfill-roll-call-votes.ts            # full 113→119, BOTH chambers, BOTH sessions, SAVES
 *   npx tsx scripts/backfill-roll-call-votes.ts --dry      # parse + count only, no Firestore write
 *   npx tsx scripts/backfill-roll-call-votes.ts --only=117 # one congress
 *   npx tsx scripts/backfill-roll-call-votes.ts --only=117 --chamber=house --session=1
 *
 * Reuses the existing scraper (scrapeRollCallVotes) for per-vote parse + the
 * existing save fn (saveRollCallVotes). House votes come from api.congress.gov
 * /v3/house-vote/{congress}/{session}; Senate votes come from senate.gov XML
 * (vote_menu_{congress}_{session}.xml) — api.congress.gov does NOT expose Senate
 * votes. Both paths set vote_id = {chamber}-{congress}-{session}-{rcNum}, which
 * is the Firestore doc id / dedup key (saveRollCallVotes line:
 *   batch.set(collection.doc(vote.vote_id), vote, { merge: true })
 * ) — identical to what the daily cron writes, so re-runs MERGE, never duplicate.
 *
 * Resumable per (congress, chamber, session) via .tmp/roll-call-votes-progress.json.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { scrapeRollCallVotes } from "../src/scrapers/congress-legislation.js";
import { saveRollCallVotes } from "../src/firestore.js";
import type { RollCallVote } from "../src/types.js";

const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const CHAMBER_ARG = process.argv.find((a) => a.startsWith("--chamber="))?.split("=")[1] as
  | "house"
  | "senate"
  | undefined;
const SESSION_ARG = process.argv.find((a) => a.startsWith("--session="))?.split("=")[1];

const PROG = ".tmp/roll-call-votes-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};

// 113th Congress = 2013-2014; 119th = 2025-2026. Session 1 = odd year, session 2 = even year.
const CONGRESSES: number[] = [];
for (let c = 113; c <= 119; c++) CONGRESSES.push(c);

const CHAMBERS: ("house" | "senate")[] = CHAMBER_ARG ? [CHAMBER_ARG] : ["house", "senate"];
const SESSIONS: number[] = SESSION_ARG ? [parseInt(SESSION_ARG, 10)] : [1, 2];

async function doUnit(congress: number, chamber: "house" | "senate", session: number) {
  const key = `${congress}-${chamber}-${session}`;
  if (done[key]) {
    console.error(`[rcv] skip ${key} (already done)`);
    return;
  }
  console.error(`[rcv] === ${key} ===`);

  let votes: RollCallVote[] = [];
  try {
    // The scraper handles network-retry/backoff internally (House) and a
    // 404-as-not-published silent skip (Senate). Scope it to exactly one
    // (congress, chamber, session) so progress is per-unit resumable.
    votes = await scrapeRollCallVotes({ congress, chamber, session });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[rcv] ${key} FAILED: ${msg} — leaving un-done for retry`);
    return;
  }

  console.error(`[rcv] ${key}: ${votes.length} votes parsed`);
  if (votes.length > 0) {
    console.error(`[rcv]   sample: ${JSON.stringify(votes[0]).slice(0, 400)}`);
  }

  if (DRY) {
    console.error(`[rcv] ${key}: DRY — not saved`);
    return;
  }

  let saved = 0;
  for (let i = 0; i < votes.length; i += 400) {
    saved += (await saveRollCallVotes(votes.slice(i, i + 400))).saved;
  }
  done[key] = true;
  writeFileSync(PROG, JSON.stringify(done));
  console.error(`[rcv] ${key} DONE: saved ${saved}`);
}

async function main() {
  const congresses = ONLY ? [parseInt(ONLY, 10)] : CONGRESSES;
  console.error(
    `[rcv] backfill congresses=${congresses.join(",")} chambers=${CHAMBERS.join(",")} sessions=${SESSIONS.join(",")}${DRY ? " (DRY — no writes)" : ""}`,
  );
  for (const congress of congresses) {
    for (const chamber of CHAMBERS) {
      for (const session of SESSIONS) {
        await doUnit(congress, chamber, session);
      }
    }
  }
  console.error("[rcv] COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[rcv] FATAL", e);
    process.exit(1);
  });
