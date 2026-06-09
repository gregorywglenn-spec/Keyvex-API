/**
 * Source Adapter: Congress — Bills & Resolutions (current Congress).
 *
 * Authoritative denominator: api.congress.gov's /bill/{congress}/{type} lists,
 * enumerated across all 8 bill/resolution types. We reuse the scraper's own
 * paginated fetch (scrapeBills) so the reconciler sees exactly what the ingest
 * sees — and if congress.gov's pagination ever caps short, the diff shows up as
 * "source < KeyVex" (the truncation tell), not a false KeyVex gap.
 *
 * SCOPE: KeyVex's bills collection currently holds ONLY the 119th Congress
 * (the cron refreshes congress 119). The adapter scopes to 119 on both sides so
 * the census is apples-to-apples; widen DEFAULT_CONGRESS / the filter if older
 * Congresses are ever backfilled.
 *
 * expectedTypes is the 8 bill/resolution types (stored UPPERCASE) so no whole
 * type can silently read zero.
 */

import { scrapeBills } from "../../scrapers/congress-legislation.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const DEFAULT_CONGRESS = 119;

/** Build the congress.gov URL for a bill_id like "119-HR-1234". */
function billUrl(billId: string): string {
  const m = /^(\d+)-([A-Za-z]+)-(\w+)$/.exec(billId);
  if (!m) return "https://www.congress.gov/";
  return `https://www.congress.gov/bill/${m[1]}/${m[2]!.toLowerCase()}/${m[3]}`;
}

export const congressBillsAdapter: SourceAdapter = {
  name: "congress-bills",
  title: "Congress — Bills & Resolutions (119th, api.congress.gov)",
  collection: "bills",
  keyvexIdField: "bill_id",
  typeField: "bill_type",
  expectedTypes: ["HR", "S", "HJRES", "SJRES", "HCONRES", "SCONRES", "HRES", "SRES"],
  keyvexFilter: { field: "congress", op: "==", value: DEFAULT_CONGRESS },

  async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
    const bills = await scrapeBills({ congress: DEFAULT_CONGRESS });
    const items: SourceItem[] = bills.map((b) => ({
      id: b.bill_id,
      url: b.congress_gov_url || billUrl(b.bill_id),
      label: b.title,
      meta: { type: b.bill_type, year: String(b.introduction_date || "").slice(0, 4) },
    }));
    console.error(`[congress-bills] enumerated ${items.length} bills (Congress ${DEFAULT_CONGRESS})`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    return billUrl(id);
  },
};
