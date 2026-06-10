/**
 * GovInfo scraper — unified pull across CRPT (Congressional Reports),
 * PLAW (Public Laws), CHRG (Congressional Hearings), GAOREPORTS (GAO).
 *
 * Source: api.govinfo.gov (US Government Publishing Office).
 *
 * Auth REQUIRED: free api.data.gov-style key from
 *   https://api.govinfo.gov/docs/
 * (or any api.data.gov-issued key works). Set GOVINFO_API_KEY env var.
 * DEMO_KEY works for low-volume testing (per api.data.gov convention).
 *
 * Pairs naturally with:
 *   - get_bills + get_roll_call_votes → CRPT links to bill-specific
 *     committee reports; PLAW is the "did it become law" outcome
 *   - get_congressional_trades → committee + hearing schedule overlay
 *   - get_enforcement_actions → GAO oversight reports often surface
 *     agencies that later face SEC / DOJ scrutiny
 *
 * Rate limit: 1000 requests/hour per api.data.gov default. We pace at
 * 200ms = ~5 req/sec sustained; full daily refresh is ~10 requests.
 *
 * Pure-publisher posture: package metadata only. Full document content
 * lives at package_link — agents follow it when they need body text.
 */
import "../load-secrets.js";
import type { GovDocument } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  API_URL: "https://api.govinfo.gov",
  /** Required. DEMO_KEY works at very low quota for testing. */
  API_KEY: process.env.GOVINFO_API_KEY ?? "DEMO_KEY",
  RATE_LIMIT_MS: 200,
  PAGE_SIZE: 100,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const COLLECTION_NAMES: Record<GovDocument["collection"], string> = {
  CRPT: "Congressional Report",
  PLAW: "Public Law",
  CHRG: "Congressional Hearing",
  GAOREPORTS: "GAO Report",
};

interface GovInfoPackage {
  packageId?: string;
  congress?: string;
  dateIssued?: string;
  docClass?: string;
  lastModified?: string;
  packageLink?: string;
  title?: string;
}

interface GovInfoResponse {
  count?: number;
  message?: string | null;
  nextPage?: string | null;
  previousPage?: string | null;
  packages?: GovInfoPackage[];
}

function normalize(
  raw: GovInfoPackage,
  collection: GovDocument["collection"],
  scrapedAt: string,
): GovDocument | null {
  if (!raw.packageId) return null;
  const dateIssued = raw.dateIssued ?? "";
  // Some legacy packages have no dateIssued — skip them rather than
  // pollute the date-sorted index with empty strings.
  if (!dateIssued) return null;

  const packageLink = raw.packageLink ?? "";
  return {
    id: raw.packageId,
    collection,
    collection_name: COLLECTION_NAMES[collection],
    package_id: raw.packageId,
    doc_class: raw.docClass ?? "",
    congress: raw.congress || null,
    date_issued: dateIssued,
    last_modified: raw.lastModified ?? "",
    title: raw.title ?? "",
    source_url: packageLink || `${CONFIG.API_URL}/packages/${raw.packageId}/summary`,
    package_link: packageLink,
    scraped_at: scrapedAt,
  };
}

export interface ScrapeGovInfoOptions {
  /** Number of days to look back from "now". Default 30. */
  lookbackDays?: number;
  /**
   * Optional override: scrape only this collection. Useful for ad-hoc
   * refreshes when one source matters. Default: all four.
   */
  collection?: GovDocument["collection"];
  /** Max packages per collection — a runaway-loop safety valve, NOT a
   *  pull-size tuner. Default 5000. The old default (500) silently truncated
   *  GovInfo bulk-reprocessing days (mass lastModified touches blow past 500
   *  in a 7-day window) — found by the 2026-06-10 reconcile as 220 missing
   *  packages in a 30-day window. Truncation now logs loudly. */
  maxPerCollection?: number;
}

/**
 * Pull recent packages from one GovInfo collection. Uses the
 * /collections/{COLLECTION}/{ISO_TIMESTAMP} endpoint, which returns
 * packages modified at or after the timestamp.
 */
export async function scrapeGovInfoCollection(
  collection: GovDocument["collection"],
  lookbackDays: number,
  maxPackages: number,
  scrapedAt: string,
): Promise<GovDocument[]> {
  // GovInfo expects an ISO timestamp with Z suffix.
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr =
    `${(start.toISOString().split(".")[0] ?? "")}Z`;

  const out: GovDocument[] = [];
  // GovInfo paginates via `offsetMark` (a server-issued cursor). First request
  // sends `offsetMark=*` to start at the beginning; each response carries a
  // `nextPage` URL with the next offsetMark embedded in its query string.
  // The `offset=N` numeric scheme works for DEMO_KEY but is rejected by real
  // api.data.gov keys.
  let offsetMark = "*";
  let pageNumber = 0;

  while (out.length < maxPackages) {
    const url =
      `${CONFIG.API_URL}/collections/${collection}/${encodeURIComponent(startStr)}` +
      `?offsetMark=${encodeURIComponent(offsetMark)}` +
      `&pageSize=${CONFIG.PAGE_SIZE}` +
      `&api_key=${encodeURIComponent(CONFIG.API_KEY)}`;

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
      console.error(`[govinfo] ${collection} fetch failed — ${msg}`);
      break;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[govinfo] ${collection} HTTP ${res.status} — ${body.slice(0, 200)}`,
      );
      break;
    }
    let data: GovInfoResponse;
    try {
      data = (await res.json()) as GovInfoResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[govinfo] ${collection} JSON parse failed — ${msg}`);
      break;
    }
    const packages = data.packages ?? [];
    if (pageNumber === 0) {
      console.error(
        `[govinfo] ${collection}: ${data.count ?? "?"} packages since ${startStr.slice(0, 10)}`,
      );
    }
    let added = 0;
    for (const p of packages) {
      const rec = normalize(p, collection, scrapedAt);
      if (rec) {
        out.push(rec);
        added++;
      }
    }
    console.error(
      `[govinfo] ${collection} page=${pageNumber}: +${added} (running ${out.length})`,
    );
    if (out.length >= maxPackages && data.nextPage) {
      // NO SILENT CAPS: the safety valve fired with more pages upstream.
      console.error(
        `[govinfo] ${collection} TRUNCATED at maxPackages=${maxPackages} — ` +
          `upstream reports ${data.count ?? "?"} in window; raise maxPerCollection`,
      );
      break;
    }
    if (packages.length < CONFIG.PAGE_SIZE) break;
    if (!data.nextPage) break;
    // Extract the next offsetMark from the nextPage URL's query string.
    const m = /[?&]offsetMark=([^&]+)/.exec(data.nextPage);
    if (!m || !m[1]) break;
    offsetMark = decodeURIComponent(m[1]);
    pageNumber++;
  }

  return out.slice(0, maxPackages);
}

export async function scrapeGovInfo(
  options: ScrapeGovInfoOptions = {},
): Promise<GovDocument[]> {
  const lookbackDays = options.lookbackDays ?? 30;
  const maxPerCollection = options.maxPerCollection ?? 5000;
  const scrapedAt = new Date().toISOString();

  const collections: GovDocument["collection"][] = options.collection
    ? [options.collection]
    : ["CRPT", "PLAW", "CHRG", "GAOREPORTS"];

  const out: GovDocument[] = [];
  for (const collection of collections) {
    const recs = await scrapeGovInfoCollection(
      collection,
      lookbackDays,
      maxPerCollection,
      scrapedAt,
    );
    out.push(...recs);
  }

  console.error(
    `[govinfo] TOTAL: ${out.length} packages across ${collections.length} collections`,
  );
  return out;
}
