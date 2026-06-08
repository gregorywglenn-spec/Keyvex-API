/**
 * Backward-compat shim for the v2 read path.
 *
 * Decision (2026-05-24, Greg): make `data_source: "bulk_v2"` the default
 * on get_insider_transactions, but emit BOTH the v2 field names AND the
 * legacy field aliases on every row, so existing callers reading legacy
 * field names continue to work without code changes.
 *
 * The one field collision — `transaction_type` — gets the LEGACY semantic
 * ("buy"|"sell"), synthesized via the same algorithm the legacy scraper
 * uses at write time (form4.ts:deriveType). The v2 native semantic
 * ("nonderiv"|"deriv") moves to a new field `row_type` so agents can
 * still distinguish the source table.
 *
 * Critical invariant per Greg: the synthesized buy/sell MUST match what
 * legacy returned for the same transactions over the overlap window —
 * verified empirically by scripts/_verify-shim-buy-sell.ts.
 */

import type { InsiderTransactionV2, TransactionNature } from "../types.js";

// ─── Phase A: SEC Form 4 transaction-code → transaction_nature mapping ────
//
// LOCKED 2026-05-24 against the official SEC source:
//   SEC 1474 (03-26), OMB 3235-0287, expires August 31, 2026.
//   Form 4 General Transaction Codes, pages 11-12.
//   PDF: https://www.sec.gov/files/form4.pdf
//
// This mapping is THE SHARED SOURCE OF TRUTH. Form 4 live scraper, Form 5
// scraper, bulk Form 3/4/5 loader, and this wire shim all derive
// transaction_nature via deriveTransactionNature(trans_code) — never invent
// their own logic. Keep this lockstep with the SEC table; any drift here
// silently mis-classifies trade events across every collection.
//
// Critical guards:
//   1. trans_code XML node value ONLY. NEVER read the acquired/disposed flag
//      (A/D in column 4 of Table I). The acqDisp flag is a separate axis
//      (whether shares were added or removed from the holding) and has the
//      same letter values for entirely unrelated meanings — confusing the
//      two would mis-classify dispositions as gifts and vice versa.
//   2. Compound codes like "S/K" (open-market sale + equity-swap modifier)
//      get split — first segment determines the nature. K is a modifier,
//      not a standalone primary code per SEC instructions.
//   3. Codes not in the SEC table, or with ambiguous categorization, MUST
//      return INSUFFICIENT_DATA. No "best guess" buckets. The Tourniquet
//      doctrine: prefer honest uncertainty over confident misclassification.

const OPEN_MARKET_CODES = new Set([
  "P", // Open market or private purchase of non-derivative or derivative security
  "S", // Open market or private sale of non-derivative or derivative security
]);

const EQUITY_COMP_CODES = new Set([
  "A", // Grant, award or other acquisition pursuant to Rule 16b-3(d)
  "M", // Exercise or conversion of derivative security exempted pursuant to Rule 16b-3
  "I", // Discretionary transaction in accordance with Rule 16b-3(f) — 401(k)/ESPP
  // ─── Note: C / X / O classification ─────────────────────────────────────
  // C, X, O are SEC "Derivative Securities Codes" — NOT explicitly
  // categorized as Rule 16b-3 compensation by the SEC table. We bucket them
  // here as EQUITY_COMP on a BEHAVIORAL-CONVENTION basis: in insider Form 4
  // filings, the derivatives being exercised/converted are overwhelmingly
  // comp-granted (originally received via an "A" grant or similar). Treating
  // them as EQUITY_COMP aligns with how analysts interpret these events
  // (option exercise = realizing comp), which is the agent-useful framing.
  //
  // Strict SEC reading would put C/X/O in INSUFFICIENT_DATA (the SEC text
  // doesn't tell us whether the underlying derivative was comp-granted).
  // Candidate for future split into a dedicated "DERIVATIVE_EXERCISE"
  // bucket if/when we want to surface the distinction. NOT in Phase A scope.
  "C", // Conversion of derivative security
  "X", // Exercise of in-the-money or at-the-money derivative security
  "O", // Exercise of out-of-the-money derivative security
]);

