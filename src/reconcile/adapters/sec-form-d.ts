/**
 * Source Adapter: SEC Form D — private placements (Reg D exempt offerings).
 *
 * Third EDGAR-full-index adapter. Denominator: every D / D/A filing in EDGAR's
 * quarterly master index. KeyVex stores these in `private_placements` keyed by
 * `filing_id` (= EDGAR accession), form in `filing_type`.
 *
 * SCOPE NOTE: KeyVex's Form D coverage begins 2016 (the backfill's start),
 * even though electronic Form D exists from 2008-09. So default years are
 * 2016→present to measure completeness OF THE COVERED WINDOW. The pre-2016
 * gap (2008-2015) is a separate scope/backfill-extension question, not a
 * within-window miss — surfaced rather than silently counted as "missing".
 */

import {
  fetchEdgarFilingsByForm,
  edgarFilingUrl,
} from "../sec-edgar-index.js";
import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const FORMS = ["D", "D/A"];
const COVERAGE_START = 2016; // KeyVex's Form D backfill begins here

function defaultYears(): number[] {
  const end = new Date().getUTCFullYear();
  const out: number[] = [];
  for (let y = COVERAGE_START; y <= end; y++) out.push(y);
  return out;
}

export const secFormDAdapter: SourceAdapter = {
  name: "sec-form-d",
  title: "SEC Form D — private placements (EDGAR full-index, 2016+)",
  collection: "private_placements",
  keyvexIdField: "filing_id",
  typeField: "filing_type",
  expectedTypes: FORMS,

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    const years = ctx.years && ctx.years.length > 0 ? ctx.years : defaultYears();
    const filings = await fetchEdgarFilingsByForm({
      forms: FORMS,
      startYear: Math.min(...years),
      endYear: Math.max(...years),
      onProgress: (m) => console.error(`[sec-form-d] ${m}`),
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
