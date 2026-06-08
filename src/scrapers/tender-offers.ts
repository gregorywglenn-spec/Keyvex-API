/**
 * SEC Schedule TO scraper — tender offer disclosures.
 *
 * Schedule TO is filed when someone (or the company itself) makes a
 * public tender offer for shares. Pairs naturally with 13D activist
 * disclosures: "they took a 5% stake, then bid for the whole thing."
 *
 * Form codes covered:
 *   SC TO-T   — third-party tender offer (acquirer bidding for target)
 *   SC TO-T/A — third-party amendment (extension, revised price, results)
 *   SC TO-I   — issuer tender offer (company buying back own shares)
 *   SC TO-I/A — issuer amendment
 *
 * Form codes deliberately NOT covered in v1A:
 *   SC TO-C   — pre-commencement communication (a PR before formal filing)
 *   SC 14D9   — target company's recommendation / response to a TO-T
 * Both pair with the main filings but their value is in HTML prose.
 *
 * v1A scope: metadata only. EDGAR's full-text-search API returns enough
 * structure (CIKs, display_names with optional tickers, accession,
 * form_type, file_date, SIC, state) to populate the record without
 * fetching the filing body. The HTML attachment carries the offer
 * price + shares sought + expiration date — that's v1.1 parsing work.
 *
 * Display-name convention (observed from real recent filings):
 *   For SC TO-T, EDGAR's `display_names` array lists the TARGET first
 *   (with its ticker in parens) and the BIDDER second. The bidder is
 *   typically a private SPV ("2025 Acquisition Company, LLC") and rarely
 *   has a surfaced ticker. We split on that convention and surface both
 *   parties in our schema so agents can disambiguate.
 *   For SC TO-I, target == bidder (the company buying back its shares),
 *   so `display_names` has a single party.
 */

import type { TenderOffer } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
  /** EDGAR FTS caps at 10000 results per query; we paginate via hits param. */
  PAGE_SIZE: 100,
  FORM_CODES: ["SC TO-T", "SC TO-T/A", "SC TO-I", "SC TO-I/A"],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatAccession = (a: string): string => a.replace(/-/g, "");

// ─── EDGAR FTS hit shape ────────────────────────────────────────────────────

interface EdgarHitSource {
  ciks?: string[];
  display_names?: string[];
  file_num?: string[];
  form?: string;
  file_type?: string;
  file_date?: string;
  adsh?: string;
  biz_states?: string[];
  sics?: string[];
  inc_states?: string[];
  items?: string[];
}

interface EdgarHit {
  _id?: string;
  _source?: EdgarHitSource;
}

interface EdgarSearchResponse {
  hits?: {
    total?: { value?: number };
    hits?: EdgarHit[];
  };
}

