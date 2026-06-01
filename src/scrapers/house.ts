/**
 * House Clerk PTR scraper — congressional trades from the U.S. House of
 * Representatives Clerk's office, the chamber sibling to Senate eFD.
 *
 * Source: https://disclosures-clerk.house.gov
 *
 * Pipeline:
 *   1. GET /public_disc/financial-pdfs/{year}FD.xml — yearly XML index of
 *      ALL financial-disclosure filings (PTRs + Annual Reports + others).
 *   2. Filter <Member><FilingType>P</FilingType> for PTRs only.
 *   3. For each PTR, GET /public_disc/ptr-pdfs/{year}/{DocID}.pdf
 *   4. Extract text via pdf-parse (machine-generated PDFs, no OCR needed).
 *   5. Heuristic line parser pulls trade rows from extracted text.
 *   6. Normalize to CongressionalTrade shape, write to Firestore alongside
 *      Senate records (same collection, distinguished by `chamber: "house"`).
 *
 * Owner codes in House PTRs are abbreviated:
 *   SP = Spouse, JT = Joint, DC = Dependent Child, otherwise Self.
 *   normalizeOwner() maps these to the same labels Senate uses.
 *
 * Rate limit: 300ms between requests to be respectful — the House Clerk
 * portal is unmetered, but no need to hammer it.
 */

