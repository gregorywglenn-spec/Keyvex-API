/**
 * Source Adapter: SEC Schedule TO — tender offers.
 *
 * First SEC-EDGAR-full-index adapter. The authoritative denominator is every
 * SC TO-T / SC TO-T/A / SC TO-I / SC TO-I/A filing in EDGAR's quarterly master
 * index (2001 → present). KeyVex stores these in `tender_offers` keyed by
 * `accession_number` (dashed, matching EDGAR). Excludes SC TO-C
 * (pre-commencement communications), which KeyVex deliberately does not carry.
 *
 * Census-appropriate: Schedule TO filings are meant to be captured completely,
 * so G1 coverage is a true measure (unlike curated subsets like 13F's tracked
 * funds).
 */

import {
  fetchEdgarFilingsByForm,
  edgarFilingUrl,
} from "../sec-edgar-index.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

// Exactly the four KeyVex carries (see src/scrapers/tender-offers.ts FORM_CODES).
const FORMS = ["SC TO-T", "SC TO-T/A", "SC TO-I", "SC TO-I/A"];

// EDGAR full-text era (and KeyVex's own coverage) begins 2001.
function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = 2001; y <= end; y++) out.push(y);
  return out;
}

export const secTenderOffersAdapter: SourceAdapter = {
  name: "sec-tender-offers",
  title: "SEC Schedule TO — tender offers (EDGAR full-index)",
  collection: "tender_offers",
  keyvexIdField: "accession_number",
  typeField: "form_type",
  expectedTypes: FORMS,

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const filings = await fetchEdgarFilingsByForm({
      forms: FORMS,
      startYear: Math.min(...years),
      endYear: Math.max(...years),
      onProgress: (m) => console.error(`[sec-tender-offers] ${m}`),
    });
    return filings.map((f) => ({
      id: f.accession,
      url: edgarFilingUrl(f.cik, f.accession),
      label: `${f.company} (${f.formType})`,
      meta: { year: f.dateFiled.slice(0, 4) },
    }));
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },
};
