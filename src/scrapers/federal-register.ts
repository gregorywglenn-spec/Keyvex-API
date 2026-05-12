/**
 * Federal Register scraper — daily-published Rules / Proposed Rules /
 * Notices / Presidential Documents from federalregister.gov.
 *
 * Public REST API at federalregister.gov/api/v1. No auth required.
 * Paginated via `page` param; per-page max is 100. Filtered via
 * conditions[publication_date][gte/lte] + conditions[type][].
 *
 * Cadence: daily 6:55 AM ET, 3-day lookback. Volume ~100-200 docs/day.
 *
 * Schema is clean — `results[]` is an array of document records with
 * title, document_number, type, publication_date, html_url, pdf_url,
 * agencies[], abstract, excerpts. Normalize agencies[] to flat name +
 * slug arrays.
 */

import type { FederalRegisterDocument } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.FEDREG_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://www.federalregister.gov/api/v1/documents",
  RATE_LIMIT_MS: 200,
  PAGE_SIZE: 100,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RawAgency {
  raw_name?: string;
  name?: string;
  slug?: string;
  id?: number;
}

interface RawDocument {
  document_number?: string;
  title?: string;
  type?: string;
  abstract?: string | null;
  publication_date?: string;
  html_url?: string;
  pdf_url?: string;
  public_inspection_pdf_url?: string;
  agencies?: RawAgency[];
  excerpts?: string | null;
}

interface ApiResponse {
  count?: number;
  total_pages?: number;
  next_page_url?: string | null;
  results?: RawDocument[];
}

function normalize(
  raw: RawDocument,
  scrapedAt: string,
): FederalRegisterDocument | null {
  if (!raw.document_number) return null;
  const agencies = Array.isArray(raw.agencies) ? raw.agencies : [];
  return {
    document_number: raw.document_number,
    title: raw.title ?? "",
    document_type: raw.type ?? "",
    abstract: raw.abstract ?? "",
    publication_date: raw.publication_date ?? "",
    html_url: raw.html_url ?? "",
    pdf_url: raw.pdf_url ?? "",
    public_inspection_pdf_url: raw.public_inspection_pdf_url ?? "",
    agency_names: agencies.map((a) => a.name ?? a.raw_name ?? "").filter(Boolean),
    agency_slugs: agencies.map((a) => a.slug ?? "").filter(Boolean),
    excerpts: raw.excerpts ?? "",
    scraped_at: scrapedAt,
  };
}

export interface ScrapeFederalRegisterOptions {
  lookbackDays?: number;
  maxPages?: number;
}

export async function scrapeFederalRegister(
  options: ScrapeFederalRegisterOptions = {},
): Promise<FederalRegisterDocument[]> {
  const scrapedAt = new Date().toISOString();
  const lookbackDays = options.lookbackDays ?? 3;
  const maxPages = options.maxPages ?? 20;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  console.error(`[fedreg] Window ${startStr} → ${endStr}, max ${maxPages} pages`);

  const out: FederalRegisterDocument[] = [];
  let page = 1;
  while (page <= maxPages) {
    const url = new URL(CONFIG.BASE_URL);
    url.searchParams.set("format", "json");
    url.searchParams.set("order", "newest");
    url.searchParams.set("per_page", String(CONFIG.PAGE_SIZE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("conditions[publication_date][gte]", startStr);
    url.searchParams.set("conditions[publication_date][lte]", endStr);

    await sleep(CONFIG.RATE_LIMIT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fedreg]   page ${page}: SKIP — ${msg}`);
      break;
    }
    if (!res.ok) {
      console.error(`[fedreg]   page ${page}: HTTP ${res.status}, stopping`);
      break;
    }
    const data = (await res.json()) as ApiResponse;
    const results = data.results ?? [];
    if (page === 1) {
      console.error(
        `[fedreg]   total in window: ${data.count ?? results.length}, total_pages: ${data.total_pages ?? "?"}`,
      );
    }
    for (const raw of results) {
      const norm = normalize(raw, scrapedAt);
      if (norm) out.push(norm);
    }
    console.error(
      `[fedreg]   page ${page}: +${results.length} (running ${out.length})`,
    );
    if (!data.next_page_url) break;
    page++;
  }

  console.error(`[fedreg] TOTAL: ${out.length} Federal Register documents`);
  return out;
}
