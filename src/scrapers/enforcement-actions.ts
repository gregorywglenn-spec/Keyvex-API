/**
 * Enforcement actions scraper — SEC + DOJ press releases unified into
 * one EnforcementAction record stream.
 *
 * SEC source: RSS feed at sec.gov/news/pressreleases.rss
 *   - Rolling ~50-item window (no historical access via RSS — sec.gov
 *     HTML archive pages are v1.1 polish for historical backfill).
 *   - Title + description + pubDate + guid + link.
 *
 * DOJ source: JSON API at justice.gov/api/v1/press_releases.json
 *   - 266K+ historical records with paginated access.
 *   - Returns title, body (HTML-encoded), teaser, date (Unix), component,
 *     topic, url, uuid, number. We strip HTML from the body to get clean
 *     descriptions and cap at ~3000 chars (matches the v1A "metadata
 *     plus teaser" scope; full prose still lives at url).
 *
 * No auth required for either source. SEC has the EDGAR-style 10 req/sec
 * rate limit; DOJ JSON API has no documented limit but we throttle to be
 * a good citizen.
 */

import { XMLParser } from "fast-xml-parser";
import * as cheerio from "cheerio";
import type { EnforcementAction } from "../types.js";

const CONFIG = {
  USER_AGENT: process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  SEC_RSS_URL: "https://www.sec.gov/news/pressreleases.rss",
  DOJ_API_URL: "https://www.justice.gov/api/v1/press_releases.json",
  CFTC_INDEX_URL: "https://www.cftc.gov/PressRoom/PressReleases",
  OCC_INDEX_URL_TEMPLATE:
    "https://www.occ.treas.gov/news-issuances/news-releases/{year}/index-news-releases-{year}.html",
  FDIC_INDEX_URL: "https://www.fdic.gov/news/press-releases",
  FTC_RSS_URL: "https://www.ftc.gov/feeds/press-release.xml",
  /** Browser-style UA — FDIC and OCC are Drupal-fronted and reject bare bot UAs. */
  BROWSER_UA: "Mozilla/5.0 (compatible; KeyVexBot/1.0; +https://keyvex.com)",
  RATE_LIMIT_MS: 200,
  /** Max number of pages of DOJ records to pull per run (20 records / page).
   *  10 pages = 200 most-recent records, plenty for daily refresh. */
  DOJ_MAX_PAGES: 10,
  /** Cap description body at this many chars to keep Firestore docs slim. */
  BODY_MAX_CHARS: 3000,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Strip HTML tags + decode common HTML entities from a body excerpt. */
function stripHtml(html: string): string {
  if (!html) return "";
  // Replace block tags with whitespace before removing them so words stay separated.
  let text = html.replace(/<(p|br|li|div|h[1-6])[^>]*>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#039;|&apos;/g, "'");
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  text = text.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  // Collapse whitespace.
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Convert Unix timestamp string OR seconds OR ISO to YYYY-MM-DD. */
function toIsoDate(raw: string | number): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "number") {
    return new Date(raw * 1000).toISOString().split("T")[0]!;
  }
  // Numeric string?
  if (/^\d+$/.test(raw)) {
    return new Date(parseInt(raw, 10) * 1000).toISOString().split("T")[0]!;
  }
  // RSS pubDate like "Wed, 06 May 2026 19:24:19 -0400"
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split("T")[0]!;
  }
  return raw.slice(0, 10);
}

// ─── SEC RSS ───────────────────────────────────────────────────────────────

interface RssItem {
  title?: string;
  link?: string;
  description?: string;
  pubDate?: string;
  guid?: string | { "#text"?: string };
}

interface RssEnvelope {
  rss?: {
    channel?: {
      item?: RssItem | RssItem[];
    };
  };
}

const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

