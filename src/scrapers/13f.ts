/**
 * 13F scraper — institutional holdings from SEC EDGAR.
 *
 * Ported from C:\CapitalEdge-API\reference\institutional_scraper.js (browser
 * version) to Node + TypeScript with v1-quality additions:
 *
 *   - DOMParser/querySelector → fast-xml-parser (Node-friendly)
 *   - CUSIP→ticker enrichment via OpenFIGI (was empty in standalone)
 *   - position_change / shares_change / shares_change_pct computed against
 *     the same fund's prior quarter from Firestore (was declared but unset
 *     in standalone)
 *   - "closed" position detection — synthetic 0-share records for positions
 *     a fund previously held but doesn't appear in the current 13F
 *   - signal_weight removed from output (publisher-only posture)
 *   - Top-N filter applied AFTER enrichment so the records we keep are the
 *     ones that matter and the ones with full ticker context
 *
 * Data source: SEC EDGAR (https://data.sec.gov, free, no API key required).
 * Rate limit: 10 req/sec per IP — we use 200ms delays = 5 req/sec.
 *
 * 13F filing schedule (45-day reporting lag after quarter end):
 *   Q4 (Oct-Dec): filed by Feb 14
 *   Q1 (Jan-Mar): filed by May 15
 *   Q2 (Apr-Jun): filed by Aug 14
 *   Q3 (Jul-Sep): filed by Nov 14
 */

import { XMLParser } from "fast-xml-parser";
import { lookupCusips, searchOpenFigiByName } from "../openfigi.js";
import { lookupTickerByName, namesMatch } from "../sec-tickers.js";
import type { InstitutionalHolding } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://data.sec.gov",
  EDGAR_URL: "https://www.sec.gov",
  SEARCH_URL: "https://efts.sec.gov/LATEST/search-index",
  RATE_LIMIT_MS: 200,
  /** How many top positions per fund to retain in Firestore */
  TOP_N_PER_FUND: 50,
};

/**
 * Curated list of well-known institutional managers. Used by the live-feed
 * mode and as friendly aliases for the per-fund mode.
 *
 * CIKs are Central Index Keys assigned by the SEC. Padded to 10 digits for
 * EDGAR submissions API URLs.
 */
const TRACKED_FUNDS: Array<{ name: string; alias: string; cik: string }> = [
  { name: "Berkshire Hathaway", alias: "berkshire", cik: "0001067983" },
  { name: "BlackRock", alias: "blackrock", cik: "0001364742" },
  { name: "Vanguard Group", alias: "vanguard", cik: "0000102909" },
  { name: "Bridgewater Associates", alias: "bridgewater", cik: "0001350694" },
  // Fixed 2026-05-23: the 4 CIKs below were wrong in the original
  // alias map — they pointed to completely unrelated entities
  // (Citadel=AGNC Investment Corp; TwoSigma=an individual named
  // Wong Pak Fai Phillip; Millennium=MoneyGram International;
  // DEShaw=Bank Bradesco). Each 13F backfill silently FATAL'd with
  // "No 13F-HR filings". Verified via EDGAR FTS for each firm name
  // with forms=13F-HR; correct CIKs are the management entities
  // that actually file 13F-HRs.
  { name: "Citadel Advisors LLC", alias: "citadel", cik: "0001423053" },
  { name: "Point72 Asset Management", alias: "point72", cik: "0001603466" },
  { name: "D. E. Shaw & Co., Inc.", alias: "deshaw", cik: "0001009207" },
  { name: "Renaissance Technologies", alias: "renaissance", cik: "0001037389" },
  { name: "Two Sigma Investments, LP", alias: "twosigma", cik: "0001179392" },
  { name: "Millennium Management LLC", alias: "millennium", cik: "0001273087" },
];

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

/** Read either a bare text node or a wrapped { '#text': '...' } object */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function read(node: any): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    if (node["#text"] !== undefined) return read(node["#text"]);
    if (node.value !== undefined) return read(node.value);
  }
  return "";
}

/**
 * Given a quarter-end date string ("YYYY-MM-DD"), return the prior quarter's
 * end date. Returns empty string for non-standard dates.
 */
