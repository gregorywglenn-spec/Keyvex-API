/**
 * Source Adapter: Member profiles — current legislators catalog.
 *
 * Authoritative denominator: the unitedstates/congress-legislators
 * `legislators-current.yaml` catalog (the same file the weekly cron ingests).
 * We reuse the scraper (scrapeBioguideCatalog) so the reconciler sees exactly
 * what the ingest sees.
 *
 * SNAPSHOT dataset (like OFAC/OIG/CSL): the source is "everyone serving right
 * now", so BOTH directions matter —
 *   - missing  = a sitting member KeyVex's `legislators` collection lacks
 *   - extras   = members KeyVex still lists who are no longer in the current
 *     catalog (resigned/died/replaced) — stale-record signal, each link
 *     verifiable on bioguide.congress.gov
 */

import { scrapeBioguideCatalog } from "../../scrapers/bioguide.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

function bioguideUrl(id: string): string {
  return `https://bioguide.congress.gov/search/bio/${id}`;
}

export const legislatorsAdapter: SourceAdapter = {
  name: "legislators",
  title: "Member profiles — current legislators (unitedstates catalog)",
  collection: "legislators",
  keyvexIdField: "bioguide_id",
  typeField: "chamber",
  expectedTypes: ["house", "senate"],

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const members = await scrapeBioguideCatalog();
    const items: SourceItem[] = members.map((m) => ({
      id: m.bioguide_id,
      url: bioguideUrl(m.bioguide_id),
      label: `${m.full_name} (${m.party} ${m.state}, ${m.chamber})`,
      meta: {
        type: m.chamber,
        year: String(m.current_term_start || "").slice(0, 4),
      },
    }));
    console.error(`[legislators] catalog has ${items.length} current members`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    return bioguideUrl(id);
  },
};