export async function scrapeSecEnforcementRss(): Promise<EnforcementAction[]> {
  const scrapedAt = new Date().toISOString();
  console.error("[sec enforcement] Fetching RSS feed...");
  await sleep(CONFIG.RATE_LIMIT_MS);
  const res = await fetch(CONFIG.SEC_RSS_URL, {
    headers: { "User-Agent": CONFIG.USER_AGENT, Accept: "application/rss+xml" },
  });
  if (!res.ok) {
    throw new Error(`SEC RSS HTTP ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parsed = rssParser.parse(xml) as RssEnvelope;
  const rawItems = parsed.rss?.channel?.item;
  const items: RssItem[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems
      ? [rawItems]
      : [];

  console.error(`[sec enforcement] RSS returned ${items.length} items`);
  const out: EnforcementAction[] = [];
  for (const item of items) {
    const guid =
      typeof item.guid === "string" ? item.guid : item.guid?.["#text"] ?? "";
    const link = item.link ?? "";
    // Use the URL slug as a stable ID when guid is missing/duplicate.
    const slug = link
      .replace(/^https?:\/\/[^/]+\//, "")
      .replace(/\/+$/, "")
      .replace(/[/?#&=]+/g, "-");
    const idCore = guid || slug;
    if (!idCore) continue;
    const action: EnforcementAction = {
      action_id: `sec-${idCore}`,
      source: "sec",
      title: (item.title ?? "").trim(),
      teaser: "",
      description: stripHtml(item.description ?? "").slice(
        0,
        CONFIG.BODY_MAX_CHARS,
      ),
      published_date: toIsoDate(item.pubDate ?? ""),
      url: link,
      agency_component: "",
      release_number: "",
      topics: [],
      scraped_at: scrapedAt,
    };
    out.push(action);
  }
  console.error(`[sec enforcement] Parsed ${out.length} actions`);
  return out;
}

// ─── DOJ JSON API ──────────────────────────────────────────────────────────

interface DojResult {
  uuid?: string;
  title?: string;
  body?: string;
  teaser?: string;
  date?: string | number;
  number?: string;
  url?: string;
  /** Variable shape in the wild: empty string, comma-separated string,
   *  single object {name, uuid}, array of those. normalizeDojTopic handles. */
  topic?: unknown;
  component?:
    | { uuid?: string; name?: string }
    | Array<{ uuid?: string; name?: string }>;
}

interface DojResponse {
  metadata?: {
    resultset?: { count?: string; pagesize?: number; page?: number };
  };
  results?: DojResult[];
}

function normalizeDojComponent(c: DojResult["component"]): string {
  if (!c) return "";
  if (Array.isArray(c)) return c.map((x) => x.name ?? "").filter(Boolean).join(", ");
  return c.name ?? "";
}

function normalizeDojTopic(t: unknown): string[] {
  if (!t) return [];
  // DOJ topic ships variably: empty string, comma-separated string,
  // single object {name: string, uuid: string}, or array of those objects.
  // Defensive against all observed shapes.
  if (typeof t === "string") {
    return t
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(t)) {
    return t
      .map((v) => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "name" in v) {
          return String((v as { name?: unknown }).name ?? "");
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof t === "object" && "name" in (t as Record<string, unknown>)) {
    const name = (t as { name?: unknown }).name;
    return name ? [String(name)] : [];
  }
  return [];
}

export interface ScrapeDojOptions {
  /** Number of pages (20 records each) to pull. Default DOJ_MAX_PAGES. */
  maxPages?: number;
}

export async function scrapeDojEnforcementApi(
  options: ScrapeDojOptions = {},
): Promise<EnforcementAction[]> {
  const scrapedAt = new Date().toISOString();
  const maxPages = options.maxPages ?? CONFIG.DOJ_MAX_PAGES;
  const out: EnforcementAction[] = [];

  console.error(
    `[doj enforcement] Fetching up to ${maxPages} pages of DOJ press releases...`,
  );
  for (let page = 0; page < maxPages; page++) {
    // sort=date&direction=DESC returns most-recent press releases first.
    // Without these the default order is oldest-first (records back to 2009).
    const url =
      `${CONFIG.DOJ_API_URL}?pagesize=20&page=${page}` +
      `&sort=date&direction=DESC`;
    await sleep(CONFIG.RATE_LIMIT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[doj enforcement] page ${page}: SKIP — ${msg}`);
      break;
    }
    if (!res.ok) {
      console.error(
        `[doj enforcement] page ${page}: HTTP ${res.status} ${res.statusText}, stopping`,
      );
      break;
    }
    const json = (await res.json()) as DojResponse;
    const results = json.results ?? [];
    if (results.length === 0) break;
    for (const r of results) {
      if (!r.uuid) continue;
      const action: EnforcementAction = {
        action_id: `doj-${r.uuid}`,
        source: "doj",
        title: stripHtml(r.title ?? "").trim(),
        teaser: stripHtml(r.teaser ?? "").slice(0, CONFIG.BODY_MAX_CHARS),
        description: stripHtml(r.body ?? "").slice(0, CONFIG.BODY_MAX_CHARS),
        published_date: toIsoDate(r.date ?? ""),
        url: r.url ?? "",
        agency_component: normalizeDojComponent(r.component),
        release_number: r.number ?? "",
        topics: normalizeDojTopic(r.topic),
        scraped_at: scrapedAt,
      };
      out.push(action);
    }
    console.error(
      `[doj enforcement] page ${page}: +${results.length} (running ${out.length})`,
    );
    if (results.length < 20) break; // last page
  }
  console.error(`[doj enforcement] Parsed ${out.length} actions`);
  return out;
}

