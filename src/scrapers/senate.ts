/**
 * Senate eFD scraper — congressional trades from Periodic Transaction
 * Reports (PTRs) filed under the STOCK Act.
 *
 * Ported from `C:\CapitalEdge-API\reference\congressional_scraper.js`
 * (browser version) to Node + TypeScript with v1-quality additions:
 *
 *   - DOMParser → cheerio (Node-friendly HTML parser, jQuery-like API)
 *   - document.cookie / browser session → tough-cookie + fetch-cookie
 *     (proper cookie jar that survives across fetch calls)
 *   - Browser IIFE wrapper dropped → ES module exports
 *   - signal_weight removed from output (publisher-only posture per
 *     TOOL_DESIGN.md — derived signals belong to the dashboard, not here)
 *   - bioguide_id field reserved (populated when congress-legislators
 *     catalog ingestion lands; empty for now)
 *
 * Data source: Senate Electronic Financial Disclosure portal,
 *   https://efdsearch.senate.gov
 *
 * Session protocol:
 *   1. GET /search/home/ to obtain a CSRF token (in cookies + form)
 *   2. POST same URL with `prohibition_agreement=1` to accept terms
 *   3. POST /search/report/data/ with report_types=[11] for PTRs
 *      (returns a JSON DataTables-shaped response)
 *   4. For each PTR row, GET /search/view/ptr/{id}/ for HTML detail
 *   5. Parse the trade table; one row per asset transaction
 *
 * Rate limit: 300ms between requests (be respectful — the eFD portal is
 * Django and not heavily provisioned).
 *
 * Reporting lag: PTRs can be filed up to 45 days after the transaction
 * (STOCK Act). For "what did Congress just disclose buying" agent queries,
 * customers should sort by `disclosure_date`, not `transaction_date`.
 */

import * as cheerio from "cheerio";
import fetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import type { CongressionalTrade } from "../types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  USER_AGENT:
    process.env.SENATE_USER_AGENT ??
    "CapitalEdgeMCP/0.1 contact@capitaledge.app",
  HOME_URL: "https://efdsearch.senate.gov/search/home/",
  /** The disclaimer-agreement POST goes here, NOT to HOME_URL. The reference
   *  browser scraper (`reference/congressional_scraper.js`, tested live April
   *  2026) was clear on this: home is GET-only for receiving the CSRF token,
   *  and the agreement POST is what activates the session for /search/report/data/. */
  SEARCH_URL: "https://efdsearch.senate.gov/search/",
  DATA_URL: "https://efdsearch.senate.gov/search/report/data/",
  PTR_URL: "https://efdsearch.senate.gov/search/view/ptr/",
  REPORT_TYPE_PTR: 11,
  RATE_LIMIT_MS: 300,
  PAGE_SIZE: 100,
  /** Default lookback window for live-feed mode. PTRs lag up to 45 days, so
   *  customers asking "what just disclosed?" want a window long enough to
   *  catch recent filings, short enough to avoid pulling thousands of stale
   *  records. 7 days matches the dashboard's morning-routine cadence. */
  DEFAULT_LOOKBACK_DAYS: 7,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Extract hidden + checkbox input fields from the eFD agreement form so we
 * submit whatever the server expects, not just what we hardcoded. Mirrors
 * what a browser would post when "Submit" is clicked on the disclaimer.
 *
 * Handles `name="X" value="Y"` and `value="Y" name="X"` orderings. Defaults
 * unspecified value to empty string.
 */
export function extractFormFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  // Crude but effective: each <input ...> element becomes one map entry
  const inputRe = /<input\b[^>]*>/gi;
  for (const match of html.matchAll(inputRe)) {
    const tag = match[0];
    const nameMatch = tag.match(/\bname\s*=\s*['"]([^'"]+)['"]/i);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;
    // Skip submit buttons (they only contribute when actually clicked)
    const typeMatch = tag.match(/\btype\s*=\s*['"]([^'"]+)['"]/i);
    const type = (typeMatch?.[1] ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") continue;
    // For checkboxes, only include if "checked" — but the agreement
    // checkbox typically isn't pre-checked, so we'll set it manually below
    if (type === "checkbox") {
      const isChecked = /\bchecked\b/i.test(tag);
      if (!isChecked) continue;
    }
    const valueMatch = tag.match(/\bvalue\s*=\s*['"]([^'"]*)['"]/i);
    const value = valueMatch?.[1] ?? "";
    fields.set(name, value);
  }
  return fields;
}

