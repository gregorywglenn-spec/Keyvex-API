/**
 * CFPB Consumer Complaints scraper.
 *
 * Source: consumerfinance.gov/data-research/consumer-complaints/search/api/v1/
 *
 * No auth. ES-style search API; iterate via `frm` + `size`. Response is a
 * flat JSON array (no envelope). Each record is one complaint with company,
 * product, issue, state, dates, and response disposition.
 *
 * v1A scope: rolling N-most-recent window pulled on daily cron. CFPB
 * receives ~10K complaints/day; full history (~5M records) is out of
 * scope for v1A. Agents follow `cfpb_source_url` for older records.
 *
 * Idempotent saves on complaint_id (CFPB's own primary key).
 */
import type { ConsumerComplaint } from "../types.js";

const CONFIG = {
  USER_AGENT: "Mozilla/5.0 (KeyVexBot/1.0; +https://keyvex.com)",
  BASE_URL:
    "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/",
  PAGE_SIZE: 200,
  RATE_LIMIT_MS: 250,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RawComplaint {
  _id?: string;
  _source?: {
    complaint_id?: string;
    product?: string;
    sub_product?: string;
    issue?: string;
    sub_issue?: string;
    company?: string;
    company_response?: string;
    company_public_response?: string;
    timely?: string;
    state?: string;
    zip_code?: string;
    submitted_via?: string;
    date_received?: string;
    date_sent_to_company?: string;
    consumer_disputed?: string;
    complaint_what_happened?: string;
    tags?: string[] | string | null;
  };
}

function toIsoDate(raw: string | undefined): string {
  if (!raw) return "";
  return raw.slice(0, 10);
}

function normalizeTags(raw: string[] | string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normalize(raw: RawComplaint, scrapedAt: string): ConsumerComplaint | null {
  const src = raw._source;
  if (!src) return null;
  const id = src.complaint_id ?? raw._id ?? "";
  if (!id) return null;
  return {
    id,
    product: src.product ?? "",
    sub_product: src.sub_product ?? "",
    issue: src.issue ?? "",
    sub_issue: src.sub_issue ?? "",
    company: src.company ?? "",
    company_response: src.company_response ?? "",
    company_public_response: src.company_public_response ?? "",
    timely_response: src.timely === "Yes",
    state: src.state ?? "",
    zip_code: src.zip_code ?? "",
    submitted_via: src.submitted_via ?? "",
    date_received: toIsoDate(src.date_received),
    date_sent_to_company: toIsoDate(src.date_sent_to_company),
    consumer_disputed: src.consumer_disputed ?? "",
    complaint_narrative: src.complaint_what_happened ?? "",
    tags: normalizeTags(src.tags),
    cfpb_source_url: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/${encodeURIComponent(id)}`,
    scraped_at: scrapedAt,
  };
}

export interface ScrapeCfpbOptions {
  /** ISO date YYYY-MM-DD. Default = 2 days ago (covers overnight pubs). */
  dateReceivedMin?: string;
  /** Max records to ingest. Default 2000. */
  maxRecords?: number;
  /** CFPB full-text search term — pushes a company/keyword filter to the API
   *  server-side (e.g. "Wells Fargo" → WELLS FARGO & COMPANY). Without this the
   *  cron's date-windowed pull can't answer "complaints about company X". */
  searchTerm?: string;
}

export async function scrapeCfpbComplaints(
  options: ScrapeCfpbOptions = {},
): Promise<ConsumerComplaint[]> {
  const scrapedAt = new Date().toISOString();
  const maxRecords = options.maxRecords ?? 2000;
  const since = new Date();
  since.setDate(since.getDate() - 2);
  const dateMin = options.dateReceivedMin ?? since.toISOString().split("T")[0]!;

  console.error(
    `[cfpb] Fetching complaints with date_received_min=${dateMin}, max ${maxRecords}...`,
  );

  const out: ConsumerComplaint[] = [];
  let frm = 0;

  while (out.length < maxRecords) {
    await sleep(CONFIG.RATE_LIMIT_MS);
    const params = new URLSearchParams();
    params.set("size", String(CONFIG.PAGE_SIZE));
    params.set("frm", String(frm));
    params.set("date_received_min", dateMin);
    // NOTE: do NOT set format=json — that returns a flat array that IGNORES
    // `size` and dumps every match (29MB / 9.5s for a big company). The default
    // ES envelope respects `size`, so a search_term company query stays bounded
    // (200 rows / ~1s). no_aggs skips the facet computation we don't use.
    params.set("no_aggs", "true");
    params.set("sort", "created_date_desc");
    if (options.searchTerm) params.set("search_term", options.searchTerm);
    const url = `${CONFIG.BASE_URL}?${params.toString()}`;

    const res = await fetch(url, {
      headers: { "User-Agent": CONFIG.USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`CFPB HTTP ${res.status} ${res.statusText}`);
    }
    // Response is the ES envelope { hits: { hits: [{ _source: {...} }] } }.
    // Stay tolerant of the legacy flat-array shape too (defensive).
    const json = (await res.json()) as unknown;
    // normalize() reads each row's `._source`, so pass the hit objects through
    // unwrapped (the legacy flat `format=json` array was already hit objects).
    const rows: RawComplaint[] = Array.isArray(json)
      ? (json as RawComplaint[])
      : ((json as { hits?: { hits?: RawComplaint[] } }).hits?.hits ?? []);
    if (rows.length === 0) break;

    for (const raw of rows) {
      const norm = normalize(raw, scrapedAt);
      if (norm) out.push(norm);
      if (out.length >= maxRecords) break;
    }
    console.error(
      `[cfpb]   page frm=${frm}: ${rows.length} rows (running ${out.length}/${maxRecords})`,
    );

    if (rows.length < CONFIG.PAGE_SIZE) break;
    frm += CONFIG.PAGE_SIZE;
  }

  console.error(`[cfpb] TOTAL: ${out.length} complaints (since ${dateMin})`);
  return out;
}
