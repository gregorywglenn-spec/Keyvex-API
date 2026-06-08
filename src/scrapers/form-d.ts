/**
 * SEC Form D scraper — exempt private placement / Reg D offering notices.
 *
 * Form D is filed within 15 days of the first sale in a private offering
 * under Rules 504 / 506(b) / 506(c) of Regulation D, or under Section 4(a).
 * Captures who's raising private capital, when, in which industry, under
 * which exemption, how much, and from how many investors. VC fund
 * formations, private equity raises, real-estate syndicates, hedge fund
 * launches — all surface here.
 *
 * Architecture: same SEC-XML template as Form 144 / Form 3 / 13D-G.
 *   1. EDGAR full-text-search for forms=D (or forms=D/A) over a date window
 *   2. Per filing: fetch primary_doc.xml from the EDGAR Archives path
 *   3. Parse structured XML with fast-xml-parser (parseTagValue:false to
 *      protect numeric-looking strings — e.g., zip codes with leading zeros)
 *   4. Normalize to PrivatePlacement records, idempotent by accession_number
 *
 * Pure-publisher posture: surface fields as filed; agents do derivation.
 */

import { XMLParser } from "fast-xml-parser";
import type {
  PrivatePlacement,
  PrivatePlacementRelatedPerson,
} from "../types.js";
import { fetchEdgarDailyIndex } from "../reconcile/sec-edgar-index.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 150,
  FTS_HITS_PER_PAGE: 100,
  FORM_CODES: ["D", "D/A"],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const formatAccession = (a: string): string => a.replace(/-/g, "");

/** Strip XSL prefix from primaryDocument. Same gotcha as Form 144 / 3 / 13D-G. */
function rawXmlPath(primaryDoc: string): string {
  return primaryDoc.replace(/^xsl[A-Z0-9]+\//, "");
}

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // critical: preserves ZIPs with leading 0s + numeric-looking strings
  trimValues: true,
});

// ─── EDGAR FTS hit shape ───────────────────────────────────────────────────