import { XMLParser } from "fast-xml-parser";
import type { CongressionalTrade } from "../types.js";
import { deriveCongressionalNature } from "../tools/insider-transactions-v2-shim.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.HOUSE_USER_AGENT ??
    "KeyVexMCP/0.1 contact@keyvex.com",
  XML_INDEX: (year: number): string =>
    `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`,
  PDF_URL: (year: number | string, docId: string): string =>
    `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
  RATE_LIMIT_MS: 300,
  /** Default lookback for live-feed mode. House PTRs are filed under the
   *  STOCK Act with the same up-to-45-day reporting lag as Senate, so 7
   *  days matches the morning-routine cadence; 30+ for "everything recent." */
  DEFAULT_LOOKBACK_DAYS: 7,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert MM/DD/YYYY → YYYY-MM-DD. Pass-through if already ISO.
 *
 * Sanity guard (Greg's 2026-05-23 finding): House PTRs are PDF-parsed
 * and pdf-parse occasionally garbles year digits ("04/30/2021" got
 * extracted as "04/30/3031" or "04/07/2220"). Returns "" for any date
 * whose year falls outside [2012, current_year+1] — 2012 is the House
 * PTR-era start; current_year+1 catches typo-future dates without
 * rejecting legitimate forward-looking notation dates. The empty
 * string sorts to the bottom of date-DESC queries, keeping garbage
 * out of the headline "most recent trades" surface.
 *
 * For audit visibility, parser failures and out-of-range dates are
 * logged to console.error rather than silently swallowed.
 */
function toISO(dateStr: string): string {
  if (!dateStr) return "";
  let iso: string;
  if (dateStr.includes("/")) {
    const parts = dateStr.split("/");
    if (parts.length !== 3) {
      console.error(`[house] toISO: malformed date "${dateStr}" — rejecting`);
      return "";
    }
    const [m, d, y] = parts;
    iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  } else {
    iso = dateStr;
  }
  // Sanity-check the year — reject corrupted PDF extractions
  const yearMatch = /^(\d{4})/.exec(iso);
  if (!yearMatch) {
    console.error(`[house] toISO: no year prefix on "${iso}" — rejecting`);
    return "";
  }
  const year = parseInt(yearMatch[1]!, 10);
  const maxYear = new Date().getUTCFullYear() + 1;
  if (year < 2012 || year > maxYear) {
    console.error(
      `[house] toISO: year ${year} out of [2012, ${maxYear}] for "${dateStr}" → "${iso}" — rejecting as PDF-parse corruption`,
    );
    return "";
  }
  return iso;
}

/** Business days between two dates. Inputs may be MM/DD/YYYY or YYYY-MM-DD. */
function businessDaysBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const parse = (d: string): Date => {
    if (d.includes("/")) {
      const [m, day, y] = d.split("/");
      return new Date(`${y}-${m!.padStart(2, "0")}-${day!.padStart(2, "0")}`);
    }
    return new Date(d);
  };
  const d1 = parse(start);
  const d2 = parse(end);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
  let count = 0;
  const cur = new Date(Math.min(d1.getTime(), d2.getTime()));
  const stop = new Date(Math.max(d1.getTime(), d2.getTime()));
  while (cur < stop) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/** Lower bound of "$1,001 - $15,000" → 1001. */
function parseAmountMin(amountStr: string): number {
  if (!amountStr) return 0;
  const match = amountStr.replace(/,/g, "").match(/\$(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/** Upper bound of "$1,001 - $15,000" → 15000. Falls back to lower bound for
 *  single-number amounts like "Over $50,000,000". */
function parseAmountMax(amountStr: string): number {
  if (!amountStr) return 0;
  const matches = amountStr.replace(/,/g, "").match(/\$(\d+)/g);
  if (!matches || matches.length < 2) return parseAmountMin(amountStr);
  return parseInt(matches[1]!.replace("$", ""), 10);
}

/** Map House abbreviated owner codes to the Senate-compatible labels. */
function normalizeOwner(
  raw: string,
): "Self" | "Spouse" | "Joint" | "Dependent" {
  const trimmed = (raw ?? "").trim().toUpperCase();
  if (trimmed === "SP" || trimmed === "SPOUSE") return "Spouse";
  if (trimmed === "JT" || trimmed === "JOINT") return "Joint";
  if (trimmed === "DC" || trimmed === "DEPENDENT") return "Dependent";
  return "Self";
}

/**
 * Build a regex that matches ASCII control characters (0x00-0x08, 0x0B-0x1F)
 * — i.e. all controls except \t (0x09) and \n (0x0A). pdf-parse emits these
 * as garbage where the source PDF used icon-font glyphs the library can't
 * decode. Built programmatically with String.fromCharCode so the source
 * file stays free of embedded control bytes.
 */
function buildControlCharRegex(): RegExp {
  const lo = String.fromCharCode(0) + "-" + String.fromCharCode(8);
  const hi = String.fromCharCode(11) + "-" + String.fromCharCode(31);
  return new RegExp("[" + lo + hi + "]", "g");
}

const CONTROL_CHARS_RE = buildControlCharRegex();

// ─── XML Index Fetcher ─────────────────────────────────────────────────────

/**
 * One row from the House Clerk yearly XML index. Each row is one filing —
 * we filter to FilingType="P" (Periodic Transaction Report) only.
 *
 * StateDst is the concatenated state + district code, e.g. "NY12" for
 * New York's 12th district. We split it into `state` and `state_district`
 * fields for query convenience.
 */
export interface PtrIndexEntry {
  first: string;
  last: string;
  prefix: string;
  state: string;
  state_district: string;
  filing_date: string; // MM/DD/YYYY format from source
  doc_id: string;
  year: string;
  pdf_url: string;
}

/**
 * Fetch and parse the House Clerk's yearly XML index. Returns ALL PTR
 * filings (FilingType="P") for the given year. Caller filters by lookback
 * window.
 *
 * Uses fast-xml-parser with `parseTagValue: false` for the same reason as
 * the 13F scraper — preserves DocIDs and other numeric-looking strings as
 * strings instead of having them turned into numbers (which loses leading
 * zeros and breaks downstream URLs).
 */
export async function fetchHousePtrIndex(
  year: number,
): Promise<PtrIndexEntry[]> {
  const url = CONFIG.XML_INDEX(year);
  console.error(`[house] Fetching XML index ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`House XML index HTTP ${res.status} for ${year}`);
  }
  const xml = await res.text();

  const parser = new XMLParser({
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    ignoreAttributes: true,
  });
  const parsed = parser.parse(xml) as {
    FinancialDisclosure?: {
      Member?: Record<string, string>[] | Record<string, string>;
    };
  };

  const memberRaw = parsed.FinancialDisclosure?.Member ?? [];
  const members = Array.isArray(memberRaw) ? memberRaw : [memberRaw];

  const ptrs: PtrIndexEntry[] = [];
  for (const m of members) {
    const filingType = String(m.FilingType ?? "").trim();
    if (filingType !== "P") continue;
    const docId = String(m.DocID ?? "").trim();
    if (!docId) continue;
    const filingYear = String(m.Year ?? year).trim();
    const stateDst = String(m.StateDst ?? "").trim();
    ptrs.push({
      first: String(m.First ?? "").trim(),
      last: String(m.Last ?? "").trim(),
      prefix: String(m.Prefix ?? "").trim(),
      state: stateDst.replace(/\d+$/, ""),
      state_district: stateDst,
      filing_date: String(m.FilingDate ?? "").trim(),
      doc_id: docId,
      year: filingYear,
      pdf_url: CONFIG.PDF_URL(filingYear, docId),
    });
  }
  console.error(`[house] Found ${ptrs.length} PTR entries in ${year} index`);
  return ptrs;
}

