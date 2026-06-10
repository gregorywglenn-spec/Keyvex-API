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

import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type {
  Form278Asset,
  Form278Filing,
  Form278Liability,
} from "../types.js";
import { createSession } from "./senate.js";

const CONFIG = {
  USER_AGENT:
    process.env.SENATE_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
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

  // eFD's submitted_end_date is EXCLUSIVE (verified 2026-06-10: a same-day
  // [d, d] window returns 0 rows; [d, d+1] returns d's filings). Our contract
  // says endDate is inclusive, so send end+1day — without this, every window
  // silently drops its final day (a weekly cron run never saw same-day
  // filings until the NEXT run's overlap caught them, and explicit backfill
  // windows permanently lost their last day).
  const endExclusive = new Date(end);
  endExclusive.setDate(endExclusive.getDate() + 1);

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
    body.append("submitted_end_date", formatDate(endExclusive));
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

// ──────────────────────────────────────────────────────────────────────────
//  Senate annual content parser (v1, 2026-06-01)
//
//  The Senate eFD "annual" view renders the Form 278 schedules as structured
//  HTML tables, one per Part, each inside a `<section class="card">` with an
//  `<h3>Part N. Title</h3>`. We parse:
//    - Part 3  Assets      → <table id="grid_items">   (Schedule A)
//    - Part 7  Liabilities → the section's .table-striped (Schedule C)
//  Everything is stored source-faithful: value/amount/income RANGES verbatim,
//  owner/type codes preserved, no derived numerics. Paper (scanned-image)
//  filings have no structured tables; the caller link-outs those with a note.
// ──────────────────────────────────────────────────────────────────────────

/** Collapse runs of whitespace (incl. &nbsp;) to single spaces and trim. */
function squish(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** From an Asset cell's muted sub-divs, pull location (parenthetical) and a
 *  source-faithful description (the remaining detail text, e.g. a "Type:" or
 *  "Description:" note). Only leaf muted divs carry real text — wrapper divs
 *  that merely contain another muted div are skipped to avoid duplicates. */
function extractAssetDetail(
  $: cheerio.CheerioAPI,
  cell: cheerio.Cheerio<any>,
): { location: string; description: string } {
  let location = "";
  const descParts: string[] = [];
  cell.find("div.muted").each((_, d) => {
    const $d = $(d);
    if ($d.children("div.muted").length > 0) return; // wrapper, skip to leaf
    const raw = squish($d.text());
    if (!raw) return;
    const paren = raw.match(/^\(([^)]+)\)$/);
    if (paren) {
      location = (paren[1] ?? "").trim();
      return;
    }
    // Strip a redundant leading "Description:" label; keep "Type:" detail as-is.
    descParts.push(raw.replace(/^Description\s*:\s*/i, ""));
  });
  return { location, description: descParts.join("; ") };
}

/** Parse the Part 3 Assets table (#grid_items) into Form278Asset rows. */
function parseSenateAssets($: cheerio.CheerioAPI): Form278Asset[] {
  const rows: Form278Asset[] = [];
  $("#grid_items tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 7) return;
    const nameCell = $(tds[1]);
    const typeCell = $(tds[2]);

    const asset_name = squish(nameCell.find("strong").first().text());
    const { location, description } = extractAssetDetail($, nameCell);

    const asset_subtype = squish(typeCell.find("div.muted").text());
    const asset_type = squish(
      typeCell.clone().children("div.muted").remove().end().text(),
    );

    rows.push({
      row_number: squish($(tds[0]).text()),
      asset_name,
      asset_type,
      asset_subtype,
      owner: squish($(tds[3]).text()),
      value_range: squish($(tds[4]).text()),
      income_type: squish($(tds[5]).text()),
      income_range: squish($(tds[6]).text()),
      location,
      description,
      ticker: "",
    });
  });
  return rows;
}

/** Parse the Part 7 Liabilities table into Form278Liability rows. The table
 *  is the `.table-striped` inside the section whose <h3> says "Liabilities"
 *  (there are several .table-striped tables on the page — bind by section). */
function parseSenateLiabilities($: cheerio.CheerioAPI): Form278Liability[] {
  // Locate the Liabilities <section> first (there are several .table-striped
  // tables on the page; bind by the section whose <h3> says "Liabilities").
  const section = $("section.card")
    .filter((_, sec) => /Liabilit/i.test($(sec).find("h3").first().text()))
    .first();
  if (section.length === 0) return [];
  const table = section.find("table").first();
  if (table.length === 0) return [];

  const rows: Form278Liability[] = [];
  table.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 9) return;
    const creditorCell = $(tds[8]);
    const creditor = squish(
      creditorCell.clone().children("div.muted").remove().end().text(),
    );
    const location = squish(creditorCell.find("div.muted").text());

    rows.push({
      row_number: squish($(tds[1]).text()),
      incurred: squish($(tds[2]).text()),
      debtor: squish($(tds[3]).text()),
      liability_type: squish($(tds[4]).text()),
      rate_term: squish($(tds[6]).text()),
      amount_range: squish($(tds[7]).text()),
      creditor,
      location,
      comment: squish($(tds[9] ?? "").length ? $(tds[9]).text() : ""),
    });
  });
  return rows;
}

export interface ParsedAnnualContent {
  assets: Form278Asset[];
  liabilities: Form278Liability[];
  /** True when the page had the structured Assets table (electronic filing). */
  parseable: boolean;
}

/** Parse a Senate eFD annual-view HTML page into structured schedule content.
 *  Exported so it can be verified directly against a saved sample. */
