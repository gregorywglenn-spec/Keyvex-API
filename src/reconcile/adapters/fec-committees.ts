/**
 * Source Adapter: FEC Committees (catalog).
 *
 * Authoritative denominator: api.open.fec.gov /committees across the cycles
 * KeyVex tracks (2022/2024/2026), deduped by committee_id — exactly what the
 * weekly cron ingests (it calls scrapeFecCommittees with NO filters, so the
 * reconciler does the same).
 *
 * typeField = committee_type (many codes: H/S/P/N/Q/O/…) — shown as a
 * distribution; no expectedTypes (no single type is mandatory).
 *
 * SCOPE NOTE (2026-06-09): like fec_candidates, the collection (~48.6K) is a
 * BROAD superset of the cron's recent-cycle pull (~31.5K). Reconciling against
 * the cron scope gives 99.96% coverage (13 recent missing) with ~17K "extra" —
 * but those extra are legitimate OLDER-cycle / defunct committees (the seed
 * spans cycles back to ~1998), NOT stale cruft to delete. We keep the adapter
 * at the cron's recent scope (enumerating all ~15 historical cycles would be
 * very expensive for no completeness benefit — the recent scope is what's
 * maintained). The "extra" is harmless extra coverage; do NOT prune.
 */

import { scrapeFecCommittees } from "../../scrapers/fec.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

export const fecCommitteesAdapter: SourceAdapter = {
  name: "fec-committees",
  title: "FEC Committees (api.open.fec.gov, cycles 2022/2024/2026)",
  collection: "fec_committees",
  keyvexIdField: "committee_id",
  typeField: "committee_type",

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const committees = await scrapeFecCommittees({});
    const items: SourceItem[] = committees.map((c) => ({
      id: c.committee_id,
      url: c.fec_url,
      label: `${c.name} (${c.committee_type})`,
      meta: { type: c.committee_type || "" },
    }));
    console.error(`[fec-committees] enumerated ${items.length} committees`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    return `https://www.fec.gov/data/committee/${id}/`;
  },
};
