/**
 * Form 144 scraper — planned insider sales from SEC EDGAR.
 *
 * Form 144 is a "notice of proposed sale" filed under Rule 144 of the
 * Securities Act. Insiders (officers, directors, 10%+ holders) MUST file
 * Form 144 BEFORE selling restricted or control stock blocks of ≥5,000
 * shares OR ≥$50,000 aggregate value. The actual sale later lands as a
 * Form 4 transaction.
 *
 * Forward-looking signal: tells you what's *about* to happen, not what
 * already did. Almost no aggregator exposes Form 144 cleanly.
 *
 * Architecture mirrors src/scrapers/form4.ts:
 *   - Same EDGAR plumbing (submissions API + full-text search)
 *   - Same rate-limit (150ms between requests, ~6 req/sec)
 *   - Same User-Agent requirement
 *   - Different XML schema, different output type
 *
 * Form 144 XML uses the `edgarSubmission` root element with sections:
 *   - issuerInfo  — issuerName, issuerTradingSymbol, issuerCik
 *   - filerInfo   — name, relationship to issuer
 *   - securitiesToBeSold[] — array of planned-sale lines (one per security
 *     class). Each has: securityClassTitle, noOfUnits, aggregateMarketValue,
 *     approxDateOfSale, brokerName, acquiredDate, natureOfAcquisition.
 *   - securitiesInformation — total shares outstanding (for percentage calc).
 *
 * One Form 144 filing usually has one security line, but can have multiple
 * (e.g., separate Class A + Class B). We emit one Form144Filing record per
 * security line.
 *
 * Data source: SEC EDGAR (https://data.sec.gov, free, no API key).
 */

import { XMLParser } from "fast-xml-parser";
import { preferPrimaryTicker } from "../sec-tickers.js";
import type { Form144Filing } from "../types.js";
import { fetchEdgarDailyIndex, fetchPrimaryDocUrl } from "../reconcile/sec-edgar-index.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`EDGAR ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

const formatAccession = (a: string): string => a.replace(/-/g, "");

/**
 * EDGAR's submissions API and full-text search both return the XSL-rendered
 * HTML path as primaryDocument for Form 144 — e.g. "xsl144X01/primary_doc.xml".
 * That's the human-readable version. The structured XML we actually want lives
 * at the sibling "primary_doc.xml" in the archive root. Strip the xsl prefix.
 */
