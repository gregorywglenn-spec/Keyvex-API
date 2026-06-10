/**
 * Source Adapter: Form 278 — annual financial disclosures (Senate eFD + House Clerk).
 *
 * Collection: `annual_financial_disclosures`, keyed by `filing_id`:
 *   - Senate: `senate-{subtype}-{reportId}`  (eFD /search/view/{subtype}/{id}/)
 *   - House:  `house-fd-{docId}`             (House Clerk yearly FD XML index)
 *
 * DENOMINATOR — independent enumeration, two source quirks verified 2026-06-10:
 *   1. Senate eFD `submitted_end_date` is EXCLUSIVE (a [d, d] same-day window
 *      returns 0 rows; [d, d+1] returns d's filings). All windows here are
 *      half-open [start, end). The first version of this adapter bisected with
 *      inclusive ends and silently dropped every midpoint day — the tell was
 *      172 "extras" clustering on exactly three mass-filing days. Pagination
 *      (start/length) IS honored for this query shape (verified: single-day
 *      paging + the 2016-2025 backfill's complete 2024 year), so windows are
 *      simply paged to recordsFiltered; no bisection needed.
 *   2. House: the scraper scopes to FilingType ∈ {A,C,H,T} — it EXCLUDES "O"
 *      (the member annual original, the flagship category; 372 entries in the
 *      2024 index alone). The denominator here includes {O,A,C,H,T} so the
 *      per-type diff makes that scope hole visible instead of inheriting it.
 *
 * `--years` = calendar years. Senate side scans 2012+ (eFD electronic floor);
 * House side scans 2015+ (collection floor) — both bounded by --years if given.
 */

import { XMLParser } from "fast-xml-parser";
import { createSession } from "../../scrapers/senate.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const UA = process.env.SENATE_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const EFD_BASE = "https://efdsearch.senate.gov";
const DATA_URL = `${EFD_BASE}/search/report/data/`;
const SEARCH_URL = `${EFD_BASE}/search/`;
const REPORT_TYPES_ANNUAL = [7, 8, 9, 12];
const RATE_LIMIT_MS = 300;

const SENATE_START_YEAR = 2012;
const HOUSE_START_YEAR = 2015;
/** House FD report-family filing types (O = annual original; P/X/W/etc. are
 *  PTRs and administrative paperwork, out of the Form 278 report family). */
const HOUSE_FD_TYPES = new Set(["O", "A", "C", "H", "T"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type EfdSession = Awaited<ReturnType<typeof createSession>>;

interface EfdRow {
  id: string;
  url: string;
  label: string;
  year: string;
  subtype: string;
}

async function fetchEfdPage(
  session: EfdSession,
  startISO: string,
  endExclusiveISO: string,
  offset: number,
): Promise<{ rows: EfdRow[]; recordsFiltered: number }> {
  const fmt = (iso: string): string => {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y} 00:00:00`;
  };
  const body = new FormData();
  body.append("start", String(offset));
  body.append("length", "100");
  body.append("report_types", `[${REPORT_TYPES_ANNUAL.join(",")}]`);
  body.append("submitted_start_date", fmt(startISO));
  body.append("submitted_end_date", fmt(endExclusiveISO));
  body.append("candidate_state", "");
  body.append("senator_state", "");
  body.append("first_name", "");
  body.append("last_name", "");
  body.append("csrfmiddlewaretoken", session.csrfToken);

  await sleep(RATE_LIMIT_MS);
  const res = await session.fetch(DATA_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Origin: EFD_BASE,
      Referer: SEARCH_URL,
      "X-CSRFToken": session.csrfToken,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!res.ok) throw new Error(`eFD data HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: unknown[][];
    recordsFiltered?: number;
    recordsTotal?: number;
  };
  const raw = Array.isArray(json.data) ? json.data : [];
  const rows: EfdRow[] = [];
  for (const row of raw) {
    const first = String(row[0] ?? "").trim();
    const last = String(row[1] ?? "").trim();
    const linkHtml = String(row[3] ?? "");
    const dateFiled = String(row[4] ?? "").trim();
    const linkMatch = linkHtml.match(/href=['"]([^'"]+)['"]/);
    if (!linkMatch) continue;
    const path = linkMatch[1] ?? "";
    const m = path.match(/\/search\/view\/([a-z0-9_-]+)\/([a-f0-9-]+)\/?/i);
    if (!m) continue;
    const subtype = m[1] ?? "";
    const reportId = m[2] ?? "";
    rows.push({
      id: `senate-${subtype}-${reportId}`,
      url: path.startsWith("http") ? path : `${EFD_BASE}${path}`,
      label: `${first} ${last}`.trim(),
      year: dateFiled.match(/(\d{4})/)?.[1] ?? "",
      subtype,
    });
  }
  return { rows, recordsFiltered: json.recordsFiltered ?? json.recordsTotal ?? raw.length };
}

/** Enumerate one half-open window [start, endExclusive) completely by paging
 *  start/length to recordsFiltered. A page of already-seen ids (the FEC-style
 *  stuck-pagination failure) breaks with a warning instead of looping. */
async function enumerateWindow(
  session: EfdSession,
  startISO: string,
  endExclusiveISO: string,
  out: Map<string, EfdRow>,
  ctx: ReconContext,
): Promise<void> {
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const { rows, recordsFiltered } = await fetchEfdPage(session, startISO, endExclusiveISO, offset);
    total = recordsFiltered;
    if (rows.length === 0) break;
    const before = out.size;
    for (const r of rows) if (!out.has(r.id)) out.set(r.id, r);
    if (out.size === before && offset > 0) {
      ctx.warn(`eFD pagination stuck at offset ${offset} for ${startISO}..${endExclusiveISO} — breaking`);
      break;
    }
    offset += rows.length;
    if (offset > 20000) {
      ctx.warn(`eFD window ${startISO}..${endExclusiveISO} exceeded 20k rows — breaking for safety`);
      break;
    }
  }
  if (Number.isFinite(total) && offset < total) {
    ctx.warn(
      `eFD window ${startISO}..${endExclusiveISO} collected ${offset} of ${total} — possible undercount`,
    );
  }
}

