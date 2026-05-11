/**
 * Form 278 (Public Financial Disclosure / Annual Financial Disclosure) scraper.
 *
 * Reuses the Senate eFD session protocol from `senate.ts` but searches for
 * Annual / New Filer / Termination / Combined report types instead of PTRs.
 *
 * Senate eFD report-type codes (from the eFD search UI):
 *   - 7  = Annual Report (Form 278 / Public Financial Disclosure)
 *   - 8  = New Filer Report (initial disclosure on entering office)
 *   - 9  = Termination Report (final disclosure on leaving office)
 *   - 11 = Periodic Transaction Report (PTR) — handled by senate.ts
 *   - 12 = Annual + Termination Combined (filer who left mid-year)
 *
 * v1A scope: metadata only. Captures who filed, when, and a URL to the
 * report. Agents follow the URL to read the actual schedules. Net-worth
 * roll-up via PDF parsing is v1.1 polish.
 *
 * Pure-publisher posture preserved: we surface where the data lives;
 * agents consume it. No derived signals.
 */

import type { Form278Filing } from "../types.js";
import { createSession } from "./senate.js";

const CONFIG = {
  USER_AGENT:
    process.env.SENATE_USER_AGENT ?? "KeyVexMCP/0.1 contact@capitaledge.app",
  HOME_URL: "https://efdsearch.senate.gov/search/home/",
  SEARCH_URL: "https://efdsearch.senate.gov/search/",
  DATA_URL: "https://efdsearch.senate.gov/search/report/data/",
  EFD_BASE: "https://efdsearch.senate.gov",
  /** Annual / New Filer / Termination / Combined — everything that Form 278
   *  family covers. Excludes PTRs (11) which senate.ts already handles. */
  REPORT_TYPES_ANNUAL: [7, 8, 9, 12],
  RATE_LIMIT_MS: 300,
  PAGE_SIZE: 100,
  /** Form 278 is filed annually (mostly by May 15 each year). A 30-day
   *  lookback catches the typical filing cluster + late filings without
   *  pulling thousands of stale records. Customers asking "who just
   *  disclosed?" want recent activity. */
  DEFAULT_LOOKBACK_DAYS: 30,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Map a numeric eFD report_type code to a human-readable filing flavor. */
function reportTypeFromCode(code: number): Form278Filing["report_type"] {
  switch (code) {
    case 7: return "Annual";
    case 8: return "New Filer";
    case 9: return "Termination";
    case 12: return "Combined";
    default: return "Other";
  }
}

/** MM/DD/YYYY → YYYY-MM-DD; pass through if already ISO. */
function toIsoDate(s: string): string {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${(mm ?? "").padStart(2, "0")}-${(dd ?? "").padStart(2, "0")}`;
  }
  return s;
}

/** Best-effort guess at the year the filing covers. Most Form 278s filed in
 *  year Y cover calendar year Y-1 (e.g., the May 15 2026 filing reports CY 2025).
 *  New Filer reports cover the partial year up to filing; Termination covers
 *  the partial year up to leaving office. We use filing_date.year - 1 as the
 *  default. v1.1 PDF parsing can refine to the exact reporting period. */
function guessFilingYear(filingDateIso: string, reportType: string): number {
  if (!filingDateIso) return new Date().getUTCFullYear() - 1;
  const filingYear = parseInt(filingDateIso.slice(0, 4), 10);
  if (Number.isNaN(filingYear)) return new Date().getUTCFullYear() - 1;
  // New Filer reports usually cover the current year so far
  if (reportType === "New Filer") return filingYear;
  // Annual / Termination / Combined typically cover the prior year
  return filingYear - 1;
}

interface ListEntry {
  firstName: string;
  lastName: string;
  office: string;
  reportSubtype: string;
  reportId: string;
  reportPath: string;
  dateFiled: string;
}

/** Fetch all matching Form 278 filings within the given date window. */
async function fetchForm278List(
  session: { fetch: typeof fetch; csrfToken: string },
  window: { start: Date; end: Date },
): Promise<ListEntry[]> {
  const { start, end } = window;

  const formatDate = (d: Date): string => {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const y = d.getFullYear();
    return `${m}/${day}/${y} 00:00:00`;
  };

  // Page through results — Form 278 filings cluster heavily in May, so a
  // 30-day window in May/June can return more than PAGE_SIZE rows.
  const allRows: unknown[][] = [];
  let pageStart = 0;
  let recordsTotal = 0;

  while (true) {
    const body = new FormData();
    body.append("start", String(pageStart));
    body.append("length", String(CONFIG.PAGE_SIZE));
    body.append("report_types", `[${CONFIG.REPORT_TYPES_ANNUAL.join(",")}]`);
    body.append("submitted_start_date", formatDate(start));
    body.append("submitted_end_date", formatDate(end));
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
        Origin: CONFIG.EFD_BASE,
        Referer: CONFIG.SEARCH_URL,
        "X-CSRFToken": session.csrfToken,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`[form278] eFD /search/report/data/ HTTP ${res.status}`);
    }

    const rawText = await res.text();
    let json: {
      data?: unknown[][];
      recordsTotal?: number;
      recordsFiltered?: number;
    } = {};
    try {
      json = JSON.parse(rawText);
    } catch {
      console.error(
        "[form278] eFD response was not JSON (likely auth failure). First 400 chars:",
      );
      console.error(rawText.slice(0, 400));
      throw new Error("Form 278 data endpoint returned non-JSON");
    }
    const rows = Array.isArray(json.data) ? json.data : [];
    if (recordsTotal === 0) {
      recordsTotal = json.recordsFiltered ?? json.recordsTotal ?? rows.length;
    }
    console.error(
      `[form278]   page start=${pageStart} returned ${rows.length} row(s)` +
        (recordsTotal ? ` (total filtered=${recordsTotal})` : ""),
    );
    allRows.push(...rows);
    if (rows.length < CONFIG.PAGE_SIZE) break;
    pageStart += rows.length;
    if (pageStart >= recordsTotal) break;
    // Safety cap. Weekly cron windows return well under 1k rows; long
    // historical backfills (year-by-year) can run into the low thousands.
    // 50k is the ceiling — narrow the window if you hit it.
    if (pageStart > 50000) {
      console.error("[form278] stopping pagination at 50000 rows for safety");
      break;
    }
  }

  return allRows
    .map((row): ListEntry | null => {
      const firstName = String(row[0] ?? "").trim();
      const lastName = String(row[1] ?? "").trim();
      const office = String(row[2] ?? "").trim();
      const linkHtml = String(row[3] ?? "");
      const dateFiled = String(row[4] ?? "").trim();

      // The link path looks like /search/view/{subtype}/{id}/  — subtype is
      // "annual" / "paper" / "amendment" / etc. Extract both the subtype
      // and the report id.
      const linkMatch = linkHtml.match(/href=['"]([^'"]+)['"]/);
      if (!linkMatch) return null;
      const reportPath = linkMatch[1] ?? "";
      const subtypeMatch = reportPath.match(
        /\/search\/view\/([a-z0-9_-]+)\/([a-f0-9-]+)\/?/i,
      );
      if (!subtypeMatch) return null;
      const reportSubtype = subtypeMatch[1] ?? "";
      const reportId = subtypeMatch[2] ?? "";

      return {
        firstName,
        lastName,
        office,
        reportSubtype,
        reportId,
        reportPath,
        dateFiled,
      };
    })
    .filter((x): x is ListEntry => x !== null);
}

/** Convert a list entry + the report_type code we filtered with into a
 *  Form278Filing record. We don't actually know which of [7,8,9,12] each
 *  row belongs to from the search results alone — eFD's response doesn't
 *  echo the matched report_type. So we infer from the URL subtype:
 *    - subtype "annual"   → 7  Annual
 *    - subtype "paper"    → likely Annual filed on paper (older); treat as Annual
 *    - subtype "amendment" → Amendment (rare)
 *  When in doubt, mark "Other" — the report_url tells the agent the truth. */
function inferReportType(subtype: string): Form278Filing["report_type"] {
  const s = subtype.toLowerCase();
  if (s === "annual") return "Annual";
  if (s === "paper") return "Annual"; // paper-filed annuals
  if (s === "amendment") return "Amendment";
  if (s === "termination") return "Termination";
  if (s === "newfiler" || s === "new_filer") return "New Filer";
  if (s === "combined") return "Combined";
  return "Other";
}

/** Parse "Senator, AK" → state "AK"; "Representative, CA-12" → state "CA",
 *  district "12". Senate offices have no district; House does. */
function parseOffice(office: string): { state: string; district: string } {
  // "Senator, AK"
  const senMatch = office.match(/Senator[,\s]+([A-Z]{2})/i);
  if (senMatch) return { state: senMatch[1] ?? "", district: "" };
  // "Representative, CA-12" or "Representative, AL" (at-large)
  const repMatch = office.match(/Representative[,\s]+([A-Z]{2})(?:-(\w+))?/i);
  if (repMatch) {
    return { state: repMatch[1] ?? "", district: repMatch[2] ?? "" };
  }
  return { state: "", district: "" };
}

export interface ScrapeOptions {
  /** Rolling lookback in days from now. Ignored if startDate+endDate set. */
  lookbackDays?: number;
  /** Explicit window start (YYYY-MM-DD). Pairs with endDate. */
  startDate?: string;
  /** Explicit window end (YYYY-MM-DD, inclusive). Pairs with startDate. */
  endDate?: string;
}

/** Parse YYYY-MM-DD to a UTC Date at midnight. Throws on bad format. */
function parseIsoDateStrict(s: string, label: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${s}`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${label} is not a valid date: ${s}`);
  }
  return d;
}

export async function scrapeSenateForm278(
  options: ScrapeOptions = {},
): Promise<Form278Filing[]> {
  let start: Date;
  let end: Date;
  let windowLabel: string;
  if (options.startDate && options.endDate) {
    start = parseIsoDateStrict(options.startDate, "startDate");
    end = parseIsoDateStrict(options.endDate, "endDate");
    if (end < start) {
      throw new Error(
        `endDate (${options.endDate}) must be on or after startDate (${options.startDate})`,
      );
    }
    windowLabel = `${options.startDate} → ${options.endDate}`;
  } else if (options.startDate || options.endDate) {
    throw new Error(
      "startDate and endDate must be provided together (or use lookbackDays)",
    );
  } else {
    const lookbackDays = options.lookbackDays ?? CONFIG.DEFAULT_LOOKBACK_DAYS;
    end = new Date();
    start = new Date();
    start.setDate(start.getDate() - lookbackDays);
    windowLabel = `last ${lookbackDays} days`;
  }
  console.error(
    `[form278] Starting Senate Form 278 live-feed (${windowLabel})...`,
  );

  console.error("[form278] Establishing Senate eFD session...");
  const session = await createSession();
  console.error("[form278]   session ready");

  const entries = await fetchForm278List(session, { start, end });
  console.error(
    `[form278] Discovered ${entries.length} Form 278 filing(s) in the window`,
  );

  const scrapedAt = new Date().toISOString();
  const filings: Form278Filing[] = entries.map((e) => {
    const { state, district } = parseOffice(e.office);
    const filingDateIso = toIsoDate(e.dateFiled);
    const reportType = inferReportType(e.reportSubtype);
    return {
      filing_id: `senate-${e.reportSubtype}-${e.reportId}`,
      source: "SENATE_EFD_AFD",
      chamber: "senate",
      member_name: `${e.firstName} ${e.lastName}`.trim(),
      member_first: e.firstName,
      member_last: e.lastName,
      bioguide_id: "",
      office: e.office,
      state,
      state_district: district,
      party: "",
      filing_year: guessFilingYear(filingDateIso, reportType),
      filing_date: filingDateIso,
      report_type: reportType,
      report_subtype: e.reportSubtype,
      report_url: `${CONFIG.EFD_BASE}${e.reportPath.startsWith("/") ? "" : "/"}${e.reportPath}`,
      scraped_at: scrapedAt,
    };
  });

  console.error(
    `[form278] Parsed ${filings.length} Senate Form 278 filings (Annual / New Filer / Termination / Combined)`,
  );
  return filings;
}