export function priorQuarterEndDate(quarter: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(quarter);
  if (!m) return "";
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  if (month === 3) return `${year - 1}-12-31`;
  if (month === 6) return `${year}-03-31`;
  if (month === 9) return `${year}-06-30`;
  if (month === 12) return `${year}-09-30`;
  return "";
}

// ─── Fund lookup (alias or CIK) ─────────────────────────────────────────────

interface FundRef {
  cik: string;
  cikRaw: string;
  name: string;
}

export function resolveFund(input: string): FundRef | null {
  const trimmed = input.trim();
  // Try alias match first
  const byAlias = TRACKED_FUNDS.find(
    (f) => f.alias.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byAlias) {
    return {
      cik: byAlias.cik,
      cikRaw: byAlias.cik.replace(/^0+/, ""),
      name: byAlias.name,
    };
  }
  // Try numeric CIK (with or without leading zeros)
  const cikMatch = /^\d+$/.exec(trimmed);
  if (cikMatch) {
    return {
      cik: trimmed.padStart(10, "0"),
      cikRaw: trimmed.replace(/^0+/, ""),
      name: trimmed,
    };
  }
  return null;
}

export function listTrackedFunds(): Array<{ alias: string; name: string }> {
  return TRACKED_FUNDS.map((f) => ({ alias: f.alias, name: f.name }));
}

// ─── XML parsing ────────────────────────────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true, // strips ns1:, ns:, etc. — 13F filings vary
  // CRITICAL: keep all text values as strings. CUSIPs like "92343E106" look
  // like scientific notation to a number parser and get mangled. Same for
  // CUSIPs with leading zeros ("037833100" → "37833100"). String form only.
  parseTagValue: false,
  parseAttributeValue: false,
});

interface FilingMeta {
  fundName: string;
  fundCik: string;
  accession: string;
  filingDate: string;
  /** Period ending date in YYYY-MM-DD form */
  period: string;
  url: string;
  /**
   * Phase A (2026-05-24): canonical verification landmark from primary_doc.xml.
   *
   * SEC requires every 13F filing to declare the total holding count in the
   * SUMMARY PAGE of primary_doc.xml via the <infoTableEntryTotal> element.
   * This is the AUTHORITATIVE row count for the filing — what the filer
   * told the SEC the table contains. Compare against our successfully-
   * parsed row count to detect:
   *   - parser bugs that drop rows silently
   *   - truncated downloads
   *   - schema variants we don't yet handle
   *
   * `null` ONLY when primary_doc.xml couldn't be fetched or didn't carry
   * the field (rare but possible on legacy / malformed filings). The
   * "no count" case defaults to verification_status=INSUFFICIENT_DATA per
   * The Tourniquet doctrine — never assume VERIFIED in the absence of a
   * canonical landmark.
   */
  infoTableEntryTotal: number | null;
}

/**
 * Parse a 13F informationTable XML document into typed holding records.
 * Excludes options (putCall = Put or Call) — equity positions only.
 *
 * Returns records with `ticker: ""` — ticker enrichment happens in a separate
 * step after this returns.
 */
