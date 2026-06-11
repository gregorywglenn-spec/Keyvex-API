/**
 * SEC Form N-PORT scraper — registered investment company monthly portfolio
 * reports (mutual funds, ETFs, closed-end funds).
 *
 * Enumeration uses EDGAR's COMPLETE daily index (master.{YYYYMMDD}.idx),
 * NOT full-text search. FTS silently under-reported N-PORT (~5% leak) due to
 * its result caps and an incomplete mirror; the daily index is the
 * authoritative, uncapped file list. Each filing's metadata (filer, period
 * ending, file number, state) is read from its own primary_doc.xml header.
 * Agents follow primary_document_url for the full per-holding portfolio detail.
 *
 * Cadence: daily 6:40 AM ET, 2-day lookback. Volume is ~140 filings/day
 * across all registered investment companies — comfortable in 9 min.
 */

import { XMLParser } from "fast-xml-parser";
import type { NportFiling, NportHolding } from "../types.js";
import { fetchEdgarDailyIndex } from "../reconcile/sec-edgar-index.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  EDGAR_URL: "https://www.sec.gov",
  RATE_LIMIT_MS: 150,
  FORM_CODES: ["NPORT-P", "NPORT-P/A"],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatAccession = (a: string): string => a.replace(/-/g, "");


export interface ScrapeNportOptions {
  lookbackDays?: number;
  maxFilingsPerForm?: number;
}

/**
 * Reference to one N-PORT filing as listed in EDGAR's daily index
 * (the complete, authoritative file list — no result caps).
 */
interface NportIndexRef {
  cik: string;
  accession: string;
  formType: string;
  fileDate: string;
}

/**
 * Build a complete NportFiling record from the filing's own primary_doc.xml
 * header. This replaces the old full-text-search path (which silently dropped
 * ~5% of filings to EDGAR FTS result caps / an incomplete mirror).
 *
 * Field mapping verified against a live N-PORT filing (2026-06-04):
 *   period_ending  ← genInfo.repPdDate  (matches what FTS reported exactly)
 *   sec_file_number ← genInfo.regFileNumber
 *   filer_state    ← genInfo.regStateConditional@regState (strip "US-")
 *   filer_cik/name ← headerData + genInfo
 * The one field not present in the filing XML is inc_state (state of
 * incorporation, an EDGAR company-metadata field, not part of N-PORT). Left
 * blank on index-recovered records — a minor field vs. recovering the whole
 * filing, which the old path was dropping outright.
 */
