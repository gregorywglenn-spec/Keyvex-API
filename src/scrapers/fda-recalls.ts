/**
 * openFDA Recalls scraper — drug, medical device, and food/dietary recalls.
 *
 * Three sub-feeds under one shared `ProductRecall` shape (source discriminator):
 *   fda_drug   → /drug/enforcement.json
 *   fda_device → /device/enforcement.json
 *   fda_food   → /food/enforcement.json
 *
 * API is free, no auth required at the default rate limit (240 req/min,
 * 1000 req/day per IP). Optional `OPENFDA_API_KEY` env var enables higher
 * limits (120K req/day) but isn't needed for v1A's daily-refresh cadence.
 *
 * Cross-source value: FDA recalls pair with get_material_events (8-K Item
 * 8.01 "Other Events" or 7.01 Reg FD often covers recalls), with
 * get_insider_transactions for insider activity around recall dates, and
 * with get_enforcement_actions for SEC / DOJ follow-on actions when a
 * recall escalates into civil or criminal liability.
 */

import type { ProductRecall } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://api.fda.gov",
  /** 250ms ≈ 4 req/sec ≈ 240 req/min; under openFDA's no-key limit. */
  RATE_LIMIT_MS: 250,
  PAGE_SIZE: 1000,
} as const;

export type FdaSubSource = "fda_drug" | "fda_device" | "fda_food";

const ENDPOINT_PATH: Record<FdaSubSource, string> = {
  fda_drug: "/drug/enforcement.json",
  fda_device: "/device/enforcement.json",
  fda_food: "/food/enforcement.json",
};

interface FdaRecallRaw {
  recall_number: string;
  recall_initiation_date?: string;
  report_date?: string;
  center_classification_date?: string;
  termination_date?: string;
  classification?: string;
  status?: string;
  product_description?: string;
  product_quantity?: string;
  reason_for_recall?: string;
  distribution_pattern?: string;
  recalling_firm?: string;
  voluntary_mandated?: string;
  product_type?: string;
  code_info?: string;
  more_code_info?: string;
}