const NON_OPEN_MARKET_TRANSFER_CODES = new Set([
  "D", // Disposition to the issuer of issuer equity securities pursuant to Rule 16b-3(e)
       // (forced disposition back to the company — NOT an open-market sale;
       //  distinct from the acquired/disposed flag value "D" in column 4)
  "F", // Payment of exercise price or tax liability by delivering or withholding
       // securities incident to receipt/exercise/vesting under Rule 16b-3 (tax withhold)
  "G", // Bona fide gift
  "W", // Acquisition or disposition by will or the laws of descent and distribution
  "Z", // Deposit into or withdrawal from voting trust
  "U", // Disposition pursuant to a tender of shares in a change of control transaction
]);

// INSUFFICIENT_DATA codes — explicitly enumerated by SEC but ambiguous in
// nature, OR modifier/flag codes that shouldn't appear standalone:
//   V — voluntary-early-report FLAG (placed in column 2A, not a primary code)
//   E — expiration of short derivative position (lifecycle event; not a trade)
//   H — expiration/cancellation of long derivative with value received (lifecycle)
//   L — small acquisition under Rule 16a-6 (size exemption, venue unspecified)
//   J — "other acquisition or disposition" (SEC explicitly says use J + describe
//        in narrative — ambiguous by design)
//   K — equity-swap MODIFIER appended to primary code (e.g., "S/K"); standalone
//        K is a parsing artifact
// All other codes, null, empty, or unrecognized strings also fall through.

/**
 * Map a SEC Form 4/5 trans_code value to its transaction_nature bucket.
 *
 * READS THE TRANSACTION CODE STRING ONLY. Never reads acquired/disposed,
 * never reads any other field. Pure function of the input code string.
 *
 * Compound codes (e.g., "S/K"): first segment determines nature.
 *
 * Returns INSUFFICIENT_DATA for anything not explicitly enumerated.
 */
export function deriveTransactionNature(
  trans_code: string | null | undefined,
): TransactionNature {
  if (!trans_code) return "INSUFFICIENT_DATA";
  const trimmed = trans_code.trim();
  if (trimmed.length === 0) return "INSUFFICIENT_DATA";

  // Compound code handling: "S/K" → first segment is the primary code.
  // K is a modifier (equity swap) appended via slash per SEC instruction 8.
  const primary = trimmed.includes("/")
    ? (trimmed.split("/")[0] ?? "").trim().toUpperCase()
    : trimmed.toUpperCase();

  if (primary.length === 0) return "INSUFFICIENT_DATA";

  if (OPEN_MARKET_CODES.has(primary)) return "OPEN_MARKET";
  if (EQUITY_COMP_CODES.has(primary)) return "EQUITY_COMP";
  if (NON_OPEN_MARKET_TRANSFER_CODES.has(primary)) return "NON_OPEN_MARKET_TRANSFER";
  // V, E, H, L, J, K (standalone), and anything else
  return "INSUFFICIENT_DATA";
}

// ─── Phase A: Congressional PTR comment → transaction_nature mapping ──────
//
// SEPARATE CODE PATH from Form 4. Congressional PTRs have no regulatory
// trans_code field; the non-trade signal lives in the free-text `comment`
// field. Detection regex matches:
//   - "contribution" / "contributed" (charitable contribution disclosures)
//   - "gift" / "gifted"
//   - "donat*" (donation, donated, donating)
//   - "charitab*" (charitable, charitably)
//
// Examples this catches in real PTR data:
//   "Contribution of 382 shares of Visa Inc. to Trinity University" (Pelosi)
//   "Gift to spouse's family trust"
//   "Donated to American Red Cross"
//   "Charitable transfer to family foundation"
//
// When the comment matches: NON_OPEN_MARKET_TRANSFER.
// When comment is clean AND transaction_type is "buy"/"sell": OPEN_MARKET.
// When comment is clean AND transaction_type is missing/empty: INSUFFICIENT_DATA.
//
// CRITICAL: NEVER overwrites transaction_type. Pelosi's row keeps its
// existing "sell" value (back-compat). The shim adds transaction_nature
// alongside so naive sell-total queries can filter the gift out by default.

const CONGRESSIONAL_TRANSFER_REGEX =
  /\b(contribution|contributed|gift(?:ed|ing|s)?|donat\w*|charitab\w*)\b/i;

