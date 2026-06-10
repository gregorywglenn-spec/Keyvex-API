/**
 * Form 3 scraper — initial statement of beneficial ownership from SEC EDGAR.
 *
 * Form 3 is the FIRST filing an insider makes after becoming one — newly
 * appointed officer/director, newly identified 10%+ holder, or post-IPO
 * insider. It snapshots their starting position. Without it, every Form 4
 * delta floats without an anchor.
 *
 * Architecture mirrors src/scrapers/form4.ts:
 *   - Same EDGAR plumbing (submissions API + full-text search)
 *   - Same XML root (`ownershipDocument`) — Form 3 is in the same family
 *   - Same multi-owner handling (10%+ holder filings often have multiple
 *     reportingOwner elements)
 *   - Different child tables: nonDerivativeHolding / derivativeHolding
 *     (Form 4 uses ...Transaction, Form 3 uses ...Holding — no transaction
 *     fields, only the position snapshot)
 *
 * Form 3 XML schema (verified against AAPL filings):
 *
 *   <ownershipDocument>
 *     <issuer>
 *       <issuerCik>...</issuerCik>
 *       <issuerName>...</issuerName>
 *       <issuerTradingSymbol>AAPL</issuerTradingSymbol>
 *     </issuer>
 *     <reportingOwner>  (one or more — multi-owner case)
 *       <reportingOwnerId>
 *         <rptOwnerCik>...</rptOwnerCik>
 *         <rptOwnerName>...</rptOwnerName>
 *       </reportingOwnerId>
 *       <reportingOwnerRelationship>
 *         <isDirector>1|0</isDirector>
 *         <isOfficer>1|0</isOfficer>
 *         <isTenPercentOwner>1|0</isTenPercentOwner>
 *         <isOther>1|0</isOther>
 *         <officerTitle>Chief Executive Officer</officerTitle>
 *         <otherText>...</otherText>
 *       </reportingOwnerRelationship>
 *     </reportingOwner>
 *     <nonDerivativeTable>
 *       <nonDerivativeHolding>  (one or more)
 *         <securityTitle><value>Common Stock</value></securityTitle>
 *         <postTransactionAmounts>
 *           <sharesOwnedFollowingTransaction>
 *             <value>3340000</value>  (BASELINE — total shares of this class)
 *           </sharesOwnedFollowingTransaction>
 *         </postTransactionAmounts>
 *         <ownershipNature>
 *           <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
 *           <natureOfOwnership><value>By Trust</value></natureOfOwnership>
 *         </ownershipNature>
 *       </nonDerivativeHolding>
 *     </nonDerivativeTable>
 *     <derivativeTable>
 *       <derivativeHolding>
 *         <securityTitle><value>Stock Option (right to buy)</value></securityTitle>
 *         <conversionOrExercisePrice><value>132.50</value></conversionOrExercisePrice>
 *         <exerciseDate><value>2024-08-15</value></exerciseDate>
 *         <expirationDate><value>2031-08-15</value></expirationDate>
 *         <underlyingSecurity>
 *           <underlyingSecurityTitle><value>Common Stock</value></underlyingSecurityTitle>
 *           <underlyingSecurityShares><value>50000</value></underlyingSecurityShares>
 *         </underlyingSecurity>
 *         <postTransactionAmounts>
 *           <sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction>
 *         </postTransactionAmounts>
 *         <ownershipNature>
 *           <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
 *         </ownershipNature>
 *       </derivativeHolding>
 *     </derivativeTable>
 *   </ownershipDocument>
 *
 * Data source: SEC EDGAR (https://data.sec.gov, free, no API key).
 * Rate limit: 10 req/sec per IP. We use 150ms delays = ~6 req/sec.
 * Required header: User-Agent identifying the requester.
 */

