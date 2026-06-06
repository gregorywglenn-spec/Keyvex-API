/**
 * FEC filer date-typo correction.
 *
 * FEC filings occasionally carry obvious year-typos in a date field (e.g. an
 * independent expenditure stamped 2104-05-28 when a companion field — and the
 * real-world race — make clear it was 2014, or a contribution receipt dated
 * 2036 when the report_year is 2026). The expenditure/contribution genuinely
 * happened; only the year digit was mistyped on the form.
 *
 * Posture (Standing Rule #8 — source-faithful, byte-exact, auditable):
 * we EXPOSE the true date but never DESTROY the source's recorded value.
 *   - the PRIMARY field (indexed / queried / sorted) becomes the corrected date,
 *     so a search for the real year finds the record and the typo is invisible
 *     to normal use;
 *   - the verbatim source value is preserved in a *_source field;
 *   - the record is flagged date_corrected:true with the basis, so the
 *     correction is plainly labeled as KeyVex's interpretation, not the source's.
 *
 * We only correct the YEAR (the single mistyped component), keep month+day
 * verbatim, and only when a corroborating field gives a year ≥2 behind the
 * typo (an unambiguous error). Borderline gaps (≤1yr) are left verbatim.
 */

export interface DateCorrection {
  /** The value to store in the PRIMARY (indexed/queried) date field. */
  value: string;
  /** The verbatim source value, ONLY set when a correction was applied. */
  source: string | null;
  corrected: boolean;
  /** Which corroborating field justified the correction. */
  basis: string | null;
}

/** Extract a 4-digit year from an ISO-ish date string, or null. */
export function yearOf(dateStr: string | null | undefined): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec((dateStr ?? "").trim());
  return m ? Number(m[1]) : null;
}

const MIN_PLAUSIBLE_YEAR = 1900;
const MAX_PLAUSIBLE_YEAR = 2099;
/** Year gap (typo - corroborator) at/above which we treat it as an error. */
const CORRECTION_GAP = 2;

/**
 * Correct an implausibly-future date's YEAR using the first plausible
 * corroborating year. `candidates` are tried in order (most-trusted first);
 * `basisName` labels the primary corroborator for the audit flag.
 */
export function correctFutureDate(
  rawDate: string | null | undefined,
  candidates: Array<number | null | undefined>,
  basisName: string,
): DateCorrection {
  const raw = (rawDate ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return { value: raw, source: null, corrected: false, basis: null };
  const year = Number(m[1]);
  const corr = candidates.find(
    (c): c is number =>
      typeof c === "number" && c >= MIN_PLAUSIBLE_YEAR && c <= MAX_PLAUSIBLE_YEAR,
  );
  if (corr !== undefined && year - corr >= CORRECTION_GAP) {
    // Fix only the year; preserve the source's month + day verbatim.
    return {
      value: `${corr}-${m[2]}-${m[3]}`,
      source: raw,
      corrected: true,
      basis: basisName,
    };
  }
  return { value: raw, source: null, corrected: false, basis: null };
}