export function deriveCongressionalNature(args: {
  comment: string | null | undefined;
  transaction_type: "buy" | "sell" | string | null | undefined;
}): TransactionNature {
  const comment = args.comment ?? "";
  if (CONGRESSIONAL_TRANSFER_REGEX.test(comment)) {
    return "NON_OPEN_MARKET_TRANSFER";
  }
  // No transfer signal in comment — fall back to transaction_type
  const tt = args.transaction_type;
  if (tt === "buy" || tt === "sell") return "OPEN_MARKET";
  // Exchange (PTR code E): a real disclosed trade but NOT an open-market
  // buy/sell — bond maturities, corporate spin-offs, share-class exchanges.
  // Classify as a non-open-market change so directional buy/sell queries
  // exclude it, while unfiltered "all trades" queries still surface it.
  if (tt === "exchange") return "NON_OPEN_MARKET_TRANSFER";
  return "INSUFFICIENT_DATA";
}

// ─── Ported verbatim from src/scrapers/form4.ts:174 (deriveType) ──────────
//
// Direction derivation. P/S are open-market and unambiguous; for the rest,
// trust `acquired_disposed` if present, otherwise fall back to code
// semantics (A/M/X/C/I = acquisition; F/G/D = disposition).
//
// DO NOT modify this without also auditing form4.ts to keep them in lockstep.
// The shim's contract is "synthesized buy/sell matches legacy byte-for-byte"
// for the overlap window. Drift here breaks that contract silently.
export function deriveLegacyBuyOrSell(
  trans_code: string,
  trans_acquired_disp_cd: "A" | "D" | null,
): "buy" | "sell" {
  if (trans_code === "P") return "buy";
  if (trans_code === "S") return "sell";
  if (trans_acquired_disp_cd === "A") return "buy";
  if (trans_acquired_disp_cd === "D") return "sell";
  return /^(A|M|X|C|I)$/.test(trans_code) ? "buy" : "sell";
}

// ─── Reporting-lag calculation (mirrors legacy field shape) ────────────────
// Legacy InsiderTransaction has `reporting_lag_days: number | null` = days
// from transaction_date to disclosure_date. Compute the same way for the shim.
export function computeReportingLagDays(
  transaction_date: string,
  filing_date: string,
): number | null {
  if (!transaction_date || !filing_date) return null;
  const tx = Date.parse(transaction_date);
  const file = Date.parse(filing_date);
  if (Number.isNaN(tx) || Number.isNaN(file)) return null;
  return Math.round((file - tx) / 86_400_000); // ms per day
}

// ─── document_type → data_source mapping ───────────────────────────────────
// Legacy uses data_source: "SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5". v2 uses
// document_type: "3" | "3/A" | "4" | "4/A" | "5" | "5/A". Map for the shim
// so legacy data_source filter (which existing callers might check) keeps
// working. Form 3 rows don't exist in insider_transactions_v2 (that's the
// initial_ownership_baselines / insider_filings_v2 paths) so we don't need
// to handle "3" / "3/A" — those rows would never reach this shim.
export function docTypeToLegacyDataSource(
  document_type: string,
): "SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5" | string {
  if (document_type === "4" || document_type === "4/A") return "SEC_EDGAR_FORM4";
  if (document_type === "5" || document_type === "5/A") return "SEC_EDGAR_FORM5";
  return document_type;
}

// ─── The shimmed shape an existing caller sees ─────────────────────────────
// = v2 + legacy field aliases. `transaction_type` is REDEFINED to the legacy
// "buy"|"sell" semantic; v2's nonderiv|deriv discriminator moves to `row_type`.
// All other v2 fields preserved as-is.
export interface InsiderTransactionV2Compat
  extends Omit<InsiderTransactionV2, "transaction_type" | "transaction_nature"> {
  // v2 semantic relocated under a new name (since transaction_type now means legacy buy/sell)
  row_type: "nonderiv" | "deriv";

  // Legacy semantic re-occupies the original field name (synthesized at response time)
  transaction_type: "buy" | "sell";

  // Phase A: always populated on the wire (derived from row.trans_code via
  // deriveTransactionNature). Required, never optional in the wire shape —
  // the read-shim guarantees every row carries it.
  transaction_nature: TransactionNature;

  // Legacy field aliases — same data, legacy names. Computed from v2 fields.
  disclosure_date: string;          // ← filing_date
  transaction_code: string;         // ← trans_code
  shares: number | null;            // ← trans_shares
  price_per_share: number | null;   // ← trans_price_per_share
  total_value: number | null;       // ← trans_total_value (falls back to shares × price for nonderiv)
  acquired_disposed: "A" | "D" | null;        // ← trans_acquired_disp_cd
  shares_owned_after: number | null;          // ← shrs_owned_following_trans
  conversion_or_exercise_price: number | null; // ← conv_exercise_price
  officer_name: string;             // ← reporting_owner_name
  is_derivative: boolean;           // ← derived from row_type === "deriv"
  reporting_lag_days: number | null; // ← computed from transaction_date + filing_date
  // Legacy carried data_source: "SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5".
  // The shimmed field uses the same name and matches when document_type is 4/5;
  // for other doc types (none currently in insider_transactions_v2) it
  // passes through document_type unchanged.
  data_source: "SEC_EDGAR_FORM4" | "SEC_EDGAR_FORM5" | string;
  // sec_filing_url alias — legacy had it; v2 has source_url
  sec_filing_url: string;

  /**
   * Phase 2b (read-time): SEC-source quirk flags applied by the
   * annotateRowsSourceMetadata shim at response time. Present ONLY when
   * at least one field on the row matches a detection rule (the 2050
   * perpetual-instrument sentinel; the anomalous-year filer-entry
   * pattern). Absence indicates "no SEC source quirks detected" — NOT
   * "certified clean by audit." See src/source-metadata.ts.
   */
  source_metadata?: import("../source-metadata.js").SourceMetadataFlags;
}