export function parseSenateAnnualHtml(html: string): ParsedAnnualContent {
  const $ = cheerio.load(html);
  const parseable = $("#grid_items").length > 0;
  if (!parseable) {
    return { assets: [], liabilities: [], parseable: false };
  }
  return {
    assets: parseSenateAssets($),
    liabilities: parseSenateLiabilities($),
    parseable: true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  House annual content parser (v1, 2026-06-01)
//
//  Unlike the Senate (structured HTML tables), House annual Form 278 filings
//  are PDFs. We extract their text with pdf-parse (the same library house.ts
//  uses for PTRs) and walk the lines with a SCHEMA-AWARE reconstructor.
//
//  The hard problem is that pdf-parse loses the visual table layout: a single
//  asset's fields land on multiple lines, names wrap, and — worst — a value
//  can be split across a PAGE BOUNDARY, with the filing-ID banner + repeated
//  column headers injected between the asset's first line and the rest of its
//  value (the "bleed"). Example (Ager, DocID 10073311):
//
//      John Hancock Annuity, 100% Interest [OT]$50,001 -None   ← asset starts
//      Filing ID #10073311                                     ← page-boundary
//      AssetOwnerValue of AssetIncome Type(s)Income            ← repeated header
//      Current Year to / Filing / Income / Preceding / Year    ← column subheads
//      $100,000                                                ← value RESUMES
//      D          : Annuity
//
//  The reconstruction technique: FILTER the page-boundary noise lines FIRST,
//  which makes the resumed "$100,000" adjacent to its asset again, then a
//  value-fragment line ALWAYS appends to the current asset block. This is the
//  same schema-aware row-reconstruction discipline that fixes the live PTR
//  "amount bleeds into next asset name" bug in house.ts.
//
//  Source-faithful: value RANGES verbatim ("$50,001 - $100,000"), owner codes
//  (JT/SP/DC, "" = Self) and bracket type codes (OL/OT/BA/FA) preserved, no
//  derived numerics. income_range is left "" for House v1 (the income columns
//  are the most bleed-prone region of the layout — an honest empty beats a
//  guessed value).
// ──────────────────────────────────────────────────────────────────────────

/** Strip control bytes pdf-parse leaves where the source PDF used symbol
 *  fonts it couldn't decode (same cleanup house.ts does for PTRs). */
const HOUSE_CONTROL_CHARS_RE = new RegExp(`[\u0000-\u0008\u000b\u000c\u000e-\u001f]`, "g");

/** Income-type vocabulary, longest-first so the alternation is greedy on the
 *  multi-word phrases ("Capital Gains" before a bare match). These are the only
 *  tokens v1 reports as income_type; everything else in the income columns
 *  ("Not"/"Applicable" placeholders, the trailing preceding-year amount range)
 *  is dropped. Used with /g to collect every income token in the region. */
const HOUSE_INCOME_VOCAB =
  /Capital Gains|Tax-Deferred|Tax Deferred|Excepted\/Blind Trust|Dividends|Interest|Rent|None/g;

/** A line that is nothing but a currency value/range fragment: a bare value
 *  ("$100,000"), an open-ended range start ("$1,000,001 -"), or a full range
 *  on its own line ("$1,001 - $15,000"). Such a line is always a VALUE — it
 *  appends to the current asset block (this is what reconstructs the bleed),
 *  and it never starts a new asset. */
function isHouseValueFragment(line: string): boolean {
  return /^\$[\d,]+(?:\.\d+)?\s*(?:-\s*(?:\$[\d,]+(?:\.\d+)?)?)?$/.test(
    line.trim(),
  );
}

/** A page-boundary / table-chrome noise line that pdf-parse repeats across
 *  page breaks. Filtering these FIRST is what makes a bled value adjacent to
 *  its asset again. */
function isHouseNoiseLine(line: string): boolean {
  const s = squish(line);
  if (s === "") return true;
  if (/^Asset\s*Owner/i.test(s)) return true; // "AssetOwnerValue of Asset…"
  if (/Value of Asset/i.test(s)) return true;
  if (/^Filing ID\s*#/i.test(s)) return true;
  if (/^\*\s*Investment Vehicle/i.test(s)) return true;
  if (/^https?:\/\//i.test(s)) return true;
  // Schedule D (Liabilities) column headers — alone or glued together.
  if (/^Owner\s*Creditor/i.test(s)) return true; // "OwnerCreditorDate IncurredType…"
  if (/^Liability$/i.test(s)) return true;
  if (/^Amount of/i.test(s)) return true; // "Amount of" / "Amount of Liability"
  if (/^Date Incurred/i.test(s)) return true;
  // Terminated-filer transaction column header ("Tx. > $1,000?").
  if (/Tx\.\s*>/i.test(s)) return true;
  if (/^\$[\d,]+\?$/.test(s)) return true; // "$1,000?"
  // Repeated column sub-headers that sit alone on a line.
  if (
    /^(Current Year to|Current Year|to Filing|Filing|Income|Preceding Year|Preceding|Year|Source|Type|Amount|Owner|Creditor)$/i.test(
      s,
    )
  ) {
    return true;
  }
  return false;
}

/** Slice the lines between a schedule header and the next schedule header /
 *  region terminator. `startRe` matches the opening header; the region ends
 *  at the first `endRe` match or the next generic schedule header. */
function sliceHouseRegion(
  lines: string[],
  startRe: RegExp,
  endRe: RegExp,
): string[] {
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) return [];
  const body: string[] = [];
  const GENERIC_HEADER = /^S\s{2,}[A-Z]:/;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (endRe.test(l)) break;
    if (GENERIC_HEADER.test(l)) break;
    body.push(l);
  }
  return body;
}

/** True when a standalone line is ONLY income-type vocabulary and the
 *  "Not"/"Applicable" placeholder words, concatenated by a page break onto its
 *  own physical line (e.g. "RentNot", "Capital Gains,", "InterestNot",
 *  "None"). This is income-column text — it belongs to the CURRENT asset
 *  block, and must never leak into `pending` and pollute the next asset's
 *  name (the "RentNot Nicolet Checking" / "Capital Gains, Fidelity ..." bug). */
function isHouseIncomeOnlyLine(line: string): boolean {
  const s = squish(line);
  if (!s || !/[A-Za-z]/.test(s)) return false;
  const stripped = s
    .replace(
      /Capital Gains|Tax-Deferred|Tax Deferred|Excepted\/Blind Trust|Dividends|Interest|Rent|None|Not|Applicable/g,
      "",
    )
    .replace(/[,\s]/g, "");
  return stripped === "";
}

/** Segment the Schedule A region into asset blocks, anchored on the [XX] type
 *  bracket that every House asset row carries exactly once. Name lines (which
 *  may wrap across several physical lines, or be split by a page break) buffer
 *  in `pending` until a bracket line closes the block. Value/income fragments
 *  that bled onto later lines append to the most-recent block — THIS is the
 *  bleed reconstruction. ⇒ Investment-Vehicle parent labels are dropped, but a
 *  page-break tail glued onto a ⇒-line is buffered and re-attached to the next
 *  block after its bracket. */
function segmentHouseAssetBlocks(region: string[]): string[][] {
  const blocks: string[][] = [];
  let pending: string[] = []; // name lines awaiting their bracket
  let cur: string[] | null = null; // most-recent closed block
  let pendingValue: string[] = []; // pre-block / ⇒-tail fragments awaiting a block
  let inSubline = false;

  for (const raw of region) {
    if (isHouseNoiseLine(raw)) continue;
    const line = raw.trim();

    // Investment-Vehicle parent label (contains ⇒/→/=>). Drop the label; if a
    // page break glued a real value tail onto it, buffer that tail.
    if (/⇒|→|=>/.test(line)) {
      const tail = line.replace(/^.*?(?:⇒|→|=>)\s*/, "").trim();
      if (tail) pendingValue.push(tail);
      continue;
    }

    if (/\[[A-Z0-9]{1,5}\]/.test(line)) {
      // Bracket line closes a block: buffered name lines + this line, then any
      // page-break value tail that arrived before the bracket.
      const block = [...pending, line];
      if (pendingValue.length) {
        block.push(...pendingValue);
        pendingValue = [];
      }
      blocks.push(block);
      cur = block;
      pending = [];
      inSubline = false;
      continue;
    }

    // Location / description sublines attach to the current block.
    if (/^[LDC]\s*:/.test(line)) {
      if (cur) cur.push(line);
      else pending.push(line);
      inSubline = true;
      continue;
    }

    // Value fragments, owner-led heads, income vocab, "Not"/"Applicable"
    // placeholders → continuation of the current block (bleed reconstruction).
    if (
      isHouseValueFragment(line) ||
      /^(JT|SP|DC)(?=\$|None|Undetermined|N\/A|\s|$)/.test(line) ||
      isHouseIncomeOnlyLine(line)
    ) {
      if (cur) cur.push(line);
      else pendingValue.push(line);
      continue;
    }

    // A subline that wrapped onto a following physical line.
    if (inSubline && cur) {
      cur.push(line);
      continue;
    }

    // Otherwise: a (possibly wrapped) asset-name line buffering for its bracket.
    pending.push(line);
  }

  return blocks;
}

/** Segment the Schedule D region into liability blocks. Unlike assets there is
 *  no bracket anchor, so a block accumulates noise-filtered lines and flushes
 *  the moment its joined text contains a COMPLETE "$X - $Y" amount range —
 *  whether that range arrives inline or is reconstructed from an open range
 *  ("$X -") continued by a "$Y" fragment on the next line. */
function segmentHouseLiabBlocks(region: string[]): string[][] {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const raw of region) {
    if (isHouseNoiseLine(raw)) continue;
    cur.push(raw.trim());
    if (
      /\$[\d,]+(?:\.\d+)?\s*-\s*\$[\d,]+(?:\.\d+)?/.test(squish(cur.join(" ")))
    ) {
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length && /\$/.test(cur.join(" "))) blocks.push(cur);
  return blocks;
}

/** Extract one Form278Asset from a reconstructed block (array of lines). */
function extractHouseAsset(lines: string[], rowNum: number): Form278Asset {
  let location = "";
  const descParts: string[] = [];
  const headLines: string[] = [];

  for (const l of lines) {
    const loc = l.match(/^L\s*:\s*(.+)$/);
    if (loc) {
      location = squish(loc[1]!);
      continue;
    }
    const desc = l.match(/^[DC]\s*:\s*(.+)$/);
    if (desc) {
      descParts.push(squish(desc[1]!));
      continue;
    }
    headLines.push(l);
  }

  const blob = squish(headLines.join(" "));

  // Asset type = the [XX] bracket; split name (before) from value tail (after).
  let asset_type = "";
  let head = blob;
  let tail = "";
  const typeMatch = blob.match(/\[([A-Z0-9]{1,5})\]/);
  if (typeMatch) {
    asset_type = typeMatch[1]!;
    head = blob.slice(0, typeMatch.index).trim();
    tail = blob.slice(typeMatch.index! + typeMatch[0].length).trim();
  }

  // Owner code leads the value tail (JT/SP/DC), possibly glued straight onto
  // the value or an income word. "" = Self.
  let owner = "";
  const ownerMatch = tail.match(/^(JT|SP|DC)(?=\$|None|Undetermined|N\/A|\s|$)/);
  if (ownerMatch) {
    owner = ownerMatch[1]!;
    tail = tail.slice(ownerMatch[1]!.length).trim();
  }

  // Value range precedence:
  //   1. complete range "$X - $Y" (verbatim, as disclosed)
  //   2. open range "$X -" — upper bound bled to a later fragment now appended
  //      to this block; reconstruct from the next $ token in the tail
  //   3. "Undetermined"
  //   4. "None"
  //   5. bare "$X"
  // `incomeSource` is the tail with the value characters masked out, so the
  // income scan can't pick the value's own "None" up as an income type.
  let value_range = "";
  let incomeSource = tail;
  const complete = tail.match(/^\$[\d,]+(?:\.\d+)?\s*-\s*\$[\d,]+(?:\.\d+)?/);
  const openRange = tail.match(/^\$[\d,]+(?:\.\d+)?\s*-/);
  if (complete) {
    value_range = squish(complete[0]);
    incomeSource = tail.slice(complete[0].length);
  } else if (openRange) {
    const lower = openRange[0].replace(/\s*-\s*$/, "").trim();
    const rest = tail.slice(openRange[0].length);
    const upper = rest.match(/\$[\d,]+(?:\.\d+)?/);
    if (upper) {
      value_range = `${lower} - ${squish(upper[0])}`;
      // Income may sit BETWEEN the open marker and the bled upper bound — mask
      // only the upper token, keep everything else for the income scan.
      incomeSource =
        rest.slice(0, upper.index!) +
        " " +
        rest.slice(upper.index! + upper[0].length);
    } else {
      value_range = `${lower} -`;
      incomeSource = rest;
    }
  } else if (/^Undetermined(?=[A-Z$]|\s|$)/.test(tail)) {
    value_range = "Undetermined";
    incomeSource = tail.slice("Undetermined".length);
  } else if (/^None(?=[A-Z$]|\s|$)/.test(tail)) {
    value_range = "None";
    incomeSource = tail.slice("None".length);
  } else {
    const bare = tail.match(/^\$[\d,]+(?:\.\d+)?/);
    if (bare) {
      value_range = squish(bare[0]);
      incomeSource = tail.slice(bare[0].length);
    }
  }

  // Income type = the income-vocabulary tokens that follow the value, comma-
  // joined. Drop $ amounts, "Not"/"Applicable", trailing preceding-year ranges.
  const incomeMatches = incomeSource.match(HOUSE_INCOME_VOCAB) ?? [];
  const income_type = incomeMatches.join(", ");

  return {
    row_number: String(rowNum),
    asset_name: head.replace(/[\s,]+$/, ""),
    asset_type,
    asset_subtype: "",
    owner,
    value_range,
    income_type,
    income_range: "", // House v1: income amount columns are bleed-prone — honest empty
    location,
    description: descParts.join("; "),
    ticker: "",
  };
}

/** Parse the House Schedule D (Liabilities) region. "None disclosed." → [].
 *  Otherwise amount-anchored segmentation (Schedule D has no [XX] bracket to
 *  anchor on, so each block flushes on a complete "$X - $Y" amount range). */
function parseHouseLiabilities(region: string[]): Form278Liability[] {
  const filtered = region.filter((l) => !isHouseNoiseLine(l));
  if (filtered.length === 0) return [];
  // None-disclosed: a "none disclosed" marker AND no dollar amount anywhere.
  if (
    filtered.some((l) => /none disclosed/i.test(l)) &&
    !filtered.some((l) => /\$[\d,]/.test(l))
  ) {
    return [];
  }
  const blocks = segmentHouseLiabBlocks(region);
  return blocks.map((b, idx) => extractHouseLiability(b, idx + 1));
}

/** Extract one Form278Liability from a reconstructed block (array of lines).
 *  Schedule D column order: Owner | Creditor | Date Incurred | Type | Amount.
 *  The Date Incurred glues onto the creditor's trailing word ("Freedom
 *  Mortgage"+"September 2021"), so splitting the blob at the month-year gives
 *  creditor = before the date, liability_type = after (minus the amount). */
function extractHouseLiability(
  lines: string[],
  rowNum: number,
): Form278Liability {
  let location = "";
  const descParts: string[] = [];
  const headLines: string[] = [];

  for (const l of lines) {
    const loc = l.match(/^L\s*:\s*(.+)$/);
    if (loc) {
      location = squish(loc[1]!);
      continue;
    }
    const desc = l.match(/^[DC]\s*:\s*(.+)$/);
    if (desc) {
      descParts.push(squish(desc[1]!));
      continue;
    }
    headLines.push(l);
  }

  let blob = squish(headLines.join(" "));

  // Owner code (JT/SP/DC) leads the row, possibly glued onto the creditor or a
  // "$". "" = Self.
  let debtor = "";
  const ownerMatch = blob.match(/^(JT|SP|DC)(?=\$|[A-Z]|\s|$)/);
  if (ownerMatch) {
    debtor = ownerMatch[1]!;
    blob = blob.slice(ownerMatch[1]!.length).trim();
  }

  // Amount: complete "$X - $Y" range first (verbatim), else a bare "$X".
  let amount_range = "";
  const complete = blob.match(/\$[\d,]+(?:\.\d+)?\s*-\s*\$[\d,]+(?:\.\d+)?/);
  if (complete) {
    amount_range = squish(complete[0]);
    blob = (blob.slice(0, complete.index) + blob.slice(complete.index! + complete[0].length)).trim();
  } else {
    const bare = blob.match(/\$[\d,]+(?:\.\d+)?/);
    if (bare) {
      amount_range = squish(bare[0]);
      blob = (blob.slice(0, bare.index) + blob.slice(bare.index! + bare[0].length)).trim();
    }
  }

  // Date Incurred = the first date. Two source-observed formats:
  //   month-name + year ("September 2021", glued/lowercase "Cardmay 2010")
  //   numeric MM/DD/YYYY ("09/20/2020", glued "Bank09/20/2020")
  // NO \b prefix: the date can be glued onto the creditor's last word.
  let incurred = "";
  let creditor = blob;
  let liability_type = "";
  const dateMatch = blob.match(
    /(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i,
  );
  if (dateMatch) {
    incurred = squish(dateMatch[0]);
    creditor = blob.slice(0, dateMatch.index).trim();
    liability_type = blob.slice(dateMatch.index! + dateMatch[0].length).trim();
  }

  return {
    row_number: String(rowNum),
    incurred,
    debtor,
    liability_type: liability_type.replace(/[\s,]+$/, ""),
    rate_term: "",
    amount_range,
    creditor: creditor.replace(/[\s,]+$/, ""),
    location,
    comment: descParts.join("; "),
  };
}

/** Parse extracted House annual Form 278 PDF text into structured schedule
 *  content. Exported so it can be verified directly against a saved sample. */
export function parseHouseAnnualText(rawText: string): ParsedAnnualContent {
  // pdf-parse emits NUL (and other control bytes) as inter-glyph padding in the
  // form template — most visibly inside schedule headers ("S\0\0\0 A: A") and the
  // "L\0\0\0:"/"D\0\0\0:" field labels. Replace them with a SPACE (not empty) so
  // the wide spacing survives for the header-detection regexes; asset-name rows
  // carry no control bytes and are unaffected.
  const cleaned = rawText.replace(HOUSE_CONTROL_CHARS_RE, " ");
  const lines = cleaned.split("\n").map((l) => l.replace(/\s+$/, ""));

  // Schedule A (Assets): from "S  A: A" header to the IV footer / next header.
  const assetRegion = sliceHouseRegion(
    lines,
    /^S\s{2,}A:\s*A/,
    /^\*\s*Investment Vehicle/i,
  );
  const parseable = assetRegion.length > 0;
  if (!parseable) {
    return { assets: [], liabilities: [], parseable: false };
  }
  // None-disclosed assets: a noise-stripped region that is empty, or carries a
  // "none disclosed" marker with no [XX] bracket anywhere → no asset rows.
  const assetFiltered = assetRegion.filter((l) => !isHouseNoiseLine(l));
  const noAssets =
    assetFiltered.length === 0 ||
    (assetFiltered.some((l) => /none disclosed/i.test(l)) &&
      !assetFiltered.some((l) => /\[[A-Z0-9]{1,5}\]/.test(l)));
  const assets = noAssets
    ? []
    : segmentHouseAssetBlocks(assetRegion).map((b, idx) =>
        extractHouseAsset(b, idx + 1),
      );

  // Schedule D (Liabilities): from "S  D: L" header to the next header.
  const liabRegion = sliceHouseRegion(
    lines,
    /^S\s{2,}D:\s*L/,
    /^S\s{2,}[A-Z]:/,
  );
  const liabilities = parseHouseLiabilities(liabRegion);

  return { assets, liabilities, parseable: true };
}

/** Fetch + parse one annual filing's HTML content. Returns null on paper /
 *  unparseable views so the caller can link-out with an honest note. */
async function fetchSenateAnnualContent(
  session: { fetch: typeof fetch },
  reportUrl: string,
): Promise<ParsedAnnualContent | null> {
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await session.fetch(reportUrl, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Referer: CONFIG.SEARCH_URL,
    },
  });
  if (!res.ok) {
    console.error(`[form278]   view HTTP ${res.status} for ${reportUrl}`);
    return null;
  }
  const html = await res.text();
  const parsed = parseSenateAnnualHtml(html);
  return parsed.parseable ? parsed : null;
}

/** Truncate schedule arrays if a single filing's assets would blow past
 *  Firestore's 1MB doc cap. Real annuals top out around 100-200 assets; the
 *  cap here (600 assets / 200 liabilities) is a defensive ceiling, never hit
 *  in normal data. Returns whether truncation occurred. */
function capSchedules(content: ParsedAnnualContent): boolean {
  let truncated = false;
  const MAX_ASSETS = 600;
  const MAX_LIABS = 200;
  if (content.assets.length > MAX_ASSETS) {
    content.assets = content.assets.slice(0, MAX_ASSETS);
    truncated = true;
  }
  if (content.liabilities.length > MAX_LIABS) {
    content.liabilities = content.liabilities.slice(0, MAX_LIABS);
    truncated = true;
  }
  return truncated;
}

export interface ScrapeOptions {
  /** Rolling lookback in days from now. Ignored if startDate+endDate set. */
  lookbackDays?: number;
  /** Explicit window start (YYYY-MM-DD). Pairs with endDate. */
  startDate?: string;
  /** Explicit window end (YYYY-MM-DD, inclusive). Pairs with startDate. */
  endDate?: string;
  /** v1: when true, fetch + parse each electronic filing's Schedule A/C
   *  contents (one extra HTTP GET per filing). Paper filings are link-out
   *  only with a coverage note. Default false (metadata-only, v1A behavior). */
  parseContent?: boolean;
  /** HOUSE ONLY (backfill): enumerate exactly these House Clerk INDEX years
   *  (the index is keyed by covered year, not filing year) and ingest every
   *  report-family entry in them, ignoring the date window. */
  indexYears?: number[];
}

/** eFD URL subtypes that ship as scanned-image (paper) filings — no
 *  structured tables, link-out only, NO OCR in v1. */
function isPaperSubtype(subtype: string): boolean {
  return subtype.toLowerCase() === "paper";
}

const PAPER_COVERAGE_NOTE =
  "Filed on paper (scanned image). Schedule contents are not machine-parsed " +
  "in v1 — follow report_url to read the original. ~6.5% of Senate annual " +
  "filings are paper.";

const PARSE_SKIP_COVERAGE_NOTE =
  "Electronic filing whose schedule tables could not be parsed (unexpected " +
  "layout). Follow report_url to read the original.";

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
  const filings: Form278Filing[] = [];
  let parsedCount = 0;
  let paperCount = 0;

  for (const e of entries) {
    const { state, district } = parseOffice(e.office);
    const filingDateIso = toIsoDate(e.dateFiled);
    const reportType = inferReportType(e.reportSubtype);
    const reportUrl = `${CONFIG.EFD_BASE}${e.reportPath.startsWith("/") ? "" : "/"}${e.reportPath}`;

    const filing: Form278Filing = {
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
      report_url: reportUrl,
      scraped_at: scrapedAt,
    };

    if (options.parseContent) {
      if (isPaperSubtype(e.reportSubtype)) {
        filing.is_paper = true;
        filing.content_parsed = false;
        filing.coverage_note = PAPER_COVERAGE_NOTE;
        paperCount++;
      } else {
        let content: ParsedAnnualContent | null = null;
        try {
          content = await fetchSenateAnnualContent(session, reportUrl);
        } catch (err) {
          console.error(
            `[form278]   content fetch failed for ${filing.filing_id}: ${
              (err as Error).message
            }`,
          );
        }
        if (content) {
          const truncated = capSchedules(content);
          filing.assets = content.assets;
          filing.liabilities = content.liabilities;
          filing.asset_count = content.assets.length;
          filing.liability_count = content.liabilities.length;
          filing.content_parsed = true;
          if (truncated) filing.schedules_truncated = true;
          parsedCount++;
        } else {
          filing.content_parsed = false;
          filing.coverage_note = PARSE_SKIP_COVERAGE_NOTE;
        }
      }
    }

    filings.push(filing);
  }

  if (options.parseContent) {
    console.error(
      `[form278] Parsed ${filings.length} Senate Form 278 filings ` +
        `(${parsedCount} with schedule contents, ${paperCount} paper link-out)`,
    );
  } else {
    console.error(
      `[form278] Parsed ${filings.length} Senate Form 278 filings (metadata only)`,
    );
  }
  return filings;
}

