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

/** Normalize an EDGAR index date to ISO. Quarterly master.idx uses YYYY-MM-DD;
 *  the daily-index uses YYYYMMDD. Return YYYY-MM-DD either way. */
function toIsoDate(d: string): string {
  const t = d.trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return t;
}

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
          dateFiled: toIsoDate(parts[3]!),
        });
        n++;
      }
      opts.onProgress?.(`${y} QTR${q}: ${n}`);
    }
  }
  return out;
}

/**
 * Enumerate every EDGAR filing of the given form types on ONE day, from the
 * daily-index (the per-day equivalent of master.idx). Complete — the right
 * source for a daily cron (FTS is incomplete). Returns [] on 404 (weekend/
 * holiday/not-yet-published).
 *   https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{n}/master.{YYYYMMDD}.idx
 */
export async function fetchEdgarDailyIndex(
  dateISO: string,
  forms: string[],
): Promise<EdgarFiling[]> {
  const [y, m, d] = dateISO.split("-");
  if (!y || !m || !d) return [];
  const q = Math.floor((parseInt(m, 10) - 1) / 3) + 1;
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/master.${y}${m}${d}.idx`;
  let text: string;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    text = await res.text();
  } catch {
    return [];
  }
  const formSet = new Set(forms.map((f) => f.trim()));
  const out: EdgarFiling[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|");
    if (parts.length !== 5) continue;
    const formType = parts[2]!.trim();
    if (!formSet.has(formType)) continue;
    const fm = parts[4]!.trim().match(/(\d{10}-\d{2}-\d{6})\.txt$/);
    if (!fm) continue;
    out.push({
      accession: fm[1]!,
      formType,
      cik: parts[0]!.trim(),
      company: parts[1]!.trim(),
      dateFiled: toIsoDate(parts[3]!),
    });
  }
  return out;
}

/** Clickable EDGAR filing-index page for an accession. */
export function edgarFilingUrl(cik: string, accession: string): string {
  const noDash = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${noDash}/${accession}-index.htm`;
}
