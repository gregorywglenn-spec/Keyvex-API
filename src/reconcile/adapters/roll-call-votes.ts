/**
 * Source Adapter: Roll-call votes — House + Senate, Congresses 113→119.
 *
 * Authoritative denominator: the vote LISTS both chambers publish —
 *   - House: api.congress.gov /v3/house-vote/{congress}/{session} (paginated)
 *   - Senate: senate.gov vote_menu_{congress}_{session}.xml
 * We reuse the scraper (scrapeRollCallVotes), which enumerates from those list
 * endpoints only (no per-vote detail fetches), so the denominator is exactly
 * what the ingest sees. If a list endpoint ever caps short, the tell is
 * "source < KeyVex", not a false gap.
 *
 * SCOPE: the 2026-06 historical backfill covered Congresses 113→119 (both
 * chambers, both sessions); the daily cron maintains 119. `--years=113-119`
 * style flags are interpreted as CONGRESS numbers here, not calendar years.
 */

import { scrapeRollCallVotes } from "../../scrapers/congress-legislation.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const DEFAULT_CONGRESSES = [113, 114, 115, 116, 117, 118, 119];

export const rollCallVotesAdapter: SourceAdapter = {
  name: "roll-call-votes",
  title: "Roll-call votes — House (api.congress.gov) + Senate (senate.gov), 113th–119th",
  collection: "roll_call_votes",
  keyvexIdField: "vote_id",
  typeField: "chamber",
  expectedTypes: ["house", "senate"],

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    // --years here means congress numbers (113–119), not calendar years.
    const congresses =
      ctx.years && ctx.years.length > 0
        ? ctx.years.filter((c) => c >= 100 && c <= 130)
        : DEFAULT_CONGRESSES;

    const items: SourceItem[] = [];
    for (const congress of congresses) {
      try {
        const votes = await scrapeRollCallVotes({ congress });
        for (const v of votes) {
          items.push({
            id: v.vote_id,
            url: v.congress_gov_url || v.source_data_url,
            label: `${v.chamber} RC#${v.roll_call_number} — ${v.result}${v.bill_id ? ` (${v.bill_id})` : ""}`,
            meta: {
              type: v.chamber,
              year: String(v.start_date || "").slice(0, 4) || String(congress),
            },
          });
        }
        console.error(`[roll-call-votes] congress ${congress}: ${votes.length} votes`);
      } catch (err) {
        ctx.warn(`congress ${congress} enumeration failed: ${(err as Error).message}`);
      }
    }
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    // vote_id = {chamber}-{congress}-{session}-{rcNum}
    const m = /^(house|senate)-(\d+)-(\d+)-(\d+)$/.exec(id);
    if (!m) return "https://www.congress.gov/roll-call-votes";
    const [, chamber, congress, session, rc] = m;
    if (chamber === "senate") {
      return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${rc!.padStart(5, "0")}.xml`;
    }
    return `https://clerk.house.gov/Votes/${congress?.slice(-2)}${session}${rc}`;
  },
};
