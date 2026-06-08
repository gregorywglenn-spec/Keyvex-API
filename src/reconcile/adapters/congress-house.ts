/**
 * Source Adapter: Congress — House (PTR filings).
 *
 * The FIRST adapter and the template for all others (per
 * docs/KEYVEX-RECONCILIATION-SYSTEM.md). It supplies the five things the
 * generic Reconciler needs; everything else is shared framework code.
 *
 * Authoritative denominator: the House Clerk yearly XML index
 * (`{year}FD.xml`), filtered to FilingType="P" — every Periodic Transaction
 * Report the Clerk publicly lists. KeyVex stores these in `congressional_trades`
 * with `ptr_id` = the Clerk DocID and `chamber` = "house".
 *
 * expectedTypes is buy / sell / exchange ON PURPOSE: the current parser drops
 * Exchange ("E") rows, so the per-type census will show exchange = 0 — exactly
 * the silent category hole the benchmark (G2) exists to surface.
 */

import {
  fetchHousePtrIndex,
  type PtrIndexEntry,
} from "../../scrapers/house.js";
import type { MissingClass, ReconContext, SourceAdapter, SourceItem } from "../types.js";

const UA = process.env.HOUSE_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";

/**
 * Years to scan. House PTR electronic filing began in 2012; we scan from there
 * through next year so a freshly-filed current-year PTR is in the denominator.
 * Override on the CLI with --years. Scanning a generous range (rather than just
 * the data's own span) is deliberate: if the Clerk has 2012–2013 PTRs that
 * KeyVex never ingested, those are real gaps that must surface, not be hidden
 * by a narrow window.
 */
function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = 2012; y <= end; y++) out.push(y);
  return out;
}

let pdfText:
  | ((b: ArrayBuffer) => Promise<{ text: string }>)
  | null = null;
async function getPdfText() {
  if (pdfText) return pdfText;
  const m = (await import("pdf-parse")) as unknown as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  pdfText = async (b: ArrayBuffer) => m.default(Buffer.from(b));
  return pdfText;
}

export const congressHouseAdapter: SourceAdapter = {
  name: "congress-house",
  title: "Congress — House PTR filings (House Clerk index)",
  collection: "congressional_trades",
  keyvexIdField: "ptr_id",
  typeField: "transaction_type",
  expectedTypes: ["buy", "sell", "exchange"],
  keyvexFilter: { field: "chamber", op: "==", value: "house" },

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const items: SourceItem[] = [];
    for (const year of years) {
      let index: PtrIndexEntry[];
      try {
        index = await fetchHousePtrIndex(year);
      } catch (e) {
        // A single year's index failing must NOT blank the census — surface it.
        const msg = e instanceof Error ? e.message : String(e);
        ctx.warn(`House index ${year} unavailable (${msg}) — year omitted from denominator`);
        continue;
      }
      for (const p of index) {
        items.push({
          id: p.doc_id,
          url: p.pdf_url,
          label: `${p.first} ${p.last}`.trim() + (p.state_district ? ` (${p.state_district})` : ""),
          meta: { year: p.year || String(year) },
        });
      }
    }
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  /**
   * Classify one missing PTR by fetching its PDF (opt-in; one round-trip each).
   * Conservative: only 404 ("gone") and an explicit "nothing to report" page
   * ("nil") count as legitimate reasons we don't have it. Everything else —
   * including a scanned PDF with no text layer — is "recoverable" (a true gap
   * to close), because a missing text layer means OCR can recover it, not that
   * the filing is empty. This keeps unexplained-missing honest rather than
   * letting real gaps hide as "unreadable".
   */
  async classifyMissing(item: SourceItem): Promise<MissingClass> {
    let buf: ArrayBuffer;
    try {
      const res = await fetch(item.url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return "gone";
      if (!res.ok) return "unclassified";
      buf = await res.arrayBuffer();
    } catch {
      return "unclassified";
    }
    let text = "";
    try {
      const r = await (await getPdfText())(buf);
      text = r.text ?? "";
    } catch {
      // pdf-parse choke = strong scanned-PDF signal = recoverable via OCR
      return "recoverable";
    }
    if (!text.trim()) return "recoverable"; // no text layer → scanned → OCR-recoverable
    if (/nothing to report|no reportable|no transactions/i.test(text)) {
      return "nil";
    }
    // Has a real text layer with content — if we don't have it, it's a true gap.
    return "recoverable";
  },
};
