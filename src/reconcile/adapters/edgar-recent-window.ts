/**
 * Factory: recent-window EDGAR completeness adapter.
 *
 * For SEC-form feeds that ACCUMULATE via a daily/hourly cron (8-K, Form 144,
 * Form 3, 13D/G, DEF 14A) rather than mirror all history, the meaningful gauge
 * is NOT "all of EDGAR" — it's "does the cron capture EVERYTHING in its recent
 * window, or does it leak?" Several of these crons enumerate via EDGAR
 * full-text search, which silently caps/under-reports (the exact N-PORT / Form D
 * failure mode). This adapter enumerates the COMPLETE EDGAR daily index for the
 * last N days and diffs against KeyVex:
 *
 *   coverage% = recent-window completeness (target ~100%)
 *   missing   = the specific recent filings the cron leaked (with EDGAR links)
 *   extra     = every older record KeyVex holds — EXPECTED and ignored here
 *               (the collection spans years; only the recent window is the test)
 *
 * Note on doc-id matching: KeyVex stores the dashed accession (e.g.
 * 0001234567-26-000123); EDGAR's daily index emits the same dashed form, so
 * ids line up. If coverage reads ~0%, suspect a format mismatch, not a leak.
 */

import { fetchEdgarDailyIndex, edgarFilingUrl } from "../sec-edgar-index.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

export interface EdgarRecentOptions {
  name: string;
  title: string;
  collection: string;
  keyvexIdField: string;
  /** EDGAR form codes as they appear in the daily index (e.g. ["8-K","8-K/A"]). */
  forms: string[];
  /** How many days back to check. Default 30. */
  days?: number;
  keyvexFilter?: SourceAdapter["keyvexFilter"];
}

export function makeEdgarRecentWindowAdapter(
  opts: EdgarRecentOptions,
): SourceAdapter {
  const days = opts.days ?? 30;
  return {
    name: opts.name,
    title: opts.title,
    collection: opts.collection,
    keyvexIdField: opts.keyvexIdField,
    keyvexFilter: opts.keyvexFilter,

    async sourceIds(_ctx: ReconContext): Promise<SourceItem[]> {
      const seen = new Map<string, SourceItem>();
      for (let i = 0; i <= days; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const day = d.toISOString().split("T")[0] ?? "";
        if (!day) continue;
        let filings: Awaited<ReturnType<typeof fetchEdgarDailyIndex>>;
        try {
          filings = await fetchEdgarDailyIndex(day, opts.forms);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${opts.name}] daily-index ${day}: SKIP — ${msg}`);
          continue;
        }
        for (const f of filings) {
          if (!opts.forms.includes(f.formType)) continue;
          if (!seen.has(f.accession)) {
            seen.set(f.accession, {
              id: f.accession,
              url: edgarFilingUrl(f.cik, f.accession),
              label: `${f.company} (${f.formType})`,
              meta: { year: f.dateFiled.slice(0, 4) },
            });
          }
        }
      }
      console.error(
        `[${opts.name}] enumerated ${seen.size} ${opts.forms.join("/")} filings over last ${days}d`,
      );
      return Array.from(seen.values());
    },

    sourceUrl(item: SourceItem): string {
      return item.url;
    },
  };
}
