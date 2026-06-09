/**
 * Source Adapter: SEC Form N-PORT (monthly fund portfolio reports).
 *
 * Reuses the EDGAR full-index enumerator. Denominator: every NPORT-P / NPORT-P/A
 * filing in EDGAR's quarterly master index. KeyVex stores these in
 * `nport_filings` keyed by `filing_id` (= EDGAR accession), form in `filing_type`.
 *
 * SCOPE: KeyVex's N-PORT coverage begins 2024-06; default years 2024+. Pre-2024
 * is a separate scope question (the public N-PORT-P form goes back to ~2019).
 */

import {
  fetchEdgarFilingsByForm,
  edgarFilingUrl,
} from "../sec-edgar-index.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const FORMS = ["NPORT-P", "NPORT-P/A"];
const COVERAGE_START = 2024;

function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = COVERAGE_START; y <= end; y++) out.push(y);
  return out;
}

export const secNportAdapter: SourceAdapter = {
  name: "sec-nport",
  title: "SEC Form N-PORT — fund portfolio reports (EDGAR full-index, 2024+)",
  collection: "nport_filings",
  keyvexIdField: "filing_id",
  typeField: "filing_type",
  expectedTypes: FORMS,

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const filings = await fetchEdgarFilingsByForm({
      forms: FORMS,
      startYear: Math.min(...years),
      endYear: Math.max(...years),
      onProgress: (m) => console.error(`[sec-nport] ${m}`),
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