function rawXmlPath(primaryDoc: string): string {
  return primaryDoc.replace(/^xsl[A-Z0-9]+\//, "");
}

/**
 * Form 144 XML wraps a lot of fields in repeating containers. fast-xml-parser
 * yields either a bare scalar or { value: ... } — same pattern as Form 4.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function read(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node.trim();
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && node.value !== undefined) {
    return read(node.value);
  }
  return "";
}

// ─── Ticker ↔ CIK lookup (bidirectional cache) ─────────────────────────────

interface TickerInfo {
  cik: string;
  cikRaw: string;
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;
// Reverse index: 10-digit zero-padded CIK → ticker. Populated alongside
// tickerCache. Form 144 XML only contains CIK, not ticker, so we need to
// look up ticker from CIK during parsing.
let cikToTicker: Record<string, string> | null = null;

async function loadCaches(): Promise<void> {
  if (tickerCache && cikToTicker) return;
  const data = (await fetchJson(
    `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
  )) as Record<string, { ticker: string; cik_str: number; title: string }>;
  tickerCache = {};
  cikToTicker = {};
  for (const entry of Object.values(data)) {
    const ticker = entry.ticker.toUpperCase();
    const cikPadded = String(entry.cik_str).padStart(10, "0");
    tickerCache[ticker] = {
      cik: cikPadded,
      cikRaw: String(entry.cik_str),
      name: entry.title,
    };
    // Primary-ticker pick for multi-class CIKs (shared helper; see sec-tickers).
    cikToTicker[cikPadded] = preferPrimaryTicker(cikToTicker[cikPadded], ticker);
  }
}

export async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
  await loadCaches();
  return tickerCache![ticker.toUpperCase()] ?? null;
}

/** Look up a ticker symbol from a CIK (any zero-padding accepted). */
async function getTickerFromCik(cik: string): Promise<string> {
  if (!cik) return "";
  await loadCaches();
  const padded = cik.replace(/^0+/, "").padStart(10, "0");
  return cikToTicker![padded] ?? "";
}

// ─── Date conversion ────────────────────────────────────────────────────────

/**
 * Form 144 XML emits dates as MM/DD/YYYY. The rest of our system uses ISO
 * YYYY-MM-DD. Returns null for empty/malformed input rather than throwing.
 */
function convertUsDate(usDate: string): string | null {
  if (!usDate) return null;
  const m = usDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// ─── Filing metadata ────────────────────────────────────────────────────────

interface FilingMeta {
  accession: string;
  companyCik: string;
  filedAt: string;
  url: string;
}

// ─── XML parsing ────────────────────────────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Form 144 has lots of numeric values where leading zeros matter (CIKs)
  // and some that are real numbers. Parse to string and let us coerce.
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * Parse a Form 144 XML document into structured filing records.
 *
 * Real SEC Form 144 schema (verified against AAPL 2026 filings):
 *
 *   <edgarSubmission>
 *     <headerData>
 *       <submissionType>144</submissionType>
 *       <filerInfo>
 *         <filer><filerCredentials><cik>...</cik></filerCredentials></filer>
 *         (NOTE: this is the filing AGENT's CIK — typically a law firm or
 *          filing service — NOT the insider. The insider is in issuerInfo.)
 *       </filerInfo>
 *     </headerData>
 *     <formData>
 *       <issuerInfo>
 *         <issuerCik>...</issuerCik>
 *         <issuerName>...</issuerName>
 *         <nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
 *           (THE ACTUAL INSIDER)
 *         </nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
 *         <relationshipsToIssuer>
 *           <relationshipToIssuer>Officer | Director | 10% Owner</relationshipToIssuer>
 *         </relationshipsToIssuer>
 *       </issuerInfo>
 *       <securitiesInformation>
 *         <securitiesClassTitle>Common</securitiesClassTitle>
 *         <brokerOrMarketmakerDetails><name>...</name></brokerOrMarketmakerDetails>
 *         <noOfUnitsSold>1534</noOfUnitsSold>             (planned units; despite "Sold" name)
 *         <aggregateMarketValue>419042.78</aggregateMarketValue>
 *         <noOfUnitsOutstanding>14681140000</noOfUnitsOutstanding>
 *         <approxSaleDate>04/23/2026</approxSaleDate>     (MM/DD/YYYY)
 *         <securitiesExchangeName>NASDAQ</securitiesExchangeName>
 *       </securitiesInformation>
 *       <securitiesToBeSold>
 *         (despite the name, this is the ACQUISITION HISTORY block)
 *         <acquiredDate>04/15/2026</acquiredDate>
 *         <natureOfAcquisitionTransaction>Restricted Stock Units</natureOfAcquisitionTransaction>
 *         <amountOfSecuritiesAcquired>1534</amountOfSecuritiesAcquired>
 *         <paymentDate>04/15/2026</paymentDate>
 *         <natureOfPayment>...</natureOfPayment>
 *       </securitiesToBeSold>
 *       <noticeSignature>
 *         <noticeDate>04/23/2026</noticeDate>
 *         <planAdoptionDates>
 *           <planAdoptionDate>11/21/2025</planAdoptionDate>
 *           (PRESENT means this is a 10b5-1 pre-arranged plan sale —
 *            significant signal, distinguishes scheduled from discretionary)
 *         </planAdoptionDates>
 *       </noticeSignature>
 *     </formData>
 *   </edgarSubmission>
 *
 * Form 144 has no ticker field — only CIK. We reverse-look ticker from CIK
 * via the EDGAR ticker catalog (loaded once and cached).
 */
export async function parseForm144Xml(
  xmlText: string,
  meta: FilingMeta,
): Promise<Form144Filing[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = xml.parse(xmlText);
  const submission = parsed.edgarSubmission;
  if (!submission) return [];

  const formData = submission.formData;
  if (!formData) return [];

  // Issuer
  const issuer = formData.issuerInfo;
  if (!issuer) return [];
  const cik = read(issuer.issuerCik) || meta.companyCik;
  const companyName = read(issuer.issuerName) || null;
  const ticker = await getTickerFromCik(cik);

  // Insider (the seller — not the filing agent in headerData)
  const filerName =
    read(issuer.nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold) ||
    "unknown";

  // Relationship — element can be a single string, an array of strings, or
  // an object with the actual relationship inside. fast-xml-parser may yield
  // any of these shapes depending on count. Capture all and join.
  const relRaw = issuer.relationshipsToIssuer?.relationshipToIssuer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const relArray: any[] = Array.isArray(relRaw)
    ? relRaw
    : relRaw !== undefined
      ? [relRaw]
      : [];
  const relationships = relArray.map((r) => read(r)).filter((r) => r);
  const filerRelationship = relationships.join(" / ");

  // Securities information — the planned-sale block
  const secInfoRaw = formData.securitiesInformation;
  // A filing usually has one block; multi-class filings produce arrays.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const secInfoArray: any[] = Array.isArray(secInfoRaw)
    ? secInfoRaw
    : secInfoRaw
      ? [secInfoRaw]
      : [];

  // Acquisition history block (mis-named "securitiesToBeSold" in the schema)
  const acqRaw = formData.securitiesToBeSold;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acqArray: any[] = Array.isArray(acqRaw)
    ? acqRaw
    : acqRaw
      ? [acqRaw]
      : [];

  // 10b5-1 plan adoption — signal that this sale is pre-arranged
  const planRaw =
    formData.noticeSignature?.planAdoptionDates?.planAdoptionDate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planArray: string[] = Array.isArray(planRaw)
    ? planRaw.map((p) => read(p))
    : planRaw !== undefined
      ? [read(planRaw)]
      : [];
  const planAdoptionDate =
    planArray.length > 0 ? convertUsDate(planArray[0]!) : null;
  const is10b51Plan = planAdoptionDate !== null;

  const noticeDate = convertUsDate(read(formData.noticeSignature?.noticeDate));

  const filings: Form144Filing[] = [];

  for (let i = 0; i < secInfoArray.length; i++) {
    const secInfo = secInfoArray[i];
    // Acquisition info aligns by position when present in matching counts;
    // otherwise default to the single object or undefined.
    const acq = acqArray[i] ?? acqArray[0] ?? {};

    const securityTitle = read(secInfo?.securitiesClassTitle) || null;
    const sharesToBeSold =
      parseFloat(read(secInfo?.noOfUnitsSold).replace(/,/g, "")) || 0;
    const aggregateMarketValue =
      parseFloat(read(secInfo?.aggregateMarketValue).replace(/,/g, "")) || 0;
    const sharesOutstandingRaw = read(secInfo?.noOfUnitsOutstanding);
    const sharesOutstanding = sharesOutstandingRaw
      ? parseFloat(sharesOutstandingRaw.replace(/,/g, ""))
      : null;
    const approxSaleDate =
      convertUsDate(read(secInfo?.approxSaleDate)) ?? "";
    const brokerName =
      read(secInfo?.brokerOrMarketmakerDetails?.name) || null;
    const exchange = read(secInfo?.securitiesExchangeName) || null;

    const acquisitionDate = convertUsDate(read(acq?.acquiredDate));
    const natureOfAcquisition =
      read(acq?.natureOfAcquisitionTransaction) || null;

    if (!sharesToBeSold || !approxSaleDate) continue;

    const pctOfOutstanding =
      sharesOutstanding && sharesOutstanding > 0
        ? (sharesToBeSold / sharesOutstanding) * 100
        : null;

    filings.push({
      id: `${meta.accession}-${ticker || cik}-${i + 1}`,
      ticker,
      company_name: companyName,
      company_cik: cik,
      filer_name: filerName,
      filer_relationship: filerRelationship,
      security_title: securityTitle,
      shares_to_be_sold: sharesToBeSold,
      aggregate_market_value: aggregateMarketValue,
      approximate_sale_date: approxSaleDate,
      shares_outstanding: sharesOutstanding,
      pct_of_outstanding: pctOfOutstanding,
      broker_name: brokerName,
      exchange,
      acquisition_date: acquisitionDate,
      nature_of_acquisition: natureOfAcquisition,
      plan_adoption_date: planAdoptionDate,
      is_10b5_1_plan: is10b51Plan,
      notice_date: noticeDate,
      filing_date: meta.filedAt,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: "SEC_EDGAR_FORM144",
    });
  }

  return filings;
}

// ─── Fetcher ────────────────────────────────────────────────────────────────

interface SubmissionsResponse {
  filings?: {
    recent?: {
      form: string[];
      accessionNumber: string[];
      filingDate: string[];
      primaryDocument?: string[];
    };
  };
}

/**
 * Fetch all Form 144 planned-sale notices for a ticker. Pulls up to
 * `maxFilings` most-recent filings from EDGAR and parses each one.
 */
export async function scrapeForm144ByTicker(
  ticker: string,
  maxFilings = 20,
): Promise<Form144Filing[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[form144] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${info.cik}.json`,
  )) as SubmissionsResponse;
  const recent = subs.filings?.recent;
  if (!recent) return [];

  const filings: FilingMeta[] = [];
  for (let i = 0; i < recent.form.length && filings.length < maxFilings; i++) {
    const form = recent.form[i];
    if (form !== "144" && form !== "144/A") continue;
    const accession = recent.accessionNumber[i];
    const filedAt = recent.filingDate[i];
    if (!accession || !filedAt) continue;
    const accessionNoSlash = formatAccession(accession);
    const primaryDoc = rawXmlPath(recent.primaryDocument?.[i] ?? "");
    filings.push({
      accession,
      companyCik: info.cikRaw,
      filedAt,
      url: `${CONFIG.EDGAR_URL}/Archives/edgar/data/${info.cikRaw}/${accessionNoSlash}/${primaryDoc}`,
    });
  }

  console.error(`[form144] Found ${filings.length} Form 144 filings`);

  const allFilings: Form144Filing[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const parsed = await parseForm144Xml(xmlText, filing);
      allFilings.push(...parsed);
      console.error(
        `[form144]   ${filing.accession}: ${parsed.length} lines`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form144]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[form144] TOTAL: ${allFilings.length} planned-sale lines for ${ticker}`,
  );
  return allFilings;
}

interface EdgarSearchHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    adsh?: string;
    file_date?: string;
    display_names?: string[];
  };
}

