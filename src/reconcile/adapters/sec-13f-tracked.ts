/**
 * Source Adapter: SEC 13F — tracked-fund filing completeness.
 *
 * `institutional_holdings` is a CURATED dataset: deep history for the 10
 * TRACKED_FUNDS (src/scrapers/13f.ts) plus opportunistic live-feed pickups.
 * The honest coverage gauge is therefore FILING-level over the tracked
 * watchlist: every 13F-HR / 13F-HR/A each tracked fund filed (per EDGAR's
 * submissions API, including the older-chunk files) should have rows in
 * KeyVex under its accession_number.
 *
 * Holdings-level row-count correctness inside each filing is a separate
 * sampled check (13F has sub-account aggregation by design, so raw row
 * counts intentionally differ from the XML).
 *
 * `--years=A-B` bounds by FILING year; default floor 2014 (the collection's
 * earliest quarter is 2014-Q2).
 */

import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";

/** Mirror of TRACKED_FUNDS in src/scrapers/13f.ts (cik → display name). */
const TRACKED: Array<{ cik: string; name: string }> = [
  { cik: "0001067983", name: "Berkshire Hathaway" },
  { cik: "0001364742", name: "BlackRock" },
  { cik: "0000102909", name: "Vanguard Group" },
  { cik: "0001350694", name: "Bridgewater Associates" },
  { cik: "0001423053", name: "Citadel Advisors LLC" },
  { cik: "0001603466", name: "Point72 Asset Management" },
  { cik: "0001009207", name: "D. E. Shaw & Co., Inc." },
  { cik: "0001037389", name: "Renaissance Technologies" },
  { cik: "0001179392", name: "Two Sigma Investments, LP" },
  { cik: "0001273087", name: "Millennium Management LLC" },
];

const DEFAULT_FLOOR_YEAR = 2014;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RecentBlock {
  form?: string[];
  accessionNumber?: string[];
  filingDate?: string[];
}

async function fetchJson(url: string): Promise<unknown> {
  await sleep(150);
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

function filingIndexUrl(cik: string, accession: string): string {
  const cikNum = String(parseInt(cik, 10));
  const accNoDash = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${accession}-index.htm`;
}

function collect(
  block: RecentBlock | undefined,
  fund: { cik: string; name: string },
  floorYear: number,
  ceilYear: number,
  out: SourceItem[],
): void {
  const forms = block?.form ?? [];
  const accs = block?.accessionNumber ?? [];
  const dates = block?.filingDate ?? [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i] ?? "";
    if (form !== "13F-HR" && form !== "13F-HR/A") continue;
    const date = dates[i] ?? "";
    const year = parseInt(date.slice(0, 4), 10);
    if (Number.isFinite(year) && (year < floorYear || year > ceilYear)) continue;
    const acc = accs[i] ?? "";
    if (!acc) continue;
    out.push({
      id: acc,
      url: filingIndexUrl(fund.cik, acc),
      label: `${fund.name} ${form} ${date}`,
      meta: { type: fund.name, year: date.slice(0, 4) },
    });
  }
}

export const sec13fTrackedAdapter: SourceAdapter = {
  name: "sec-13f-tracked",
  title: "SEC 13F — tracked-fund filing completeness (10 watchlist funds, EDGAR submissions)",
  collection: "institutional_holdings",
  keyvexIdField: "accession_number",
  typeField: "fund_name",
  keyvexFilter: {
    field: "fund_cik",
    op: "in",
    value: TRACKED.map((f) => f.cik),
  },

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const floorYear = ctx.years && ctx.years.length > 0 ? Math.min(...ctx.years) : DEFAULT_FLOOR_YEAR;
    const ceilYear = ctx.years && ctx.years.length > 0 ? Math.max(...ctx.years) : 9999;

    const items: SourceItem[] = [];
    for (const fund of TRACKED) {
      try {
        const sub = (await fetchJson(
          `https://data.sec.gov/submissions/CIK${fund.cik}.json`,
        )) as {
          filings?: {
            recent?: RecentBlock;
            files?: { name?: string; filingFrom?: string; filingTo?: string }[];
          };
        };
        const before = items.length;
        collect(sub.filings?.recent, fund, floorYear, ceilYear, items);
        // Older chunks — fetch any whose range overlaps the floor.
        for (const f of sub.filings?.files ?? []) {
          if (!f.name) continue;
          const to = parseInt(String(f.filingTo ?? "9999").slice(0, 4), 10);
          if (Number.isFinite(to) && to < floorYear) continue;
          const older = (await fetchJson(
            `https://data.sec.gov/submissions/${f.name}`,
          )) as RecentBlock;
          collect(older, fund, floorYear, ceilYear, items);
        }
        console.error(
          `[13f-tracked] ${fund.name}: ${items.length - before} 13F-HR(/A) filings since ${floorYear}`,
        );
      } catch (err) {
        ctx.warn(`${fund.name} (CIK ${fund.cik}): submissions fetch failed — ${(err as Error).message}`);
      }
    }
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
