/**
 * house-trade-map — shared mapping from vision-OCR'd rows to CongressionalTrade.
 * Used by the unified completeness backfill (and ingest-house-ocr.ts logic).
 * Canonical home for the amount-bracket table + date/owner/type normalizers so
 * the text path and the vision path produce byte-identical record shapes.
 */
import type { CongressionalTrade } from "../../src/types.js";

export const BRACKET: Record<string, string> = {
  A: "$1,001 - $15,000",
  B: "$15,001 - $50,000",
  C: "$50,001 - $100,000",
  D: "$100,001 - $250,000",
  E: "$250,001 - $500,000",
  F: "$500,001 - $1,000,000",
  G: "$1,000,001 - $5,000,000",
  H: "$5,000,001 - $25,000,000",
  I: "$25,000,001 - $50,000,000",
  J: "Over $50,000,000",
  K: "Over $1,000,000",
};

export function amountMin(range: string): number {
  const m = range.replace(/,/g, "").match(/\$(\d+)/);
  return m ? parseInt(m[1]!, 10) : 0;
}
export function amountMax(range: string): number {
  const ms = range.replace(/,/g, "").match(/\$(\d+)/g);
  if (!ms || ms.length < 2) return amountMin(range);
  return parseInt(ms[ms.length - 1]!.replace("$", ""), 10);
}
export function normalizeOwner(
  raw: string,
): "Self" | "Spouse" | "Joint" | "Dependent" {
  const t = (raw ?? "").trim().toUpperCase();
  if (t === "SP" || t === "SPOUSE") return "Spouse";
  if (t === "JT" || t === "JOINT") return "Joint";
  if (t === "DC" || t === "DEPENDENT") return "Dependent";
  return "Self";
}
export function normalizeType(
  raw: string,
): "buy" | "sell" | "exchange" | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "buy" || t === "purchase" || t === "p") return "buy";
  if (t === "sell" || t === "sale" || t === "partial sale" || t === "s")
    return "sell";
  // Exchanges (E) are real disclosed trades — bond maturities, corporate
  // spin-offs, share-class exchanges. Captured, not dropped (benchmark G2).
  if (t === "exchange" || t === "e") return "exchange";
  return null;
}
/** ISO already, or MM/DD/YY[YY] or MM-DD-YY[YY] -> ISO. Empty -> "". */
export function toISO(d: string): string {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return "";
  const [, mm, dd, yyRaw] = m;
  const yy = yyRaw!.length === 2 ? `20${yyRaw}` : yyRaw!;
  return `${yy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}
export function businessDaysBetween(aISO: string, bISO: string): number | null {
  if (!aISO || !bISO) return null;
  const a = new Date(aISO),
    b = new Date(bISO);
  if (isNaN(+a) || isNaN(+b)) return null;
  let days = 0;
  const step = a <= b ? 1 : -1;
  const cur = new Date(a);
  while (step === 1 ? cur < b : cur > b) {
    cur.setDate(cur.getDate() + step);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days += step;
  }
  return Math.abs(days);
}

export interface VisionRow {
  asset_name: string;
  ticker?: string;
  asset_type?: string;
  owner?: string;
  type: string;
  tx_date: string;
  notif_date?: string;
  amount_col: string;
  comment?: string;
}
export interface IndexMeta {
  first: string;
  last: string;
  state: string;
  state_district: string;
  filing_date_iso: string; // YYYY-MM-DD
}

/** Map vision rows for one filing into CongressionalTrade records. */
export function visionRowsToTrades(
  rows: VisionRow[],
  meta: IndexMeta,
  docId: string,
  filingUrl: string,
): CongressionalTrade[] {
  const out: CongressionalTrade[] = [];
  let rowNo = 0;
  for (const r of rows) {
    const txType = normalizeType(r.type);
    if (!txType) continue; // genuinely unrecognized type only (exchange now kept)
    rowNo++;
    const col = (r.amount_col || "").trim().toUpperCase();
    const amount_range = BRACKET[col] ?? "";
    const txISO = toISO(r.tx_date);
    out.push({
      id: `house-${docId}-ocr-${rowNo}`,
      ticker: (r.ticker ?? "").toUpperCase(),
      asset_name: (r.asset_name ?? "").trim(),
      asset_type: r.asset_type || "Stock",
      member_name: `${meta.first} ${meta.last}`.trim(),
      member_first: meta.first,
      member_last: meta.last,
      bioguide_id: "",
      chamber: "house",
      party: "",
      state: meta.state,
      state_district: meta.state_district,
      office: `${meta.last}, ${meta.first} (Representative)`.trim(),
      transaction_type: txType,
      transaction_date: txISO,
      disclosure_date: meta.filing_date_iso,
      reporting_lag_days: businessDaysBetween(txISO, meta.filing_date_iso),
      amount_range,
      amount_min: amountMin(amount_range),
      amount_max: amountMax(amount_range),
      owner: normalizeOwner(r.owner ?? "Self"),
      comment: r.comment ?? "",
      ptr_id: docId,
      report_url: filingUrl,
      data_source: "HOUSE_CLERK_PTR",
      extraction_method: "vision_ocr",
    });
  }
  return out;
}