// ─── CFTC (HTML index — no RSS, no API) ────────────────────────────────────

/**
 * CFTC has no RSS or JSON API for press releases as of 2026-05. The index
 * page at /PressRoom/PressReleases lists ~50 most-recent releases as
 * server-rendered HTML. Each row is one release with:
 *   - `<time datetime="ISO_TIMESTAMP">` for the date
 *   - `<a href="/PressRoom/PressReleases/<id>-<yr>">TITLE</a>` for the link
 *
 * v1A scope is metadata-only (title + date + URL + release number). The
 * full body would require a second fetch per release (~50 round trips).
 * Agents follow `url` for the prose. v1.1 polish: fetch body for the
 * top-5 most-recent enforcement-only releases.
 */
export async function scrapeCftcEnforcementHtml(): Promise<EnforcementAction[]> {
  const scrapedAt = new Date().toISOString();
  console.error("[cftc enforcement] Fetching index HTML...");
  await sleep(CONFIG.RATE_LIMIT_MS);

  const res = await fetch(CONFIG.CFTC_INDEX_URL, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "text/html",
    },
  });
  if (!res.ok) {
    throw new Error(`CFTC HTML HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  // The index lays out one release per <tr> with two <td>s — date then
  // link. We walk all rows and pair the date <time> with the next sibling
  // press-release link.
  const out: EnforcementAction[] = [];
  $("tr").each((_, row) => {
    const $row = $(row);
    const $time = $row.find("time[datetime]").first();
    const $link = $row
      .find('a[href*="/PressRoom/PressReleases/"]')
      .first();
    if ($time.length === 0 || $link.length === 0) return;

    const datetime = $time.attr("datetime") ?? "";
    const isoDate = datetime ? datetime.slice(0, 10) : "";
    const href = $link.attr("href") ?? "";
    const title = $link.text().trim();
    if (!isoDate || !href || !title) return;

    // Release number lives at the end of the URL slug (e.g. "9230-26"
    // for the 9230th release of fiscal year 2026). Use it as the stable
    // ID component.
    const releaseSlug = href.split("/").filter(Boolean).pop() ?? "";
    if (!releaseSlug) return;

    out.push({
      action_id: `cftc-${releaseSlug}`,
      source: "cftc",
      title,
      teaser: "",
      // v1A: body not extracted (would need per-release fetch).
      description: "",
      published_date: isoDate,
      url: href.startsWith("http")
        ? href
        : `https://www.cftc.gov${href}`,
      agency_component: "",
      release_number: releaseSlug,
      topics: [],
      scraped_at: scrapedAt,
    });
  });

  console.error(`[cftc enforcement] Parsed ${out.length} releases from index`);
  return out;
}

// ─── OCC (HTML index — Drupal, no RSS, browser-UA required) ───────────────

/**
 * OCC publishes news releases at /news-issuances/news-releases/<year>/.
 * The yearly index page mixes news releases (`nr-occ-...`, `nr-ia-...`)
 * with bulletins (`bulletins/...`). v1A keeps only news releases — the
 * bulletins are routine regulatory paperwork, not enforcement/news.
 *
 * Each row in the Drupal "usa-collection" template has:
 *   - `<li class="usa-collection__meta-item item-date">May 08, 2026</li>`
 *   - `<h3 class="usa-collection__heading"><a href="...">TITLE</a></h3>`
 *
 * The date format is "MMM DD, YYYY"; we parse via Date.parse() and emit ISO.
 *
 * OCC's CDN rejects bare `KeyVexMCP/...` User-Agent strings. Use the
 * configured browser-style UA defined in CONFIG.BROWSER_UA.
 */