import { XMLParser } from "fast-xml-parser";
import type { Form3Holding } from "../types.js";
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
 * HTML path as primaryDocument for Forms 3/4/5/144 — e.g. "xslF345X02/wk-
 * form3_1234567890.xml". That's the human-readable rendering through an XSL
 * stylesheet. The actual structured XML sits at the sibling path with no
 * xsl<schema>/ prefix. Without this strip, the parser fetches HTML, the XML
 * parse "succeeds" but produces zero ownershipDocument records.
 *
 * Same fix that lives in form144.ts. Form 4 doesn't currently use it
 * (works empirically on observed filings), but if Form 4 starts dropping
 * silent zeros that's the place to add it.
 */
function rawXmlPath(primaryDoc: string): string {
  return primaryDoc.replace(/^xsl[A-Z0-9]+\//, "");
}

/**
 * Form 3 XML uses <value> wrappers on fields that may carry footnote refs.
 * fast-xml-parser yields either a bare string/number or { value: ... }.
 * This walks either shape and returns a string. Same as Form 4.
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

function parseFloatOrNull(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/,/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a raw issuerTradingSymbol from Form 3 XML.
 *
 * Some filers prefix the exchange — Trinity Industries' Form 3 has
 * "NYSE/TRN" instead of "TRN" in issuerTradingSymbol. Strip everything
 * before the last slash so agents can query by symbol alone. Surfaced in
 * Day 4 testing.
 *
 * Doesn't touch other quirks: literal "NONE" (private companies / pre-IPO),
 * non-standard fund symbols ("AB-LEND"), CINS-style tickers. Those are
 * preserved — pure-publisher posture.
 */
function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!t) return "";
  const slashIdx = t.lastIndexOf("/");
  if (slashIdx >= 0) return t.slice(slashIdx + 1);
  return t;
}

/**
 * Sanitize a string for use in a Firestore doc ID.
 *
 * Firestore rejects '/' (path separator). Some Form 3 filings emit
 * exchange-prefixed tickers like "NYSE/TRN" or "NASDAQ/AAPL" in
 * issuerTradingSymbol. Replace any path-illegal char with '-'.
 *
 * Also collapses whitespace and uppercases for consistency.
 */
