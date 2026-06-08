/**
 * Source Adapter: SEC registration statements (S-1 / S-3 family).
 *
 * Second EDGAR-full-index adapter — reuses fetchEdgarFilingsByForm. The
 * authoritative denominator is every S-1, S-1/A, S-3, S-3/A, S-3ASR filing in
 * EDGAR's quarterly master index (2001 → present). KeyVex stores these in
 * `registration_statements` keyed by `filing_id` (= EDGAR accession, dashed),
 * with the form in `filing_type`.
 */

import {
  fetchEdgarFilingsByForm,
  edgarFilingUrl,
} from "../sec-edgar-index.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

// Exactly the five KeyVex carries (see registration_statements form_type spread).
const FORMS = ["S-1", "S-1/A", "S-3", "S-3/A", "S-3ASR"];

function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = 2001; y <= end; y++) out.push(y);
  return out;
}

export const secRegistrationStatementsAdapter: SourceAdapter = {
  name: "sec-registration-statements",
  title: "SEC registration statements — S-1/S-3 (EDGAR full-index)",
  collection: "registration_statements",
  keyvexIdField: "filing_id",
  typeField: "filing_type",
  expectedTypes: FORMS,

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const filings = await fetchEdgarFilingsByForm({
      forms: FORMS,
      startYear: Math.min(...years),
      endYear: Math.max(...years),
      onProgress: (m) => console.error(`[sec-registration-statements] ${m}`),
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
