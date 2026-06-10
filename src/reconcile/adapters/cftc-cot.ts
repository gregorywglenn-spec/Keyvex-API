/**
 * Source Adapter: CFTC Commitments of Traders — legacy futures-only (jun7-fc8e).
 *
 * Authoritative denominator: the Socrata dataset itself, enumerated as bare
 * (contract_market_code, report_date) pairs via $select paging — independent
 * of the scraper's normalize path, so a scraper-side drop would surface as
 * missing. KeyVex stores one doc per pair in `cftc_cot_reports` with
 * `id = {code}-{YYYY-MM-DD}` (same key the weekly cron and the 2026-06-06
 * historical backfill write).
 *
 * SCOPE: default floor 2016-06-06 — the historical backfill's exact window
 * start (10 years back from its 2026-06-06 run). `--years=A-B` overrides
 * (floor = Jan 1 of min year, ceiling = Dec 31 of max year).
 *
 * Each missing row's link is the Socrata row query itself (JSON) — clickable
 * proof the pair exists upstream.
 */

import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const BASE = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json";
const UA = process.env.KEYVEX_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const DEFAULT_FLOOR = "2016-06-06";
const PAGE = 50000; // Socrata's per-page cap

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rowUrl(code: string, dateIso: string): string {
  return (
    `${BASE}?cftc_contract_market_code=${encodeURIComponent(code)}` +
    `&report_date_as_yyyy_mm_dd=${encodeURIComponent(`${dateIso}T00:00:00.000`)}`
  );
}

export const cftcCotAdapter: SourceAdapter = {
  name: "cftc-cot",
  title: "CFTC COT — legacy futures (publicreporting.cftc.gov jun7-fc8e)",
  collection: "cftc_cot_reports",
  keyvexIdField: "id",
  typeField: "market_code",

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    let floor = DEFAULT_FLOOR;
    let ceiling: string | undefined;
    if (ctx.years && ctx.years.length > 0) {
      floor = `${Math.min(...ctx.years)}-01-01`;
      ceiling = `${Math.max(...ctx.years)}-12-31`;
    }
    const where =
      `report_date_as_yyyy_mm_dd >= '${floor}'` +
      (ceiling ? ` AND report_date_as_yyyy_mm_dd <= '${ceiling}'` : "");

    const items: SourceItem[] = [];
    let offset = 0;
    while (true) {
      const url = new URL(BASE);
      url.searchParams.set(
        "$select",
        "cftc_contract_market_code,report_date_as_yyyy_mm_dd,contract_market_name",
      );
      url.searchParams.set("$where", where);
      url.searchParams.set("$order", "report_date_as_yyyy_mm_dd,cftc_contract_market_code");
      url.searchParams.set("$limit", String(PAGE));
      url.searchParams.set("$offset", String(offset));

      await sleep(200);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        ctx.warn(`Socrata HTTP ${res.status} at offset ${offset} — denominator may be short`);
        break;
      }
      const rows = (await res.json()) as {
        cftc_contract_market_code?: string;
        report_date_as_yyyy_mm_dd?: string;
        contract_market_name?: string;
      }[];
      for (const r of rows) {
        const code = r.cftc_contract_market_code?.trim();
        const date = (r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
        if (!code || !date) continue;
        items.push({
          id: `${code}-${date}`,
          url: rowUrl(code, date),
          label: r.contract_market_name ?? code,
          meta: { year: date.slice(0, 4) },
        });
      }
      console.error(`[cftc-cot] offset ${offset}: ${rows.length} rows (running ${items.length})`);
      if (rows.length < PAGE) break;
      offset += rows.length;
      if (offset > 2_000_000) {
        ctx.warn("aborting at 2M rows — window too wide?");
        break;
      }
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