/** Convert MM/DD/YYYY → YYYY-MM-DD. Pass-through if already ISO. */
function toISO(dateStr: string): string {
  if (!dateStr) return "";
  if (dateStr.includes("/")) {
    const [m, d, y] = dateStr.split("/");
    return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return dateStr;
}

/** Parse the lower bound of a Senate amount range like "$1,001 - $15,000". */
function parseAmountMin(amountStr: string): number {
  if (!amountStr) return 0;
  const match = amountStr.replace(/,/g, "").match(/\$(\d+)/);
  return match ? parseInt(match[1]!, 10) : 0;
}

/** Parse the upper bound of a Senate amount range. Returns the lower bound
 *  when the range has only one number (e.g., "Over $50,000,000"). */
function parseAmountMax(amountStr: string): number {
  if (!amountStr) return 0;
  const matches = amountStr.replace(/,/g, "").match(/\$(\d+)/g);
  if (!matches || matches.length < 2) return parseAmountMin(amountStr);
  return parseInt(matches[1]!.replace("$", ""), 10);
}

// ─── Session management ────────────────────────────────────────────────────

/** Build a fetch with cookie-jar support, matching the eFD portal's CSRF
 *  protocol. The returned object also exposes `getCsrfToken()` for stamping
 *  on subsequent POST headers. */
export async function createSession(): Promise<{
  fetch: typeof fetch;
  csrfToken: string;
  jar: CookieJar;
}> {
  const jar = new CookieJar();
  // fetch-cookie wraps the global fetch with cookie-jar persistence so the
  // session cookie set by the eFD portal carries across all subsequent calls
  const cookied = fetchCookie(fetch, jar) as unknown as typeof fetch;

  // Step 1: GET home to receive csrftoken cookie + the CSRF input in the form
  const homeRes = await cookied(CONFIG.HOME_URL, {
    headers: { "User-Agent": CONFIG.USER_AGENT },
  });
  const homeHtml = await homeRes.text();

  // Try the form-input first (more reliable than reading from the cookie jar
  // since the cookie may be HttpOnly on some Django configs)
  let csrfToken =
    homeHtml.match(
      /name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/,
    )?.[1] ?? "";

  if (!csrfToken) {
    const cookies = await jar.getCookies(CONFIG.HOME_URL);
    csrfToken =
      cookies.find((c) => c.key === "csrftoken")?.value ?? "";
  }

  if (!csrfToken) {
    throw new Error("Senate: could not obtain CSRF token from home page");
  }

  // Discover ALL hidden input fields in the agreement form. Senate eFD
  // historically had only `csrfmiddlewaretoken` + `prohibition_agreement`,
  // but they sometimes add fields (e.g., a second `agreement_form` or
  // `view_disclaimer`). A browser submits whatever's in the form; we'll do
  // the same so we never miss a hidden requirement.
  const formFields = extractFormFields(homeHtml);
  // Make sure both required fields are set even if the regex missed them
  formFields.set("csrfmiddlewaretoken", csrfToken);
  formFields.set("prohibition_agreement", "1");

  // Extract the actual form's `action` URL — don't assume /search/. Print
  // a chunk of the form so we can inspect attributes directly.
  const formMatch = homeHtml.match(
    /<form\b[^>]*\bid\s*=\s*['"]agreement_form['"][^>]*>/i,
  ) ?? homeHtml.match(/<form\b[^>]*prohibition_agreement[^>]*>([\s\S]*?)<\/form>/i)
    ?? homeHtml.match(/<form\b[^>]*>([\s\S]{0,600}prohibition_agreement[\s\S]{0,200})/i);
  const formActionMatch = formMatch?.[0].match(/\baction\s*=\s*['"]([^'"]+)['"]/i);
  const formMethodMatch = formMatch?.[0].match(/\bmethod\s*=\s*['"]([^'"]+)['"]/i);
  const formAction = formActionMatch?.[1];
  const formMethod = (formMethodMatch?.[1] ?? "POST").toUpperCase();
  // HTML form spec: action="" (empty) and a missing action attribute both
  // mean "submit to the document's URL" — which here is HOME_URL. The
  // reference browser scraper posts to /search/, but the eFD form's
  // action="" actually targets /search/home/. Posting to /search/ silently
  // re-renders the home page with the agreement form unchecked, leaving
  // the session unagreed.
  let agreementUrl: string;
  if (formAction === undefined) {
    agreementUrl = CONFIG.HOME_URL; // no action attribute → current URL
  } else if (formAction === "") {
    agreementUrl = CONFIG.HOME_URL; // explicit empty action → current URL
  } else {
    agreementUrl = new URL(formAction, CONFIG.HOME_URL).toString();
  }
  const actionDisplay =
    formAction === undefined
      ? "(missing)"
      : formAction === ""
        ? '(empty — submit-to-self)'
        : `"${formAction}"`;
  console.error(
    `[senate]   agreement form action=${actionDisplay} method=${formMethod} → POST to ${agreementUrl}`,
  );
  // Show form snippet so we can sanity-check the structure
  if (formMatch) {
    const snippet = formMatch[0].slice(0, 500).replace(/\s+/g, " ");
    console.error(`[senate]   form opening tag: ${snippet}`);
  } else {
    console.error("[senate]   WARNING: could not locate <form> on home page");
  }

  await sleep(CONFIG.RATE_LIMIT_MS);

  // Step 2: POST the disclaimer agreement to /search/ (NOT /search/home/) —
  // this is what flips the session into "agreed" state per the reference
  // browser scraper. Posting to /search/home/ silently no-ops, leaving the
  // data endpoint to return empty results.
  const agreeBody = new URLSearchParams();
  for (const [k, v] of formFields) agreeBody.append(k, v);
  console.error(
    `[senate]   agreement form fields: ${[...formFields.keys()].join(", ")}`,
  );
  const agreeRes = await cookied(agreementUrl, {
    method: "POST",
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      // Origin is required by Django 4.x CSRF middleware for unsafe methods.
      // Browsers send this automatically; Node fetch (undici) does not.
      // Without it, Django silently rejects the POST and re-renders the home
      // page with the agreement form, leaving the session unagreed.
      Origin: "https://efdsearch.senate.gov",
      Referer: CONFIG.HOME_URL,
      "X-CSRFToken": csrfToken,
    },
    body: agreeBody.toString(),
    redirect: "follow",
  });
  console.error(
    `[senate]   agreement POST → HTTP ${agreeRes.status}, finalUrl=${(agreeRes as Response).url}`,
  );
  if (!agreeRes.ok && agreeRes.status !== 302) {
    throw new Error(
      `Senate disclaimer POST failed: HTTP ${agreeRes.status}`,
    );
  }

  // Step 3: GET /search/ — the browser-flow lands on the search page after
  // the agreement redirect. Doing this explicitly ensures any final session
  // cookies are written by the server before we POST to the data endpoint.
  await sleep(CONFIG.RATE_LIMIT_MS);
  const searchRes = await cookied(CONFIG.SEARCH_URL, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Referer: CONFIG.HOME_URL,
    },
  });
  if (!searchRes.ok) {
    throw new Error(`Senate /search/ landing page failed: HTTP ${searchRes.status}`);
  }

  // Step 4: refresh CSRF after agreement+landing (Django rotates the token)
  const cookiesAfter = await jar.getCookies(CONFIG.SEARCH_URL);
  csrfToken = cookiesAfter.find((c) => c.key === "csrftoken")?.value ?? csrfToken;

  // Some Django installs put the CSRF token in the search-page form too;
  // prefer that over the cookie (handles HttpOnly-csrf configurations).
  const searchHtml = await searchRes.text();
  const formCsrf = searchHtml.match(
    /name=['"]csrfmiddlewaretoken['"]\s+value=['"]([^'"]+)['"]/,
  )?.[1];
  if (formCsrf) csrfToken = formCsrf;

  return { fetch: cookied, csrfToken, jar };
}

// ─── PTR list fetcher ───────────────────────────────────────────────────────

interface PtrListEntry {
  firstName: string;
  lastName: string;
  office: string;
  ptrId: string;
  reportPath: string;
  dateFiled: string;
}

async function fetchPtrList(
  session: { fetch: typeof fetch; csrfToken: string },
  windowStart: Date,
  windowEnd: Date,
  paginationCap: number,
): Promise<PtrListEntry[]> {
  const formatDate = (d: Date): string => {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const y = d.getFullYear();
    return `${m}/${day}/${y} 00:00:00`;
  };

  // Use multipart FormData (matches what the eFD portal's own browser UI
  // sends — the reference scraper at reference/congressional_scraper.js
  // confirmed this works live). Don't set Content-Type manually; fetch will
  // append the right multipart boundary string when given a FormData body.
  //
  // Pagination: eFD caps at PAGE_SIZE per page; loop with `start` offset
  // until we've collected recordsFiltered or hit the safety cap. Multi-year
  // backfills can return thousands of rows; the original single-page fetch
  // silently truncated to 100.
  const allRows: unknown[][] = [];
  let pageStart = 0;
  let recordsTotal = 0;

  while (true) {
    const body = new FormData();
    body.append("start", String(pageStart));
    body.append("length", String(CONFIG.PAGE_SIZE));
    body.append("report_types", `[${CONFIG.REPORT_TYPE_PTR}]`);
    body.append("submitted_start_date", formatDate(windowStart));
    body.append("submitted_end_date", formatDate(windowEnd));
    body.append("candidate_state", "");
    body.append("senator_state", "");
    body.append("first_name", "");
    body.append("last_name", "");
    body.append("csrfmiddlewaretoken", session.csrfToken);

    await sleep(CONFIG.RATE_LIMIT_MS);
    const res = await session.fetch(CONFIG.DATA_URL, {
      method: "POST",
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        Origin: "https://efdsearch.senate.gov",
        Referer: CONFIG.SEARCH_URL,
        "X-CSRFToken": session.csrfToken,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Senate /search/report/data/ HTTP ${res.status}`);
    }

    const rawText = await res.text();
    let json: {
      data?: unknown[][];
      recordsTotal?: number;
      recordsFiltered?: number;
      error?: string;
    } = {};
    try {
      json = JSON.parse(rawText);
    } catch {
      console.error(
        "[senate] /search/report/data/ did not return JSON. First 400 chars:",
      );
      console.error(rawText.slice(0, 400));
      throw new Error(
        "Senate data endpoint returned non-JSON (likely auth failure)",
      );
    }
    const rows = Array.isArray(json.data) ? json.data : [];
    if (recordsTotal === 0) {
      recordsTotal = json.recordsFiltered ?? json.recordsTotal ?? rows.length;
    }
    console.error(
      `[senate]   page start=${pageStart} returned ${rows.length} row(s)` +
        (recordsTotal ? ` (total filtered=${recordsTotal})` : ""),
    );
    if (rows.length === 0 && pageStart === 0) {
      console.error(
        "[senate] Empty result — first 400 chars of raw response for inspection:",
      );
      console.error(rawText.slice(0, 400));
    }
    allRows.push(...rows);
    if (rows.length < CONFIG.PAGE_SIZE) break;
    pageStart += rows.length;
    if (pageStart >= recordsTotal) break;
    if (pageStart > paginationCap) {
      console.error(
        `[senate] stopping pagination at ${paginationCap} rows for safety`,
      );
      break;
    }
  }

  return allRows
    .map((row): PtrListEntry | null => {
      const firstName = String(row[0] ?? "");
      const lastName = String(row[1] ?? "");
      const office = String(row[2] ?? "");
      const linkHtml = String(row[3] ?? "");
      const dateFiled = String(row[4] ?? "");

      // The PTR ID is embedded in an href like /search/view/ptr/abc123-def/
      const linkMatch = linkHtml.match(/href=['"]([^'"]+)['"]/);
      if (!linkMatch) return null;
      const reportPath = linkMatch[1] ?? "";
      const ptrIdMatch = reportPath.match(/\/ptr\/([a-f0-9-]+)\//);
      if (!ptrIdMatch) return null;

      return {
        firstName,
        lastName,
        office,
        ptrId: ptrIdMatch[1] ?? "",
        reportPath,
        dateFiled,
      };
    })
    .filter((e): e is PtrListEntry => e !== null && e.ptrId.length > 0);
}

// ─── PTR HTML parser ────────────────────────────────────────────────────────

/**
 * Parse a single Senate PTR HTML page into normalized trade records.
 *
 * Senate PTR table columns (typical):
 *   0: Row #
 *   1: Transaction Date (MM/DD/YYYY)
 *   2: Owner (Self / Spouse / Joint / Dependent)
 *   3: Ticker
 *   4: Asset Name
 *   5: Asset Type (Stock, Stock Option, etc.)
 *   6: Type (Purchase / Sale - Full / Sale - Partial / Exchange)
 *   7: Amount range ("$1,001 - $15,000")
 *   8: Comment (optional)
 *
 * Filters applied:
 *   - Only Stock and Stock Option asset types (drops bonds, mutual funds,
 *     real estate, crypto since v1 tool surface is equity-focused)
 *   - Only Purchase / Sale transaction types (drops Exchange, etc.)
 */
/**
 * Detect Senate "paper" PTR amendments. These return an HTML wrapper page
 * with a PDF embed instead of the standard trade table. They have to be
 * handled differently (PDF parsing) and aren't what the v1 tool surface
 * targets — log + skip.
 */
function isPaperPtr(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("paper") &&
    (lower.includes("amendment") || lower.includes("filing")) &&
    (lower.includes("<embed") ||
      lower.includes("/view/paper/") ||
      lower.includes(".pdf"))
  );
}

export function parseSenatePtr(
  html: string,
  meta: PtrListEntry,
): CongressionalTrade[] {
  const $ = cheerio.load(html);
  const trades: CongressionalTrade[] = [];

  // Diagnostic: count tables and rows so when 0 trades parse, we can tell
  // immediately whether the structure is what we expect.
  const tables = $("table");
  const rows = $("table tr");

  rows.each((i, row) => {
    if (i === 0) return; // header row
    const cells = $(row)
      .find("td")
      .map((_, td) => $(td).text().trim())
      .get();
    if (cells.length < 8) return;

    const transactionDate = cells[1] ?? "";
    const owner = cells[2] ?? "Self";
    const ticker = (cells[3] ?? "").toUpperCase().trim();
    const assetName = cells[4] ?? "";
    const assetType = cells[5] ?? "";
    const txTypeRaw = (cells[6] ?? "").toLowerCase();
    const amountRange = cells[7] ?? "";
    const comment = cells[8] ?? "";

    // Equity-only filter for v1
    if (
      !["Stock", "Stock Option", "OP"].includes(assetType) &&
      !ticker
    ) {
      return;
    }

    // Type-of-transaction filter
    const isBuy = txTypeRaw.includes("purchase");
    const isSell =
      txTypeRaw.includes("sale") || txTypeRaw.includes("sell");
    if (!isBuy && !isSell) return;

    const transaction_type: "buy" | "sell" = isBuy ? "buy" : "sell";

    trades.push({
      id: `senate-${meta.ptrId}-${i}`,
      ticker,
      asset_name: assetName,
      asset_type: assetType || "Stock",
      member_name: `${meta.firstName} ${meta.lastName}`.trim(),
      member_first: meta.firstName,
      member_last: meta.lastName,
      bioguide_id: "", // populated later via congress-legislators catalog
      chamber: "senate",
      party: "", // enriched via bioguide_id
      state: "", // enriched via bioguide_id
      state_district: "",
      office: meta.office,
      transaction_type,
      transaction_date: toISO(transactionDate),
      disclosure_date: toISO(meta.dateFiled),
      reporting_lag_days: businessDaysBetween(transactionDate, meta.dateFiled),
      amount_range: amountRange,
      amount_min: parseAmountMin(amountRange),
      amount_max: parseAmountMax(amountRange),
      owner,
      comment,
      ptr_id: meta.ptrId,
      report_url: `${CONFIG.PTR_URL}${meta.ptrId}/`,
      data_source: "SENATE_EFD_PTR",
    });
  });

  // Diagnostic: when nothing parsed, surface what the page looked like so we
  // can quickly tell paper-PTR vs structural mismatch vs filtered-out-trades.
  if (trades.length === 0) {
    if (isPaperPtr(html)) {
      console.error(
        `[senate]     ${meta.ptrId}: paper PTR (PDF amendment) — skipped, electronic-only for v1`,
      );
    } else {
      const sample = $("table tr")
        .map((_, r) =>
          $(r)
            .find("td,th")
            .map((_j, c) => $(c).text().trim().slice(0, 30))
            .get()
            .join(" | "),
        )
        .get()
        .slice(0, 4)
        .join("\n        ");
      console.error(
        `[senate]     ${meta.ptrId}: 0 trades parsed — tables=${tables.length}, rows=${rows.length}\n        ${sample || "(no rows)"}`,
      );
    }
  }

  return trades;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Parse YYYY-MM-DD to Date at UTC midnight. Throws on malformed input. */
function parseIsoDate(s: string, label: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(
      `Invalid ${label} "${s}" — expected YYYY-MM-DD format (e.g., 2016-01-01)`,
    );
  }
  const [, yyyy, mm, dd] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label} "${s}" — not a real calendar date`);
  }
  return d;
}

/**
 * Scrape Senate PTRs. Two modes:
 *   1. lookback — pass `lookbackDays` for "last N days" (default 7).
 *   2. date-range — pass `startDate` + `endDate` (ISO YYYY-MM-DD) for
 *      historical backfill. Pagination cap raises to 50000 in this mode.
 *
 * Optionally caps the number of PTRs processed via `maxPtrs`. Useful for
 * testing without hammering the eFD portal.
 *
 * Does not write to Firestore — caller decides what to do with the result
 * (matches the form4.ts / 13f.ts pattern).
 */
export async function scrapeSenateLiveFeed(
  options: {
    lookbackDays?: number;
    maxPtrs?: number;
    /** ISO YYYY-MM-DD start (date-range mode). Mutually exclusive with lookbackDays. */
    startDate?: string;
    /** ISO YYYY-MM-DD end (date-range mode). */
    endDate?: string;
    /** Pagination safety cap. Defaults: 1000 in lookback mode, 50000 in date-range. */
    paginationCap?: number;
  } = {},
): Promise<CongressionalTrade[]> {
  const hasStart = typeof options.startDate === "string" && options.startDate.length > 0;
  const hasEnd = typeof options.endDate === "string" && options.endDate.length > 0;
  if (hasStart !== hasEnd) {
    throw new Error(
      "Senate date-range mode requires BOTH startDate and endDate (got only one)",
    );
  }
  const dateRangeMode = hasStart && hasEnd;

  let windowStart: Date;
  let windowEnd: Date;
  let modeDescription: string;

  if (dateRangeMode) {
    windowStart = parseIsoDate(options.startDate as string, "startDate");
    windowEnd = parseIsoDate(options.endDate as string, "endDate");
    if (windowEnd.getTime() < windowStart.getTime()) {
      throw new Error(
        `endDate (${options.endDate}) must be >= startDate (${options.startDate})`,
      );
    }
    modeDescription = `date range ${options.startDate} → ${options.endDate}`;
  } else {
    const lookbackDays = options.lookbackDays ?? CONFIG.DEFAULT_LOOKBACK_DAYS;
    windowEnd = new Date();
    windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - lookbackDays);
    modeDescription = `last ${lookbackDays} days`;
  }
  const paginationCap =
    options.paginationCap ?? (dateRangeMode ? 50000 : 1000);
  const maxPtrs = options.maxPtrs;

  console.error(`[senate] Initializing eFD session (${modeDescription})...`);
  const session = await createSession();
  console.error(`[senate] Session ready (CSRF token obtained).`);

  const allEntries = await fetchPtrList(
    session,
    windowStart,
    windowEnd,
    paginationCap,
  );
  const entries = maxPtrs ? allEntries.slice(0, maxPtrs) : allEntries;
  console.error(
    `[senate] ${allEntries.length} PTR filings in window` +
      (maxPtrs ? ` (capped to ${entries.length} for this run)` : ""),
  );

  const allTrades: CongressionalTrade[] = [];
  for (const entry of entries) {
    try {
      await sleep(CONFIG.RATE_LIMIT_MS);
      const url = `${CONFIG.PTR_URL}${entry.ptrId}/`;
      const res = await session.fetch(url, {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Referer: CONFIG.SEARCH_URL,
        },
      });
      if (!res.ok) {
        console.error(
          `[senate]   ${entry.lastName} (${entry.ptrId}): SKIP — HTTP ${res.status}`,
        );
        continue;
      }
      // Diagnostic: did fetch redirect us elsewhere? (e.g., back to agreement)
      const finalUrl = (res as Response).url;
      const ctype = (res as Response).headers.get("content-type") ?? "";
      const html = await res.text();
      const trades = parseSenatePtr(html, entry);
      if (trades.length === 0) {
        console.error(
          `[senate]     finalUrl=${finalUrl} content-type=${ctype} bytes=${html.length}`,
        );
        // First time only — dump a chunk of the HTML so we can see structure
        if (allTrades.length === 0 && entries.indexOf(entry) === 0) {
          console.error(
            `[senate]     === HTML SAMPLE (first 2000 chars of first PTR) ===\n${html.slice(0, 2000)}\n=== END SAMPLE ===`,
          );
        }
      }
      allTrades.push(...trades);
      console.error(
        `[senate]   ${entry.firstName} ${entry.lastName}: ${trades.length} trades`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[senate]   ${entry.lastName} (${entry.ptrId}): SKIP — ${msg}`,
      );
    }
  }

  console.error(
    `[senate] TOTAL: ${allTrades.length} trades across ${entries.length} PTRs`,
  );
  return allTrades;
}

/**
 * Scrape one specific PTR by ID. Useful for re-pulling a known filing or
 * testing the parser against a specific URL without going through the full
 * search flow.
 */
export async function scrapeSenatePtrById(
  ptrId: string,
  meta?: Partial<PtrListEntry>,
): Promise<CongressionalTrade[]> {
  console.error(`[senate] Initializing eFD session for single PTR ${ptrId}...`);
  const session = await createSession();
  await sleep(CONFIG.RATE_LIMIT_MS);
  const url = `${CONFIG.PTR_URL}${ptrId}/`;
  const res = await session.fetch(url, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Referer: CONFIG.HOME_URL,
    },
  });
  if (!res.ok) {
    throw new Error(`Senate PTR ${ptrId}: HTTP ${res.status}`);
  }
  const html = await res.text();
  const fullMeta: PtrListEntry = {
    firstName: meta?.firstName ?? "",
    lastName: meta?.lastName ?? "",
    office: meta?.office ?? "",
    ptrId,
    reportPath: meta?.reportPath ?? `/search/view/ptr/${ptrId}/`,
    dateFiled: meta?.dateFiled ?? "",
  };
  return parseSenatePtr(html, fullMeta);
}