function sanitizeForDocId(s: string): string {
  return s
    .replace(/[/\\#?\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

// ─── Ticker → CIK lookup ────────────────────────────────────────────────────

interface TickerInfo {
  /** 10-digit zero-padded CIK */
  cik: string;
  /** un-padded CIK, used in EDGAR archive URL paths */
  cikRaw: string;
  /** Issuer name */
  name: string;
}

let tickerCache: Record<string, TickerInfo> | null = null;

export async function getTickerInfo(ticker: string): Promise<TickerInfo | null> {
  if (!tickerCache) {
    const data = (await fetchJson(
      `${CONFIG.EDGAR_URL}/files/company_tickers.json`,
    )) as Record<string, { ticker: string; cik_str: number; title: string }>;
    tickerCache = {};
    for (const entry of Object.values(data)) {
      tickerCache[entry.ticker.toUpperCase()] = {
        cik: String(entry.cik_str).padStart(10, "0"),
        cikRaw: String(entry.cik_str),
        name: entry.title,
      };
    }
  }
  return tickerCache[ticker.toUpperCase()] ?? null;
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
  // Keep numeric-looking strings (CIKs with leading zeros, etc.) as strings.
  // Same lesson as 13F's CUSIP issue — auto-coercion silently corrupts.
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * Parse a Form 3 XML document into structured holding records.
 * Emits one Form3Holding per security class in nonDerivativeTable + derivativeTable.
 */
export function parseForm3Xml(
  xmlText: string,
  meta: FilingMeta,
): Form3Holding[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = xml.parse(xmlText);
  const doc = parsed.ownershipDocument;
  if (!doc) return [];

  // Multi-owner handling — same as Form 4. Some Form 3 filings (especially
  // 10%+ holder reports for fund entities) have multiple reportingOwner
  // elements. fast-xml-parser yields an array in that case.
  const reportingOwnerRaw = doc.reportingOwner;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reportingOwners: any[] = Array.isArray(reportingOwnerRaw)
    ? reportingOwnerRaw
    : reportingOwnerRaw
      ? [reportingOwnerRaw]
      : [];

  const ownerNames = reportingOwners
    .map((o) => read(o?.reportingOwnerId?.rptOwnerName))
    .filter((n) => n);
  const filerName =
    ownerNames.length > 0 ? ownerNames.join(" / ") : "unknown";

  const ownerCiks = reportingOwners
    .map((o) => read(o?.reportingOwnerId?.rptOwnerCik))
    .filter((c) => c);
  const filerCik = ownerCiks.length > 0 ? ownerCiks.join(" / ") : "";

  // Relationship flags — OR across all owners (consistent with Form 4 fix).
  const isDirector = reportingOwners.some(
    (o) => read(o?.reportingOwnerRelationship?.isDirector) === "1",
  );
  const isOfficer = reportingOwners.some(
    (o) => read(o?.reportingOwnerRelationship?.isOfficer) === "1",
  );
  const isTenPercentOwner = reportingOwners.some(
    (o) => read(o?.reportingOwnerRelationship?.isTenPercentOwner) === "1",
  );
  const isOther = reportingOwners.some(
    (o) => read(o?.reportingOwnerRelationship?.isOther) === "1",
  );

  const titles = reportingOwners
    .map((o) => read(o?.reportingOwnerRelationship?.officerTitle))
    .filter((t) => t);
  const officerTitle =
    titles.length > 0 ? titles[0]! : isDirector ? "Director" : "";

  const otherTexts = reportingOwners
    .map((o) => read(o?.reportingOwnerRelationship?.otherText))
    .filter((t) => t);
  const otherText = otherTexts.join(" / ");

  // Issuer
  const issuer = doc.issuer;
  const ticker = normalizeTicker(read(issuer?.issuerTradingSymbol));
  const companyName = read(issuer?.issuerName) || null;
  const cik = read(issuer?.issuerCik) || meta.companyCik;

  const holdings: Form3Holding[] = [];

  // ─── Non-derivative holdings (common stock, RSUs, preferred) ──────────
  const nonDerivRaw = doc.nonDerivativeTable?.nonDerivativeHolding;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonDerivArray: any[] = Array.isArray(nonDerivRaw)
    ? nonDerivRaw
    : nonDerivRaw
      ? [nonDerivRaw]
      : [];

  let lineNo = 0;
  for (const h of nonDerivArray) {
    lineNo++;
    const securityTitle = read(h?.securityTitle) || "";
    const sharesOwnedRaw = read(
      h?.postTransactionAmounts?.sharesOwnedFollowingTransaction,
    );
    const sharesOwned = parseFloatOrNull(sharesOwnedRaw) ?? 0;
    const directOrIndirect = read(
      h?.ownershipNature?.directOrIndirectOwnership,
    );
    const natureOfIndirect = read(h?.ownershipNature?.natureOfOwnership);

    holdings.push({
      id: `${meta.accession}-${sanitizeForDocId(ticker || cik)}-ND-${lineNo}`,
      ticker,
      company_name: companyName,
      company_cik: cik,
      filer_name: filerName,
      filer_cik: filerCik,
      officer_title: officerTitle,
      is_director: isDirector,
      is_officer: isOfficer,
      is_ten_percent_owner: isTenPercentOwner,
      is_other: isOther,
      other_text: otherText,
      filing_date: meta.filedAt,
      security_title: securityTitle,
      is_derivative: false,
      shares_owned: sharesOwned,
      direct_or_indirect:
        directOrIndirect === "D" || directOrIndirect === "I"
          ? directOrIndirect
          : null,
      nature_of_indirect_ownership: natureOfIndirect,
      conversion_or_exercise_price: null,
      exercise_date: null,
      expiration_date: null,
      underlying_security_title: null,
      underlying_security_shares: null,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: "SEC_EDGAR_FORM3",
    });
  }

  // ─── Derivative holdings (options, warrants, convertibles) ───────────
  const derivRaw = doc.derivativeTable?.derivativeHolding;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const derivArray: any[] = Array.isArray(derivRaw)
    ? derivRaw
    : derivRaw
      ? [derivRaw]
      : [];

  let derivLineNo = 0;
  for (const h of derivArray) {
    derivLineNo++;
    const securityTitle = read(h?.securityTitle) || "";
    const sharesOwnedRaw = read(
      h?.postTransactionAmounts?.sharesOwnedFollowingTransaction,
    );
    const sharesOwned = parseFloatOrNull(sharesOwnedRaw) ?? 0;
    const directOrIndirect = read(
      h?.ownershipNature?.directOrIndirectOwnership,
    );
    const natureOfIndirect = read(h?.ownershipNature?.natureOfOwnership);
    const conversionPrice = parseFloatOrNull(
      read(h?.conversionOrExercisePrice),
    );
    const exerciseDate = read(h?.exerciseDate) || null;
    const expirationDate = read(h?.expirationDate) || null;
    const underlyingTitle =
      read(h?.underlyingSecurity?.underlyingSecurityTitle) || null;
    const underlyingShares = parseFloatOrNull(
      read(h?.underlyingSecurity?.underlyingSecurityShares),
    );

    holdings.push({
      id: `${meta.accession}-${sanitizeForDocId(ticker || cik)}-D-${derivLineNo}`,
      ticker,
      company_name: companyName,
      company_cik: cik,
      filer_name: filerName,
      filer_cik: filerCik,
      officer_title: officerTitle,
      is_director: isDirector,
      is_officer: isOfficer,
      is_ten_percent_owner: isTenPercentOwner,
      is_other: isOther,
      other_text: otherText,
      filing_date: meta.filedAt,
      security_title: securityTitle,
      is_derivative: true,
      shares_owned: sharesOwned,
      direct_or_indirect:
        directOrIndirect === "D" || directOrIndirect === "I"
          ? directOrIndirect
          : null,
      nature_of_indirect_ownership: natureOfIndirect,
      conversion_or_exercise_price: conversionPrice,
      exercise_date: exerciseDate,
      expiration_date: expirationDate,
      underlying_security_title: underlyingTitle,
      underlying_security_shares: underlyingShares,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: "SEC_EDGAR_FORM3",
    });
  }

  // ─── Nil filing (no securities owned) — Greg's 2026-06-10 capture call ──
  // Many Form 3s declare <noSecuritiesOwned>1</noSecuritiesOwned> with zero
  // holding tables (a person who became an insider owning nothing yet) —
  // ~half of all Form 3 filings in the 2026-06 reconcile's recent window.
  // Storing nothing made "did X file a Form 3?" read as no. Emit ONE marker
  // row so the filer-event is queryable; is_nil_filing distinguishes it
  // from real position rows (shares_owned 0 + empty security_title).
  if (holdings.length === 0) {
    holdings.push({
      id: `${meta.accession}-${sanitizeForDocId(ticker || cik)}-NIL`,
      ticker,
      company_name: companyName,
      company_cik: cik,
      filer_name: filerName,
      filer_cik: filerCik,
      officer_title: officerTitle,
      is_director: isDirector,
      is_officer: isOfficer,
      is_ten_percent_owner: isTenPercentOwner,
      is_other: isOther,
      other_text: otherText,
      filing_date: meta.filedAt,
      security_title: "",
      is_derivative: false,
      shares_owned: 0,
      direct_or_indirect: null,
      nature_of_indirect_ownership: "",
      conversion_or_exercise_price: null,
      exercise_date: null,
      expiration_date: null,
      underlying_security_title: null,
      underlying_security_shares: null,
      is_nil_filing: true,
      accession_number: meta.accession,
      sec_filing_url: meta.url,
      data_source: "SEC_EDGAR_FORM3",
    });
  }

  return holdings;
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
 * Fetch all Form 3 initial-ownership filings for a ticker. Pulls up to
 * `maxFilings` most-recent filings from EDGAR and parses each one.
 *
 * Note: Form 3 is rare per company — usually a few per year (new exec hires,
 * new 10%+ holders). Don't expect dozens.
 */
export async function scrapeForm3ByTicker(
  ticker: string,
  maxFilings = 20,
): Promise<Form3Holding[]> {
  const info = await getTickerInfo(ticker);
  if (!info) {
    throw new Error(`No CIK found for ticker: ${ticker}`);
  }
  console.error(`[form3] ${ticker} = ${info.name} (CIK ${info.cik})`);

  const subs = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${info.cik}.json`,
  )) as SubmissionsResponse;
  const recent = subs.filings?.recent;
  if (!recent) return [];

  const filings: FilingMeta[] = [];
  for (let i = 0; i < recent.form.length && filings.length < maxFilings; i++) {
    const form = recent.form[i];
    if (form !== "3" && form !== "3/A") continue;
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

  console.error(`[form3] Found ${filings.length} Form 3 filings`);

  const allHoldings: Form3Holding[] = [];
  for (const filing of filings) {
    try {
      const xmlText = await fetchText(filing.url);
      const holdings = parseForm3Xml(xmlText, filing);
      allHoldings.push(...holdings);
      console.error(
        `[form3]   ${filing.accession}: ${holdings.length} holdings`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form3]   ${filing.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[form3] TOTAL: ${allHoldings.length} initial-ownership rows for ${ticker}`,
  );
  return allHoldings;
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
 * Live-feed mode: scan EDGAR full-text search for recent Form 3 filings
 * across all companies. "Who just became an insider this week."
 */
export async function scrapeForm3LiveFeed(
  lookbackDays = 7,
  maxFilings = 100000,
): Promise<Form3Holding[]> {
  const end = new Date();

  // Enumerate via EDGAR's COMPLETE daily index, NOT full-text search. FTS
  // silently caps/under-reports — measured at only ~35% recent-window coverage
  // before this fix (same leak class fixed for N-PORT and Form D). The daily
  // index gives (cik, accession) but NOT the doc filename, and Form 3's
  // structured doc is `ownership.xml` (not primary_doc.xml), so resolve each via
  // fetchPrimaryDocUrl (index.json). The issuer CIK comes from the XML itself
  // (parseForm3Xml reads issuerCik), so the index CIK is only the archive path.
  const seen = new Map<string, { accession: string; companyCik: string; filedAt: string }>();
  for (let dayOffset = 0; dayOffset <= lookbackDays; dayOffset++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - dayOffset);
    const dayISO = dt.toISOString().split("T")[0] ?? "";
    if (!dayISO) continue;
    let idx: Awaited<ReturnType<typeof fetchEdgarDailyIndex>>;
    try {
      idx = await fetchEdgarDailyIndex(dayISO, ["3", "3/A"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form3 live] daily-index ${dayISO}: SKIP — ${msg}`);
      continue;
    }
    for (const f of idx) {
      if (f.formType !== "3" && f.formType !== "3/A") continue;
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
    `[form3 live] ${seen.size} Form 3 filings in last ${lookbackDays}d (daily-index)`,
  );

  const allHoldings: Form3Holding[] = [];
  for (const ref of seen.values()) {
    try {
      const url = await fetchPrimaryDocUrl(ref.companyCik, ref.accession);
      if (!url) {
        console.error(`[form3 live]   ${ref.accession}: SKIP — no primary XML`);
        continue;
      }
      const filing: FilingMeta = { ...ref, url };
      const xmlText = await fetchText(filing.url);
      const holdings = parseForm3Xml(xmlText, filing);
      allHoldings.push(...holdings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form3 live]   ${ref.accession}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[form3 live] TOTAL: ${allHoldings.length} initial-ownership rows`,
  );
  return allHoldings;
}
