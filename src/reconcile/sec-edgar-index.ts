/**
 * SEC EDGAR full-index enumerator — the authoritative denominator for ANY
 * SEC form type.
 *
 * SEC publishes a quarterly master index listing EVERY filing:
 *   https://www.sec.gov/Archives/edgar/full-index/{YYYY}/QTR{n}/master.idx
 * Pipe-delimited: CIK|Company Name|Form Type|Date Filed|Filename
 * where Filename is edgar/data/{cik}/{accession}.txt
 *
 * This is the complete census source for SEC datasets (tender offers, Form D,
 * Form 144, 13D/G, insider 3/4/5, etc.) — filter by form type, collect the
 * accession numbers. Reused by every SEC reconciliation adapter.
 */

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface EdgarFiling {
  accession: string; // dashed, e.g. 0000320193-24-000123 (matches KeyVex)
  formType: string;
  cik: string;
  company: string;
  dateFiled: string; // YYYY-MM-DD
}

/**
 * Enumerate every EDGAR filing whose Form Type is in `forms`, across
 * [startYear, endYear] quarters. Future/empty quarters 404 and are skipped.
 * SEC fair-access: one request per quarter, paced; a real UA is required.
 */
export async function fetchEdgarFilingsByForm(opts: {
  forms: string[];
  startYear: number;
  endYear: number;
  onProgress?: (msg: string) => void;
}): Promise<EdgarFiling[]> {
  const formSet = new Set(opts.forms.map((f) => f.trim()));
  const out: EdgarFiling[] = [];
  const accSeen = new Set<string>();

  for (let y = opts.startYear; y <= opts.endYear; y++) {
    for (let q = 1; q <= 4; q++) {
      const url = `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/master.idx`;
      let text: string;
      try {
        await sleep(150);
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (res.status === 404) continue; // quarter not published yet
        if (!res.ok) {
          opts.onProgress?.(`${y} QTR${q}: HTTP ${res.status} — skipped`);
          continue;
        }
        text = await res.text();
      } catch (e) {
        opts.onProgress?.(
          `${y} QTR${q}: ${e instanceof Error ? e.message : e} — skipped`,
        );
        continue;
      }
      let n = 0;
      for (const line of text.split("\n")) {
        // 5 pipe-delimited fields; header/dashes lines won't have exactly 5.
        const parts = line.split("|");
        if (parts.length !== 5) continue;
        const formType = parts[2]!.trim();
        if (!formSet.has(formType)) continue;
        const filename = parts[4]!.trim(); // edgar/data/CIK/ACCESSION.txt
        const m = filename.match(/(\d{10}-\d{2}-\d{6})\.txt$/);
        if (!m) continue;
        const accession = m[1]!;
        if (accSeen.has(accession)) continue;
        accSeen.add(accession);
        out.push({
          accession,
          formType,
          cik: parts[0]!.trim(),
          company: parts[1]!.trim(),
          dateFiled: parts[3]!.trim(),
        });
        n++;
      }
      opts.onProgress?.(`${y} QTR${q}: ${n}`);
    }
  }
  return out;
}

/** Clickable EDGAR filing-index page for an accession. */
export function edgarFilingUrl(cik: string, accession: string): string {
  const noDash = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${noDash}/${accession}-index.htm`;
}