export function parse13FXml(
  xmlText: string,
  meta: FilingMeta,
): InstitutionalHolding[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = xml.parse(xmlText);

  // Different filers wrap the root element differently
  const root =
    parsed.informationTable ?? parsed["informationTable"] ?? parsed;
  const entriesRaw = root?.infoTable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = Array.isArray(entriesRaw)
    ? entriesRaw
    : entriesRaw
      ? [entriesRaw]
      : [];

  // Aggregate sub-account records into one record per (fund, CUSIP). Large
  // 13F filers (Berkshire, BlackRock, Vanguard) report the same security
  // across multiple internal sub-accounts ("managers") — each as its own
  // <infoTable> entry. Customers want the consolidated fund position, not
  // each manager's slice. Sum shares and value, take first non-null discretion.
  const byCusip = new Map<string, InstitutionalHolding>();

  for (const entry of entries) {
    const nameOfIssuer = read(entry.nameOfIssuer);
    const cusip = read(entry.cusip);
    // 13F XML <value> field: SEC instructions historically said "report in
    // thousands (omit last three digits)," but modern filers (2023+) reliably
    // report the FULL dollar amount. Treating as dollars matches actual
    // filings; older "thousands" filings will report values that look small
    // but the convention has shifted. The aggregator-of-record (OpenFIGI,
    // Whalewisdom, etc.) all treat value as dollars now.
    const valueDollars = parseInt(read(entry.value), 10) || 0;
    const shares = parseInt(read(entry.shrsOrPrnAmt?.sshPrnamt), 10) || 0;
    const shareType = read(entry.shrsOrPrnAmt?.sshPrnamtType);
    const discretion = read(entry.investmentDiscretion);
    const putCall = read(entry.putCall);

    if (putCall === "Put" || putCall === "Call") continue;
    if (!nameOfIssuer || !cusip || valueDollars === 0) continue;

    const existing = byCusip.get(cusip);
    if (existing) {
      existing.shares_held += shares;
      existing.market_value += valueDollars;
      existing.market_value_thousands = Math.round(existing.market_value / 1000);
      // Keep first non-null discretion seen
      if (!existing.investment_discretion && discretion) {
        existing.investment_discretion = discretion;
      }
    } else {
      byCusip.set(cusip, {
        id: `13f-${meta.fundCik}-${cusip}-${meta.period}`,
        fund_name: meta.fundName,
        fund_cik: meta.fundCik,
        issuer_name: nameOfIssuer,
        cusip,
        ticker: "", // enriched separately
        share_type: shareType || "SH",
        investment_discretion: discretion || null,
        shares_held: shares,
        market_value: valueDollars,
        market_value_thousands: Math.round(valueDollars / 1000),
        quarter: meta.period,
        filing_date: meta.filingDate,
        position_change: null, // computed later
        shares_change: null,
        shares_change_pct: null,
        accession_number: meta.accession,
        filing_url: meta.url,
        data_source: "SEC_EDGAR_13F",
      });
    }
  }

  return Array.from(byCusip.values());
}

// ─── Fetcher ────────────────────────────────────────────────────────────────

interface SubmissionsRecent {
  form: string[];
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  primaryDocument: string[];
}

interface SubmissionsResponse {
  name?: string;
  filings?: { recent?: SubmissionsRecent };
}

interface IndexResponse {
  directory?: { item?: Array<{ name: string }> };
}

/**
 * Fetch the most recent 13F-HR for a fund and return its filing meta and the
 * raw holdings XML. Throws on missing filings or unparseable index.
 */