interface OpenFdaResponse {
  meta?: {
    results?: { total?: number; limit?: number; skip?: number };
  };
  results?: FdaRecallRaw[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** openFDA dates are YYYYMMDD strings — convert to ISO YYYY-MM-DD. */
function isoDate(yyyymmdd: string | undefined | null): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function normalize(
  raw: FdaRecallRaw,
  source: FdaSubSource,
  scrapedAt: string,
): ProductRecall | null {
  if (!raw.recall_number) return null;
  // openFDA recall_numbers occasionally contain whitespace — sanitize.
  const recallNumber = raw.recall_number.trim();

  const initDate = isoDate(raw.recall_initiation_date);
  const postedDate = raw.report_date ? isoDate(raw.report_date) : null;
  const termDate = raw.termination_date ? isoDate(raw.termination_date) : null;

  return {
    id: `${source}-${recallNumber}`,
    source,
    recall_number: recallNumber,
    recall_initiation_date: initDate,
    posted_date: postedDate || null,
    recalling_firm: raw.recalling_firm ?? "",
    product_description: raw.product_description ?? "",
    reason_for_recall: raw.reason_for_recall ?? "",
    classification: raw.classification ?? null,
    status: raw.status ?? null,
    initiator: raw.voluntary_mandated ?? null,
    distribution_pattern: raw.distribution_pattern ?? null,
    product_quantity: raw.product_quantity ?? null,
    product_category: raw.product_type ?? null,
    product_codes: raw.code_info
      ? [raw.code_info, ...(raw.more_code_info ? [raw.more_code_info] : [])]
      : null,
    vehicle_make: null,
    vehicle_model: null,
    model_year_range: null,
    affected_component: null,
    termination_date: termDate || null,
    source_url: `${CONFIG.BASE_URL}${ENDPOINT_PATH[source]}?search=recall_number:%22${encodeURIComponent(recallNumber)}%22`,
    scraped_at: scrapedAt,
  };
}

export interface ScrapeFdaRecallsOptions {
  source: FdaSubSource;
  lookbackDays?: number;
  /** Hard cap on total records returned (across all pages). Default 5000. */
  maxRecords?: number;
}

/**
 * Pull one openFDA recall sub-feed for the configured lookback window.
 * Paginates by 1000 at a time. Treats HTTP 404 as an empty result (the
 * openFDA convention when a query matches zero records). Skips malformed
 * records (missing recall_number) and logs them.
 */
export async function scrapeFdaRecalls(
  options: ScrapeFdaRecallsOptions,
): Promise<ProductRecall[]> {
  const lookbackDays = options.lookbackDays ?? 30;
  const maxRecords = options.maxRecords ?? 5000;
  const scrapedAt = new Date().toISOString();

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = start.toISOString().slice(0, 10).replace(/-/g, "");
  const endStr = end.toISOString().slice(0, 10).replace(/-/g, "");

  const path = ENDPOINT_PATH[options.source];
  const out: ProductRecall[] = [];
  let skip = 0;

  console.error(
    `[fda-recalls] ${options.source} — window ${startStr}-${endStr}`,
  );

  // openFDA caps `skip` at 25,000 (anything beyond returns 400). For deeper
  // historical needs, use date-window slicing — out of scope for v1A.
  while (out.length < maxRecords && skip < 25000) {
    // openFDA date-range syntax: `[start TO end]` with SPACES around TO.
    // encodeURIComponent turns the spaces into %20, which openFDA parses
    // correctly. Using a literal `+` here would encode to %2B (literal
    // plus char) and openFDA returns HTTP 500 on the malformed query.
    const searchExpr = `recall_initiation_date:[${startStr} TO ${endStr}]`;
    const url =
      `${CONFIG.BASE_URL}${path}` +
      `?search=${encodeURIComponent(searchExpr)}` +
      `&limit=${CONFIG.PAGE_SIZE}&skip=${skip}`;

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
      console.error(`[fda-recalls] ${options.source} fetch failed — ${msg}`);
      break;
    }

    // openFDA returns 404 with a `NOT_FOUND` body when the query matches
    // zero records — not an error condition.
    if (res.status === 404) {
      break;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[fda-recalls] ${options.source} HTTP ${res.status} — ${body.slice(0, 200)}`,
      );
      break;
    }

    let data: OpenFdaResponse;
    try {
      data = (await res.json()) as OpenFdaResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[fda-recalls] ${options.source} JSON parse failed — ${msg}`,
      );
      break;
    }
    const results = data.results ?? [];
    let added = 0;
    for (const r of results) {
      const rec = normalize(r, options.source, scrapedAt);
      if (rec) {
        out.push(rec);
        added++;
      }
    }
    if (skip === 0) {
      const total = data.meta?.results?.total ?? results.length;
      console.error(
        `[fda-recalls] ${options.source}: ${total} total in window, paging ${CONFIG.PAGE_SIZE} at a time`,
      );
    }
    console.error(
      `[fda-recalls] ${options.source} skip=${skip}: +${added} (running ${out.length})`,
    );
    if (results.length < CONFIG.PAGE_SIZE) break;
    skip += CONFIG.PAGE_SIZE;
  }

  console.error(
    `[fda-recalls] ${options.source} TOTAL: ${out.length} recalls in last ${lookbackDays}d`,
  );
  return out;
}

/**
 * Convenience wrapper: pull all three sub-feeds (drug + device + food) in
 * sequence. Sequential rather than parallel to keep us comfortably under
 * the 240 req/min rate limit.
 */
export async function scrapeAllFdaRecalls(
  options: { lookbackDays?: number; maxRecords?: number } = {},
): Promise<ProductRecall[]> {
  const sources: FdaSubSource[] = ["fda_drug", "fda_device", "fda_food"];
  const out: ProductRecall[] = [];
  for (const source of sources) {
    const recalls = await scrapeFdaRecalls({ ...options, source });
    out.push(...recalls);
  }
  console.error(
    `[fda-recalls] ALL THREE: ${out.length} total recalls across drug+device+food`,
  );
  return out;
}