async function senateSourceIds(years: number[], ctx: ReconContext): Promise<SourceItem[]> {
  let session = await createSession();
  const out = new Map<string, EfdRow>();
  for (const y of years) {
    // half-open quarter windows: [Q start, next-Q start) — no dropped boundary
    // days (eFD's submitted_end_date is EXCLUSIVE)
    const quarters: [string, string][] = [
      [`${y}-01-01`, `${y}-04-01`],
      [`${y}-04-01`, `${y}-07-01`],
      [`${y}-07-01`, `${y}-10-01`],
      [`${y}-10-01`, `${y + 1}-01-01`],
    ];
    for (const [ws, we] of quarters) {
      try {
        await enumerateWindow(session, ws, we, out, ctx);
      } catch (err) {
        // one session-recreate retry (the agreement session can lapse)
        console.error(`[form278] window ${ws}..${we} failed (${(err as Error).message}); recreating session`);
        try {
          session = await createSession();
          await enumerateWindow(session, ws, we, out, ctx);
        } catch (err2) {
          ctx.warn(`Senate eFD window ${ws}..${we} failed twice: ${(err2 as Error).message}`);
        }
      }
    }
    console.error(`[form278] senate ${y}: running total ${out.size}`);
  }
  return [...out.values()].map((r) => ({
    id: r.id,
    url: r.url,
    label: r.label,
    meta: { year: r.year, type: `senate-${r.subtype}` },
  }));
}

async function houseSourceIds(years: number[], ctx: ReconContext): Promise<SourceItem[]> {
  const parser = new XMLParser({
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    ignoreAttributes: true,
  });
  const items: SourceItem[] = [];
  for (const y of years) {
    try {
      const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}FD.xml`;
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const parsed = parser.parse(xml) as {
        FinancialDisclosure?: { Member?: Record<string, string>[] | Record<string, string> };
      };
      const raw = parsed.FinancialDisclosure?.Member ?? [];
      const members = Array.isArray(raw) ? raw : [raw];
      let kept = 0;
      for (const m of members) {
        const t = String(m.FilingType ?? "").trim();
        if (!HOUSE_FD_TYPES.has(t)) continue;
        const docId = String(m.DocID ?? "").trim();
        if (!docId) continue;
        const fy = String(m.Year ?? y).trim();
        items.push({
          id: `house-fd-${docId}`,
          url: `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${fy}/${docId}.pdf`,
          label: `${String(m.First ?? "").trim()} ${String(m.Last ?? "").trim()}`.trim(),
          meta: {
            year: String(m.FilingDate ?? "").match(/(\d{4})/)?.[1] ?? String(y),
            type: `house-${t}`,
          },
        });
        kept++;
      }
      console.error(`[form278] house ${y} index: ${kept} report-family entries (of ${members.length})`);
    } catch (err) {
      ctx.warn(`House FD index ${y} failed: ${(err as Error).message}`);
    }
  }
  return items;
}

export const form278Adapter: SourceAdapter = {
  name: "form278",
  title: "Form 278 — annual financial disclosures (Senate eFD + House Clerk FD index)",
  collection: "annual_financial_disclosures",
  keyvexIdField: "filing_id",
  typeField: "report_type",
  expectedTypes: ["Annual", "New Filer", "Termination", "Combined", "Amendment", "Other"],

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const now = new Date().getUTCFullYear();
    const all = ctx.years && ctx.years.length > 0 ? ctx.years : undefined;
    const senateYears = (all ?? range(SENATE_START_YEAR, now)).filter((y) => y >= SENATE_START_YEAR);
    const houseYears = (all ?? range(HOUSE_START_YEAR, now)).filter((y) => y >= HOUSE_START_YEAR);

    const house = await houseSourceIds(houseYears, ctx);
    const senate = await senateSourceIds(senateYears, ctx);
    console.error(`[form278] denominator: ${senate.length} senate + ${house.length} house`);
    return [...senate, ...house];
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let y = a; y <= b; y++) out.push(y);
  return out;
}
