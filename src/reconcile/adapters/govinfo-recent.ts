/**
 * Source Adapter: GovInfo publications — recent-window completeness (30d).
 *
 * Accumulating feed (daily cron, lastModified windows), so the meaningful
 * gauge is: does KeyVex hold every package GovInfo says was modified in the
 * last 30 days? Denominator = the /collections/{C}/{ts} endpoint for all four
 * collections, paged via offsetMark with NO cap — deliberately unlike the
 * scraper, whose maxPerCollection default (500) silently truncates heavy
 * windows (the hidden-cap pattern). If the cap has been biting, this diff
 * shows it as missing.
 *
 * KeyVex side: `gov_documents`, id = GovInfo packageId. GAOREPORTS is
 * expected ~0 current (the GovInfo archive stopped updating — documented in
 * the tool description) but stays in expectedTypes so it can never silently
 * read zero without being seen.
 */

import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const API = "https://api.govinfo.gov";
const KEY = process.env.GOVINFO_API_KEY ?? "DEMO_KEY";
const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const DAYS = 30;
const COLLECTIONS = ["CRPT", "PLAW", "CHRG", "GAOREPORTS"] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const govinfoRecentAdapter: SourceAdapter = {
  name: "govinfo-recent",
  title: `GovInfo publications — recent-window completeness (last ${DAYS}d, gov_documents)`,
  collection: "gov_documents",
  keyvexIdField: "id",
  typeField: "collection",
  expectedTypes: [...COLLECTIONS],

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const start = new Date();
    start.setDate(start.getDate() - DAYS);
    const startStr = `${start.toISOString().split(".")[0]}Z`;

    const items: SourceItem[] = [];
    for (const col of COLLECTIONS) {
      let offsetMark = "*";
      let fetched = 0;
      let total: number | undefined;
      while (true) {
        const url =
          `${API}/collections/${col}/${encodeURIComponent(startStr)}` +
          `?offsetMark=${encodeURIComponent(offsetMark)}&pageSize=100&api_key=${encodeURIComponent(KEY)}`;
        await sleep(250);
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) {
          ctx.warn(`${col}: HTTP ${res.status} after ${fetched} packages — denominator short`);
          break;
        }
        const json = (await res.json()) as {
          count?: number;
          packages?: { packageId?: string; dateIssued?: string; title?: string; packageLink?: string }[];
          nextPage?: string | null;
        };
        total = total ?? json.count;
        const pkgs = json.packages ?? [];
        for (const p of pkgs) {
          if (!p.packageId) continue;
          items.push({
            id: p.packageId,
            url: p.packageLink || `${API}/packages/${p.packageId}/summary?api_key=DEMO_KEY`,
            label: (p.title ?? "").slice(0, 120),
            meta: { type: col, year: String(p.dateIssued ?? "").slice(0, 4) },
          });
        }
        fetched += pkgs.length;
        const m = json.nextPage ? /[?&]offsetMark=([^&]+)/.exec(json.nextPage) : null;
        if (!m || pkgs.length === 0) break;
        offsetMark = decodeURIComponent(m[1]!);
        if (fetched > 100_000) {
          ctx.warn(`${col}: aborting at 100k — unexpected volume`);
          break;
        }
      }
      console.error(`[govinfo-recent] ${col}: ${fetched} packages (api count=${total ?? "?"})`);
      if (total !== undefined && fetched < total) {
        ctx.warn(`${col}: collected ${fetched} of api-reported ${total}`);
      }
    }
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
