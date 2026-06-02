/**
 * OGE Form 278-T scraper — executive-branch Periodic Transaction Reports.
 *
 * The 278-T is the executive-branch sibling of the congressional STOCK Act
 * PTR: senior Senate-confirmed appointees (Cabinet secretaries, agency heads)
 * must disclose securities transactions over $1,000 within 30-45 days. Every
 * filing carries "Note: This is a public form" — federal public record under
 * the Ethics in Government Act (5 U.S.C. § 13101 et seq.; 5 C.F.R. Part 2634).
 *
 * SCOPE (v1 / Track A): Cabinet + Senate-confirmed appointees, discovered via
 * the OGE "PAS Index" (extapps2.oge.gov). These file CLEAN born-digital PDFs
 * through Integrity.gov — the text layer extracts cleanly with pdf-parse, same
 * library family as the House PTR scraper.
 *
 * NOT in v1: the President / Vice-President. Their 278-Ts live in a separate
 * collection (www.oge.gov "Officials Individual Disclosures") and ship with a
 * CORRUPTED text layer (broken font encoding — verified 2026-06-02 against
 * Trump's OGE + whitehouse.gov filings, both garbled; OGE publishes no
 * structured export). Reliable extraction there needs render→OCR, deferred to
 * v1.1 (Track B) pending a Director ruling. The PAS Index naturally excludes
 * President/VP, so this scraper only ever sees the clean appointee filings.
 *
 * Pipeline:
 *   1. GET PAS Index fully expanded (?OpenView&Count=5000&ExpandView) — one
 *      server-rendered HTML page listing every appointee filing's $FILE link.
 *   2. Extract the 278-T PDF links; parse filer name + filing date from the
 *      filename (e.g. "Howard-Lutnick-06.17.2025-278T.pdf").
 *   3. Filter to the lookback window (daily cron = parse-on-new).
 *   4. Fetch each PDF, extract text with pdf-parse.
 *   5. Line-walk the transaction table → ExecutiveTrade rows.
 *
 * Owner note (verified 2026-06-02 across 5 filers — Lutnick, Abizaid, DeVos,
 * Kratsios, Criswell): the 278-T transaction table has NO per-row owner
 * column (columns are #, DESCRIPTION, TYPE, DATE, NOTIFICATION, AMOUNT). The
 * form covers filer + spouse + dependent child collectively without per-row
 * attribution. We default owner to "self" and only upgrade to spouse/dependent
 * when the description/endnote text says so — never fabricated.
 */

import type { ExecutiveTrade } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.OGE_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  HOST: "https://extapps2.oge.gov",
  /** PAS Index, fully expanded — every appointee filing's $FILE link inline.
   *  The `PAS+Index` form (not %20) is required; Domino treats them
   *  differently and %20 triggers a redirect to the agreement page. */
  INDEX_URL:
    "https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index?OpenView&Count=5000&ExpandView",
  RATE_LIMIT_MS: 300,
  DEFAULT_LOOKBACK_DAYS: 30,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert MM/DD/YYYY or MM.DD.YYYY → YYYY-MM-DD. Returns "" for malformed or
 * out-of-range years (defensive against any odd extraction). 278-T era runs
 * from ~2010; allow [2008, current_year+1].
 */
