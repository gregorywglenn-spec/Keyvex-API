/**
 * EDGAR ticker lookup by issuer name — fallback for OpenFIGI gaps.
 *
 * Why this exists: OpenFIGI's CUSIP-to-ticker lookup is excellent for most
 * US-domiciled securities, but for foreign-domiciled US-listed companies
 * (Chubb, AON, Allegion, Liberty Latin America — CUSIPs starting with G or
 * H per the CINS scheme), it sometimes returns only the foreign primary
 * listing or no result at all. We need a fallback for those.
 *
 * EDGAR's `company_tickers.json` is an authoritative SEC-published mapping
 * of every US-listed company (by CIK) to its primary ticker and registered
 * name. About 10K entries, ~1MB JSON. We use it as a name → ticker reverse
 * lookup for whatever OpenFIGI couldn't resolve.
 *
 * The mapping is cached in-memory for the life of the process. The file is
 * stable enough that one fetch per process is fine. (For longer-running
 * deployments, refresh once a week or on schedule.)
 */

/**
 * EDGAR publishes two ticker catalogs:
 *
 *   - `company_tickers.json` — ~10K entries, but heavily filtered toward
 *     mega-cap names. Empirically missing many real S&P-mid-cap tickers like
 *     Hologic (HOLX), CyberArk (CYBR), Confluent (CFLT), Jamf (JAMF). Despite
 *     the SEC documenting it as comprehensive, it's not.
 *
 *   - `company_tickers_exchange.json` — ~12K entries covering every active
 *     US-listed company on a major exchange (NYSE, Nasdaq, etc.). Different
 *     format: a `{fields, data}` shape where data is an array of arrays.
 *     This is what we want for ticker-resolution coverage.
 *
 * We use the exchange file. If SEC ever changes URL or format, both fallback
 * paths (CUSIP-cache miss → name lookup) will start returning empty until we
 * adapt — diagnostic logs will surface that immediately.
 */
const SEC_TICKERS_URL =
  "https://www.sec.gov/files/company_tickers_exchange.json";
const USER_AGENT =
  process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";

/** Format of `company_tickers_exchange.json` from SEC.gov */
interface SecExchangeFile {
  fields: string[];
  /** Each row is [cik, name, ticker, exchange] but column order is resolved
   *  by `fields[]` lookup at runtime, not by tuple position. */
  data: Array<Array<number | string>>;
}

interface NormalizedEntry {
  ticker: string;
  title: string;
  cik: number;
  /** Length of ticker — used to prefer primary listings on ambiguous names */
  tickerLen: number;
}

/** Map from normalized name → list of matching tickers (multiple share classes possible) */
let nameMap: Map<string, NormalizedEntry[]> | null = null;
/** Set of all known US-listed tickers (uppercase). Used by OpenFIGI selector
 *  to validate picks against the SEC's authoritative US ticker catalog. */
let tickerSet: Set<string> | null = null;

/**
 * Common 13F-filer abbreviations expanded to their EDGAR canonical form.
 * Applied BEFORE corporate-form stripping so that "JOHNSON CTLS INTL PLC"
 * becomes "JOHNSON CONTROLS INTERNATIONAL PLC" before LTD/PLC/INC stripping
 * runs and produces "JOHNSON CONTROLS INTERNATIONAL" — matching how EDGAR
 * has Johnson Controls registered.
 *
 * Keep this list conservative: only expand abbreviations that are extremely
 * unlikely to be substrings of real words. e.g. "CO" alone would over-match
 * (every word starting with CO would expand) — the corporate-form regex
 * handles bare "CO" / "CORP" already, so we don't list those here.
 */
