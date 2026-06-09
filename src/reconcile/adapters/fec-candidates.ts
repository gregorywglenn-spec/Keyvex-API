/**
 * Source Adapter: FEC Candidates (catalog).
 *
 * SCOPE NOTE (discovered 2026-06-09): the fec_candidates collection holds a
 * BROADER set than the weekly cron maintains. The cron calls
 * scrapeFecCandidates({activeOnly:true}) = candidate_status=C for cycles
 * 2022/2024/2026 (~3.5K). But the collection holds ~25.6K — ALL statuses
 * (C/N/P/F) across cycles back to ~2020, from an earlier broad seed. Those
 * extra records are legitimate FEC candidates, not stale cruft — so the honest
 * denominator is the BROAD set (all statuses, the cycles the collection spans),
 * NOT the narrow cron filter. We enumerate all-status across CYCLES below.
 *
 * Finding to surface: the cron under-maintains the collection's scope (it only
 * refreshes status=C / 3 cycles). Candidate metadata is largely static so the
 * freshness risk is low, but the scope should be documented or the cron
 * broadened to match. NEVER prune the "extra" here — they are real candidates.
 *
 * typeField = office (H/S/P) so no office class can silently read zero.
 */

import { scrapeFecCandidates } from "../../scrapers/fec.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

// Cycles the collection actually spans (broad seed went back past 2020). Cover
// the modern era 2016→2026 all-status. Any residual "extra" beyond this is
// pre-2016 historical candidates — legitimate extra coverage, not gaps.
const CYCLES = [2016, 2018, 2020, 2022, 2024, 2026];

export const fecCandidatesAdapter: SourceAdapter = {
  name: "fec-candidates",
  title: "FEC Candidates (api.open.fec.gov, all-status, cycles 2020–2026)",
  collection: "fec_candidates",
  keyvexIdField: "candidate_id",
  typeField: "office",
  expectedTypes: ["H", "S", "P"], // House / Senate / President

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    // Enumerate the BROAD scope (all statuses) per cycle, deduped by
    // candidate_id — matches what actually seeded the collection.
    const seen = new Map<string, SourceItem>();
    for (const cycle of CYCLES) {
      const cands = await scrapeFecCandidates({ cycle });
      for (const c of cands) {
        if (!seen.has(c.candidate_id)) {
          seen.set(c.candidate_id, {
            id: c.candidate_id,
            url: c.fec_url,
            label: `${c.name} (${c.office}-${c.state})`,
            meta: { type: c.office || "" },
          });
        }
      }
      console.error(`[fec-candidates] cycle ${cycle}: running ${seen.size} unique`);
    }
    console.error(`[fec-candidates] enumerated ${seen.size} candidates (all-status, ${CYCLES.join("/")})`);
    return Array.from(seen.values());
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    return `https://www.fec.gov/data/candidate/${id}/`;
  },
};