/**
 * Filter a list of PTR index entries to those filed within the last
 * `lookbackDays`. Filing dates are MM/DD/YYYY in the source.
 */
export function filterByLookback(
  ptrs: PtrIndexEntry[],
  lookbackDays: number,
): PtrIndexEntry[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  cutoff.setHours(0, 0, 0, 0);
  return ptrs.filter((p) => {
    if (!p.filing_date) return false;
    const [m, d, y] = p.filing_date.split("/");
    if (!m || !d || !y) return false;
    const filed = new Date(
      `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    );
    return !Number.isNaN(filed.getTime()) && filed >= cutoff;
  });
}

// ─── PDF text extractor ────────────────────────────────────────────────────

/**
 * Lazy-load pdf-parse so the dep is optional — index-only mode (XML only,
 * no PDF parsing) works without it. pdf-parse is CommonJS, so we use
 * dynamic import to interop cleanly with our ESM build.
 */
async function getPdfExtractor(): Promise<
  (buf: ArrayBuffer) => Promise<string>
> {
  const mod = (await import("pdf-parse")) as unknown as {
    default: (buffer: Buffer) => Promise<{ text: string }>;
  };
  return async (buf: ArrayBuffer): Promise<string> => {
    const result = await mod.default(Buffer.from(buf));
    return result.text;
  };
}

/**
 * Fetch one PTR PDF and return the extracted plain text. Used by the
 * `house-text` CLI command to inspect a single PTR's text before we
 * design the parser. Also reused internally by the production pipeline.
 */
export async function fetchHousePtrText(
  ptr: PtrIndexEntry,
): Promise<string> {
  const res = await fetch(ptr.pdf_url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`House PDF HTTP ${res.status} for ${ptr.doc_id}`);
  }
  const buf = await res.arrayBuffer();
  const extract = await getPdfExtractor();
  return extract(buf);
}

// ─── PDF text parser ───────────────────────────────────────────────────────

/**
 * Transaction-signature regex. Matches the line that uniquely identifies a
 * trade row: tx code letter (P/S/E), optional "(partial)" or "(full)"
 * qualifier, transaction date MM/DD/YYYY, notification date MM/DD/YYYY,
 * dollar amount.
 *
 * The signature can either start a fresh line OR be appended to the same
 * line as a single-line asset description. Examples observed in the wild:
 *   "P03/05/202604/07/2026$1,001 - $15,000"           — fresh line (2025+ layout)
 *   "S (partial)03/24/202604/07/2026$1,001 - $15,000" — partial sale
 *   "JTCBIZ, Inc. Common Stock (CBZ) [ST]S03/05/202604/07/2026$1,001 - $15,000"
 *                                                     — single-line collapse
 *   "Visa Inc. (V)s12/29/201412/29/2014$250,001 - $500,000"
 *                                                     — 2014/2015 layout
 *
 * TWO LAYOUT ERAS (verified empirically against live PDFs 2026-06-01):
 *   • 2025/2026 — tx code is UPPERCASE (P/S/E) on its own line or appended;
 *     footer markers are abbreviated ("F S:", "S O:", "D:").
 *   • 2014/2015 — the eFD font renders erratically: tx codes are MIXED case
 *     (lowercase "s" = sale, uppercase "P" = purchase), dates may use a
 *     single-digit day ("02/9/2015"), owner codes render lowercase-first
 *     ("sP" not "SP"), and footer markers are FULL WORDS with scrambled
 *     casing ("FILINg sTATUs:", "sUbHoLDINg oF:", "DEsCRIPTION:", lowercase
 *     "amount" header). The asset, code, both dates, and amount range often
 *     collapse onto ONE line.
 *
 * Therefore the code class is [PSEpse] (case-insensitive on the code letter)
 * and the day/month fields are \d{1,2}. This is what lets the 2014/2015
 * lowercase-"s" sale rows be recognized as their own signatures — the root
 * cause of the asset_name BLEED bug: when an "s" sale line was NOT recognized
 * as a signature, the next uppercase-"P" trade's backward-walk vacuumed the
 * whole skipped sale row (its embedded "$X - $Y" range included) into its own
 * asset_name. Recognizing lowercase codes both recovers the lost sale rows AND
 * halts the bleed (a recognized prior signature stops the backward-walk).
 *
 * The double MM/DD/YYYY immediately followed by "$" makes false positives
 * inside asset names vanishingly unlikely even with the widened code class.
 *
 * The regex captures: txCode, txDate, notifDate, amountStart. txCode is
 * uppercased by the caller before buy/sell classification. The "partial"
 * qualifier is detected separately for comment enrichment (it doesn't
 * change the fundamental buy/sell classification).
 */
const TX_SIG_RE =
  /([PSEpse])(?:\s*\([^)]+\))?(\d{1,2}\/\d{1,2}\/\d{4})(\d{1,2}\/\d{1,2}\/\d{4})(\$[^\n]*)/;

/**
 * Predicate: is this line a "stop marker" that signals we've walked past
 * the start of an asset description and should not include it in the
 * gathered asset name? Covers footer rows ("F S: New", "S O: TrustName",
 * "D: Call options..."), the table header lines that repeat across pages,
 * and the certification footer.
 */
function isAssetWalkStopMarker(line: string): boolean {
  return (
    // Abbreviated footer markers (2025/2026 layout)
    /^F\s+S\s*:/.test(line) ||
    /^S\s+O\s*:/.test(line) ||
    /^D\s*:/.test(line) ||
    /^L\s*:/.test(line) ||
    // Full-word footer markers (2014/2015 layout — scrambled casing, so /i)
    /^filing\s+status\b/i.test(line) ||
    /^subholding\s+of\b/i.test(line) ||
    /^description\s*:/i.test(line) ||
    /^location\s*:/i.test(line) ||
    /^comments?\b/i.test(line) ||
    // Table header / page-break artifacts
    /^Filing\s+ID/i.test(line) ||
    /^IDOwner/i.test(line) ||
    /^ID\s+Owner/i.test(line) ||
    /^DateNotification/i.test(line) ||
    /^Notification$/i.test(line) ||
    /^Type$/i.test(line) ||
    /^Date$/i.test(line) ||
    /^Amount$/i.test(line) ||
    line.startsWith("Amount") ||
    line === "Cap." ||
    line.startsWith("Gains") ||
    /^\$200/.test(line) ||
    /^\*\s+For the complete list/i.test(line) ||
    /^I CERTIFY/i.test(line) ||
    /^Digitally Signed/i.test(line)
  );
}

/**
 * Predicate: is this line nothing but a currency amount (or the second half
 * of a wrapped amount range)? e.g. "$5,000,000", "$1,001 -", "$1,001 - $15,000".
 *
 * This is the load-bearing guard against the cross-trade amount BLEED: when a
 * trade's amount range wraps across two PDF lines (TX_SIG_RE captures the first
 * half ending in " - ", the forward-look at i+1 appends the second half), that
 * orphaned second-half line physically sits ABOVE the NEXT trade's asset name.
 * Without this guard, the next trade's backward-walk unshifts the stray
 * "$5,000,000" into ITS asset_name — producing names like
 * "$5,000,000 Hickory Nut Gap Meats LLC". An asset name never legitimately
 * consists solely of a currency amount, so breaking the walk here is safe.
 */
function isCurrencyFragmentLine(line: string): boolean {
  return /^\$[\d,]+(?:\.\d+)?\s*(?:-\s*(?:\$[\d,]+(?:\.\d+)?)?)?$/.test(
    line.trim(),
  );
}

/**
 * Predicate: is this line part of a wrapped "Description" block — the
 * `D : The full transaction included the following sales: ...` enumeration
 * that multi-lot House PTRs spill across several PDF lines?
 *
 * This is the load-bearing guard against the asset_name DESCRIPTION BLEED.
 * On a PTR that sells several securities in one transaction, the Description
 * block lists every lot: "T – 37.426 shares sold @ $27.645/share BRK/B – 3
 * shares sold @ $493.42/share SPY – 8.318 shares ...". pdf-parse wraps that
 * single logical line into 3-4 physical lines. Only the FIRST physical line
 * starts with "D :" (caught by isAssetWalkStopMarker); the wrapped
 * continuation lines do not — so the NEXT trade's backward asset-walk
 * unshifts them into ITS asset_name, producing corrupt names like
 * "sold @ $493.42/share SPY – 8.318 shares ... Apple Inc. - Common Stock".
 * The first asset in the filing is always clean (nothing precedes it); every
 * asset after it inherits the prior lot-list. That is the ~10% corruption
 * signature the 5ffbcb6 fix did not cover.
 *
 * The three tokens below — a "$X/share" price, a "– N shares" lot count, and
 * the "shares sold/purchased" phrasing — never occur in a genuine House asset
 * name (company names + "Common Stock"/"ETF Trust"/ticker/type-code). Breaking
 * the backward walk here stops the bleed while leaving real names untouched.
 * "iShares" is safe: \bshares\b has no word boundary inside "iShares", and the
 * predicate additionally requires a price/lot/verb context an ETF name lacks.
 */
function isDescriptionContinuationLine(line: string): boolean {
  return (
    /\/share\b/i.test(line) ||
    /[–—-]\s*[\d.]+\s+shares?\b/i.test(line) ||
    /\bshares?\b\s+(?:sold|purchased)\b/i.test(line)
  );
}

/**
 * Parse extracted PDF text from a House PTR into normalized trade records.
 *
 * Algorithm:
 *   1. Strip null bytes and other control chars (pdf-parse leaves them
 *      where the source PDF used icon/symbol fonts the library can't decode).
 *   2. Split into lines, trim, drop empties.
 *   3. For each line, find a transaction signature (TX_SIG_RE) ANYWHERE
 *      in the line. The signature is the anchor — every trade has one,
 *      and false positives inside asset names are vanishingly unlikely
 *      because the regex requires double MM/DD/YYYY immediately followed
 *      by a dollar amount.
 *   4. The portion of the line BEFORE the signature is the trailing chunk
 *      of the asset description. If empty, gather asset content from prior
 *      lines until we hit a line starting with an owner code (SP/JT/DC)
 *      or a stop marker.
 *   5. Reassemble asset, extract owner code, ticker `(XXX)`, asset type
 *      `[TT]` from the assembled string.
 *   6. Look forward at next line for amount continuation if the captured
 *      amount ends with " - " (House PTRs occasionally wrap the amount
 *      range across two lines).
 *   7. Look forward up to 5 lines for a `D:` description line (used by
 *      options trades to encode strike + expiry); capture into `comment`.
 *
 * Filters:
 *   - tx code "E" (Exchange) is skipped — same convention as Senate.
 *   - Empty asset descriptions are skipped (defensive against header rows
 *     that happen to slip through).
 */
export function parseHousePtrText(
  rawText: string,
  meta: PtrIndexEntry,
): CongressionalTrade[] {
  // Step 1: strip control bytes (preserve \n only)
  const cleaned = rawText.replace(CONTROL_CHARS_RE, "");

  // Step 2: split into trimmed non-empty lines
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const trades: CongressionalTrade[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sigMatch = line.match(TX_SIG_RE);
    if (!sigMatch) continue;

    const matchIdx = sigMatch.index ?? 0;
    const beforeTx = line.slice(0, matchIdx);
    const txCode = sigMatch[1]!.toUpperCase();
    const txDate = sigMatch[2]!;
    const notifDate = sigMatch[3]!;
    let amount = sigMatch[4]!.trim();

    // Detect "(partial)" / "(full)" qualifier for comment enrichment
    const qualifierMatch = line
      .slice(matchIdx)
      .match(/^[PSEpse]\s*\(([^)]+)\)/);
    const qualifier = qualifierMatch?.[1]?.trim() ?? "";

    // ─── Step 4-5: gather asset description ───────────────────────────
    const assetParts: string[] = [];

    // Walk backward through prior lines until we hit a stop marker, a
    // prior tx signature, or a line that starts with an owner code (which
    // means we've found the start of the asset). The owner-code pattern
    // requires SP/JT/DC followed by any non-whitespace char — handles all
    // observed corporate-name starts: ProperCase ("SPApple"), camelCase
    // ("SPiShares"), all-caps acronyms ("DCBJ's", "DCSTERIS"), period
    // abbreviations ("JTT. Rowe Price"), and apostrophe-starts ("JTO'Reilly").
    // Space after the prefix breaks the pattern, correctly excluding
    // self-owned names that happen to start with "SP ", "JT ", "DC " (e.g.
    // "SP Plus Corp"). Known v1.1 false-positives: SPDR ETFs in Self
    // accounts and self-owned digit-prefix names like "3M" preceded by
    // owner-less context — fix later with ticker-alignment validation.
    let j = i - 1;
    while (j >= 0) {
      const prev = lines[j]!;
      if (isAssetWalkStopMarker(prev)) break;
      if (TX_SIG_RE.test(prev)) break;
      // Guard against the cross-trade amount bleed: a stray currency fragment
      // (the wrapped second-half of the PRIOR trade's amount range) sits above
      // this trade's name. It is not part of the asset description — stop here.
      if (isCurrencyFragmentLine(prev)) break;
      // Guard against the asset_name DESCRIPTION BLEED: a wrapped continuation
      // of the PRIOR trade's "D : ...the following sales:" lot enumeration sits
      // above this trade's name. It is not part of the asset description — stop
      // here so it does not get captured as this trade's asset_name.
      if (isDescriptionContinuationLine(prev)) break;
      assetParts.unshift(prev);
      if (/^([Ss]P|[Jj]T|[Dd]C)\S/.test(prev)) break;
      j--;
    }

    // The portion of the current line BEFORE the tx signature is the
    // final chunk of the asset description. When the asset is short
    // enough to fit on one line, this IS the entire asset description.
    if (beforeTx.trim().length > 0) {
      assetParts.push(beforeTx);
    }

    if (assetParts.length === 0) continue;

    // Reassemble. Replace runs of whitespace with single spaces.
    const fullAsset = assetParts.join(" ").replace(/\s+/g, " ").trim();

    // Owner code: SP/JT/DC at very start of assembled string; default Self.
    // Pattern requires any non-whitespace char immediately after the owner
    // code — see comment on the backward-walk regex above for handling of
    // ProperCase, camelCase, all-caps acronyms, period-abbreviations
    // ("T. Rowe Price"), and apostrophe-starts ("O'Reilly").
    let owner: "Self" | "Spouse" | "Joint" | "Dependent" = "Self";
    let withoutOwner = fullAsset;
    const ownerMatch = fullAsset.match(/^([Ss]P|[Jj]T|[Dd]C)(\S.*)$/);
    if (ownerMatch) {
      owner = normalizeOwner(ownerMatch[1]!);
      withoutOwner = ownerMatch[2]!.trim();
    }

    // Asset type code: [XX] at end of string
    let assetType = "";
    let withoutType = withoutOwner;
    const typeMatch = withoutOwner.match(/\[([A-Z]{1,4})\]\s*$/);
    if (typeMatch) {
      assetType = typeMatch[1]!;
      withoutType = withoutOwner.slice(0, typeMatch.index).trim();
    }

    // Ticker: (XXX) at end of remaining string
    let ticker = "";
    let assetName = withoutType;
    const tickerMatch = withoutType.match(/\(([A-Z][A-Z0-9.]{0,9})\)\s*$/);
    if (tickerMatch) {
      ticker = tickerMatch[1]!;
      assetName = withoutType.slice(0, tickerMatch.index).trim();
    }
    // Strip any trailing comma/dash from the asset name
    assetName = assetName.replace(/[\s,\-]+$/, "");

    // ─── Step 6: forward look for amount continuation ────────────────
    if (/-\s*$/.test(amount) && i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (/^\$[\d,]+/.test(next)) {
        amount = `${amount} ${next}`.replace(/\s+/g, " ").trim();
      }
    }

    // ─── Step 7: forward look for option-description line ────────────
    let comment = "";
    for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
      const l = lines[k]!;
      if (TX_SIG_RE.test(l)) break;
      const desc = l.match(/^D\s*:\s*(.+)$/);
      if (desc) {
        comment = desc[1]!.trim();
        break;
      }
    }
    if (qualifier && qualifier.toLowerCase() !== "full") {
      comment = comment ? `${qualifier}; ${comment}` : qualifier;
    }

    // ─── Filter to buy/sell only (skip Exchange) ──────────────────────
    let txType: "buy" | "sell" | undefined;
    if (txCode === "P") txType = "buy";
    else if (txCode === "S") txType = "sell";
    else continue; // E or anything else: skip

    trades.push({
      id: `house-${meta.doc_id}-${trades.length + 1}`,
      ticker: ticker.toUpperCase(),
      asset_name: assetName,
      asset_type: assetType || "Stock",
      member_name: `${meta.first} ${meta.last}`.trim(),
      member_first: meta.first,
      member_last: meta.last,
      bioguide_id: "", // populated later via congress-legislators catalog
      chamber: "house",
      party: "", // enriched via bioguide_id
      state: meta.state,
      state_district: meta.state_district,
      office: `${meta.last}, ${meta.first} (Representative)`.trim(),
      transaction_type: txType,
      // Phase A (2026-05-24): event-kind tag derived from the PDF comment.
      // Catches gift/contribution/donation language. Separate code path from
      // Form 4 (no regulatory trans_code field for congressional).
      transaction_nature: deriveCongressionalNature({
        comment,
        transaction_type: txType,
      }),
      transaction_date: toISO(txDate),
      disclosure_date: toISO(meta.filing_date),
      reporting_lag_days: businessDaysBetween(txDate, meta.filing_date),
      amount_range: amount,
      amount_min: parseAmountMin(amount),
      amount_max: parseAmountMax(amount),
      owner,
      comment,
      ptr_id: meta.doc_id,
      report_url: meta.pdf_url,
      data_source: "HOUSE_CLERK_PTR",
    });
    // notifDate captured for documentation; the disclosure_date used for
    // querying is meta.filing_date (the canonical filing date from the
    // XML index). They normally match within a day; the XML date is more
    // reliable as the public-disclosure timestamp.
    void notifDate;
  }

  return trades;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Scrape House PTRs filed in the last N days. By default this is INDEX
 * MODE: the XML feed is parsed, PTR metadata is returned, but no PDFs are
 * fetched. Pass `extractTrades: true` to also fetch each PDF and run the
 * text parser.
 *
 * Index mode is useful on its own: it answers "what PTRs were just filed?"
 * with member names, dates, doc IDs, and PDF URLs. That alone is a usable
 * MCP-level signal.
 */
export async function scrapeHouseLiveFeed(
  options: {
    lookbackDays?: number;
    maxPtrs?: number;
    extractTrades?: boolean;
  } = {},
): Promise<{
  ptrs: PtrIndexEntry[];
  trades: CongressionalTrade[];
}> {
  const lookback = options.lookbackDays ?? CONFIG.DEFAULT_LOOKBACK_DAYS;
  const year = new Date().getFullYear();
  const allPtrs = await fetchHousePtrIndex(year);
  const filtered = filterByLookback(allPtrs, lookback);
  const ptrs = options.maxPtrs ? filtered.slice(0, options.maxPtrs) : filtered;
  console.error(
    `[house] ${filtered.length} PTRs filed in last ${lookback}d` +
      (options.maxPtrs ? ` (capped to ${ptrs.length} for this run)` : ""),
  );

  const trades: CongressionalTrade[] = [];
  if (!options.extractTrades) {
    console.error(
      "[house] Index-only mode (no PDF parsing). Use --extract to fetch PDFs.",
    );
    return { ptrs, trades };
  }

  const extract = await getPdfExtractor();
  for (const ptr of ptrs) {
    try {
      await sleep(CONFIG.RATE_LIMIT_MS);
      const res = await fetch(ptr.pdf_url, {
        headers: { "User-Agent": CONFIG.USER_AGENT },
      });
      if (!res.ok) {
        console.error(
          `[house]   ${ptr.last} (${ptr.doc_id}): SKIP — PDF HTTP ${res.status}`,
        );
        continue;
      }
      const buf = await res.arrayBuffer();
      const text = await extract(buf);
      const t = parseHousePtrText(text, ptr);
      trades.push(...t);
      console.error(
        `[house]   ${ptr.first} ${ptr.last}: ${t.length} trades`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[house]   ${ptr.last} (${ptr.doc_id}): SKIP — ${msg}`);
    }
  }

  console.error(
    `[house] TOTAL: ${trades.length} trades across ${ptrs.length} PTRs`,
  );
  return { ptrs, trades };
}

/**
 * Fetch one PTR's PDF and return the raw extracted text. Diagnostic helper
 * for designing the parser — run this against a few real PTRs to see what
 * shape the text comes out in, then build the parser to that shape.
 *
 * Pass `docId` directly if known; otherwise the function fetches the
 * yearly index and looks it up.
 */
export async function dumpHousePtrText(
  docId: string,
  year?: number,
): Promise<{ ptr: PtrIndexEntry; text: string }> {
  const targetYear = year ?? new Date().getFullYear();
  const allPtrs = await fetchHousePtrIndex(targetYear);
  const ptr = allPtrs.find((p) => p.doc_id === docId);
  if (!ptr) {
    throw new Error(
      `House PTR ${docId} not found in ${targetYear} index (${allPtrs.length} PTRs in index)`,
    );
  }
  const text = await fetchHousePtrText(ptr);
  return { ptr, text };
}