export async function scrapeOccEnforcementHtml(
  year = new Date().getFullYear(),
): Promise<EnforcementAction[]> {
  const scrapedAt = new Date().toISOString();
  const url = CONFIG.OCC_INDEX_URL_TEMPLATE.replace(/\{year\}/g, String(year));
  console.error(`[occ enforcement] Fetching ${year} index HTML...`);
  await sleep(CONFIG.RATE_LIMIT_MS);

  const res = await fetch(url, {
    headers: { "User-Agent": CONFIG.BROWSER_UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`OCC HTML HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const out: EnforcementAction[] = [];
  // Each release sits inside a "usa-collection__item" <li>. The collection
  // structure puts the date <li> as a sibling of the heading <h3>, both
  // children of the wrapping <li>.
  $("li.usa-collection__item, .usa-collection__item, .item-list--news-release li").each(
    (_, el) => {
      const $el = $(el);
      const dateText = $el.find("li.item-date, .item-date").first().text().trim();
      const $link = $el.find("h3.usa-collection__heading a").first();
      if (!dateText || $link.length === 0) return;

      const href = $link.attr("href") ?? "";
      const title = $link.text().trim();
      if (!href || !title) return;
      // News-release filter: keep `nr-occ-` and `nr-ia-` (interagency), skip bulletins.
      if (
        !href.includes("/news-releases/") ||
        !(href.includes("/nr-occ-") || href.includes("/nr-ia-"))
      ) {
        return;
      }
      // Parse "May 08, 2026" → ISO. Fallback: leave empty.
      const parsed = new Date(dateText);
      const isoDate = Number.isNaN(parsed.getTime())
        ? ""
        : parsed.toISOString().split("T")[0]!;
      const slug = href
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/\.html?$/i, "") ?? "";
      if (!isoDate || !slug) return;

      out.push({
        action_id: `occ-${slug}`,
        source: "occ",
        title,
        teaser: "",
        description: "",
        published_date: isoDate,
        url: href.startsWith("http") ? href : `https://www.occ.treas.gov${href}`,
        agency_component: "",
        release_number: slug,
        topics: [],
        scraped_at: scrapedAt,
      });
    },
  );

  console.error(`[occ enforcement] Parsed ${out.length} news releases (${year})`);
  return out;
}

// ─── FDIC (HTML index — Drupal, no RSS, browser-UA required) ──────────────

/**
 * FDIC press releases at /news/press-releases. Drupal-fronted; no RSS.
 *
 * Each release sits inside an `<article class="node node--news node-teaser">`
 * with:
 *   - `<time datetime="ISO-DATE" itemprop="datePublished">DATE</time>`
 *   - `<p class="news-title"><a href="/news/press-releases/YYYY/SLUG"><span>TITLE</span></a></p>`
 *
 * Like OCC, FDIC's CDN rejects bare bot UA strings. Use BROWSER_UA.
 *
 * FDIC press releases include bank-failure announcements ("Anchor Bank
 * Assumes Insured Deposits of...") which are some of the most
 * agent-relevant FDIC items. v1A scope: title + date + URL only.
 */
