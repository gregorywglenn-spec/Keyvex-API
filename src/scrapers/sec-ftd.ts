/**
 * SEC Fails-to-Deliver (FTD) scraper.
 *
 * The SEC publishes bi-monthly zip files at sec.gov/files/data/fails-deliver-data/
 * containing daily settlement-failure records. Each row is one ticker / one
 * settlement date where a clearing-member's short sale failed to deliver
 * shares on T+1 (now T+0 after May 2024 settlement-cycle change).
 *
 * Signal value: persistent FTDs are a contrarian short-squeeze leading
 * indicator. When FTDs spike on a ticker, it often means:
 *   - Naked short selling overwhelming locate supply
 *   - Settlement / locate failure under heavy short pressure
 *   - Potential for squeeze if longs demand delivery
 *
 * Related to Reg SHO Threshold Securities (FTDs > 0.5% of issued shares
 * for 5+ days = ticker lands on threshold list, hard borrow requirements).
 *
 * URL pattern: cnsfails<YYYYMM><a|b>.zip
 *   - 'a' = first half of month (settlement dates 1-15)
 *   - 'b' = second half (settlement dates 16-EOM)
 * Each file is ~1MB compressed / ~3MB plain, ~30K rows pipe-delimited:
 *   SETTLEMENT DATE | CUSIP | SYMBOL | QUANTITY (FAILS) | DESCRIPTION | PRICE
 *
 * v1A scope: most-recent half-month zip pulled weekly. Older zips can be
 * backfilled via CLI with explicit year/month/half.
 */

import AdmZip from "adm-zip";
import type { SecFailToDeliver } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  BASE_URL: "https://www.sec.gov/files/data/fails-deliver-data",
  RATE_LIMIT_MS: 200,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert YYYYMMDD to ISO YYYY-MM-DD. */
function isoDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Decrement a (year, month, half) tuple by one half-month. */
function priorHalf(t: { year: number; month: number; half: "a" | "b" }): {
  year: number;
  month: number;
  half: "a" | "b";
} {
  if (t.half === "b") return { ...t, half: "a" };
  // half === "a" → prior month's "b"
  if (t.month === 1) return { year: t.year - 1, month: 12, half: "b" };
  return { year: t.year, month: t.month - 1, half: "b" };
}

/** Resolve the current "publishable" half-month. SEC posts each half about
 *  2-3 weeks behind, so we start a generous distance back and let the scraper
 *  walk forward via the auto-fallback in fetch when the target 404s. */
function resolveCurrentHalf(): { year: number; month: number; half: "a" | "b" } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 20);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (day > 15) return { year, month, half: "a" };
  if (month === 1) return { year: year - 1, month: 12, half: "b" };
  return { year, month: month - 1, half: "b" };
}

/** Parse one half-month FTD text file (pipe-delimited) into rows. */
function parseFtdText(text: string, scrapedAt: string): SecFailToDeliver[] {
  const lines = text.split(/\r?\n/);
  // First line is the header — skip if it contains "SETTLEMENT".
  const startIdx = lines[0]?.toUpperCase().includes("SETTLEMENT") ? 1 : 0;
  const out: SecFailToDeliver[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 6) continue;
    const [settle, cusip, symbol, qtyRaw, desc, priceRaw] = parts;
    if (!settle || !cusip || !symbol) continue;
    const settlementDate = isoDate(settle.trim());
    if (!settlementDate) continue;
    const cleanSymbol = symbol.trim().toUpperCase();
    const cleanCusip = cusip.trim();
    const docId = `${settlementDate}-${cleanCusip}`;
    const quantity = qtyRaw ? parseInt(qtyRaw.trim(), 10) : 0;
    const price = priceRaw ? parseFloat(priceRaw.trim()) : 0;
    out.push({
      id: docId,
      settlement_date: settlementDate,
      cusip: cleanCusip,
      ticker: cleanSymbol,
      description: (desc ?? "").trim(),
      quantity_fails: Number.isFinite(quantity) ? quantity : 0,
      price: Number.isFinite(price) ? price : 0,
      fail_value: Number.isFinite(quantity) && Number.isFinite(price)
        ? quantity * price
        : 0,
      year_month: `${settle.slice(0, 4)}-${settle.slice(4, 6)}`,
      source_url: `${CONFIG.BASE_URL}`,
      scraped_at: scrapedAt,
    });
  }
  return out;
}

// ─── Public scraper ─────────────────────────────────────────────────────────

export interface ScrapeFtdOptions {
  /** Year (e.g., 2026). Default: most recent published half-month. */
  year?: number;
  /** Month (1-12). Default: most recent published. */
  month?: number;
  /** "a" (first half) or "b" (second half). Default: most recent. */
  half?: "a" | "b";
}

export async function scrapeSecFailsToDeliver(
  options: ScrapeFtdOptions = {},
): Promise<SecFailToDeliver[]> {
  const scrapedAt = new Date().toISOString();

  // Target half-month. When all three options are supplied, no fallback.
  // When omitted, walk backward through up to 6 half-months (= 3 months)
  // to handle SEC's variable 2-3 week posting lag.
  let target: { year: number; month: number; half: "a" | "b" } =
    options.year !== undefined && options.month !== undefined && options.half
      ? { year: options.year, month: options.month, half: options.half }
      : resolveCurrentHalf();
  const userSupplied =
    options.year !== undefined && options.month !== undefined && options.half;
  const maxFallback = userSupplied ? 1 : 6;

  for (let attempt = 0; attempt < maxFallback; attempt++) {
    const monthStr = String(target.month).padStart(2, "0");
    const fileName = `cnsfails${target.year}${monthStr}${target.half}.zip`;
    const url = `${CONFIG.BASE_URL}/${fileName}`;
    console.error(`[sec-ftd] Fetching ${url}`);

    await sleep(CONFIG.RATE_LIMIT_MS);
    const res = await fetch(url, {
      headers: {
        "User-Agent": CONFIG.USER_AGENT,
        Accept: "application/octet-stream",
      },
    });
    if (res.status === 404) {
      console.error(
        `[sec-ftd]   ${fileName} not yet published; trying prior half`,
      );
      target = priorHalf(target);
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `SEC FTD HTTP ${res.status} ${res.statusText} for ${fileName}`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    console.error(`[sec-ftd] Downloaded ${buf.length} bytes; unzipping`);

    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    if (entries.length === 0) {
      console.error(`[sec-ftd] WARN: zip is empty`);
      return [];
    }
    const entry = entries[0]!;
    const text = entry.getData().toString("utf8");
    const records = parseFtdText(text, scrapedAt);
    console.error(
      `[sec-ftd] Parsed ${records.length} FTD rows for ${target.year}-${monthStr}${target.half}`,
    );
    return records;
  }

  throw new Error(
    `SEC FTD: no published half-month found after ${maxFallback} fallback attempts`,
  );
}
