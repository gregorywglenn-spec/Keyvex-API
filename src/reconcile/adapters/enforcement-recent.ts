/**
 * Source Adapter: Enforcement actions — recent-window completeness across
 * all six regulators (SEC, DOJ, CFTC, OCC, FDIC, FTC).
 *
 * These sources are ROLLING feeds by design (RSS windows, press-release
 * index pages, DOJ's recent pages) — KeyVex's v1A scope is "recent
 * enforcement news", not all-of-history. So the meaningful gauge is: does
 * `enforcement_actions` hold everything the six feeds show RIGHT NOW?
 *
 * Denominator: the scraper's own per-source fetchers via
 * scrapeEnforcementActions({}) — the join key (action_id) is identical by
 * construction, and per-source failures are warned (a dead feed shows up
 * as a warning + missing per-type census, never a silent blank).
 *
 * Extras are EXPECTED here (older records that rolled out of the feeds'
 * windows — that's the accumulating value) — informational only.
 */

import { scrapeEnforcementActions } from "../../scrapers/enforcement-actions.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

export const enforcementRecentAdapter: SourceAdapter = {
  name: "enforcement-recent",
  title: "Enforcement actions — recent-window completeness (6 regulators' live feeds)",
  collection: "enforcement_actions",
  keyvexIdField: "action_id",
  typeField: "source",
  expectedTypes: ["sec", "doj", "cftc", "occ", "fdic", "ftc"],

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const actions = await scrapeEnforcementActions({});
    const bySource: Record<string, number> = {};
    const items: SourceItem[] = actions.map((a) => {
      bySource[a.source] = (bySource[a.source] ?? 0) + 1;
      return {
        id: a.action_id,
        url: a.url,
        label: a.title.slice(0, 120),
        meta: { type: a.source, year: a.published_date.slice(0, 4) },
      };
    });
    console.error(`[enforcement-recent] live feeds: ${JSON.stringify(bySource)}`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
