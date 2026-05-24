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

import type { InsiderTransactionV2 } from "../types.js";

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
  extends Omit<InsiderTransactionV2, "transaction_type"> {
  // v2 semantic relocated under a new name (since transaction_type now means legacy buy/sell)
  row_type: "nonderiv" | "deriv";

  // Legacy semantic re-occupies the original field name (synthesized at response time)
  transaction_type: "buy" | "sell";

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

  return {
    ...v2Rest,
    row_type: v2TxType,
    transaction_type: buyOrSell,

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
    sec_filing_url: row.source_url,
  };
}
