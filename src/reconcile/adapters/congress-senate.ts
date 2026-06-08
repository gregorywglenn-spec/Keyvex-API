/**
 * Source Adapter: Congress — Senate (PTR filings).
 *
 * Second adapter — completes the Congress dataset (benchmark item #1) using the
 * same framework the House adapter proved. Mirrors congress-house.ts; the only
 * real difference is the authoritative index.
 *
 * Authoritative denominator: the Senate eFD search (efdsearch.senate.gov),
 * report_types=[11] = Periodic Transaction Reports. There's no static yearly
 * file like the House Clerk XML, so we drive the eFD's own search endpoint via
 * fetchSenatePtrRefs — ONE search per year (each year is well under the eFD
 * page cap, so a single request per year enumerates that year completely;
 * scanning year-by-year also keeps any one failed year from blanking the
 * census). KeyVex stores these in `congressional_trades` with `ptr_id` = the
 * eFD PTR uuid and `chamber` = "senate".
 *
 * expectedTypes is buy / sell / exchange on purpose: the Senate parser drops
 * Exchange rows (same hole the House parser had), so the per-type census will
 * surface exchange = 0.
 */

import { fetchSenatePtrRefsWindowed } from "../../scrapers/senate.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

/**
 * Years to scan. Senate eFD electronic PTRs begin ~2012; scan through next year
 * so a freshly-filed current-year PTR is in the denominator.
 */
function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = 2012; y <= end; y++) out.push(y);
  return out;
}

export const congressSenateAdapter: SourceAdapter = {
  name: "congress-senate",
  title: "Congress — Senate PTR filings (Senate eFD)",
  collection: "congressional_trades",
  keyvexIdField: "ptr_id",
  typeField: "transaction_type",
  expectedTypes: ["buy", "sell", "exchange"],
  keyvexFilter: { field: "chamber", op: "==", value: "senate" },

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const start = `${Math.min(...years)}-01-01`;
    const end = `${Math.max(...years)}-12-31`;
    // MONTHLY windows beat the eFD ~80-row per-response cap (a wide window
    // silently truncates — see fetchSenatePtrRefsWindowed). This yields the
    // true census denominator instead of ~60% of it.
    const refs = await fetchSenatePtrRefsWindowed(start, end, (m) =>
      console.error(`[congress-senate] ${m}`),
    );
    const items: SourceItem[] = [];
    for (const r of refs) {
      if (!r.ptrId) continue;
      const year = (r.dateFiled || "").match(/(\d{4})/)?.[1] ?? "";
      items.push({
        id: r.ptrId,
        url: r.detailUrl,
        label: `${r.firstName} ${r.lastName}`.trim(),
        meta: { year },
      });
    }
    console.error(`[congress-senate] enumerated ${items.length} PTRs ${start}..${end}`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
