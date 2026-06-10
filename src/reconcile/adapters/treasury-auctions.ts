/**
 * Source Adapter: Treasury auctions (fiscaldata.treasury.gov auctions_query).
 *
 * Authoritative denominator: the ENTIRE auctions_query dataset (KeyVex's
 * backfill pulled full history — collection spans 1979→present), enumerated
 * as bare (cusip, auction_date) pairs via the fields= projection, paged on
 * the API's own total-pages meta. Independent of the scraper's normalize
 * path. KeyVex doc id = `{cusip}-{auction_date}` in `treasury_auctions`.
 *
 * `--years=A-B` scopes by auction_date when a narrower window is wanted.
 *
 * Missing-row links are the API row query itself (JSON) — clickable proof
 * the pair exists upstream.
 */

import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const BASE =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query";
const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const PAGE_SIZE = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rowUrl(cusip: string, dateIso: string): string {
  return `${BASE}?filter=cusip:eq:${encodeURIComponent(cusip)},auction_date:eq:${dateIso}`;
}

export const treasuryAuctionsAdapter: SourceAdapter = {
  name: "treasury-auctions",
  title: "Treasury auctions (fiscaldata auctions_query, full history)",
  collection: "treasury_auctions",
  keyvexIdField: "id",
  typeField: "security_type",

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    let filter = "";
    if (ctx.years && ctx.years.length > 0) {
      const lo = `${Math.min(...ctx.years)}-01-01`;
      const hi = `${Math.max(...ctx.years)}-12-31`;
      filter = `&filter=auction_date:gte:${lo},auction_date:lte:${hi}`;
    }

    const items: SourceItem[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const url =
        `${BASE}?fields=cusip,auction_date,security_type,security_term` +
        `&sort=auction_date&page[size]=${PAGE_SIZE}&page[number]=${page}${filter}`;
      await sleep(250);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        ctx.warn(`fiscaldata HTTP ${res.status} on page ${page} — denominator may be short`);
        break;
      }
      const json = (await res.json()) as {
        data?: {
          cusip?: string;
          auction_date?: string;
          security_type?: string;
          security_term?: string;
        }[];
        meta?: { "total-pages"?: number; "total-count"?: number };
      };
      totalPages = json.meta?.["total-pages"] ?? page;
      const rows = json.data ?? [];
      for (const r of rows) {
        const cusip = (r.cusip ?? "").trim();
        const date = (r.auction_date ?? "").slice(0, 10);
        if (!cusip || !date) continue;
        items.push({
          id: `${cusip}-${date}`,
          url: rowUrl(cusip, date),
          label: `${r.security_type ?? ""} ${r.security_term ?? ""}`.trim(),
          meta: { year: date.slice(0, 4), type: r.security_type ?? "" },
        });
      }
      console.error(
        `[treasury-auctions] page ${page}/${totalPages}: ${rows.length} rows (running ${items.length})`,
      );
      page++;
    }
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    const m = /^(.+)-(\d{4}-\d{2}-\d{2})$/.exec(id);
    return m ? rowUrl(m[1]!, m[2]!) : BASE;
  },
};