// ──────────────────────────────────────────────────────────────────────────
//  House annual Form 278 scraper (v1, 2026-06-01)
//
//  Mirrors scrapeSenateForm278 but sources from the House Clerk's yearly XML
//  index instead of the Senate eFD search API. Two-stage pipeline:
//    1. GET /public_disc/financial-pdfs/{year}FD.xml — the SAME yearly index
//       house.ts uses for PTRs, but we filter to the ANNUAL-family filing
//       types instead of "P".
//    2. For each entry, GET /public_disc/financial-pdfs/{year}/{DocID}.pdf
//       (NOTE: financial-pdfs/, NOT ptr-pdfs/ — annual reports live in a
//       different directory than PTRs) and parse via parseHouseAnnualText.
//
//  Filing-type ingest set — established empirically + by primary-source PDF
//  self-labels (each PDF carries its own "Filing Type:" field):
//    A = "Amendment Report"        → parseable  (8/8 sampled)
//    C = "Candidate Report"        → parseable  (7/8 sampled)
//    H = "New Filer Report"        → parseable  (1/1 sampled)
//    T = "Terminated Filer Report" → parseable  (8/8 sampled)
//  EXCLUDED (not Form 278 disclosures — NOT silent omission):
//    D, W = cover letters to the Clerk ("Dear Mister Clerk:")
//    X    = "Financial Disclosure Extension Request" (no schedules)
//    E,B,G,O = scanned-image / blank filings (no extractable text)
//  report_type is derived per-PDF from the verbatim "Filing Type:" label
//  (robust to letter-vs-label drift), with a letter fallback.
// ──────────────────────────────────────────────────────────────────────────