interface EdgarHitSource {
  ciks?: string[];
  display_names?: string[];
  form?: string;
  file_type?: string;
  file_date?: string;
  adsh?: string;
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

// ─── Helpers for the rich Form D XML ───────────────────────────────────────

/** Coerce a possibly-undefined / unknown value to string; trim. */
function s(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  return String(v).trim();
}

/** Coerce to number; return 0 on failure. Many Form D money fields ship as
 *  comma-formatted strings; strip commas before parseFloat. */
function n(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  const raw = typeof v === "string" ? v.replace(/,/g, "") : String(v);
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Coerce to boolean; XML serializes booleans as "true"/"false" strings. */
function b(v: unknown): boolean {
  return s(v).toLowerCase() === "true";
}

/** A "list" element in Form D XML may be a single object, an array, or absent.
 *  Normalize to array. */
function toArray<T>(v: unknown): T[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v as T[];
  return [v as T];
}

interface RawIssuerAddress {
  street1?: string;
  street2?: string;
  city?: string;
  stateOrCountry?: string;
  zipCode?: string;
}

interface RawRelatedPerson {
  relatedPersonName?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
  };
  relatedPersonAddress?: {
    city?: string;
    stateOrCountry?: string;
  };
  relatedPersonRelationshipList?: {
    relationship?: string | string[];
  };
  relationshipClarification?: string;
}

interface RawFormDXml {
  edgarSubmission?: {
    submissionType?: string;
    primaryIssuer?: {
      cik?: string;
      entityName?: string;
      issuerAddress?: RawIssuerAddress;
      issuerPhoneNumber?: string;
      jurisdictionOfInc?: string;
      entityType?: string;
      yearOfInc?: {
        withinFiveYears?: string;
        value?: string;
      };
    };
    relatedPersonsList?: {
      relatedPersonInfo?: RawRelatedPerson | RawRelatedPerson[];
    };
    offeringData?: {
      industryGroup?: {
        industryGroupType?: string;
        investmentFundInfo?: {
          investmentFundType?: string;
          is40Act?: string;
        };
      };
      issuerSize?: {
        revenueRange?: string;
      };
      federalExemptionsExclusions?: {
        item?: string | string[];
      };
      typeOfFiling?: {
        newOrAmendment?: { isAmendment?: string };
        dateOfFirstSale?: { value?: string };
      };
      durationOfOffering?: {
        moreThanOneYear?: string;
      };
      offeringSalesAmounts?: {
        totalOfferingAmount?: string;
        totalAmountSold?: string;
        totalRemaining?: string;
      };
      minimumInvestmentAccepted?: string;
      salesCommissionsFinderFees?: {
        salesCommissionsAmount?: string;
        salesCommissionsEstimateIsX?: string;
        findersFeeAmount?: string;
        findersFeeEstimateIsX?: string;
      };
      investors?: {
        hasNonAccreditedInvestors?: string;
        totalNumberAlreadyInvested?: string;
      };
    };
  };
}

// ─── Parse + normalize ────────────────────────────────────────────────────

function parseRelatedPerson(
  raw: RawRelatedPerson,
): PrivatePlacementRelatedPerson {
  const relationships = toArray<string>(
    raw.relatedPersonRelationshipList?.relationship,
  );
  return {
    first_name: s(raw.relatedPersonName?.firstName),
    middle_name: s(raw.relatedPersonName?.middleName),
    last_name: s(raw.relatedPersonName?.lastName),
    city: s(raw.relatedPersonAddress?.city),
    state: s(raw.relatedPersonAddress?.stateOrCountry),
    relationships: relationships.map(s),
    clarification: s(raw.relationshipClarification),
  };
}

function parseFormDXml(
  xmlText: string,
  meta: {
    accession: string;
    fileDate: string;
    fileType: string;
    primaryDocUrl: string;
    filingUrl: string;
  },
  scrapedAt: string,
): PrivatePlacement | null {
  let parsed: RawFormDXml;
  try {
    parsed = xmlParser.parse(xmlText) as RawFormDXml;
  } catch {
    return null;
  }
  const sub = parsed.edgarSubmission;
  if (!sub) return null;

  const issuer = sub.primaryIssuer;
  const addr = issuer?.issuerAddress;
  const offering = sub.offeringData;
  const filingType = s(sub.submissionType ?? meta.fileType);
  const isAmendment = filingType.endsWith("/A");

  const relatedPersonsRaw = toArray<RawRelatedPerson>(
    sub.relatedPersonsList?.relatedPersonInfo,
  );
  const relatedPersons = relatedPersonsRaw.map(parseRelatedPerson);

  const exemptions = toArray<string>(
    offering?.federalExemptionsExclusions?.item,
  ).map(s);

  return {
    filing_id: meta.accession,
    filing_type: filingType,
    is_amendment: isAmendment,
    file_date: meta.fileDate,
    issuer_cik: s(issuer?.cik).padStart(10, "0"),
    issuer_name: s(issuer?.entityName),
    issuer_street: [s(addr?.street1), s(addr?.street2)]
      .filter(Boolean)
      .join(", "),
    issuer_city: s(addr?.city),
    issuer_state: s(addr?.stateOrCountry),
    issuer_zip: s(addr?.zipCode),
    issuer_phone: s(issuer?.issuerPhoneNumber),
    jurisdiction_of_inc: s(issuer?.jurisdictionOfInc),
    entity_type: s(issuer?.entityType),
    year_of_inc: s(issuer?.yearOfInc?.value),
    year_of_inc_within_five_years: b(issuer?.yearOfInc?.withinFiveYears),
    industry_group_type: s(offering?.industryGroup?.industryGroupType),
    investment_fund_type: s(
      offering?.industryGroup?.investmentFundInfo?.investmentFundType,
    ),
    is_40_act: b(offering?.industryGroup?.investmentFundInfo?.is40Act),
    revenue_range: s(offering?.issuerSize?.revenueRange),
    federal_exemptions: exemptions,
    date_of_first_sale: s(offering?.typeOfFiling?.dateOfFirstSale?.value),
    duration_more_than_one_year: b(offering?.durationOfOffering?.moreThanOneYear),
    total_offering_amount: s(
      offering?.offeringSalesAmounts?.totalOfferingAmount,
    ),
    total_amount_sold: n(offering?.offeringSalesAmounts?.totalAmountSold),
    total_remaining: s(offering?.offeringSalesAmounts?.totalRemaining),
    min_investment_accepted: n(offering?.minimumInvestmentAccepted),
    total_number_already_invested: n(
      offering?.investors?.totalNumberAlreadyInvested,
    ),
    sales_commissions: n(
      offering?.salesCommissionsFinderFees?.salesCommissionsAmount,
    ),
    finder_fees: n(offering?.salesCommissionsFinderFees?.findersFeeAmount),
    related_persons: relatedPersons,
    primary_document_url: meta.primaryDocUrl,
    filing_url: meta.filingUrl,
    scraped_at: scrapedAt,
  };
}

// ─── Public scraper ────────────────────────────────────────────────────────

export interface ScrapeFormDOptions {
  /** Look back N days from today (default 2 — daily-cadence safe overlap). */
  lookbackDays?: number;
  /** Hard cap on filings per form code (D vs D/A). Default 1000. */
  maxFilingsPerForm?: number;
}

/**
 * Live-feed scraper for Form D filings. Iterates D + D/A across the
 * lookback window, fetches each per-filing primary_doc.xml, parses to
 * PrivatePlacement, and returns the deduped array.
 */
export async function scrapeFormDLiveFeed(
  options: ScrapeFormDOptions = {},
): Promise<PrivatePlacement[]> {
  const scrapedAt = new Date().toISOString();
  const lookbackDays = options.lookbackDays ?? 2;
  const maxFilingsPerForm = options.maxFilingsPerForm ?? 1000;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  const startStr = (start.toISOString().split("T")[0] ?? "");
  const endStr = (end.toISOString().split("T")[0] ?? "");

  console.error(
    `[form-d] Window ${startStr} → ${endStr}, forms: ${CONFIG.FORM_CODES.join(", ")}`,
  );

  // Collect filing metadata from FTS first, then dedup by accession.
  interface FilingMeta {
    accession: string;
    archiveCik: string;
    filedAt: string;
    fileType: string;
    primaryDocFilename: string;
  }
  const byAccession = new Map<string, FilingMeta>();

  // Enumerate via EDGAR's COMPLETE daily-index (one file per day), NOT FTS.
  // FTS silently omits ~30% of Form D filings (verified 2026-06-08 against the
  // EDGAR full-index reconciler), which is why the old cron under-captured the
  // current quarter. The daily-index lists every filing for a day; Form D's
  // structured doc is always primary_doc.xml. maxFilingsPerForm is repurposed
  // as a total safety cap (default unlimited).
  const totalCap = options.maxFilingsPerForm ?? Infinity;
  for (let dayOffset = 0; dayOffset <= lookbackDays; dayOffset++) {
    const dt = new Date(end);
    dt.setUTCDate(dt.getUTCDate() - dayOffset);
    const dayISO = dt.toISOString().split("T")[0] ?? "";
    const filings = await fetchEdgarDailyIndex(dayISO, CONFIG.FORM_CODES);
    let added = 0;
    for (const f of filings) {
      if (byAccession.has(f.accession)) continue;
      if (byAccession.size >= totalCap) break;
      byAccession.set(f.accession, {
        accession: f.accession,
        archiveCik: f.cik.replace(/^0+/, ""),
        filedAt: f.dateFiled,
        fileType: f.formType,
        primaryDocFilename: "primary_doc.xml",
      });
      added++;
    }
    if (filings.length > 0) {
      console.error(
        `[form-d]   ${dayISO}: ${filings.length} in daily-index, +${added} new (running ${byAccession.size})`,
      );
    }
    await sleep(CONFIG.RATE_LIMIT_MS);
  }

  console.error(
    `[form-d] Found ${byAccession.size} unique Form D filings. Fetching XML detail...`,
  );

  // Fetch + parse each. Rate-limited via the fetchText sleep.
  const out: PrivatePlacement[] = [];
  let parsed = 0;
  let skipped = 0;
  for (const meta of byAccession.values()) {
    const accNoDash = formatAccession(meta.accession);
    const primaryDocUrl =
      `${CONFIG.EDGAR_URL}/Archives/edgar/data/${meta.archiveCik}/` +
      `${accNoDash}/${meta.primaryDocFilename}`;
    const filingUrl =
      `${CONFIG.EDGAR_URL}/Archives/edgar/data/${meta.archiveCik}/` +
      `${accNoDash}/${meta.accession}-index.htm`;
    let xml: string;
    try {
      xml = await fetchText(primaryDocUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[form-d]   SKIP ${meta.accession}: ${msg}`);
      skipped++;
      continue;
    }
    const record = parseFormDXml(
      xml,
      {
        accession: meta.accession,
        fileDate: meta.filedAt,
        fileType: meta.fileType,
        primaryDocUrl,
        filingUrl,
      },
      scrapedAt,
    );
    if (record) {
      out.push(record);
      parsed++;
    } else {
      console.error(`[form-d]   SKIP ${meta.accession}: parse returned null`);
      skipped++;
    }
  }

  console.error(
    `[form-d] TOTAL: ${parsed} parsed, ${skipped} skipped over ${byAccession.size} filings`,
  );
  return out;
}