export async function scrapeFdicEnforcementHtml(): Promise<EnforcementAction[]> {
  const scrapedAt = new Date().toISOString();
  console.error("[fdic enforcement] Fetching index HTML...");
  await sleep(CONFIG.RATE_LIMIT_MS);

  const res = await fetch(CONFIG.FDIC_INDEX_URL, {
    headers: { "User-Agent": CONFIG.BROWSER_UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(
      `FDIC HTML HTTP ${res.status} ${res.statusText} — ${CONFIG.FDIC_INDEX_URL}`,
    );
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const out: EnforcementAction[] = [];
  $("article.node--news").each((_, el) => {
    const $el = $(el);
    const datetime = $el.find("time[datetime]").first().attr("datetime") ?? "";
    const $link = $el
      .find('p.news-title a[rel="bookmark"]')
      .first();
    if (!datetime || $link.length === 0) return;

    const href = $link.attr("href") ?? "";
    // Title text is wrapped in <span>; .text() gets the unwrapped string either way.
    const title = $link.text().trim();
    if (!href || !title) return;

    const isoDate = datetime.slice(0, 10);
    const slug = href.split("/").filter(Boolean).pop() ?? "";
    if (!isoDate || !slug) return;

    out.push({
      action_id: `fdic-${slug}`,
      source: "fdic",
      title,
      teaser: "",
      description: "",
      published_date: isoDate,
      url: href.startsWith("http") ? href : `https://www.fdic.gov${href}`,
      agency_component: "",
      release_number: slug,
      topics: [],
      scraped_at: scrapedAt,
    });
  });

  console.error(`[fdic enforcement] Parsed ${out.length} press releases from index`);
  return out;
}

// ─── FTC RSS ───────────────────────────────────────────────────────────────

/**
 * FTC press release RSS feed. Structurally identical to SEC RSS — just a
 * different URL and namespace. Volume is ~5-15 items per week (focused on
 * antitrust, deceptive practices, merger reviews, and consumer protection
 * enforcement). Ideal cross-source pair with lobbying_filings (LDA HCR/MMM
 * issue codes) for merger-review tracking.
 */
export async function scrapeFtcEnforcementRss(): Promise<EnforcementAction[]> {
  const scrapedAt = new Date().toISOString();
  console.error("[ftc enforcement] Fetching RSS feed...");
  await sleep(CONFIG.RATE_LIMIT_MS);

  const res = await fetch(CONFIG.FTC_RSS_URL, {
    headers: {
      "User-Agent": CONFIG.USER_AGENT,
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });
  if (!res.ok) {
    throw new Error(
      `FTC RSS HTTP ${res.status} ${res.statusText} — ${CONFIG.FTC_RSS_URL}`,
    );
  }
  const xml = await res.text();
  const parsed = rssParser.parse(xml) as RssEnvelope;
  const itemsRaw = parsed.rss?.channel?.item;
  const items = Array.isArray(itemsRaw) ? itemsRaw : itemsRaw ? [itemsRaw] : [];
  console.error(`[ftc enforcement] Parsed ${items.length} RSS items`);

  const out: EnforcementAction[] = [];
  for (const item of items) {
    const link = item.link ?? "";
    const guid =
      typeof item.guid === "string"
        ? item.guid
        : (item.guid?.["#text"] ?? "");
    // Use the FTC's url slug as the action_id (stable across re-pulls).
    const slug = link
      ? link.split("/").filter(Boolean).slice(-1)[0] ?? ""
      : guid;
    if (!slug) continue;
    const desc = stripHtml(item.description ?? "");
    out.push({
      action_id: `ftc-${slug}`,
      source: "ftc",
      title: (item.title ?? "").trim(),
      teaser: desc.slice(0, 300),
      description: desc.slice(0, CONFIG.BODY_MAX_CHARS),
      published_date: toIsoDate(item.pubDate ?? ""),
      url: link,
      agency_component: "",
      release_number: slug,
      topics: [],
      scraped_at: scrapedAt,
    });
  }
  return out;
}

// ─── Combined entry point ──────────────────────────────────────────────────

export interface ScrapeEnforcementOptions {
  /** Number of DOJ pages to pull. Default 10 (= 200 most-recent records). */
  dojMaxPages?: number;
  /** When true, skip the SEC RSS fetch. Default false. */
  skipSec?: boolean;
  /** When true, skip the DOJ JSON fetch. Default false. */
  skipDoj?: boolean;
  /** When true, skip the CFTC HTML index fetch. Default false. */
  skipCftc?: boolean;
  /** When true, skip the OCC HTML index fetch. Default false. */
  skipOcc?: boolean;
  /** When true, skip the FDIC HTML index fetch. Default false. */
  skipFdic?: boolean;
  /** When true, skip the FTC RSS fetch. Default false. */
  skipFtc?: boolean;
}

export async function scrapeEnforcementActions(
  options: ScrapeEnforcementOptions = {},
): Promise<EnforcementAction[]> {
  const all: EnforcementAction[] = [];
  if (!options.skipSec) {
    try {
      const sec = await scrapeSecEnforcementRss();
      all.push(...sec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] SEC RSS FAILED — ${msg}`);
    }
  }
  if (!options.skipDoj) {
    try {
      const doj = await scrapeDojEnforcementApi({
        ...(options.dojMaxPages !== undefined && { maxPages: options.dojMaxPages }),
      });
      all.push(...doj);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] DOJ API FAILED — ${msg}`);
    }
  }
  if (!options.skipCftc) {
    try {
      const cftc = await scrapeCftcEnforcementHtml();
      all.push(...cftc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] CFTC HTML FAILED — ${msg}`);
    }
  }
  if (!options.skipOcc) {
    try {
      const occ = await scrapeOccEnforcementHtml();
      all.push(...occ);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] OCC HTML FAILED — ${msg}`);
    }
  }
  if (!options.skipFdic) {
    try {
      const fdic = await scrapeFdicEnforcementHtml();
      all.push(...fdic);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] FDIC HTML FAILED — ${msg}`);
    }
  }
  if (!options.skipFtc) {
    try {
      const ftc = await scrapeFtcEnforcementRss();
      all.push(...ftc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[enforcement] FTC RSS FAILED — ${msg}`);
    }
  }
  console.error(
    `[enforcement] TOTAL: ${all.length} actions across SEC / DOJ / CFTC / OCC / FDIC / FTC`,
  );
  return all;
}