async function fetchNportFilingMeta(
  ref: NportIndexRef,
  scrapedAt: string,
): Promise<NportFiling | null> {
  const archiveCik = ref.cik.replace(/^0+/, "");
  const accNoDash = formatAccession(ref.accession);
  const url = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/primary_doc.xml`;
  let text: string;
  try {
    text = await fetchText(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[nport] ${ref.accession}: header fetch SKIP — ${msg}`);
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  try {
    doc = xml.parse(text);
  } catch {
    console.error(`[nport] ${ref.accession}: header parse SKIP`);
    return null;
  }
  const sub = doc?.edgarSubmission;
  const gen = sub?.formData?.genInfo ?? {};
  const formType =
    readScalar(sub?.headerData?.submissionType) || ref.formType;
  let filerCik =
    readScalar(sub?.headerData?.filerInfo?.filer?.issuerCredentials?.cik) ||
    readScalar(gen.regCik) ||
    ref.cik;
  filerCik = filerCik.padStart(10, "0");
  const regStateNode = gen?.regStateConditional;
  const regState =
    (regStateNode && regStateNode["@_regState"]) || "";
  const filerState =
    typeof regState === "string" ? regState.replace(/^US-/, "") : "";
  return {
    filing_id: ref.accession,
    filing_type: formType,
    is_amendment: formType.endsWith("/A"),
    file_date: ref.fileDate,
    period_ending: readScalar(gen.repPdDate),
    filer_name: readScalar(gen.regName),
    filer_cik: filerCik,
    sec_file_number: readScalar(gen.regFileNumber),
    filer_state: filerState,
    inc_state: "",
    primary_document_url: url,
    filing_url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${archiveCik}/${accNoDash}/${ref.accession}-index.htm`,
    scraped_at: scrapedAt,
  };
}

export async function scrapeNportLiveFeed(
  options: ScrapeNportOptions = {},
): Promise<NportFiling[]> {
  const scrapedAt = new Date().toISOString();
  const lookbackDays = options.lookbackDays ?? 2;

  // Enumerate from EDGAR's COMPLETE daily index instead of full-text search.
  // FTS silently under-reported N-PORT (~5% leak) due to its result caps and
  // an incomplete mirror; the daily index is the authoritative file list.
  // Same fix already applied to Form D's daily feed.
  const days: string[] = [];
  for (let i = 0; i <= lookbackDays; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().split("T")[0] ?? "");
  }

  const seen = new Map<string, NportIndexRef>();
  for (const day of days) {
    if (!day) continue;
    let filings: Awaited<ReturnType<typeof fetchEdgarDailyIndex>>;
    try {
      filings = await fetchEdgarDailyIndex(day, CONFIG.FORM_CODES);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[nport] daily-index ${day}: SKIP — ${msg}`);
      continue;
    }
    for (const f of filings) {
      if (!f.formType.startsWith("NPORT-P")) continue;
      seen.set(f.accession, {
        cik: f.cik,
        accession: f.accession,
        formType: f.formType,
        fileDate: f.dateFiled,
      });
    }
    console.error(
      `[nport] daily-index ${day}: ${filings.length} filings (running ${seen.size} unique)`,
    );
  }

  const out: NportFiling[] = [];
  let done = 0;
  for (const ref of seen.values()) {
    const rec = await fetchNportFilingMeta(ref, scrapedAt);
    if (rec) out.push(rec);
    done++;
    if (done % 50 === 0) {
      console.error(`[nport] header fetch ${done}/${seen.size}`);
    }
  }
  console.error(
    `[nport] TOTAL: ${out.length} N-PORT filings (of ${seen.size} in complete index)`,
  );
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
  // Bounded retry on 429/5xx (2s/4s/8s, honoring Retry-After). Without it,
  // a transient SEC rate-limit window burned an ENTIRE 600-filing healing
  // batch in minutes — every fetch insta-SKIPped (2026-06-11 6:40 cron;
  // the 6:30-6:50 ET slot is crowded with other SEC crons on shared GCP
  // egress, so brief 429 windows there are normal, not exceptional).
  for (let attempt = 1; ; attempt++) {
    await sleep(CONFIG.RATE_LIMIT_MS);
    const res = await fetch(url, {
      headers: { "User-Agent": CONFIG.USER_AGENT },
    });
    if (res.ok) return res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 2000 * 2 ** (attempt - 1);
      console.error(
        `[nport] HTTP ${res.status} on ${url.slice(-40)} — retry ${attempt} in ${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
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
  // Some filer agents list the human-readable NPORT-EX exhibit (.htm) as the
  // primary document, so primary_document_url isn't always the structured
  // XML (caught 2026-06-10: 100 consecutive catch-up filings parsed to 0
  // rows because we were parsing exhibit HTML). The archive directory
  // ALWAYS contains primary_doc.xml for NPORT-P — derive it from the
  // accession when the stored URL isn't an .xml.
  let xmlUrl = filing.primary_document_url;
  if (!/\.xml($|\?)/i.test(xmlUrl)) {
    const cikNum = String(parseInt(filing.filer_cik, 10));
    const accNoDash = filing.filing_id.replace(/-/g, "");
    xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/primary_doc.xml`;
  }
  let xmlText: string;
  try {
    xmlText = await fetchText(xmlUrl);
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
    // Loop, not push(...spread): a single mega-fund N-PORT (total-market
    // index funds) can carry >100K rows, and spreading that many args blows
    // the call stack (RangeError, caught 2026-06-10 mid-catch-up).
    for (const h of holdings) out.push(h);
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