/**
 * Live-feed mode: scan EDGAR full-text search for recent Form 144 filings
 * across all companies. "What insiders just announced they're about to sell."
 */
export async function scrapeForm144LiveFeed(
  lookbackDays = 7,
  maxFilings = 100000,
): Promise<Form144Filing[]> {
  const end = new Date();

  // Enumerate via EDGAR's COMPLETE daily index, NOT full-text search. FTS
  // silently caps/under-reports — measured at only ~38% recent-window coverage
  // before this fix (same leak class fixed for N-PORT and Form D). The daily
  // index gives (cik, accession) but NOT the doc filename, and Form 144's
  // structured doc name varies, so resolve each via fetchPrimaryDocUrl
  // (index.json) rather than assuming primary_doc.xml.
  const seen = new Map<string, { accession: string; companyCik: string; filedAt: string }>();
  for (let dayOffset = 0; dayOffset <= lookbackDays; dayOffset++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - dayOffset);
    const dayISO = dt.toISOString().split("T")[0] ?? "";
    if (!dayISO) continue;
    let idx: Awaited<ReturnType<typeof fetchEdgarDailyIndex>>;
    try {
      idx = await fetchEdgarDailyIndex(dayISO, ["144", "144/A"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form144 live] daily-index ${dayISO}: SKIP — ${msg}`);
      continue;
    }
    for (const f of idx) {
      if (!f.formType.startsWith("144")) continue;
      if (seen.has(f.accession)) continue;
      if (seen.size >= maxFilings) break;
      seen.set(f.accession, {
        accession: f.accession,
        companyCik: f.cik.replace(/^0+/, ""),
        filedAt: f.dateFiled,
      });
    }
  }

  console.error(
    `[form144 live] ${seen.size} Form 144 filings in last ${lookbackDays}d (daily-index)`,
  );

  const allFilings: Form144Filing[] = [];
  for (const ref of seen.values()) {
    try {
      const url = await fetchPrimaryDocUrl(ref.companyCik, ref.accession);
      if (!url) {
        console.error(`[form144 live]   ${ref.accession}: SKIP — no primary XML`);
        continue;
      }
      const filing: FilingMeta = { ...ref, url };
      const xmlText = await fetchText(filing.url);
      const parsed = await parseForm144Xml(xmlText, filing);
      allFilings.push(...parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form144 live]   ${ref.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[form144 live] TOTAL: ${allFilings.length} planned-sale lines`,
  );
  return allFilings;
}
