/**
 * "Needs OCR" detector — decides whether a PDF filing lacks a usable digital
 * text layer (scanned / image-only / corrupted) and therefore must be OCR'd
 * later. PURE function: no I/O, no side effects. Callers pass the already-
 * extracted pdf-parse text + page count.
 *
 * Why a per-PAGE real-word density metric (not a raw char/word count): a long
 * scanned document (e.g. Rep. Ro Khanna's 22-page 2024 PTR) can accumulate a
 * few stray noise characters across its pages. A flat "chars > N" threshold
 * could be tricked into thinking such a doc has text. Normalizing real words
 * by page count means a 22-page scan with 0 real words still reads as 0
 * words/page — it cannot be rescued by length-induced noise.
 *
 * "Real word" = a run of >=3 ASCII letters (/[A-Za-z]{3,}/). This deliberately
 * ignores the digits, slashes, dollar signs, and single-letter glyphs that
 * pdf-parse emits from icon fonts and rotated-scan artifacts — those are not
 * evidence of a genuine readable text layer.
 *
 * CALIBRATION (measured live 2026-06-05, House Clerk PTR PDFs):
 *   Scanned (Khanna 2024/8220127.pdf):  22 pages, 44 chars,   0 real words → 0.0 words/page
 *   Digital control samples (2024 idx): 1-2 pages, ~1.2-1.5k chars, 96-120 real words
 *                                       → 51-102 real words/page (lowest digital = 51)
 *
 * The gap between 0 (scanned) and 51 (lowest digital) is enormous. Threshold
 * set to 5 real words/page: ~10x above the scanned signal, ~10x below the
 * lowest digital signal. Anything at or below 5 words/page is flagged.
 */

export const WORDS_PER_PAGE_THRESHOLD = 5;

/** Count of /[A-Za-z]{3,}/ matches — the real-word density numerator. */
export function realWordCount(text: string): number {
  return (text.match(/[A-Za-z]{3,}/g) ?? []).length;
}

/**
 * TRUE when the extracted text is too sparse to be a genuine digital filing
 * and the document should be queued for OCR.
 *
 * @param pdfText   the text pdf-parse extracted from the PDF
 * @param pageCount pages reported by pdf-parse; defaults to 1 so a missing
 *                  count never divides by zero (treats unknown as single-page,
 *                  the most conservative — i.e. most likely to flag — choice).
 */
export function needsOcr(pdfText: string, pageCount?: number): boolean {
  const pages = pageCount && pageCount > 0 ? pageCount : 1;
  const words = realWordCount(pdfText ?? "");
  return words / pages <= WORDS_PER_PAGE_THRESHOLD;
}
