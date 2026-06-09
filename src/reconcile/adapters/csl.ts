/**
 * Source Adapter: US Consolidated Screening List (CSL).
 *
 * Authoritative denominator: trade.gov's bulk consolidated.json (the full union
 * of 12 export-screening lists from Commerce/State/Treasury — single file, no
 * auth, uncapped). We reuse the scraper's own downloader so the reconciler
 * derives the SAME id KeyVex stores (csl-<listShort>-<rawId>).
 *
 * SHAPE NOTE — CURRENT-SNAPSHOT union, like OFAC/OIG. The "extra in KeyVex"
 * count is the STALE-record signal (entries the source dropped that the
 * full-refresh scraper kept). typeField is source_short so the per-list census
 * surfaces whether any of the 12 component lists silently reads zero.
 * expectedTypes is intentionally left unset on the first pass — the exact short
 * codes are whatever sourceShort() derives from live data, so we observe them
 * rather than guess (guessing risks a false "reads zero").
 */

import { scrapeConsolidatedScreeningList } from "../../scrapers/csl.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

export const cslAdapter: SourceAdapter = {
  name: "csl",
  title: "US Consolidated Screening List (trade.gov consolidated.json)",
  collection: "screening_list",
  keyvexIdField: "id",
  typeField: "source_short",
  // The 12 component lists, confirmed present in live data (2026-06). Listed as
  // expected so a future run loudly flags if any one list silently drops to
  // zero (a whole-source-vanished failure). CAP currently has just 1 entry —
  // exactly the kind of fragile list this guard is meant to watch.
  expectedTypes: [
    "SDN", "EL", "DPL", "DTC", "SSI", "UVL",
    "MEU", "PLC", "CMIC", "ISN", "MBS", "CAP",
  ],

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const rows = await scrapeConsolidatedScreeningList();
    const items: SourceItem[] = rows.map((r) => ({
      id: r.id,
      url: r.source_information_url || r.source_list_url || "",
      label: `${r.name} (${r.source_short})`,
      meta: { type: r.source_short || "" },
    }));
    console.error(`[csl] enumerated ${items.length} screening entries`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