const ABBREVIATIONS: Record<string, string> = {
  CTLS: "CONTROLS",
  INTL: "INTERNATIONAL",
  MGMT: "MANAGEMENT",
  SVCS: "SERVICES",
  TECHS: "TECHNOLOGIES",
  COS: "COMPANIES",
  PHARMA: "PHARMACEUTICALS",
  PHARMS: "PHARMACEUTICALS",
  PHARM: "PHARMACEUTICALS",
  PETE: "PETROLEUM",
  PETRO: "PETROLEUM",
  COMMS: "COMMUNICATIONS",
  COMMUN: "COMMUNICATIONS",
  NATL: "NATIONAL",
  INDS: "INDUSTRIES",
  INDUS: "INDUSTRIES",
  AMER: "AMERICAN",
  AMERN: "AMERICAN",
  RES: "RESOURCES",
  RESOURCS: "RESOURCES",
  ENRGY: "ENERGY",
  TR: "TRUST",
  HLDG: "HOLDINGS",
  ENTERPRISE: "ENTERPRISES",
  TELECOMM: "TELECOMMUNICATIONS",
  TELECOMS: "TELECOMMUNICATIONS",
  ELEC: "ELECTRIC",
  PWR: "POWER",
  WTR: "WATER",
  WKS: "WORKS",
  // Geographic / structural abbreviations from 13F filers — without these,
  // namesMatch incorrectly rejects legit OpenFIGI mappings (e.g., 13F's
  // "NORFOLK SOUTHN CORP" → tokens ["NORFOLK","SOUTHN"] vs OpenFIGI's
  // "NORFOLK SOUTHERN CORP" → tokens ["NORFOLK","SOUTHERN"] — different
  // second tokens cause false rejection of NSC).
  SOUTHN: "SOUTHERN",
  NORTHN: "NORTHERN",
  EASTN: "EASTERN",
  WESTN: "WESTERN",
  INDL: "INDUSTRIAL",
  UTILS: "UTILITIES",
  UTIL: "UTILITY",
  MED: "MEDICAL",
  TRANS: "TRANSPORTATION",
  MFG: "MANUFACTURING",
  MIN: "MINING",
  PROPS: "PROPERTIES",
  PPTYS: "PROPERTIES",
  PPTY: "PROPERTY",
  PRODS: "PRODUCTS",
  HLTHCARE: "HEALTHCARE",
  HLTH: "HEALTH",
  PHARMACEUTICAL: "PHARMACEUTICALS",
  THERAPS: "THERAPEUTICS",
  TECH: "TECHNOLOGY",
  TECHNOL: "TECHNOLOGY",
};

/**
 * Country / jurisdiction suffix words. Often appended by 13F filers to
 * disambiguate foreign-domiciled US-listed companies (Chubb LTD SWITZ,
 * Accenture PLC IRELAND). EDGAR doesn't include these in the registered
 * title, so we have to strip them before matching.
 *
 * Plus a handful of state codes that appear bare-word (DEL, NE) — limited
 * to known cases observed in real 13F filings, kept short to avoid
 * over-stripping legitimate company names.
 */
const JURISDICTION_RE =
  /\b(IRELAND|BERMUDA|SWITZ|SWITZERLAND|NETHERLANDS|CAYMAN|JERSEY|GUERNSEY|GIBRALTAR|MARSHALL|LIBERIA|SCOTLAND|ENGLAND|JAPAN|KOREA|CHINA|GBR|UK|USA|US|DEL|NE)\b/g;

/**
 * CIK->ticker reverse-map primary-ticker picker. SEC's company_tickers.json
 * lists MULTIPLE tickers per CIK for multi-class / preferred-heavy issuers
 * (~18% of CIKs): JPM + JPM-PC..JPM-PM, BAC + 16 preferreds, GOOGL + GOOG +
 * structured series. Naive last-write-wins stored a preferred/odd series
 * (JPM-PM, BAC-PS, GGLBP) as the CIK's ticker — so a query by the common
 * ticker returned 0 even though the rows existed under that CIK. SEC orders
 * the primary common ticker first, so: keep the FIRST non-hyphenated ticker
 * seen per CIK, and upgrade away from a previously-stored hyphenated
 * (preferred) one. Shared by every scraper that builds a cikToTicker map
 * (proxy/form8k/form144/activist/xbrl) so the fix can't drift back apart.
 *
 * Usage: `cikToTicker[cik] = preferPrimaryTicker(cikToTicker[cik], ticker);`
 */
export function preferPrimaryTicker(
  existing: string | undefined,
  candidate: string,
): string {
  if (!existing) return candidate;
  if (existing.includes("-") && !candidate.includes("-")) return candidate;
  return existing;
}

/**
 * Normalize an issuer name for matching. Aggressive — strips suffixes,
 * punctuation, whitespace variations, abbreviation differences. Tuned to
 * match what 13F filings write ("CHUBB LIMITED") against what EDGAR
 * registers ("Chubb Limited").
 */