/**
 * Take an InsiderTransactionV2 row and return a backward-compat shape that
 * adds the legacy field aliases on top + redefines `transaction_type` to
 * legacy buy/sell semantic.
 *
 * Performance: O(1) per row, no allocations beyond the merged object. Safe
 * to call on every row in a 500-row response.
 */
export function applyV2BackwardCompatShim(
  row: InsiderTransactionV2,
): InsiderTransactionV2Compat {
  const buyOrSell = deriveLegacyBuyOrSell(
    row.trans_code,
    row.trans_acquired_disp_cd,
  );
  const reportingLag = computeReportingLagDays(
    row.transaction_date,
    row.filing_date,
  );
  // Legacy `total_value` was shares × price for nonderiv (deriv had its own
  // TRANS_TOTAL_VALUE field). Mirror that.
  const totalValue =
    row.trans_total_value !== null
      ? row.trans_total_value
      : row.trans_shares !== null && row.trans_price_per_share !== null
        ? row.trans_shares * row.trans_price_per_share
        : null;

  // Spread v2 first, then overwrite `transaction_type` with the legacy
  // semantic. The original v2 "nonderiv"|"deriv" value is preserved under
  // `row_type` so agents can still discriminate when they need to.
  const { transaction_type: v2TxType, ...v2Rest } = row;

  // Phase A (2026-05-24): derive transaction_nature on-the-fly. Option A
  // backfill — historical rows in Firestore don't carry this field, the
  // shim computes it at read time from the SEC-verified trans_code mapping.
  // Forward-write paths (new ingestion) WILL store transaction_nature
  // directly, but the shim re-derives anyway so the wire shape is consistent
  // regardless of whether the underlying row was Phase A ingested or not.
  // (Re-derive cost is ~O(1) per row — a Set lookup. Negligible.)
  const transactionNature =
    row.transaction_nature ?? deriveTransactionNature(row.trans_code);

  // The bulk loader (form345-bulk.ts) stored a malformed browse-edgar SEARCH
  // url for source_url because it thought CIK wasn't on the row — but
  // company_cik IS here. Build the real EDGAR Archives filing URL at serve-time
  // so the link is actually auditable (fixes all rows without a 9.9M migration).
  const filingUrl =
    row.company_cik && row.accession_number
      ? `https://www.sec.gov/Archives/edgar/data/${Number(row.company_cik)}/${row.accession_number.replace(/-/g, "")}/${row.accession_number}-index.htm`
      : row.source_url;

  return {
    ...v2Rest,
    source_url: filingUrl,
    row_type: v2TxType,
    transaction_type: buyOrSell,
    transaction_nature: transactionNature,

    // Legacy field aliases (computed/renamed)
    disclosure_date: row.filing_date,
    transaction_code: row.trans_code,
    shares: row.trans_shares,
    price_per_share: row.trans_price_per_share,
    total_value: totalValue,
    acquired_disposed: row.trans_acquired_disp_cd,
    shares_owned_after: row.shrs_owned_following_trans,
    conversion_or_exercise_price: row.conv_exercise_price,
    officer_name: row.reporting_owner_name,
    is_derivative: v2TxType === "deriv",
    reporting_lag_days: reportingLag,
    data_source: docTypeToLegacyDataSource(row.document_type),
    sec_filing_url: filingUrl,
  };
}