async function fetchLatest13F(fund: FundRef): Promise<{
  meta: FilingMeta;
  xml: string;
}> {
  const subs = (await fetchJson(
    `${CONFIG.BASE_URL}/submissions/CIK${fund.cik}.json`,
  )) as SubmissionsResponse;

  const recent = subs.filings?.recent;
  if (!recent) throw new Error(`No filings for CIK ${fund.cik}`);

  let latestIdx = -1;
  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i];
    if (form === "13F-HR" || form === "13F-HR/A") {
      latestIdx = i;
      break; // submissions are ordered most-recent-first
    }
  }
  if (latestIdx === -1) {
    throw new Error(`No 13F-HR filings for ${fund.name} (CIK ${fund.cik})`);
  }

  const accession = recent.accessionNumber[latestIdx]!;
  const filingDate = recent.filingDate[latestIdx]!;
  const period = recent.reportDate[latestIdx]!;
  const accessionNoSlash = formatAccession(accession);

  const indexUrl = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${fund.cikRaw}/${accessionNoSlash}/index.json`;
  const index = (await fetchJson(indexUrl)) as IndexResponse;

  const items = index.directory?.item ?? [];
  // Find the holdings XML. Strategy: prefer explicit "infotable" match
  // (cleanest signal — common naming convention), fall back to any
  // .xml that isn't the primary_doc.xml header. The earlier exclusion
  // of names containing "filing" was a false-positive trap — Millennium
  // Management's holdings file is literally named "MLP_FIling_20260331.xml"
  // (their typo on "Filing"), which legitimately contains the holdings
  // table. Caught 2026-05-23. Trust .xml + exclude only primary_doc.
  const xmlFiles = items.filter((f) => f.name.endsWith(".xml"));
  const holdingsFile =
    xmlFiles.find((f) => f.name.toLowerCase().includes("infotable")) ??
    xmlFiles.find((f) => !f.name.toLowerCase().includes("primary_doc"));
  if (!holdingsFile) {
    throw new Error(`No holdings XML found in ${accession}`);
  }

  const holdingsUrl = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${fund.cikRaw}/${accessionNoSlash}/${holdingsFile.name}`;
  const xmlText = await fetchText(holdingsUrl);

  // Phase A: fetch primary_doc.xml in parallel for the canonical count.
  // Per SEC 13F instructions, primary_doc.xml carries the SUMMARY PAGE
  // including <infoTableEntryTotal>, which is the FILER's own declared
  // row count. We use it as the integrity landmark per The Tourniquet
  // doctrine: prove the parsed-row count matches the declared count, or
  // mark the filing INSUFFICIENT_DATA rather than silently trust ourselves.
  const primaryDocFile = xmlFiles.find((f) =>
    f.name.toLowerCase().includes("primary_doc"),
  );
  let infoTableEntryTotal: number | null = null;
  if (primaryDocFile) {
    try {
      const primaryDocUrl = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${fund.cikRaw}/${accessionNoSlash}/${primaryDocFile.name}`;
      const primaryDocXml = await fetchText(primaryDocUrl);
      infoTableEntryTotal = parseInfoTableEntryTotal(primaryDocXml);
    } catch (e) {
      // Couldn't fetch / parse primary_doc.xml — null count means
      // downstream consumers (saveFlow stamps verification_status) will
      // default to INSUFFICIENT_DATA. Honest failure mode.
      console.error(
        `[13f] primary_doc.xml fetch/parse failed for ${accession}: ${(e as Error).message}`,
      );
    }
  } else {
    console.error(
      `[13f] No primary_doc.xml found in ${accession} — verification_status will default to INSUFFICIENT_DATA`,
    );
  }

  return {
    meta: {
      fundName: subs.name ?? fund.name,
      fundCik: fund.cik,
      accession,
      filingDate,
      period,
      url: holdingsUrl,
      infoTableEntryTotal,
    },
    xml: xmlText,
  };
}

/**
 * Extract `<tableEntryTotal>N</tableEntryTotal>` from a 13F primary_doc.xml.
 * Returns null on parse failure / missing element so the caller can stamp
 * INSUFFICIENT_DATA per the no-count rule.
 *
 * VERIFIED 2026-05-24 against a live primary_doc.xml fetch (Atlas Brown
 * accession 0001388168-26-000002):
 *
 *     <summaryPage>
 *       <otherIncludedManagersCount>0</otherIncludedManagersCount>
 *       <tableEntryTotal>339</tableEntryTotal>
 *       <tableValueTotal>332174291</tableValueTotal>
 *       ...
 *
 * The SEC schema element is `tableEntryTotal` (in the summaryPage section).
 * Phase A's original spec referenced `infoTableEntryTotal` as the concept —
 * the actual schema element is `tableEntryTotal`. Verified live; both names
 * accepted to be defensive against schema-name drift, but `tableEntryTotal`
 * is what real 13F filings emit.
 *
 * SEC schema reference:
 *   https://www.sec.gov/info/edgar/specifications/form13fxml-tdoc
 *
 * Regex-based for robustness against optional namespace prefixes. Accepts
 * both spellings to be defensive.
 */
function parseInfoTableEntryTotal(primaryDocXml: string): number | null {
  // Match `<tableEntryTotal>` (canonical) OR `<infoTableEntryTotal>` (alias),
  // with or without namespace prefix
  const m = primaryDocXml.match(
    /<\s*(?:[a-zA-Z0-9_]+:)?(?:info)?tableEntryTotal\s*>\s*(\d+)\s*</i,
  );
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ─── Position change calculation ────────────────────────────────────────────

type FirestoreInstance = import("firebase-admin/firestore").Firestore;

/**
 * Compute position_change, shares_change, and shares_change_pct on each
 * current-quarter holding by comparing to the same fund's prior-quarter
 * holdings in Firestore.
 *
 * Also returns synthetic "closed" records for positions that existed in the
 * prior quarter but don't appear in the current quarter — those are real
 * sell-everything events and customers want to see them.
 *
 * If `db` is not provided (offline / dry-run mode), all position_change
 * values are left null and no closed-position synthesis happens.
 */
export async function applyPositionChanges(
  current: InstitutionalHolding[],
  db: FirestoreInstance | null,
): Promise<InstitutionalHolding[]> {
  if (current.length === 0) return current;
  if (!db) return current;

  const fund_cik = current[0]!.fund_cik;
  const current_quarter = current[0]!.quarter;
  const prior_quarter = priorQuarterEndDate(current_quarter);

  // ─── Phase A: read the current quarter's verification_status from the
  // first holding in the batch. All holdings in a single saveFlow share the
  // same status (it's a per-filing check). The §1 count comparison was
  // computed ONCE in saveFlow and stamped on every row — we reuse that
  // result here for the §2 phantom-closed guard (don't recompute).
  const currentIsVerified =
    current[0]!.verification_status === "VERIFIED";

  if (!prior_quarter) {
    // Can't compute a prior_quarter date — emit INSUFFICIENT_DATA on every
    // current holding rather than silently leaving position_change null
    // (which previously meant "we didn't try"). Explicit honesty.
    for (const holding of current) {
      holding.position_change = "INSUFFICIENT_DATA";
      holding.shares_change = null;
      holding.shares_change_pct = null;
    }
    return current;
  }

  // Pull prior quarter's holdings for this fund
  const snap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", fund_cik)
    .where("quarter", "==", prior_quarter)
    .get();

  const priorByCusip = new Map<string, InstitutionalHolding>();
  for (const doc of snap.docs) {
    const data = doc.data() as InstitutionalHolding;
    if (data.cusip) priorByCusip.set(data.cusip, data);
  }

  // ─── Phase A FALSE-"new" GUARD ────────────────────────────────────────────
  // If the prior-quarter lookup returned ZERO holdings for this fund, we
  // can't tell whether (a) the fund genuinely had no prior positions or
  // (b) we just don't have the prior data ingested. Confidently labeling
  // every current holding "new" in case (b) creates a phantom-acquisition
  // narrative ("Citadel just opened 500 new positions this quarter!" when
  // reality is "Citadel's prior quarter isn't in our database").
  //
  // The honest answer is INSUFFICIENT_DATA: we don't know.
  const priorIsMissingEntirely = priorByCusip.size === 0;

  // Annotate current holdings
  for (const holding of current) {
    if (priorIsMissingEntirely) {
      // Prior baseline missing — can't compute deltas honestly
      holding.position_change = "INSUFFICIENT_DATA";
      holding.shares_change = null;
      holding.shares_change_pct = null;
      continue;
    }
    const prior = priorByCusip.get(holding.cusip);
    if (!prior || prior.shares_held === 0) {
      holding.position_change = "new";
      holding.shares_change = holding.shares_held;
      holding.shares_change_pct = null;
    } else {
      const change = holding.shares_held - prior.shares_held;
      holding.shares_change = change;
      holding.shares_change_pct =
        prior.shares_held > 0
          ? Math.round((change / prior.shares_held) * 10000) / 100
          : null;
      if (change > 0) holding.position_change = "increased";
      else if (change < 0) holding.position_change = "decreased";
      else holding.position_change = "unchanged";
    }
  }

  // ─── Phase A PHANTOM-"closed" GUARD ──────────────────────────────────────
  // Synthesize "closed" labels ONLY when the current quarter's filing
  // passed its infoTableEntryTotal count check. If the current filing is
  // incomplete (parser dropped rows, truncated download, schema variant
  // we didn't handle), prior positions that don't appear in our parsed
  // current set might EXIST in the actual filing — we just didn't see them.
  // Labeling them "closed" in that case is a phantom liquidation event.
  //
  // Reuse the verification_status that saveFlow stamped on each holding
  // (the §1 count check) — DO NOT recompute it here (Greg's directive:
  // "Reuse the §1 13F count-check result — don't compute it twice.").
  //
  // If verification failed, WITHHOLD synthetic closed rows AND ALSO tag
  // any remaining ambiguous deltas as INSUFFICIENT_DATA (a parser miss
  // could swing increased/decreased the wrong way too).
  if (!currentIsVerified) {
    // Mark all annotated holdings INSUFFICIENT_DATA — we can't trust the
    // delta calculation when we don't know if the current set is complete.
    for (const holding of current) {
      holding.position_change = "INSUFFICIENT_DATA";
      holding.shares_change = null;
      holding.shares_change_pct = null;
    }
    return current; // explicitly no synthesized closed rows
  }

  // Verified path: it's safe to emit synthetic "closed" rows for prior
  // CUSIPs absent in the (complete) current set.
  const currentCusips = new Set(current.map((h) => h.cusip));
  const closed: InstitutionalHolding[] = [];
  for (const [cusip, prior] of priorByCusip) {
    if (currentCusips.has(cusip)) continue;
    if (prior.shares_held === 0) continue; // already closed
    closed.push({
      ...prior,
      id: `13f-${fund_cik}-${cusip}-${current_quarter}`,
      quarter: current_quarter,
      filing_date: current[0]!.filing_date,
      shares_held: 0,
      market_value: 0,
      market_value_thousands: 0,
      position_change: "closed",
      shares_change: -prior.shares_held,
      shares_change_pct: -100,
      accession_number: current[0]!.accession_number,
      filing_url: current[0]!.filing_url,
      // The synthesized closed row inherits the parent quarter's
      // verification_status (VERIFIED — we only reach this branch when so).
      verification_status: "VERIFIED",
    });
  }

  return [...current, ...closed];
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Scrape the most recent 13F-HR for one institutional manager.
 *
 * The returned holdings are filtered to the top N by market value (default 50)
 * AFTER ticker enrichment and position-change calculation. That keeps the
 * Firestore footprint sensible while preserving the meaningful positions plus
 * any closed positions worth reporting.
 *
 * Pass `db` to enable Firestore-backed CUSIP cache and prior-quarter
 * comparison. Without a db, ticker enrichment still works (just no caching)
 * and position_change stays null.
 */
export async function scrape13FByFund(
  fundInput: string,
  options: {
    db?: FirestoreInstance | null;
    topN?: number;
  } = {},
): Promise<InstitutionalHolding[]> {
  const fund = resolveFund(fundInput);
  if (!fund) {
    throw new Error(
      `Unknown fund "${fundInput}". Use a CIK like 0001067983 or an alias from listTrackedFunds()`,
    );
  }
  console.error(`[13f] ${fund.name} (CIK ${fund.cik}) — fetching latest 13F-HR`);

  const { meta, xml: xmlText } = await fetchLatest13F(fund);
  const allHoldings = parse13FXml(xmlText, meta);
  console.error(
    `[13f] ${fund.name}: ${allHoldings.length} positions parsed (filing ${meta.accession}, period ${meta.period})`,
  );

  // ─── Phase A §1: count check vs primary_doc.xml infoTableEntryTotal ─────
  // SEC declares the filing's table size in the SUMMARY PAGE. Compare to
  // our parsed-row count. The Tourniquet doctrine: VERIFIED only if the
  // counts match AND we successfully extracted the declared count. The
  // "no count" case (primary_doc missing or unparseable) defaults to
  // INSUFFICIENT_DATA — NEVER VERIFIED in the absence of the landmark.
  //
  // Note: parse13FXml deliberately excludes options (putCall = Put/Call).
  // The infoTableEntryTotal landmark counts EVERY row in the table including
  // option rows, so equity-only filings will always pass equality while
  // options-mixed filings need a tolerant check. We use ≥ rather than ==:
  // if SEC says N total rows and we parsed N or more equity rows, we
  // captured everything we needed. If we parsed FEWER than N declared, we
  // dropped real equity rows (parser bug) OR the filing had options
  // (legitimate exclusion) — we can't distinguish without re-parsing. Per
  // The Tourniquet, when uncertain → INSUFFICIENT_DATA.
  let verification_status: "VERIFIED" | "INSUFFICIENT_DATA";
  if (meta.infoTableEntryTotal === null) {
    verification_status = "INSUFFICIENT_DATA";
    console.error(
      `[13f] ${fund.name} ${meta.accession}: NO CANONICAL COUNT (primary_doc.xml missing/unparseable) — verification_status=INSUFFICIENT_DATA`,
    );
  } else if (allHoldings.length === meta.infoTableEntryTotal) {
    verification_status = "VERIFIED";
  } else {
    verification_status = "INSUFFICIENT_DATA";
    console.error(
      `[13f] ${fund.name} ${meta.accession}: parsed ${allHoldings.length} rows vs SEC declared ${meta.infoTableEntryTotal} — verification_status=INSUFFICIENT_DATA`,
    );
  }
  const verification_expected = meta.infoTableEntryTotal ?? 0;
  const verification_actual = allHoldings.length;

  const topN = options.topN ?? CONFIG.TOP_N_PER_FUND;

  // Take top N by value first (cheaper to enrich N tickers than thousands)
  const top = allHoldings
    .slice()
    .sort((a, b) => b.market_value - a.market_value)
    .slice(0, topN);

  // Stamp Phase A verification fields on every kept holding. applyPositionChanges
  // reads verification_status from the first row to decide whether to emit
  // synthetic "closed" labels (Greg's directive: §1 count check is computed
  // once and reused for the §2 phantom-closed guard).
  for (const h of top) {
    h.verification_status = verification_status;
    h.verification_expected = verification_expected;
    h.verification_actual = verification_actual;
  }

  // Enrich with tickers — primary path is OpenFIGI by CUSIP. The lookup
  // returns both ticker AND OpenFIGI's issuer name so we can detect wrong-
  // issuer mappings (Bloomberg occasionally maps the wrong CUSIP to a real
  // ticker — e.g., CUSIP 023139884 is Ambac Financial but OpenFIGI returns
  // "Overseas Shipholding Group" / OSG). The 13F filer's `nameOfIssuer`
  // is authoritative for who the security IS; if OpenFIGI's name doesn't
  // match the 13F's expected issuer, reject the ticker and let tier 2/3
  // (EDGAR / OpenFIGI search-by-name) try.
  const cusips = top.map((h) => h.cusip);
  const tickerMap = await lookupCusips(cusips, options.db ?? undefined);
  for (const holding of top) {
    const result = tickerMap.get(holding.cusip);
    if (!result?.ticker) {
      holding.ticker = "";
      continue;
    }
    if (namesMatch(holding.issuer_name, result.name)) {
      holding.ticker = result.ticker;
    } else {
      console.error(
        `[13f]   ${holding.cusip} (${holding.issuer_name}): rejected ticker "${result.ticker}" — OpenFIGI name "${result.name}" doesn't match 13F issuer`,
      );
      holding.ticker = "";
    }
  }

  // Tier 2 fallback: for any holding still empty (typical for foreign-
  // domiciled CINS-coded issuers like Chubb, AON, Allegion), look up by
  // issuer name in EDGAR's company_tickers_exchange.json catalog. Free,
  // in-memory, fast.
  let stillEmpty = top.filter((h) => !h.ticker && h.issuer_name);
  if (stillEmpty.length > 0) {
    console.error(
      `[13f] ${stillEmpty.length} holdings empty after CUSIP lookup — trying name fallback against EDGAR`,
    );
    for (const holding of stillEmpty) {
      try {
        const ticker = await lookupTickerByName(holding.issuer_name);
        if (ticker) {
          holding.ticker = ticker;
          console.error(
            `[13f]   ${holding.cusip} (${holding.issuer_name}) → ${ticker} via EDGAR name`,
          );
          if (options.db) {
            await options.db
              .collection("cusip_map")
              .doc(holding.cusip)
              .set(
                {
                  cusip: holding.cusip,
                  ticker,
                  name: holding.issuer_name,
                  market_sector: null,
                  last_verified: new Date().toISOString(),
                  source: "edgar_name_fallback",
                },
                { merge: true },
              );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[13f]   ${holding.cusip} (${holding.issuer_name}): EDGAR name fallback failed — ${msg}`,
        );
      }
    }
  }

  // Tier 3 fallback: for holdings STILL empty after EDGAR, query OpenFIGI's
  // search-by-name endpoint. SEC's catalog has known gaps (HOLX, CYBR, CFLT,
  // JAMF, etc. are missing despite being real US-listed equities) and some
  // wrong mappings (RNA → "Atrium Therapeutics" not Avidity, PSTG →
  // "Everpure" not Pure Storage). OpenFIGI's search uses Bloomberg's
  // comprehensive security database — closes the remaining coverage gap.
  //
  // Rate-limited (5 req/min free, 25 req/min with API key) so this only
  // fires for the small number of names that EDGAR couldn't resolve.
  stillEmpty = top.filter((h) => !h.ticker && h.issuer_name);
  if (stillEmpty.length > 0) {
    console.error(
      `[13f] ${stillEmpty.length} holdings still empty after EDGAR — trying OpenFIGI search-by-name`,
    );
    for (const holding of stillEmpty) {
      try {
        const match = await searchOpenFigiByName(holding.issuer_name);
        if (!match?.ticker) continue;
        // Same name-validation rule as tier 1 — OpenFIGI's search endpoint
        // can return tickers whose underlying name doesn't match what the
        // 13F filer wrote. If they're clearly different companies, drop it.
        if (!namesMatch(holding.issuer_name, match.name)) {
          console.error(
            `[13f]   ${holding.cusip} (${holding.issuer_name}): rejected search ticker "${match.ticker}" — OpenFIGI name "${match.name}" doesn't match`,
          );
          continue;
        }
        holding.ticker = match.ticker;
        console.error(
          `[13f]   ${holding.cusip} (${holding.issuer_name}) → ${match.ticker} via OpenFIGI search`,
        );
        if (options.db) {
          await options.db
            .collection("cusip_map")
            .doc(holding.cusip)
            .set(
              {
                cusip: holding.cusip,
                ticker: match.ticker,
                name: match.name ?? holding.issuer_name,
                market_sector: null,
                last_verified: new Date().toISOString(),
                source: "openfigi_name_search",
              },
              { merge: true },
            );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[13f]   ${holding.cusip} (${holding.issuer_name}): OpenFIGI search failed — ${msg}`,
        );
      }
    }
  }

  // Compute position changes (and synthesize closed positions)
  const annotated = await applyPositionChanges(top, options.db ?? null);

  console.error(
    `[13f] ${fund.name}: ${annotated.length} holdings ready (${top.length} current + ${annotated.length - top.length} closed)`,
  );
  return annotated;
}

/**
 * Live-feed mode: scan EDGAR for recent 13F-HR filings across all filers,
 * not just our tracked list. Returns flattened holdings across every filing
 * processed.
 *
 * Useful for catching new/smaller funds that aren't in TRACKED_FUNDS yet.
 */
export async function scrape13FLiveFeed(
  options: {
    db?: FirestoreInstance | null;
    days?: number;
    maxFunds?: number;
    topN?: number;
  } = {},
): Promise<InstitutionalHolding[]> {
  const days = options.days ?? 30;
  const maxFunds = options.maxFunds ?? 25;

  const start = new Date();
  start.setDate(start.getDate() - days);
  const startStr = start.toISOString().split("T")[0];

  const url = `${CONFIG.SEARCH_URL}?q=%22%22&forms=13F-HR&dateRange=custom&startdt=${startStr}`;
  const data = (await fetchJson(url)) as {
    hits?: { hits?: Array<{ _id?: string; _source?: { ciks?: string[] } }> };
  };
  const hits = data.hits?.hits ?? [];
  console.error(`[13f live] ${hits.length} 13F-HR filings in last ${days}d`);

  // Dedupe by fund CIK — one filing per fund max in this batch
  const seenCiks = new Set<string>();
  const fundsToProcess: FundRef[] = [];
  for (const hit of hits) {
    const cikRaw = (hit._source?.ciks?.[0] ?? "").replace(/^0+/, "");
    if (!cikRaw || seenCiks.has(cikRaw)) continue;
    seenCiks.add(cikRaw);
    fundsToProcess.push({
      cik: cikRaw.padStart(10, "0"),
      cikRaw,
      name: cikRaw, // resolved later from submissions
    });
    if (fundsToProcess.length >= maxFunds) break;
  }

  const all: InstitutionalHolding[] = [];
  for (const fund of fundsToProcess) {
    try {
      const holdings = await scrape13FByFund(fund.cik, {
        db: options.db,
        topN: options.topN,
      });
      all.push(...holdings);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[13f live] CIK ${fund.cik}: SKIP — ${msg}`);
    }
  }

  console.error(
    `[13f live] TOTAL: ${all.length} holdings across ${fundsToProcess.length} funds`,
  );
  return all;
}