const HOUSE_CONFIG = {
  USER_AGENT:
    process.env.HOUSE_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  XML_INDEX: (year: number): string =>
    `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`,
  /** Annual reports live under financial-pdfs/, NOT ptr-pdfs/ (which holds
   *  Periodic Transaction Reports). Confirmed HTTP 200 application/pdf. */
  PDF_URL: (year: number | string, docId: string): string =>
    `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}/${docId}.pdf`,
  RATE_LIMIT_MS: 300,
};

/** House FilingType letters in the Form 278 report family.
 *  O = annual original (the flagship member annual — 372 in the 2024 index
 *  alone; excluded until 2026-06-10, which was the House side's biggest
 *  coverage hole). A = amendment, C = candidate, H = new filer, T =
 *  termination. P (PTRs) and X/W/D/G/B/E (extensions, withdrawals, and other
 *  administrative paperwork) are intentionally out of scope. */
const HOUSE_FD_FILING_TYPES = new Set(["O", "A", "C", "H", "T"]);

const HOUSE_PARSE_SKIP_COVERAGE_NOTE =
  "House annual filing whose Schedule A could not be machine-parsed " +
  "(scanned image or unexpected layout). Follow report_url to read the original.";

interface HouseAnnualIndexEntry {
  first: string;
  last: string;
  prefix: string;
  state: string;
  state_district: string;
  filing_type: string; // single-letter code (A/C/H/T)
  filing_date: string; // MM/DD/YYYY from source
  doc_id: string;
  year: string;
  pdf_url: string;
}

