/**
 * Source Adapter: Product recalls — openFDA (drug/device/food) + CPSC.
 *
 * Collection: `product_recalls`, id = `{source}-{recall_number}` with
 * slashes sanitized to "-" (mirrors both scrapers' doc-id builders).
 *
 * DENOMINATOR via the file-based full-index rule (paginated-API hidden-cap
 * memory): openFDA's bulk download zips (api.fda.gov/download.json lists
 * the current partition files per enforcement endpoint — the COMPLETE
 * dataset, no skip-cap), and CPSC's single-response full JSON (the
 * endpoint doesn't paginate). Same sources the 2026-06-05 bulk backfill
 * used.
 *
 * Accumulating dataset — extras would mean records the sources later
 * REMOVED (openFDA does occasionally drop records on data corrections);
 * informational, not auto-pruned.
 */

import AdmZip from "adm-zip";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const FDA_SOURCES = ["fda_drug", "fda_device", "fda_food"] as const;
const FDA_DOWNLOAD_KEY: Record<(typeof FDA_SOURCES)[number], string> = {
  fda_drug: "drug",
  fda_device: "device",
  fda_food: "food",
};

function docId(source: string, recallNumber: string): string {
  return `${source}-${recallNumber.trim().replace(/[/\\]+/g, "-")}`;
}

function fdaSearchUrl(source: (typeof FDA_SOURCES)[number], rn: string): string {
  return `https://api.fda.gov/${FDA_DOWNLOAD_KEY[source]}/enforcement.json?search=recall_number:%22${encodeURIComponent(rn)}%22`;
}

async function fdaSourceIds(ctx: ReconContext): Promise<SourceItem[]> {
  const dl = await fetch("https://api.fda.gov/download.json", {
    headers: { "User-Agent": UA },
  });
  if (!dl.ok) {
    ctx.warn(`download.json HTTP ${dl.status} — FDA denominator unavailable`);
    return [];
  }
  const manifest = (await dl.json()) as {
    results?: Record<
      string,
      { enforcement?: { partitions?: { file?: string }[]; total_records?: number } }
    >;
  };

  const items: SourceItem[] = [];
  for (const source of FDA_SOURCES) {
    const key = FDA_DOWNLOAD_KEY[source];
    const enf = manifest.results?.[key]?.enforcement;
    const partitions = enf?.partitions ?? [];
    if (partitions.length === 0) {
      ctx.warn(`${source}: no enforcement partitions in download.json`);
      continue;
    }
    let added = 0;
    for (const p of partitions) {
      if (!p.file) continue;
      const res = await fetch(p.file, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        ctx.warn(`${source}: partition ${p.file} HTTP ${res.status}`);
        continue;
      }
      const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.endsWith(".json")) continue;
        const json = JSON.parse(zip.readAsText(entry)) as {
          results?: { recall_number?: string; report_date?: string; classification?: string }[];
        };
        for (const r of json.results ?? []) {
          const rn = r.recall_number?.trim();
          if (!rn) continue;
          items.push({
            id: docId(source, rn),
            url: fdaSearchUrl(source, rn),
            label: rn,
            meta: {
              type: source,
              year: String(r.report_date ?? "").slice(0, 4),
            },
          });
          added++;
        }
      }
    }
    const expected = enf?.total_records;
    console.error(
      `[product-recalls] ${source}: ${added} recalls from ${partitions.length} partition(s)` +
        (expected !== undefined ? ` (manifest total_records=${expected})` : ""),
    );
    if (expected !== undefined && added < expected) {
      ctx.warn(`${source}: collected ${added} of manifest-reported ${expected}`);
    }
  }
  return items;
}

async function cpscSourceIds(ctx: ReconContext): Promise<SourceItem[]> {
  const res = await fetch(
    "https://www.saferproducts.gov/RestWebServices/Recall?format=json",
    { headers: { "User-Agent": UA, Accept: "application/json" } },
  );
  if (!res.ok) {
    ctx.warn(`CPSC HTTP ${res.status} — CPSC denominator unavailable`);
    return [];
  }
  const rows = (await res.json()) as { RecallNumber?: string; RecallDate?: string; URL?: string }[];
  const items: SourceItem[] = [];
  for (const r of rows) {
    const rn = r.RecallNumber?.trim();
    if (!rn) continue;
    items.push({
      id: docId("cpsc", rn),
      url: r.URL || `https://www.saferproducts.gov/RestWebServices/Recall?RecallNumber=${encodeURIComponent(rn)}`,
      label: rn,
      meta: { type: "cpsc", year: String(r.RecallDate ?? "").slice(0, 4) },
    });
  }
  console.error(`[product-recalls] cpsc: ${items.length} recalls (single full response)`);
  return items;
}

export const productRecallsAdapter: SourceAdapter = {
  name: "product-recalls",
  title: "Product recalls — openFDA drug/device/food (bulk zips) + CPSC (full JSON)",
  collection: "product_recalls",
  keyvexIdField: "id",
  typeField: "source",
  expectedTypes: ["fda_drug", "fda_device", "fda_food", "cpsc"],

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const fda = await fdaSourceIds(ctx);
    const cpsc = await cpscSourceIds(ctx);
    return [...fda, ...cpsc];
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
