/**
 * Source Adapter: HHS-OIG List of Excluded Individuals/Entities (LEIE).
 *
 * Authoritative denominator: OIG's UPDATED.csv (the full current exclusion
 * roster, single-file, uncapped). We reuse the scraper's own downloader so the
 * reconciler derives the SAME id KeyVex stores (oig-<npi> or oig-<hash>).
 *
 * SHAPE NOTE — CURRENT-SNAPSHOT list, like OFAC. When a person is reinstated or
 * removed, OIG drops them from UPDATED.csv. KeyVex's daily full-refresh saves
 * idempotently but does not delete, so the "extra in KeyVex" count is the
 * STALE-record signal (reinstated/removed people KeyVex kept). There is no
 * per-record detail URL (OIG publishes a CSV + a search page), so stale ids are
 * listed bare in the report; verify via OIG's online LEIE search by name/NPI.
 */

import { scrapeOigExclusions } from "../../scrapers/oig-exclusions.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

export const oigExclusionsAdapter: SourceAdapter = {
  name: "oig-exclusions",
  title: "HHS-OIG Excluded Individuals/Entities (LEIE UPDATED.csv)",
  collection: "oig_exclusions",
  keyvexIdField: "id",
  typeField: "exclusion_type",
  // exclusion_type is a descriptive statutory basis code (1128a1, 1128b4, …),
  // not a "must not drop" category — no expectedTypes (the census just shows
  // the distribution; nothing should flag a false "reads zero").

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const rows = await scrapeOigExclusions();
    const items: SourceItem[] = rows.map((r) => ({
      id: r.id,
      url: r.oig_source_url,
      label: r.full_name,
      meta: { type: r.exclusion_type || "" },
    }));
    console.error(`[oig-exclusions] enumerated ${items.length} exclusions`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