function toISO(dateStr: string): string {
  if (!dateStr) return "";
  const m = dateStr.trim().match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (!m) return "";
  const [, mm, dd, yyyy] = m;
  const year = parseInt(yyyy!, 10);
  const maxYear = new Date().getUTCFullYear() + 1;
  if (year < 2008 || year > maxYear) return "";
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

/** Lower bound of "$1,000,001 -$5,000,000" or "Over $50,000,000" → number. */
function parseAmountMin(amountStr: string): number {
  if (!amountStr) return 0;
  const match = amountStr.replace(/,/g, "").match(/\$(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Upper bound of a range like "$1,001 - $15,000" → 15000. Returns undefined
 * for open-ended amounts ("Over $50,000,000") so amount_max honestly reflects
 * "no upper bound disclosed" rather than collapsing to the lower bound.
 */
function parseAmountMax(amountStr: string): number | undefined {
  if (!amountStr) return undefined;
  if (/over/i.test(amountStr)) return undefined;
  const matches = amountStr.replace(/,/g, "").match(/\$(\d+)/g);
  if (!matches || matches.length < 2) return undefined;
  return parseInt(matches[1]!.replace("$", ""), 10);
}

/** Build a regex matching ASCII control chars except \t and \n (pdf-parse
 *  garbage where the source used icon-font glyphs). Built programmatically so
 *  the source file stays free of embedded control bytes. */
function buildControlCharRegex(): RegExp {
  const lo = String.fromCharCode(0) + "-" + String.fromCharCode(8);
  const hi = String.fromCharCode(11) + "-" + String.fromCharCode(31);
  return new RegExp("[" + lo + hi + "]", "g");
}
const CONTROL_CHARS_RE = buildControlCharRegex();

/** Derive a coarse filer_type from the position string. Best-effort. */
function deriveFilerType(position: string): "cabinet" | "appointee" | "other" {
  const p = position.toLowerCase();
  // Cabinet = a Secretary/Attorney General who is NOT a deputy/under/assistant.
  if (
    /\bsecretary\b/.test(p) &&
    !/\b(deputy|under|assistant|acting)\b/.test(p)
  ) {
    return "cabinet";
  }
  if (/attorney general/.test(p) && !/\b(deputy|assistant)\b/.test(p)) {
    return "cabinet";
  }
  if (position.trim().length === 0) return "other";
  return "appointee";
}

/** Owner is "self" unless the source text explicitly indicates spouse or
 *  dependent. Source-faithful — never fabricated beyond the default the form
 *  structurally implies (the 278-T has no per-row owner column). */
function deriveOwner(text: string): "self" | "spouse" | "dependent" {
  const t = text.toLowerCase();
  if (/\bdependent\b|\bdependent child\b/.test(t)) return "dependent";
  if (/\bspouse'?s?\b/.test(t)) return "spouse";
  return "self";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Index enumeration ───────────────────────────────────────────────────────

/** One discovered 278-T filing from the PAS Index. */
export interface Oge278tFilingRef {
  pdf_url: string;
  filename: string;
  filer_name: string; // "First Last" derived from filename
  filer_slug: string;
  filing_date: string; // ISO (YYYY-MM-DD), parsed from filename
}

/**
 * Parse a 278-T PDF filename into filer name + filing date.
 * Examples:
 *   "Howard-Lutnick-06.17.2025-278T.pdf"        → Howard Lutnick, 2025-06-17
 *   "Christine-Abizaid-01.16.2024-278T.pdf"     → Christine Abizaid, 2024-01-16
 *   "Elisabeth-(Betsy)-P-DeVos-11.11.2020-278T.pdf" → Elisabeth (Betsy) P DeVos
 */
function parseFilename(
  filename: string,
): { filer_name: string; filing_date: string } {
  // Strip the trailing form-type + extension.
  let base = filename.replace(/-278-?T\.pdf$/i, "");
  // Trailing -MM.DD.YYYY is the filing date.
  let filing_date = "";
  const dateMatch = base.match(/-(\d{1,2}\.\d{1,2}\.\d{4})$/);
  if (dateMatch) {
    filing_date = toISO(dateMatch[1]!);
    base = base.slice(0, dateMatch.index);
  }
  const filer_name = decodeURIComponent(base)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { filer_name, filing_date };
}

/**
 * Fetch the fully-expanded PAS Index and extract every 278-T filing link.
 * Deduped by PDF URL. Annual 278/278e filings are excluded (we only want the
 * periodic transaction reports, filenames ending -278T.pdf).
 */
export async function fetchOge278tIndex(): Promise<Oge278tFilingRef[]> {
  console.error(`[oge278t] Fetching PAS Index: ${CONFIG.INDEX_URL}`);
  const res = await fetch(CONFIG.INDEX_URL, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`OGE PAS Index HTTP ${res.status}`);
  }
  const html = await res.text();

  // Extract $FILE links whose filename ends in 278T / 278-T. The href uses a
  // literal "$FILE" path segment; the [^'"<>]+ stops at the closing quote.
  const linkRe =
    /\/201\/Presiden\.nsf\/PAS\+Index\/[0-9A-Fa-f]+\/\$FILE\/[^'"<>]+?278-?T\.pdf/gi;
  const seen = new Set<string>();
  const refs: Oge278tFilingRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const path = m[0];
    if (seen.has(path)) continue;
    seen.add(path);
    const filename = decodeURIComponent(path.split("/$FILE/")[1] ?? "");
    const { filer_name, filing_date } = parseFilename(filename);
    // Build the absolute URL. Encode only spaces/parens that may appear in the
    // filename; the rest of the path is already URL-safe.
    const pdf_url = CONFIG.HOST + path.replace(/ /g, "%20");
    refs.push({
      pdf_url,
      filename,
      filer_name,
      filer_slug: slugify(filer_name),
      filing_date,
    });
  }
  console.error(`[oge278t] Found ${refs.length} unique 278-T filings in index`);
  return refs;
}

/** Filter filing refs to those filed within the last `lookbackDays`. Filings
 *  with an unparseable filing_date are kept (defensive — better to parse than
 *  silently drop a recent filing whose filename format we didn't anticipate). */
export function filterByLookback(
  refs: Oge278tFilingRef[],
  lookbackDays: number,
): Oge278tFilingRef[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  cutoff.setHours(0, 0, 0, 0);
  return refs.filter((r) => {
    if (!r.filing_date) return true;
    const filed = new Date(r.filing_date);
    return Number.isNaN(filed.getTime()) || filed >= cutoff;
  });
}

// ─── PDF extraction ──────────────────────────────────────────────────────────

async function getPdfExtractor(): Promise<(buf: ArrayBuffer) => Promise<string>> {
  const mod = (await import("pdf-parse")) as unknown as {
    default: (buffer: Buffer) => Promise<{ text: string }>;
  };
  return async (buf: ArrayBuffer): Promise<string> => {
    const result = await mod.default(Buffer.from(buf));
    return result.text;
  };
}

/** Fetch one 278-T PDF and return extracted text. */
export async function fetchOge278tText(ref: Oge278tFilingRef): Promise<string> {
  const res = await fetch(ref.pdf_url, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`OGE 278-T PDF HTTP ${res.status} for ${ref.filename}`);
  }
  const buf = await res.arrayBuffer();
  const extract = await getPdfExtractor();
  return extract(buf);
}

// ─── PDF text parser ───────────────────────────────────────────────────────

const TYPE_RE = /^(Purchase|Sale|Exchange)$/i;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const AMOUNT_RE = /\$[\d,]/;
const ROWNUM_RE = /^\d{1,3}$/;

/** Lines that mark the end of the transaction table / start of boilerplate. */
function isTableStopMarker(line: string): boolean {
  return (
    /^Endnotes$/i.test(line) ||
    /^Summary of Contents/i.test(line) ||
    /^Privacy Act/i.test(line) ||
    /^PART$/i.test(line) ||
    /^ENDNOTE$/i.test(line)
  );
}

/** Header / page-furniture lines to skip during the backward asset walk. */
function isHeaderLine(line: string): boolean {
  return (
    line === "#" ||
    /^DESCRIPTION$/i.test(line) ||
    /^TYPE$/i.test(line) ||
    /^DATE$/i.test(line) ||
    /^AMOUNT$/i.test(line) ||
    /^NOTIFICATION/i.test(line) ||
    /^RECEIVED OVER/i.test(line) ||
    /^See Endnote$/i.test(line) ||
    /- Page \d+$/i.test(line)
  );
}

/**
 * Extract the filer's position from the PDF header. The header reads roughly
 * "Filer's Information{Last, First} {Position} Electronic Signature ...".
 * Best-effort: grab the chunk after "Filer's Information" up to the first
 * signature / certification marker, strip a leading "Last, First" name token.
 * Returns "" if not confidently found (position is a secondary field).
 */
function extractFilerPosition(text: string, filerName: string): string {
  const m = text.match(
    /Filer'?s Information(.*?)(?:Electronic Signature|\/s\/|U\.S\. Office of Government Ethics Certification|Agency Ethics)/is,
  );
  if (!m) return "";
  let chunk = m[1]!.replace(/\s+/g, " ").trim();
  // Strip a leading "Last, First" name (the filer name echoed before position).
  const parts = filerName.split(" ");
  const last = parts[parts.length - 1] ?? "";
  const first = parts[0] ?? "";
  const nameRe = new RegExp(`^${last}\\s*,\\s*${first}\\b`, "i");
  chunk = chunk.replace(nameRe, "").trim();
  // Also strip a bare "Last Name First Name Ml Position" label scaffold if present.
  chunk = chunk.replace(/^(Last Name|First Name|Ml|Position)\b/i, "").trim();
  return chunk.slice(0, 200).trim();
}

/**
 * Parse extracted 278-T PDF text into ExecutiveTrade rows.
 *
 * pdf-parse renders the transaction table one CELL per line:
 *   1 / <description> / [See Endnote] / <Type> / <Date> / <Yes|No> / <Amount>
 *
 * Algorithm: anchor on each standalone TYPE line (Purchase|Sale|Exchange) that
 * is immediately followed by a DATE line — that pair uniquely marks a real
 * transaction (the repeated "TYPE" column header is not a type word, and
 * endnote prose never puts a bare "Sale" on its own line above a date). Then:
 *   - date  = next line, notified = line after (Yes/No), amount = line after.
 *   - description = walk backward, skipping "See Endnote"/header lines, until
 *     the row-number line (pure integer) or a stop marker.
 */
export function parseOge278tText(
  rawText: string,
  ref: Oge278tFilingRef,
): ExecutiveTrade[] {
  const cleaned = rawText.replace(CONTROL_CHARS_RE, "");
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const filerPosition = extractFilerPosition(cleaned, ref.filer_name);
  const filerType = deriveFilerType(filerPosition);
  const scrapedAt = new Date().toISOString();

  const trades: ExecutiveTrade[] = [];
  let stopped = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isTableStopMarker(line)) {
      stopped = true;
      // Boilerplate/endnotes start here. Endnote sections can interleave with a
      // second page's table, so don't hard-break — just skip until a row resumes.
    }
    if (!TYPE_RE.test(line)) continue;

    // Confirm this is a real transaction anchor: next line must be a date.
    const dateLine = lines[i + 1];
    if (!dateLine || !DATE_RE.test(dateLine)) continue;
    // Notification (Yes/No) then amount follow.
    const notifLine = lines[i + 2] ?? "";
    let amountLine = lines[i + 3] ?? "";
    // Defensive: if the notif slot isn't Yes/No, the amount may have shifted up.
    let notified = /^yes$/i.test(notifLine);
    if (!/^(yes|no)$/i.test(notifLine) && AMOUNT_RE.test(notifLine)) {
      amountLine = notifLine;
      notified = false;
    }
    if (!AMOUNT_RE.test(amountLine) && !/over/i.test(amountLine)) continue;
    stopped = false; // a valid row resumed the table

    const txTypeRaw = line.toLowerCase();
    const transaction_type =
      txTypeRaw === "purchase"
        ? "purchase"
        : txTypeRaw === "sale"
          ? "sale"
          : "exchange";

    // ─── backward-walk the description ───────────────────────────────────
    const parts: string[] = [];
    let rowNum = "";
    for (let j = i - 1; j >= 0 && i - j < 12; j--) {
      const prev = lines[j]!;
      if (ROWNUM_RE.test(prev)) {
        rowNum = prev;
        break;
      }
      if (isTableStopMarker(prev)) break;
      if (TYPE_RE.test(prev) || DATE_RE.test(prev)) break;
      if (AMOUNT_RE.test(prev) && parts.length > 0) break;
      if (isHeaderLine(prev)) continue; // skip "See Endnote", column headers
      parts.unshift(prev);
    }
    const description = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!description) continue;

    // ─── ticker from trailing parens ─────────────────────────────────────
    let ticker = "";
    let asset_name = description;
    const tickerMatch = description.match(/\(([A-Z][A-Z0-9.]{0,9})\)\s*$/);
    if (tickerMatch) {
      ticker = tickerMatch[1]!;
      asset_name = description.slice(0, tickerMatch.index).trim();
    }
    asset_name = asset_name.replace(/[\s,]+$/, "");

    const amount_range = amountLine.replace(/\s+/g, " ").trim();
    const idx = trades.length + 1;
    trades.push({
      filing_id: `oge-278t-${ref.filer_slug || "unknown"}-${ref.filing_date || "nodate"}-${idx}`,
      filer_name: ref.filer_name,
      filer_position: filerPosition,
      filer_type: filerType,
      transaction_date: toISO(dateLine),
      asset_name,
      ...(ticker ? { ticker: ticker.toUpperCase() } : {}),
      transaction_type,
      amount_range,
      amount_min: parseAmountMin(amount_range),
      ...(() => {
        const max = parseAmountMax(amount_range);
        return max !== undefined ? { amount_max: max } : {};
      })(),
      owner: deriveOwner(description),
      notified,
      filing_date: ref.filing_date,
      report_url: ref.pdf_url,
      source: "OGE_278T",
      scraped_at: scrapedAt,
    });
  }

  void stopped;
  return trades;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scrape OGE 278-T filings from the PAS Index filed within the last N days.
 * Index-only by default; pass extractTrades to fetch + parse each PDF.
 */
export async function scrapeOge278tLiveFeed(
  options: {
    lookbackDays?: number;
    maxFilings?: number;
    extractTrades?: boolean;
  } = {},
): Promise<{ filings: Oge278tFilingRef[]; trades: ExecutiveTrade[] }> {
  const lookback = options.lookbackDays ?? CONFIG.DEFAULT_LOOKBACK_DAYS;
  const all = await fetchOge278tIndex();
  const filtered = filterByLookback(all, lookback);
  const filings = options.maxFilings
    ? filtered.slice(0, options.maxFilings)
    : filtered;
  console.error(
    `[oge278t] ${filtered.length} filings in last ${lookback}d` +
      (options.maxFilings ? ` (capped to ${filings.length})` : ""),
  );

  const trades: ExecutiveTrade[] = [];
  if (!options.extractTrades) {
    console.error("[oge278t] Index-only mode. Use --extract to parse PDFs.");
    return { filings, trades };
  }

  for (const ref of filings) {
    try {
      await sleep(CONFIG.RATE_LIMIT_MS);
      const text = await fetchOge278tText(ref);
      const t = parseOge278tText(text, ref);
      trades.push(...t);
      console.error(`[oge278t]   ${ref.filer_name}: ${t.length} trades`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[oge278t]   ${ref.filename}: SKIP — ${msg}`);
    }
  }
  console.error(
    `[oge278t] TOTAL: ${trades.length} trades across ${filings.length} filings`,
  );
  return { filings, trades };
}

/** Diagnostic: fetch one filing's PDF text by filename substring. */
export async function dumpOge278tText(
  filenameSubstring: string,
): Promise<{ ref: Oge278tFilingRef; text: string }> {
  const all = await fetchOge278tIndex();
  const ref = all.find((r) =>
    r.filename.toLowerCase().includes(filenameSubstring.toLowerCase()),
  );
  if (!ref) {
    throw new Error(
      `No 278-T filing matching "${filenameSubstring}" (${all.length} in index)`,
    );
  }
  const text = await fetchOge278tText(ref);
  return { ref, text };
}
