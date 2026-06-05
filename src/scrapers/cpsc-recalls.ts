/**
 * CPSC (Consumer Product Safety Commission) recall scraper.
 *
 * Source: saferproducts.gov/RestWebServices/Recall — a public REST endpoint
 * that returns the full CPSC recall registry as JSON. Supports filtering by
 * RecallDateStart / RecallDateEnd (ISO date strings). No auth, no rate
 * limit flagged on the docs page (we pace at 1 req/sec defensively).
 *
 * Unified into the same `product_recalls` Firestore collection as the FDA
 * sub-feeds; source discriminator is "cpsc". Schema mapping:
 *   CPSC.RecallNumber       → recall_number
 *   CPSC.RecallDate         → recall_initiation_date (strip TZ component)
 *   CPSC.LastPublishDate    → posted_date
 *   CPSC.Description        → product_description
 *   CPSC.Hazards[0].Name    → reason_for_recall
 *   CPSC.Manufacturers[0]   → recalling_firm (fallback chain via Importers
 *                              / Distributors / Retailers)
 *   CPSC.Products[0]        → product_category + product_quantity
 *   CPSC.URL                → source_url
 *
 * Pure-publisher posture: CPSC doesn't use FDA-style severity classes, so
 * `classification` stays null. CPSC recalls are nominally voluntary; we
 * leave `initiator` null rather than fabricate that label.
 */

import type { ProductRecall } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://www.saferproducts.gov/RestWebServices/Recall",
  /** 1 req/sec — defensive default. saferproducts.gov has no documented limit. */
  RATE_LIMIT_MS: 1000,
} as const;

interface CpscProduct {
  Name?: string;
  Description?: string;
  Model?: string;
  Type?: string;
  CategoryID?: string;
  NumberOfUnits?: string;
}

interface CpscNamed {
  Name?: string;
  CompanyID?: string;
}

interface CpscHazard {
  Name?: string;
  HazardType?: string;
  HazardTypeID?: string;
}

interface CpscRemedy {
  Name?: string;
}

interface CpscCountry {
  Country?: string;
}

interface CpscUpc {
  UPC?: string;
}

export interface CpscRecallRaw {
  RecallID?: number;
  RecallNumber?: string;
  RecallDate?: string;
  LastPublishDate?: string;
  Description?: string;
  URL?: string;
  Title?: string;
  ConsumerContact?: string;
  Products?: CpscProduct[];
  Manufacturers?: CpscNamed[];
  Importers?: CpscNamed[];
  Distributors?: CpscNamed[];
  Retailers?: CpscNamed[];
  ManufacturerCountries?: CpscCountry[];
  ProductUPCs?: CpscUpc[];
  Hazards?: CpscHazard[];
  Remedies?: CpscRemedy[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CPSC dates ship as "YYYY-MM-DDT00:00:00" — strip the time component to
 * leave a clean ISO date. Returns "" for missing/malformed.
 */
function isoDate(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.slice(0, 10);
}

/**
 * First non-empty `.Name` across a fallback chain. CPSC recalls almost
 * always populate at least one of these, but the order matters for the
 * "who actually issued the recall" signal — manufacturer takes priority,
 * then the importer (for foreign goods), then the distributor, then the
 * retailer (last resort — sometimes the only party identified).
 */
function pickFirm(raw: CpscRecallRaw): string {
  const candidates: (CpscNamed[] | undefined)[] = [
    raw.Manufacturers,
    raw.Importers,
    raw.Distributors,
    raw.Retailers,
  ];
  for (const group of candidates) {
    if (group && group.length > 0) {
      const name = group[0]?.Name?.trim();
      if (name) return name;
    }
  }
  return "";
}

export function normalize(
  raw: CpscRecallRaw,
  scrapedAt: string,
): ProductRecall | null {
  if (!raw.RecallNumber) return null;
  const recallNumber = raw.RecallNumber.trim();
  const initDate = isoDate(raw.RecallDate);
  if (!initDate) return null;

  const firstProduct = raw.Products?.[0];
  const productCodes: string[] = [];
  for (const upc of raw.ProductUPCs ?? []) {
    if (upc.UPC) productCodes.push(upc.UPC);
  }

  return {
    // "/" is illegal in a Firestore doc path; sanitize for the id only.
    id: `cpsc-${recallNumber.replace(/[/\\]+/g, "-")}`,
    source: "cpsc",
    recall_number: recallNumber,
    recall_initiation_date: initDate,
    posted_date: isoDate(raw.LastPublishDate) || null,
    recalling_firm: pickFirm(raw),
    product_description: raw.Description ?? "",
    reason_for_recall: raw.Hazards?.[0]?.Name ?? "",
    classification: null,
    status: null,
    initiator: null,
    distribution_pattern: raw.Retailers?.[0]?.Name ?? null,
    product_quantity: firstProduct?.NumberOfUnits ?? null,
    product_category: firstProduct?.Type || firstProduct?.Name || null,
    product_codes: productCodes.length > 0 ? productCodes : null,
    vehicle_make: null,
    vehicle_model: null,
    model_year_range: null,
    affected_component: null,
    termination_date: null,
    source_url:
      raw.URL ?? `${CONFIG.BASE_URL}?RecallNumber=${encodeURIComponent(recallNumber)}`,
    scraped_at: scrapedAt,
  };
}

export interface ScrapeCpscRecallsOptions {
  /** Number of calendar days to look back from "today". Default 30. */
  lookbackDays?: number;
}

/**
 * Pull recent CPSC recalls into `ProductRecall` rows. Uses the
 * `RecallDateStart` / `RecallDateEnd` query parameters on the SaferProducts
 * REST endpoint. Single round trip — CPSC doesn't paginate this response.
 *
 * Real-world volume: ~20-60 recalls/month, so a 30-day window comfortably
 * fits in one response (~50KB JSON).
 */
export async function scrapeCpscRecalls(
  options: ScrapeCpscRecallsOptions = {},
): Promise<ProductRecall[]> {
  const lookbackDays = options.lookbackDays ?? 30;
  const scrapedAt = new Date().toISOString();

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  const url =
    `${CONFIG.BASE_URL}?format=json` +
    `&RecallDateStart=${startStr}&RecallDateEnd=${endStr}`;

  console.error(`[cpsc-recalls] window ${startStr} → ${endStr}`);

  await sleep(CONFIG.RATE_LIMIT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        Accept: "application/json",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cpsc-recalls] fetch failed — ${msg}`);
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[cpsc-recalls] HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    );
    return [];
  }

  let data: CpscRecallRaw[];
  try {
    data = (await res.json()) as CpscRecallRaw[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cpsc-recalls] JSON parse failed — ${msg}`);
    return [];
  }

  if (!Array.isArray(data)) {
    console.error(
      `[cpsc-recalls] response was not an array — got ${typeof data}`,
    );
    return [];
  }

  const out: ProductRecall[] = [];
  let skipped = 0;
  for (const raw of data) {
    const rec = normalize(raw, scrapedAt);
    if (rec) out.push(rec);
    else skipped++;
  }
  console.error(
    `[cpsc-recalls] TOTAL: ${out.length} recalls in last ${lookbackDays}d (${skipped} skipped)`,
  );
  return out;
}
