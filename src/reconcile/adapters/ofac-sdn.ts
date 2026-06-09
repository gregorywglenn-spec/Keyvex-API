/**
 * Source Adapter: OFAC Specially Designated Nationals (SDN) list.
 *
 * Authoritative denominator: Treasury OFAC's canonical SDN.csv (single-file,
 * uncapped full list). We reuse the scraper's own downloader (scrapeOfacSdn)
 * as the answer key, so the reconciler compares apples to apples — same parse,
 * same ent_num keys KeyVex stores.
 *
 * SHAPE NOTE — this is a CURRENT-SNAPSHOT list, not an append-only archive.
 * OFAC publishes the *current* sanctions roster; entities are added AND removed
 * over time. So both diff directions matter:
 *   - missing (in SDN.csv, not in KeyVex)  → under-coverage
 *   - extraInKeyvex (in KeyVex, not in SDN.csv) → STALE rows the daily
 *     full-refresh scraper kept after OFAC delisted them. The reconciler
 *     reports extraInKeyvexCount/Sample; for SDN that count is the real
 *     quality signal to watch.
 */

import { scrapeOfacSdn } from "../../scrapers/ofac-sdn.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

export const ofacSdnAdapter: SourceAdapter = {
  name: "ofac-sdn",
  title: "OFAC Specially Designated Nationals (SDN.csv)",
  collection: "ofac_sdn",
  keyvexIdField: "ent_num",
  typeField: "entity_type",
  // OFAC's SDN_Type is populated only for individual / vessel / aircraft.
  // COMPANIES carry a BLANK SDN_Type by OFAC's design (they surface in the
  // census as the "(none)" bucket — ~9.7K of them, faithfully blank). So
  // "entity" is intentionally NOT an expected type here; listing it would
  // raise a false "reads zero" flag.
  expectedTypes: ["individual", "vessel", "aircraft"],

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const entries = await scrapeOfacSdn();
    const items: SourceItem[] = entries.map((e) => ({
      id: e.ent_num,
      url: e.ofac_url,
      label: e.name,
      meta: { type: e.entity_type || "" },
    }));
    console.error(`[ofac-sdn] enumerated ${items.length} SDN entries`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  // Link to confirm a stale (extra-in-KeyVex) entry: OFAC's per-entity detail
  // page. A delisted ent_num no longer appears in the live sanctions search.
  urlForId(id: string): string {
    return `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${id}`;
  },
};