/** Fetch the House Clerk yearly XML index and return the ANNUAL-family
 *  entries (FilingType ∈ {A,C,H,T}). Mirrors fetchHousePtrIndex but with the
 *  annual filing-type filter and the financial-pdfs PDF directory. */
async function fetchHouseAnnualIndex(
  year: number,
): Promise<HouseAnnualIndexEntry[]> {
  const url = HOUSE_CONFIG.XML_INDEX(year);
  console.error(`[form278] Fetching House FD XML index ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": HOUSE_CONFIG.USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`House FD XML index HTTP ${res.status} for ${year}`);
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

  const entries: HouseAnnualIndexEntry[] = [];
  for (const m of members) {
    const filingType = String(m.FilingType ?? "").trim();
    if (!HOUSE_FD_FILING_TYPES.has(filingType)) continue;
    const docId = String(m.DocID ?? "").trim();
    if (!docId) continue;
    const filingYear = String(m.Year ?? year).trim();
    const stateDst = String(m.StateDst ?? "").trim();
    entries.push({
      first: String(m.First ?? "").trim(),
      last: String(m.Last ?? "").trim(),
      prefix: String(m.Prefix ?? "").trim(),
      state: stateDst.replace(/\d+$/, ""),
      state_district: stateDst,
      filing_type: filingType,
      filing_date: String(m.FilingDate ?? "").trim(),
      doc_id: docId,
      year: filingYear,
      pdf_url: HOUSE_CONFIG.PDF_URL(filingYear, docId),
    });
  }
  console.error(
    `[form278] Found ${entries.length} report-family entries (O/A/C/H/T) in ${year} index`,
  );
  return entries;
}

/** Map a House filing's verbatim "Filing Type:" label (and letter fallback)
 *  to the Form278Filing report_type enum. Label-first so a letter-vs-label
 *  drift in the index can't mistype the record. */
function deriveHouseReportType(
  label: string,
  letter: string,
): Form278Filing["report_type"] {
  const l = label.toLowerCase();
  if (/amendment/.test(l)) return "Amendment";
  if (/new filer/.test(l)) return "New Filer";
  if (/terminat/.test(l)) return "Termination";
  if (/annual/.test(l)) return "Annual";
  if (/combined/.test(l)) return "Combined";
  if (/candidate/.test(l)) return "Other"; // no "Candidate" enum value
  switch (letter) {
    case "O": return "Annual";
    case "A": return "Amendment";
    case "H": return "New Filer";
    case "T": return "Termination";
    case "C": return "Other";
    default: return "Other";
  }
}

interface HouseHeaderFields {
  /** Verbatim "Filing Type:" self-label, e.g. "Amendment Report". */
  filingTypeLabel: string;
  /** Verbatim "Status:" value, e.g. "Member" / "Congressional Candidate". */
  status: string;
  /** Form's declared "Filing Year:" value as a number, or null. */
  filingYear: number | null;
}

/** Pull the header self-labels from a House FD PDF's text. The header block
 *  reads "...Name:Mr. X Status:Member State/District:WI08 F I Filing Type:New
 *  Filer Report Filing Year:2025 Filing Date:05/14/2025...". Whitespace is
 *  normalized first so the wide control-byte padding doesn't break the regexes. */
function extractHouseHeader(rawText: string): HouseHeaderFields {
  const norm = rawText
    .replace(HOUSE_CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const typeMatch = norm.match(/Filing Type:\s*(.+?)\s+Filing Year:/);
  const statusMatch = norm.match(/Status:\s*(.+?)\s+State\/District:/);
  const yearMatch = norm.match(/Filing Year:\s*(\d{4})/);
  return {
    filingTypeLabel: typeMatch ? squish(typeMatch[1]!) : "",
    status: statusMatch ? squish(statusMatch[1]!) : "",
    filingYear: yearMatch ? parseInt(yearMatch[1]!, 10) : null,
  };
}

/** Lazy pdf-parse loader (CommonJS interop), local to the House annual path. */
async function getHousePdfText(buf: ArrayBuffer): Promise<string> {
  const mod = (await import("pdf-parse")) as unknown as {
    default: (buffer: Buffer) => Promise<{ text: string }>;
  };
  const result = await mod.default(Buffer.from(buf));
  return result.text;
}

/** Resolve the [start,end] date window from ScrapeOptions, identical to the
 *  Senate path's resolution so both chambers honor the same flags. */
function resolveWindow(options: ScrapeOptions): {
  start: Date;
  end: Date;
  label: string;
} {
  if (options.startDate && options.endDate) {
    const start = parseIsoDateStrict(options.startDate, "startDate");
    const end = parseIsoDateStrict(options.endDate, "endDate");
    if (end < start) {
      throw new Error(
        `endDate (${options.endDate}) must be on or after startDate (${options.startDate})`,
      );
    }
    return { start, end, label: `${options.startDate} → ${options.endDate}` };
  }
  if (options.startDate || options.endDate) {
    throw new Error(
      "startDate and endDate must be provided together (or use lookbackDays)",
    );
  }
  const lookbackDays = options.lookbackDays ?? CONFIG.DEFAULT_LOOKBACK_DAYS;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - lookbackDays);
  return { start, end, label: `last ${lookbackDays} days` };
}

/** True when a House FD filing's MM/DD/YYYY filing date falls in [start,end]. */
function houseFilingInWindow(
  filingDateMMDDYYYY: string,
  start: Date,
  end: Date,
): boolean {
  const m = filingDateMMDDYYYY.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return false;
  const [, mm, dd, yyyy] = m;
  const filed = new Date(
    `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}T00:00:00Z`,
  );
  if (Number.isNaN(filed.getTime())) return false;
  // Compare on date only (inclusive of the end day).
  const endInclusive = new Date(end);
  endInclusive.setHours(23, 59, 59, 999);
  return filed >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) &&
    filed <= endInclusive;
}

export async function scrapeHouseForm278(
  options: ScrapeOptions = {},
): Promise<Form278Filing[]> {
  const { start, end, label } = options.indexYears
    ? { start: new Date(0), end: new Date(), label: `index years ${options.indexYears.join(", ")}` }
    : resolveWindow(options);
  console.error(`[form278] Starting House annual Form 278 feed (${label})...`);

  // The yearly index is keyed by the COVERED year, not the filing year —
  // annual originals for CY y live in the y index but are FILED in y+1
  // (verified 2026-06-10: a CY2024 "O" report carries FilingDate 4/29/2025 in
  // the 2024 index). So fetch one index year BEFORE the window start too, or
  // the May annual wave is invisible to a current-year window.
  const years: number[] = [];
  if (options.indexYears) {
    years.push(...options.indexYears);
  } else {
    for (let y = start.getFullYear() - 1; y <= end.getFullYear(); y++) years.push(y);
  }

  const indexEntries: HouseAnnualIndexEntry[] = [];
  for (const y of years) {
    try {
      const yearEntries = await fetchHouseAnnualIndex(y);
      indexEntries.push(...yearEntries);
    } catch (err) {
      console.error(
        `[form278]   House index ${y} failed: ${(err as Error).message}`,
      );
    }
  }

  const inWindow = options.indexYears
    ? indexEntries
    : indexEntries.filter((e) => houseFilingInWindow(e.filing_date, start, end));
  console.error(
    `[form278] ${inWindow.length} House annual filing(s) in scope ` +
      `(of ${indexEntries.length} report-family entries across ${years.join(", ")})`,
  );

  const scrapedAt = new Date().toISOString();
  const filings: Form278Filing[] = [];
  let parsedCount = 0;
  let skipCount = 0;

  for (const e of inWindow) {
    const filingDateIso = toIsoDate(e.filing_date);
    const district = e.state_district.replace(/^[A-Z]{2}/, "");
    const office = district
      ? `Representative, ${e.state}-${district}`
      : `Representative, ${e.state}`;

    // Letter-based report_type as the baseline; refined from the PDF's own
    // "Filing Type:" label once we fetch the body (parseContent path).
    let reportType = deriveHouseReportType("", e.filing_type);
    let reportSubtype = e.filing_type;
    let filingYear = guessFilingYear(filingDateIso, reportType);

    const filing: Form278Filing = {
      filing_id: `house-fd-${e.doc_id}`,
      source: "HOUSE_CLERK_FD",
      chamber: "house",
      member_name: `${e.first} ${e.last}`.trim(),
      member_first: e.first,
      member_last: e.last,
      bioguide_id: "",
      office,
      state: e.state,
      state_district: district,
      party: "",
      filing_year: filingYear,
      filing_date: filingDateIso,
      report_type: reportType,
      report_subtype: reportSubtype,
      report_url: e.pdf_url,
      scraped_at: scrapedAt,
    };

    if (options.parseContent) {
      let content: ParsedAnnualContent | null = null;
      try {
        await sleep(HOUSE_CONFIG.RATE_LIMIT_MS);
        const res = await fetch(e.pdf_url, {
          headers: { "User-Agent": HOUSE_CONFIG.USER_AGENT },
        });
        if (!res.ok) {
          console.error(
            `[form278]   PDF HTTP ${res.status} for ${filing.filing_id}`,
          );
        } else {
          const text = await getHousePdfText(await res.arrayBuffer());
          // Refine report_type / subtype / year from the PDF's own header.
          const header = extractHouseHeader(text);
          if (header.filingTypeLabel) {
            filing.report_type = deriveHouseReportType(
              header.filingTypeLabel,
              e.filing_type,
            );
            filing.report_subtype = header.filingTypeLabel;
          }
          if (header.filingYear) filing.filing_year = header.filingYear;
          const parsed = parseHouseAnnualText(text);
          if (parsed.parseable) content = parsed;
        }
      } catch (err) {
        console.error(
          `[form278]   content fetch/parse failed for ${filing.filing_id}: ${
            (err as Error).message
          }`,
        );
      }

      if (content) {
        const truncated = capSchedules(content);
        filing.assets = content.assets;
        filing.liabilities = content.liabilities;
        filing.asset_count = content.assets.length;
        filing.liability_count = content.liabilities.length;
        filing.content_parsed = true;
        if (truncated) filing.schedules_truncated = true;
        parsedCount++;
      } else {
        filing.content_parsed = false;
        filing.coverage_note = HOUSE_PARSE_SKIP_COVERAGE_NOTE;
        skipCount++;
      }
    }

    filings.push(filing);
  }

  if (options.parseContent) {
    console.error(
      `[form278] Parsed ${filings.length} House annual Form 278 filings ` +
        `(${parsedCount} with schedule contents, ${skipCount} link-out)`,
    );
  } else {
    console.error(
      `[form278] Discovered ${filings.length} House annual Form 278 filings (metadata only)`,
    );
  }
  return filings;
}
