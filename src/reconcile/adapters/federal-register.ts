/**
 * Source Adapter: Federal Register documents.
 *
 * Denominator: federalregister.gov/api/v1 — every Rule / Proposed Rule /
 * Notice / Presidential Document. KeyVex stores these in
 * `federal_register_documents` keyed by `document_number`.
 *
 * CAP HANDLING: the FR API silently caps each query at ~2,000 results, and a
 * single busy MONTH already exceeds that (Jan 2025 = 2,353). So we enumerate in
 * WEEKLY windows (~590 each, safely under the cap) and page within each. Same
 * hidden-cap class as the eFD (~80) and EDGAR FTS (10k) — see
 * project_govt_api_result_caps memory.
 *
 * SCOPE: KeyVex's coverage begins 2016-06; default years 2016+. The FR archive
 * goes back to 1994 — pre-2016 is a separate scope question, not a gap.
 */

import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const API = "https://www.federalregister.gov/api/v1/documents.json";
const TYPES = ["Rule", "Proposed Rule", "Notice", "Presidential Document"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = 2016; y <= end; y++) out.push(y);
  return out;
}

/** 7-day [start,end] windows (inclusive) across [startISO, endISO]. */
function weeklyWindows(startISO: string, endISO: string): [string, string][] {
  const out: [string, string][] = [];
  const end = new Date(endISO + "T00:00:00Z");
  const cur = new Date(startISO + "T00:00:00Z");
  while (cur <= end) {
    const ws = cur.toISOString().slice(0, 10);
    const weEnd = new Date(cur);
    weEnd.setUTCDate(weEnd.getUTCDate() + 6);
    const we = (weEnd > end ? end : weEnd).toISOString().slice(0, 10);
    out.push([ws, we]);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
}

interface FrDoc {
  document_number?: string;
  type?: string;
  publication_date?: string;
  html_url?: string;
  title?: string;
}

export const federalRegisterAdapter: SourceAdapter = {
  name: "federal-register",
  title: "Federal Register documents (federalregister.gov API, 2016+)",
  collection: "federal_register_documents",
  keyvexIdField: "document_number",
  typeField: "document_type",
  expectedTypes: TYPES,

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const start = `${Math.min(...years)}-01-01`;
    const end = `${Math.max(...years)}-12-31`;
    const byId = new Map<string, SourceItem>();
    const fields = ["document_number", "type", "publication_date", "html_url", "title"];

    for (const [ws, we] of weeklyWindows(start, end)) {
      for (let page = 1; page <= 2; page++) {
        // per_page 1000 × 2 pages = 2000 (the cap); a week is ~590 so page 1
        // usually suffices, page 2 is a safety net.
        const url =
          `${API}?per_page=1000&page=${page}` +
          `&conditions%5Bpublication_date%5D%5Bgte%5D=${ws}` +
          `&conditions%5Bpublication_date%5D%5Blte%5D=${we}` +
          fields.map((f) => `&fields%5B%5D=${f}`).join("");
        let data: { count?: number; total_pages?: number; results?: FrDoc[] };
        try {
          await sleep(200);
          const res = await fetch(url, { headers: { "User-Agent": UA } });
          if (!res.ok) {
            ctx.warn(`FR ${ws}..${we} p${page}: HTTP ${res.status}`);
            break;
          }
          data = (await res.json()) as typeof data;
        } catch (e) {
          ctx.warn(`FR ${ws}..${we} p${page}: ${e instanceof Error ? e.message : e}`);
          break;
        }
        if ((data.count ?? 0) >= 2000) {
          ctx.warn(`FR week ${ws}..${we} has ${data.count} docs (>= cap) — may truncate; use sub-week windows`);
        }
        const results = data.results ?? [];
        for (const d of results) {
          if (!d.document_number || byId.has(d.document_number)) continue;
          byId.set(d.document_number, {
            id: d.document_number,
            url: d.html_url ?? `https://www.federalregister.gov/d/${d.document_number}`,
            label: `${(d.title ?? "").slice(0, 60)} (${d.type ?? ""})`,
            meta: { year: (d.publication_date ?? "").slice(0, 4) },
          });
        }
        if (results.length < 1000) break; // last page for this window
      }
    }
    console.error(`[federal-register] enumerated ${byId.size} documents ${start}..${end}`);
    return [...byId.values()];
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
