/**
 * SEC Form N-PORT scraper — registered investment company monthly portfolio
 * reports (mutual funds, ETFs, closed-end funds).
 *
 * v1A is metadata-only via EDGAR full-text search. Each FTS hit carries
 * enough to populate the NportFiling record: filer name + CIK, period
 * ending (the month-end the filing covers), file number, file date,
 * accession, and the URL to the primary_doc.xml. Agents follow the URL
 * for the full per-holding portfolio detail (v1.1 polish to extract).
 *
 * Cadence: daily 6:40 AM ET, 2-day lookback. Volume is ~20-50 filings/day
 * across all registered investment companies — comfortable in 9 min.
 */

import { XMLParser } from "fast-xml-parser";
import type { NportFiling, NportHolding } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
  FTS_HITS_PER_PAGE: 100,
  FORM_CODES: ["NPORT-P", "NPORT-P/A"],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatAccession = (a: string): string => a.replace(/-/g, "");

/** Strip the xsl<schema>/ prefix from primaryDocument paths. Same gotcha
 *  as every SEC ownership form (Form 144 / 3 / D / 13D-G / NPORT-P). */
function rawXmlPath(primaryDoc: string): string {
  return primaryDoc.replace(/^xsl[A-Z0-9_]+\//, "");
}

interface EdgarHitSource {
  ciks?: string[];
  display_names?: string[];
  form?: string;
  file_type?: string;
  file_date?: string;
  period_ending?: string;
  file_num?: string[];
  adsh?: string;
  biz_states?: string[];
  inc_states?: string[];
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

/** Display name format from EDGAR FTS:
 *   "WisdomTree Trust  (CIK 0001350487)"
 * Extract the plain fund name (drop the CIK suffix). */
function parseFilerName(displayName: string): string {
  return displayName.replace(/\s*\(CIK\s+\d+\)\s*$/i, "").trim();
}

function normalizeHit(hit: EdgarHit, scrapedAt: string): NportFiling | null {
  const src = hit._source;
  if (!src) return null;
  const accession = src.adsh ?? "";
  if (!accession) return null;
  const formType = src.form ?? src.file_type ?? "";
  // Only ingest the actual NPORT-P / NPORT-P/A filings (skip the
  // ancillary attachments EDGAR sometimes surfaces with form=NPORT-EX).
  if (!formType.startsWith("NPORT-P")) return null;

  const ciks = src.ciks ?? [];
  const archiveCik = (ciks[0] ?? "").replace(/^0+/, "");
  const filerCik = (ciks[0] ?? "").padStart(10, "0");
  const filerName = parseFilerName(src.display_names?.[0] ?? "");
  const idParts = (hit._id ?? "").split(":");
  const primaryDoc = rawXmlPath(idParts[1] ?? "");
  if (!archiveCik || !primaryDoc) return null;

  const accNoDash = formatAccession(accession);
  return {
    filing_id: accession,
    filing_type: formType,
    is_amendment: formType.endsWith("/A"),
    file_date: src.file_date ?? "",
    period_ending: src.period_ending ?? "",
    filer_name: filerName,
    filer_cik: filerCik,
    sec_file_number: src.file_num?.[0] ?? "",
    filer_state: src.biz_states?.[0] ?? "",
    inc_state: src.inc_states?.[0] ?? "",
    primary_document_url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${primaryDoc}`,
    filing_url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${accession}-index.htm`,
    scraped_at: scrapedAt,
  };
}

export interface ScrapeNportOptions {
  lookbackDays?: number;
  maxFilingsPerForm?: number;
}

export async function scrapeNportLiveFeed(
  options: ScrapeNportOptions = {},
): Promise<NportFiling[]> {
  const scrapedAt = new Date().toISOString();
  const lookbackDays = options.lookbackDays ?? 2;
  const maxFilingsPerForm = options.maxFilingsPerForm ?? 1000;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  console.error(
    `[nport] Window ${startStr} → ${endStr}, forms: ${CONFIG.FORM_CODES.join(", ")}`,
  );

  const byAccession = new Map<string, NportFiling>();
  for (const form of CONFIG.FORM_CODES) {
    const formEncoded = encodeURIComponent(form);
    let from = 0;
    let pulled = 0;
    while (pulled < maxFilingsPerForm) {
      // EDGAR FTS requires a non-empty q parameter; q=%22%22 (literal "")
      // works as a no-op filter that still allows form filtering.
      const url =
        `${CONFIG.SEARCH_URL}?q=%22%22&forms=${formEncoded}` +
        `&dateRange=custom&startdt=${startStr}&enddt=${endStr}` +
        `&hits=${CONFIG.FTS_HITS_PER_PAGE}&from=${from}`;
      let data: EdgarSearchResponse;
      try {
        data = await fetchJson(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[nport] ${form} from=${from}: SKIP — ${msg}`);
        break;
      }
      const hits = data.hits?.hits ?? [];
      const total = data.hits?.total?.value ?? hits.length;
      if (from === 0) {
        console.error(
          `[nport]   ${form}: ${total} total in window, paging ${CONFIG.FTS_HITS_PER_PAGE} at a time`,
        );
      }
      for (const hit of hits) {
        const filing = normalizeHit(hit, scrapedAt);
        if (filing) byAccession.set(filing.filing_id, filing);
      }
      pulled += hits.length;
      console.error(
        `[nport]   ${form} from=${from}: +${hits.length} (running ${byAccession.size} unique)`,
      );
      if (hits.length < CONFIG.FTS_HITS_PER_PAGE) break;
      from += CONFIG.FTS_HITS_PER_PAGE;
    }
  }

  const out = Array.from(byAccession.values());
  console.error(`[nport] TOTAL: ${out.length} unique N-PORT filings`);
  return out;
}

// ─── Per-holding extraction (primary_doc.xml parse) ─────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
});

/** Asset-category codes that mean "this row is a derivative." Repos (REPO, RP)
 *  are categorized separately by the SEC and stay is_derivative=false. */
const DERIV_ASSET_CATS = new Set(["DCO", "DCR", "DE", "DFE", "DIR", "DR"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function derivTypeFromInfo(info: any): string | null {
  if (!info) return null;
  if (info.futrDeriv) return "future";
  if (info.fwdDeriv) return "forward";
  if (info.swapDeriv) return "swap";
  if (info.optionSwaptionWarrantDeriv) {
    // Sub-discriminate via derivCat attribute when present:
    //   OPT → option, WAR → warrant, SWO → swaption. Default option.
    const sub = info.optionSwaptionWarrantDeriv;
    const cat =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sub as any)?.["@_derivCat"] ?? (sub as any)?.derivCat ?? "";
    if (cat === "WAR") return "warrant";
    if (cat === "SWO") return "swaption";
    return "option";
  }
  if (info.otherDeriv) return "other";
  return null;
}

/**
 * Read a possibly-wrapped XML scalar field. fast-xml-parser yields either a
 * bare string (when no attributes) or an object `{ "#text": "value", "@_attr": ... }`
 * (when attributes are present). This handles both. Returns "" for missing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readScalar(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    if (typeof node["#text"] === "string") return node["#text"];
    // Some elements wrap the value in @_value (e.g. <ticker value="AAPL"/>)
    if (typeof node["@_value"] === "string") return node["@_value"];
  }
  return "";
}

function parseNumber(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseYN(s: string): boolean | null {
  if (s === "Y" || s === "y") return true;
  if (s === "N" || s === "n") return false;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readIdentifier(identifiers: any, tag: string): string | null {
  if (!identifiers) return null;
  const node = identifiers[tag];
  if (!node) return null;
  // Can be a single object or an array if multiple are filed.
  const first = Array.isArray(node) ? node[0] : node;
  const v =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (first as any)?.["@_value"] ?? (first as any)?.value ?? readScalar(first);
  return v || null;
}

async function fetchText(url: string): Promise<string> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Fetch one N-PORT primary_doc.xml and parse its `<invstOrSecs>` block into
 * NportHolding rows. Returns an empty array on any fetch/parse error after
 * logging — keeps the bulk run resilient.
 */
export async function parseNportHoldings(
  filing: NportFiling,
  scrapedAt: string,
): Promise<NportHolding[]> {
  let xmlText: string;
  try {
    xmlText = await fetchText(filing.primary_document_url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[nport-holdings] ${filing.filing_id} fetch SKIP — ${msg}`);
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = xml.parse(xmlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[nport-holdings] ${filing.filing_id} parse SKIP — ${msg}`);
    return [];
  }

  const formData = parsed.edgarSubmission?.formData;
  if (!formData) return [];
  const invstOrSecs = formData.invstOrSecs;
  if (!invstOrSecs) return [];
  const items = invstOrSecs.invstOrSec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr: any[] = Array.isArray(items) ? items : items ? [items] : [];

  const out: NportHolding[] = [];
  let idx = 0;
  for (const item of arr) {
    const assetCat = readScalar(item.assetCat) || null;
    const isDeriv = DERIV_ASSET_CATS.has(assetCat ?? "");
    const derivType = isDeriv ? derivTypeFromInfo(item.derivativeInfo) : null;

    out.push({
      id: `${filing.filing_id}-${idx}`,
      filing_id: filing.filing_id,
      filing_type: filing.filing_type,
      is_amendment: filing.is_amendment,
      period_ending: filing.period_ending,
      filer_name: filing.filer_name,
      filer_cik: filing.filer_cik,
      sec_file_number: filing.sec_file_number,
      holding_index: idx,
      name: readScalar(item.name) || "",
      lei: readScalar(item.lei) || null,
      title: readScalar(item.title) || null,
      cusip: readScalar(item.cusip) || null,
      ticker: readIdentifier(item.identifiers, "ticker"),
      isin: readIdentifier(item.identifiers, "isin"),
      asset_cat: assetCat,
      is_derivative: isDeriv,
      derivative_type: derivType,
      issuer_cat: readScalar(item.issuerCat) || null,
      country: readScalar(item.invCountry) || null,
      balance: parseNumber(readScalar(item.balance)),
      units: readScalar(item.units) || null,
      currency: readScalar(item.curCd) || null,
      value_usd: parseNumber(readScalar(item.valUSD)),
      pct_of_portfolio: parseNumber(readScalar(item.pctVal)),
      payoff_profile: readScalar(item.payoffProfile) || null,
      fair_val_level: parseNumber(readScalar(item.fairValLevel)),
      is_restricted: parseYN(readScalar(item.isRestrictedSec)),
      is_non_cash_collateral: parseYN(
        readScalar(item.securityLending?.isNonCashCollateral),
      ),
      is_loaned: parseYN(readScalar(item.securityLending?.isLoanByFund)),
      scraped_at: scrapedAt,
    });
    idx++;
  }
  return out;
}

/**
 * Walk a list of NportFilings and emit per-holding rows for each.
 * Sequential to respect EDGAR's 10 req/sec ceiling. Returns whatever it
 * successfully parsed; errors are logged and skipped per-filing.
 */
export async function scrapeNportHoldings(
  filings: NportFiling[],
): Promise<NportHolding[]> {
  const scrapedAt = new Date().toISOString();
  const out: NportHolding[] = [];
  let i = 0;
  for (const filing of filings) {
    i++;
    const holdings = await parseNportHoldings(filing, scrapedAt);
    out.push(...holdings);
    if (i % 10 === 0 || i === filings.length) {
      console.error(
        `[nport-holdings] ${i}/${filings.length} filings, ${out.length} holdings`,
      );
    }
  }
  console.error(
    `[nport-holdings] TOTAL: ${out.length} holdings across ${filings.length} filings`,
  );
  return out;
}