async function fetchJson(url: string): Promise<EdgarSearchResponse> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`EDGAR FTS ${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as EdgarSearchResponse;
}

// ─── Display-name parsing ───────────────────────────────────────────────────

/**
 * EDGAR's display_names entries look like:
 *   "Kezar Life Sciences, Inc.  (KZR)  (CIK 0001645666)"
 *   "Aurinia Pharmaceuticals Inc.  (CIK 0001600620)"
 * Extract the clean company name and optional ticker. The (CIK ...) tail
 * is redundant with the parallel `ciks` array but useful for verification.
 */
interface ParsedDisplayName {
  name: string;
  ticker: string;
  cik: string;
}

function parseDisplayName(raw: string): ParsedDisplayName {
  // Strip the (CIK xxxxx) suffix to get name + optional ticker.
  const cikMatch = raw.match(/\(CIK\s+(\d+)\)\s*$/i);
  const cik = cikMatch ? (cikMatch[1] ?? "").padStart(10, "0") : "";
  const withoutCik = raw.replace(/\(CIK\s+\d+\)\s*$/i, "").trim();
  // Ticker shows up as "(TICKER)" at the end after the name.
  // Filter false-positive parens that wrap a place ("(CA)", "(South San Francisco)").
  // Real tickers are 1-5 chars, all uppercase, may contain a dot (BRK.A).
  const tickerMatch = withoutCik.match(/\(([A-Z][A-Z0-9.]{0,4})\)\s*$/);
  let ticker = "";
  let name = withoutCik;
  if (tickerMatch) {
    ticker = tickerMatch[1] ?? "";
    name = withoutCik.replace(/\([A-Z][A-Z0-9.]{0,4}\)\s*$/, "").trim();
  }
  return { name, ticker, cik };
}

// ─── Normalizer ─────────────────────────────────────────────────────────────

function buildFilingUrl(cik: string, accession: string): string {
  const cikNum = cik.replace(/^0+/, "");
  const accNoDashes = formatAccession(accession);
  return `${CONFIG.EDGAR_URL}/cgi-bin/browse-edgar?action=getcompany&CIK=${cikNum}&type=SC+TO&dateb=&owner=include&count=40`;
}

function buildPrimaryDocUrl(
  cik: string,
  accession: string,
  filename: string,
): string {
  const cikNum = cik.replace(/^0+/, "");
  const accNoDashes = formatAccession(accession);
  return `${CONFIG.EDGAR_URL}/Archives/edgar/data/${cikNum}/${accNoDashes}/${filename}`;
}

function buildFilingIndexUrl(cik: string, accession: string): string {
  const cikNum = cik.replace(/^0+/, "");
  const accNoDashes = formatAccession(accession);
  return `${CONFIG.EDGAR_URL}/Archives/edgar/data/${cikNum}/${accNoDashes}/${accession}-index.htm`;
}

export function normalizeHit(hit: EdgarHit, scrapedAt: string): TenderOffer | null {
  const src = hit._source;
  if (!src) return null;
  const accession = src.adsh ?? "";
  if (!accession) return null;

  const formType = src.form ?? src.file_type ?? "";
  const isAmendment = formType.endsWith("/A");
  const isIssuerTender = formType.startsWith("SC TO-I");

  // display_names is parallel to ciks. For SC TO-T, target first then bidder.
  // For SC TO-I, target == bidder (single party).
  const names = src.display_names ?? [];
  const ciks = src.ciks ?? [];
  const parsed = names.map(parseDisplayName);

  let target: ParsedDisplayName = { name: "", ticker: "", cik: "" };
  let bidder: ParsedDisplayName = { name: "", ticker: "", cik: "" };

  if (parsed.length === 0) {
    return null;
  }
  if (isIssuerTender) {
    target = parsed[0] ?? target;
    bidder = parsed[0] ?? bidder;
  } else {
    // Third-party: convention is target first, bidder second.
    target = parsed[0] ?? target;
    bidder = parsed[1] ?? parsed[0] ?? bidder;
  }

  // Cross-reference parsed CIK against `ciks` array — they should align.
  // Fall back to ciks[i] if display-name parsing missed the suffix.
  if (!target.cik && ciks[0]) target.cik = ciks[0].padStart(10, "0");
  if (!bidder.cik && ciks[isIssuerTender ? 0 : 1]) {
    bidder.cik = (ciks[isIssuerTender ? 0 : 1] ?? "").padStart(10, "0");
  }

  // Extract primary document filename from hit._id ("accession:filename").
  const idParts = (hit._id ?? "").split(":");
  const filename = idParts[1] ?? "";

  // For the primary doc URL, use the FIRST cik in the ciks array — that's
  // the archive root for the filing (EDGAR uses the first listed CIK).
  const archiveCik = ciks[0] ?? target.cik;

  return {
    accession_number: accession,
    form_type: formType,
    is_amendment: isAmendment,
    is_issuer_tender: isIssuerTender,
    filing_date: src.file_date ?? "",
    target_name: target.name,
    target_cik: target.cik,
    target_ticker: target.ticker,
    bidder_name: bidder.name,
    bidder_cik: bidder.cik,
    bidder_ticker: bidder.ticker,
    all_ciks: ciks.map((c) => c.padStart(10, "0")),
    file_number: (src.file_num ?? [])[0] ?? "",
    filing_url: buildFilingIndexUrl(archiveCik, accession),
    primary_document_url: filename
      ? buildPrimaryDocUrl(archiveCik, accession, filename)
      : "",
    inc_states: src.inc_states ?? [],
    sic_codes: src.sics ?? [],
    scraped_at: scrapedAt,
  };
}

// ─── Public scrapers ────────────────────────────────────────────────────────

/**
 * Pull Schedule TO filings filed in the last N days. Iterates each form
 * code (SC TO-T, SC TO-T/A, SC TO-I, SC TO-I/A) and dedups by accession
 * (rare cross-form duplicates can occur).
 */
export async function scrapeTenderOffersLiveFeed(
  lookbackDays = 30,
  maxPerForm = 1000,
): Promise<TenderOffer[]> {
  const scrapedAt = new Date().toISOString();
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  console.error(
    `[tender-offers] Window ${startStr} → ${endStr}, forms: ${CONFIG.FORM_CODES.join(", ")}`,
  );

  const byAccession = new Map<string, TenderOffer>();

  for (const form of CONFIG.FORM_CODES) {
    const formEncoded = encodeURIComponent(form);
    let from = 0;
    let pulled = 0;
    while (pulled < maxPerForm) {
      const url =
        `${CONFIG.SEARCH_URL}?q=&forms=${formEncoded}` +
        `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
        `&hits=${CONFIG.PAGE_SIZE}&from=${from}`;
      let data: EdgarSearchResponse;
      try {
        data = await fetchJson(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tender-offers] ${form} from=${from}: SKIP — ${msg}`);
        break;
      }
      const hits = data.hits?.hits ?? [];
      const total = data.hits?.total?.value ?? hits.length;
      if (from === 0) {
        console.error(
          `[tender-offers]   ${form}: ${total} total in window, paging in ${CONFIG.PAGE_SIZE}-row chunks`,
        );
      }
      for (const hit of hits) {
        const offer = normalizeHit(hit, scrapedAt);
        if (offer) byAccession.set(offer.accession_number, offer);
      }
      pulled += hits.length;
      console.error(
        `[tender-offers]   ${form} from=${from}: +${hits.length} (running ${byAccession.size} unique)`,
      );
      if (hits.length < CONFIG.PAGE_SIZE) break;
      from += CONFIG.PAGE_SIZE;
    }
  }

  const offers = Array.from(byAccession.values());
  console.error(
    `[tender-offers] TOTAL: ${offers.length} unique Schedule TO filings in last ${lookbackDays}d`,
  );
  return offers;
}

/**
 * Pull recent Schedule TO filings for a single target ticker. Uses EDGAR's
 * FTS with a ticker-keyword query plus the SC TO form filter. Useful for
 * "what tender offers have been filed against ACME this year" queries.
 */
export async function scrapeTenderOffersByTicker(
  ticker: string,
  lookbackDays = 365,
  maxPerForm = 100,
): Promise<TenderOffer[]> {
  const scrapedAt = new Date().toISOString();
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  const tickerUpper = ticker.trim().toUpperCase();
  console.error(
    `[tender-offers] By ticker ${tickerUpper}, window ${startStr} → ${endStr}`,
  );

  const byAccession = new Map<string, TenderOffer>();
  for (const form of CONFIG.FORM_CODES) {
    const formEncoded = encodeURIComponent(form);
    const url =
      `${CONFIG.SEARCH_URL}?q=${encodeURIComponent(tickerUpper)}` +
      `&forms=${formEncoded}` +
      `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
      `&hits=${maxPerForm}`;
    let data: EdgarSearchResponse;
    try {
      data = await fetchJson(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tender-offers] ${form}: SKIP — ${msg}`);
      continue;
    }
    const hits = data.hits?.hits ?? [];
    for (const hit of hits) {
      const offer = normalizeHit(hit, scrapedAt);
      if (!offer) continue;
      // Filter to filings that actually involve the requested ticker on the
      // target side (FTS keyword can match prose, not just the target).
      if (offer.target_ticker !== tickerUpper) continue;
      byAccession.set(offer.accession_number, offer);
    }
    console.error(
      `[tender-offers]   ${form}: ${hits.length} raw hits, ${byAccession.size} matching ticker`,
    );
  }

  const offers = Array.from(byAccession.values());
  console.error(
    `[tender-offers] TOTAL: ${offers.length} TO filings for ${tickerUpper}`,
  );
  return offers;
}