export function normalizeName(name: string): string {
  let s = name.toUpperCase();

  // 1. Expand abbreviations BEFORE suffix-stripping
  // Replace whole-word matches only; preserves words like "AMER" inside
  // longer tokens accidentally — but those don't have word boundaries on
  // both sides anyway.
  for (const [abbrev, full] of Object.entries(ABBREVIATIONS)) {
    s = s.replace(new RegExp(`\\b${abbrev}\\b`, "g"), full);
  }

  // 2. Strip leading/trailing "THE" — common for "The X Company"
  //    EDGAR sometimes lists "X COMPANY, THE" with comma+the at end.
  s = s.replace(/^THE\s+/g, "");
  s = s.replace(/[,\s]+THE\s*$/g, "");

  // 3. Strip corporate-form suffixes (now after abbreviation expansion)
  s = s.replace(
    /\b(INC(ORPORATED)?|CORP(ORATION)?|CO(MPANY)?|LTD|LIMITED|PLC|LLC|N\.?V\.?|S\.?A\.?|LP|HOLDINGS|HOLDING|HLDGS|GROUP|GRP|TRUST|TR)\b/g,
    " ",
  );

  // 4. Strip jurisdiction / country / state-suffix words
  s = s.replace(JURISDICTION_RE, " ");

  // 5. Strip directional / state suffixes ("(NEW)", "/PA/", etc.)
  s = s.replace(/\(?\b(NEW|OLD|PA|MD|NY|CA|MA)\b\)?/g, " ");
  s = s.replace(/\/[A-Z]{2,3}\/?/g, " ");

  // 6. Strip punctuation
  s = s.replace(/[.,'"()\\\/&\-]/g, " ");

  // 7. Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

async function loadMap(): Promise<Map<string, NormalizedEntry[]>> {
  if (nameMap) return nameMap;

  console.error(
    "[sec-tickers] Loading EDGAR company_tickers_exchange.json...",
  );
  const res = await fetch(SEC_TICKERS_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`SEC tickers fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as SecExchangeFile;

  // Validate the response shape. Defensive: SEC has changed file formats
  // before; surface a clear error rather than silently returning [].
  if (
    !raw ||
    !Array.isArray(raw.fields) ||
    !Array.isArray(raw.data) ||
    raw.fields.length === 0
  ) {
    throw new Error(
      `SEC tickers response missing fields/data arrays — format changed?`,
    );
  }

  // Field positions vary between SEC files; resolve by name not by index.
  const cikIdx = raw.fields.indexOf("cik");
  const nameIdx = raw.fields.indexOf("name");
  const tickerIdx = raw.fields.indexOf("ticker");
  const exchangeIdx = raw.fields.indexOf("exchange");
  if (cikIdx < 0 || nameIdx < 0 || tickerIdx < 0) {
    throw new Error(
      `SEC tickers fields missing expected columns. Got: ${raw.fields.join(",")}`,
    );
  }

  const built = new Map<string, NormalizedEntry[]>();
  const tickers = new Set<string>();
  for (const row of raw.data) {
    const cik = row[cikIdx] as unknown as number;
    const title = row[nameIdx] as unknown as string;
    const ticker = row[tickerIdx] as unknown as string;
    if (!ticker || !title) continue;
    const norm = normalizeName(title);
    if (!norm) continue;
    const existing = built.get(norm) ?? [];
    existing.push({
      ticker,
      title,
      cik,
      tickerLen: ticker.length,
    });
    built.set(norm, existing);
    tickers.add(ticker.toUpperCase());
  }
  console.error(
    `[sec-tickers] Loaded ${raw.data.length} tickers, ${built.size} unique normalized names (source: company_tickers_exchange.json)`,
  );
  nameMap = built;
  tickerSet = tickers;
  return built;
}

/**
 * Look up a US ticker for an issuer name. Returns empty string if no match
 * found. When multiple tickers match the same normalized name (different
 * share classes), returns the one with the shortest ticker — usually the
 * primary / most-traded class.
 *
 * For Liberty Latin America (which has LILA and LILAK both registered with
 * the same name), this picks LILA. Customers who care about share class
 * specifically can join on the cusip field instead of ticker.
 */
export async function lookupTickerByName(
  issuerName: string,
): Promise<string> {
  if (!issuerName) return "";
  const map = await loadMap();
  const normalized = normalizeName(issuerName);
  if (!normalized) return "";

  const matches = map.get(normalized);
  if (matches && matches.length > 0) {
    return [...matches].sort((a, b) => a.tickerLen - b.tickerLen)[0]!.ticker;
  }

  // Diagnostic: surface the miss so we can refine normalization further.
  // Only log when input was non-trivial — avoid noise on clearly empty names.
  if (normalized.length >= 4) {
    console.error(
      `[sec-tickers] MISS: "${issuerName}" → normalized "${normalized}" — no EDGAR match`,
    );
  }

  return "";
}

/**
 * Resolve an issuer name to its ticker + CIK + canonical title. Returns
 * null if no EDGAR match. When multiple share classes match the same
 * normalized name (LILA / LILAK), returns the shortest-ticker variant
 * (usually the primary class).
 *
 * CIK is returned as a 10-digit zero-padded string to match the format
 * the rest of KeyVex uses everywhere (Form 4 / 144 / 13F / NPORT etc.).
 */
export async function resolveCompanyByName(
  issuerName: string,
): Promise<{ ticker: string; cik: string; title: string } | null> {
  if (!issuerName) return null;
  const map = await loadMap();
  const normalized = normalizeName(issuerName);
  if (!normalized) return null;

  const matches = map.get(normalized);
  if (!matches || matches.length === 0) return null;

  const best = [...matches].sort((a, b) => a.tickerLen - b.tickerLen)[0]!;
  return {
    ticker: best.ticker,
    cik: String(best.cik).padStart(10, "0"),
    title: best.title,
  };
}

/**
 * Compare two issuer names for a "same company" match. Used by OpenFIGI's
 * pickBestMatch to detect wrong-issuer mappings — e.g., Bloomberg returned
 * ticker "OSG" (Overseas Shipholding Group) for Ambac Financial Group's
 * CUSIP. The OpenFIGI name field for that result was "Overseas Shipholding
 * Group" but the 13F filer wrote "Ambac Financial Group" — the names don't
 * share significant tokens, so we reject the mapping.
 *
 * Algorithm: normalize both names, split into significant tokens (≥3 chars,
 * skipping common-form words already stripped by normalizeName), check
 * whether all tokens of the SHORTER name appear in the longer name. This
 * gives us tighter matching than simple intersection while staying tolerant
 * of suffix differences ("APPLE" vs "APPLE INC" → both normalize to "APPLE",
 * trivially match; "JOHNSON CONTROLS INTERNATIONAL" vs "JOHNSON CONTROLS"
 * → all tokens of short side present, match).
 *
 * Returns true if names match, false if they're clearly different companies.
 * Tolerant of one-sided being undefined/empty (returns true — can't validate).
 */
export function namesMatch(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b) return true; // can't validate; default to accept
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return true;
  if (na === nb) return true;
  // Tokenize, keep significant words (3+ chars filters out 'INC', 'CO', '&')
  const tokensA = na.split(/\s+/).filter((t) => t.length >= 3);
  const tokensB = nb.split(/\s+/).filter((t) => t.length >= 3);
  if (tokensA.length === 0 || tokensB.length === 0) {
    // After stripping suffixes/short tokens, one side has no signal — fall
    // back to substring check on full normalized form.
    return na.includes(nb) || nb.includes(na);
  }
  // The shorter name should be fully contained (token-wise) in the longer.
  // Picks the right side automatically: shorter token list is checked for
  // membership in the longer token list.
  const [short, long] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const longSet = new Set(long);
  return short.every((t) => longSet.has(t));
}

/**
 * Returns true if the given ticker (case-insensitive) appears anywhere in
 * EDGAR's `company_tickers.json` as a registered US ticker. Used by the
 * OpenFIGI selector to validate its picks: if OpenFIGI returns a single-
 * character "P" for Pure Storage's CUSIP and "P" isn't in EDGAR's catalog,
 * that pick is suspect and we should try another or fall back to name match.
 *
 * Note: EDGAR's catalog is authoritative for currently-active US tickers.
 * Recently-delisted tickers will not appear, which is the correct behavior
 * for our use case (we want valid currently-tradeable symbols).
 */
export async function isKnownUSTicker(ticker: string): Promise<boolean> {
  if (!ticker) return false;
  // Ensure catalog is loaded; tickerSet is set as a side effect of loadMap()
  await loadMap();
  if (!tickerSet) return false;
  return tickerSet.has(ticker.toUpperCase());
}

/**
 * Diagnostic: search EDGAR's company_tickers.json for entries whose title
 * (in either raw or normalized form) contains the given substring. Useful
 * when test-normalize reports a MISS — we can see what EDGAR ACTUALLY has
 * registered under that company name.
 *
 * Example: if "HOLOGIC INC" → normalized "HOLOGIC" misses, run
 *   searchEdgar("HOLOGIC")
 * to see whether EDGAR has the company under a totally different title
 * (e.g. "Hologic Inc /DE/" or "HOLOGIC GROUP HOLDINGS").
 */
export async function searchEdgar(needle: string): Promise<
  Array<{
    title: string;
    ticker: string;
    cik: number;
    normalized: string;
  }>
> {
  if (!needle) return [];
  await loadMap();
  if (!nameMap) return [];
  const NEEDLE = needle.toUpperCase();
  const NEEDLE_NORM = normalizeName(needle);
  const results: Array<{
    title: string;
    ticker: string;
    cik: number;
    normalized: string;
  }> = [];
  for (const [norm, entries] of nameMap) {
    // Match either by raw-title substring or normalized-form substring —
    // helps catch cases where EDGAR's title is a rename or has extra tokens.
    const titleMatch = entries.some((e) =>
      e.title.toUpperCase().includes(NEEDLE),
    );
    const normMatch = norm.includes(NEEDLE_NORM);
    if (titleMatch || normMatch) {
      for (const e of entries) {
        results.push({
          title: e.title,
          ticker: e.ticker,
          cik: e.cik,
          normalized: norm,
        });
      }
    }
  }
  return results;
}

/**
 * Diagnostic: dump raw stats from EDGAR's company_tickers.json — total entry
 * count, unique normalized name count, sample of the first N entries (in
 * iteration order). Used to verify the catalog actually loaded what we expect.
 *
 * If this returns counts of zero or sample entries that don't look like real
 * companies, the catalog isn't loading correctly.
 */
export async function dumpEdgar(sampleSize = 20): Promise<{
  totalEntries: number;
  uniqueNormalizedNames: number;
  uniqueTickers: number;
  sample: Array<{ title: string; ticker: string; normalized: string }>;
  /** Per-ticker check: is this ticker in the catalog at all (any title)? */
  tickersInCatalog: Record<string, boolean>;
  /** For tickers that ARE in the catalog, what's their actual title? */
  tickersToTitles: Record<string, string>;
}> {
  await loadMap();
  if (!nameMap || !tickerSet) {
    return {
      totalEntries: 0,
      uniqueNormalizedNames: 0,
      uniqueTickers: 0,
      sample: [],
      tickersInCatalog: {},
      tickersToTitles: {},
    };
  }
  const sample: Array<{
    title: string;
    ticker: string;
    normalized: string;
  }> = [];
  let totalEntries = 0;
  // The 13 canary tickers we care about — HOLX/CYBR/CFLT/etc. are the
  // unresolved ones, AAPL/JCI are sanity checks we know should be there.
  const canaryTickers = [
    "AAPL",
    "JCI",
    "ACN",
    "HOLX",
    "CYBR",
    "CFLT",
    "JAMF",
    "RNA",
    "DAY",
    "EXAS",
    "AVDL",
    "DNB",
    "HI",
    "DVAX",
    "PSTG",
    "AMBC",
  ];
  const tickersInCatalog: Record<string, boolean> = {};
  const tickersToTitles: Record<string, string> = {};
  for (const t of canaryTickers) tickersInCatalog[t] = false;

  for (const [norm, entries] of nameMap) {
    for (const e of entries) {
      totalEntries++;
      if (sample.length < sampleSize) {
        sample.push({
          title: e.title,
          ticker: e.ticker,
          normalized: norm,
        });
      }
      const upperTicker = e.ticker.toUpperCase();
      if (canaryTickers.includes(upperTicker)) {
        tickersInCatalog[upperTicker] = true;
        tickersToTitles[upperTicker] = e.title;
      }
    }
  }
  return {
    totalEntries,
    uniqueNormalizedNames: nameMap.size,
    uniqueTickers: tickerSet.size,
    sample,
    tickersInCatalog,
    tickersToTitles,
  };
}
