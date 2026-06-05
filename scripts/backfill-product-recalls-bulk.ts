/**
 * PRODUCT RECALLS BULK BACKFILL — full history, openFDA (drug/device/food) + CPSC.
 *
 *   npx tsx scripts/backfill-product-recalls-bulk.ts                 # all 4 sources, --save
 *   npx tsx scripts/backfill-product-recalls-bulk.ts --dry           # parse + sample, NO writes
 *   npx tsx scripts/backfill-product-recalls-bulk.ts --dry --only=fda_drug
 *   npx tsx scripts/backfill-product-recalls-bulk.ts --only=cpsc     # one source, --save
 *
 * Sources (verified 2026-06-05 against api.fda.gov/download.json + saferproducts.gov):
 *   fda_drug    download.open.fda.gov/drug/enforcement/...json.zip    ~17.7K records
 *   fda_device  download.open.fda.gov/device/enforcement/...json.zip  ~39.1K records
 *   fda_food    download.open.fda.gov/food/enforcement/...json.zip    ~29.0K records
 *   cpsc        saferproducts.gov/RestWebServices/Recall (full range)  ~9.8K  records (1973+)
 *   (TOTAL ~95.5K records — no multi-million giant, no per-source window needed.)
 *
 * DEDUP-SAFE: reuses each scraper's EXACT exported normalize() so the Firestore
 * doc-id (`r.id`) matches the daily cron byte-for-byte:
 *   fda_*  →  `${source}-${recall_number}`   (fda-recalls.ts normalize)
 *   cpsc   →  `cpsc-${recall_number}`         (cpsc-recalls.ts normalize)
 * Writes through saveProductRecalls (merge:true), same fn the cron uses.
 * Resumable per source via .tmp/product-recalls-bulk-progress.json. Network-retry.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import AdmZip from "adm-zip";
import { saveProductRecalls } from "../src/firestore.js";
import {
  normalize as normalizeFda,
  type FdaRecallRaw,
  type FdaSubSource,
} from "../src/scrapers/fda-recalls.js";
import {
  normalize as normalizeCpsc,
  type CpscRecallRaw,
} from "../src/scrapers/cpsc-recalls.js";
import type { ProductRecall } from "../src/types.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const PROG = ".tmp/product-recalls-bulk-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

const FDA_BULK: Record<FdaSubSource, string> = {
  fda_drug:
    "https://download.open.fda.gov/drug/enforcement/drug-enforcement-0001-of-0001.json.zip",
  fda_device:
    "https://download.open.fda.gov/device/enforcement/device-enforcement-0001-of-0001.json.zip",
  fda_food:
    "https://download.open.fda.gov/food/enforcement/food-enforcement-0001-of-0001.json.zip",
};
const CPSC_URL =
  "https://www.saferproducts.gov/RestWebServices/Recall?format=json" +
  "&RecallDateStart=1970-01-01&RecallDateEnd=2099-12-31";

const ALL_SOURCES = ["fda_drug", "fda_device", "fda_food", "cpsc"] as const;
type Source = (typeof ALL_SOURCES)[number];

async function fetchBuf(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(200);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e: any) {
      if (a === 5) throw e;
      console.error(
        `[recalls] net "${e?.cause?.code ?? e}" ${url.slice(0, 70)} retry ${a + 1}`,
      );
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

async function persist(source: string, recs: ProductRecall[]) {
  if (DRY) {
    console.error(`[recalls] ${source}: ${recs.length} parsed (DRY — no write)`);
    if (recs[0]) console.error("   sample: " + JSON.stringify(recs[0]));
    return;
  }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400)
    saved += (await saveProductRecalls(recs.slice(i, i + 400))).saved;
  done[source] = true;
  writeFileSync(PROG, JSON.stringify(done));
  console.error(`[recalls] ${source} DONE: saved ${saved}`);
}

async function doFda(source: FdaSubSource) {
  if (done[source]) {
    console.error(`[recalls] skip ${source}`);
    return;
  }
  const buf = await fetchBuf(FDA_BULK[source]);
  if (!buf) {
    console.error(`[recalls] ${source}: no ZIP`);
    return;
  }
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".json"));
  if (!entry) {
    console.error(`[recalls] ${source}: no .json in ZIP`);
    return;
  }
  const data = JSON.parse(entry.getData().toString("utf8")) as {
    results?: FdaRecallRaw[];
  };
  const raws = data.results ?? [];
  const recs: ProductRecall[] = [];
  let skipped = 0;
  for (const raw of raws) {
    const rec = normalizeFda(raw, source, NOW);
    if (rec) recs.push(rec);
    else skipped++;
  }
  console.error(
    `[recalls] ${source}: ${raws.length} raw → ${recs.length} normalized (${skipped} skipped)`,
  );
  await persist(source, recs);
}

async function doCpsc() {
  if (done.cpsc) {
    console.error("[recalls] skip cpsc");
    return;
  }
  const buf = await fetchBuf(CPSC_URL);
  if (!buf) {
    console.error("[recalls] cpsc: no response");
    return;
  }
  let data: CpscRecallRaw[];
  try {
    data = JSON.parse(buf.toString("utf8")) as CpscRecallRaw[];
  } catch (e: any) {
    console.error(`[recalls] cpsc JSON parse failed — ${e?.message ?? e}`);
    return;
  }
  if (!Array.isArray(data)) {
    console.error(`[recalls] cpsc: response was not an array (${typeof data})`);
    return;
  }
  const recs: ProductRecall[] = [];
  let skipped = 0;
  for (const raw of data) {
    const rec = normalizeCpsc(raw, NOW);
    if (rec) recs.push(rec);
    else skipped++;
  }
  console.error(
    `[recalls] cpsc: ${data.length} raw → ${recs.length} normalized (${skipped} skipped)`,
  );
  await persist("cpsc", recs);
}

async function main() {
  const sources: Source[] = ONLY
    ? (ALL_SOURCES.filter((s) => s === ONLY) as Source[])
    : [...ALL_SOURCES];
  if (sources.length === 0) {
    console.error(`[recalls] --only=${ONLY} matched no source; valid: ${ALL_SOURCES.join(", ")}`);
    process.exit(1);
  }
  console.error(`[recalls] sources: ${sources.join(", ")}${DRY ? " (DRY)" : ""}`);
  for (const s of sources) {
    if (s === "cpsc") await doCpsc();
    else await doFda(s);
  }
  console.error("[recalls] COMPLETE");
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[recalls] FATAL", e);
    process.exit(1);
  });
