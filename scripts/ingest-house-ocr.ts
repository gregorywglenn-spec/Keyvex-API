/**
 * INGEST-HOUSE-OCR — map vision-OCR'd scanned House PTR rows into the
 * `congressional_trades` collection, with honest provenance.
 *
 * The scanned House PTRs in the `needs_ocr` collection have NO text layer,
 * so the normal house.ts text parser produces nothing. Their asset /
 * transaction_type / amount / owner / dates are read from the rendered page
 * image by vision (see scripts/render-house-ptr.mjs + the spike in
 * docs/handoff-2026-06-07-testing-ocr.md). This script takes the structured
 * rows that reading produced and:
 *
 *   1. joins member metadata (first/last/state/district) from the House
 *      Clerk XML index by doc_id,
 *   2. maps amount-column letters (A–K) to the canonical House bracket
 *      strings + min/max,
 *   3. maps Purchase/Sale/Partial Sale -> buy/sell (Exchange is skipped,
 *      matching house.ts),
 *   4. writes idempotent CongressionalTrade rows tagged
 *      `extraction_method: "vision_ocr"` and `data_source: "HOUSE_CLERK_PTR"`,
 *      with `report_url` pointing at the source PDF for audit.
 *
 * DRY by default (prints mapped rows, no writes). Pass --save to persist.
 *
 *   npx tsx scripts/ingest-house-ocr.ts <extractions.json>            # dry
 *   npx tsx scripts/ingest-house-ocr.ts <extractions.json> --save     # write
 *
 * Input file = JSON array of per-filing extraction objects:
 *   {
 *     "doc_id": "8219808",
 *     "filing_url": "https://disclosures-clerk.house.gov/.../8219808.pdf",
 *     "filer_name": "Doug Lamborn",
 *     "filing_date": "2023-06-23",          // ISO; falls back to index date
 *     "nil": false,                          // true => "nothing to report"
 *     "confidence": "high",                  // high | medium | low
 *     "rows": [
 *       { "asset_name": "NetApp, Inc.", "ticker": "NTAP", "asset_type": "ST",
 *         "owner": "Self", "type": "sell", "tx_date": "2023-06-05",
 *         "notif_date": "2023-06-05", "amount_col": "B", "comment": "" }
 *     ]
 *   }
 *
 * Idempotent doc IDs: house-<doc_id>-ocr-<rowIndex>. The "-ocr-" infix keeps
 * OCR rows from ever colliding with text-layer house-<doc_id>-<n> IDs.
 */
import "../src/load-secrets.js";
import { readFileSync } from "node:fs";
import {
  fetchHousePtrIndex,
  type PtrIndexEntry,
} from "../src/scrapers/house.js";
import { saveCongressionalTrades } from "../src/firestore.js";
import type { CongressionalTrade } from "../src/types.js";

const SAVE = process.argv.includes("--save");
const inputPath = process.argv.find(
  (a) => a.endsWith(".json") || a.endsWith(".jsonl"),
);
if (!inputPath) {
  console.error("usage: ingest-house-ocr.ts <extractions.json> [--save]");
  process.exit(1);
}

// ─── House amount brackets (official PTR form, columns A–K) ───────────────────
const BRACKET: Record<string, string> = {
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
  // K = "Transaction in a Spouse/Dependent Child asset over $1,000,000" —
  // a high-value flag, not a normal bracket. Treat as ">$1,000,000".
  K: "Over $1,000,000",
};

function amountMin(range: string): number {
  const m = range.replace(/,/g, "").match(/\$(\d+)/);
  return m ? parseInt(m[1]!, 10) : 0;
}
function amountMax(range: string): number {
  const ms = range.replace(/,/g, "").match(/\$(\d+)/g);
  if (!ms || ms.length < 2) return amountMin(range);
  return parseInt(ms[ms.length - 1]!.replace("$", ""), 10);
}

function normalizeOwner(
  raw: string,
): "Self" | "Spouse" | "Joint" | "Dependent" {
  const t = (raw ?? "").trim().toUpperCase();
  if (t === "SP" || t === "SPOUSE") return "Spouse";
  if (t === "JT" || t === "JOINT") return "Joint";
  if (t === "DC" || t === "DEPENDENT") return "Dependent";
  return "Self";
}

function normalizeType(raw: string): "buy" | "sell" | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "buy" || t === "purchase" || t === "p") return "buy";
  if (t === "sell" || t === "sale" || t === "partial sale" || t === "s")
    return "sell";
  return null; // exchange / unknown -> skip (matches house.ts)
}

/** ISO already, or MM/DD/YY[YY] or MM-DD-YY[YY] -> ISO. Empty -> "".
 *  House PTRs mix slash and dash date separators (sometimes within one
 *  filing), so accept both. */
function toISO(d: string): string {
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return "";
  const [, mm, dd, yyRaw] = m;
  const yy = yyRaw!.length === 2 ? `20${yyRaw}` : yyRaw!;
  return `${yy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

function businessDaysBetween(aISO: string, bISO: string): number | null {
  if (!aISO || !bISO) return null;
  const a = new Date(aISO),
    b = new Date(bISO);
  if (isNaN(+a) || isNaN(+b)) return null;
  let days = 0;
  const step = a <= b ? 1 : -1;
  const cur = new Date(a);
  while ((step === 1 ? cur < b : cur > b)) {
    cur.setDate(cur.getDate() + step);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days += step;
  }
  return Math.abs(days);
}

interface ExtractionRow {
  asset_name: string;
  ticker?: string;
  asset_type?: string;
  owner?: string;
  type: string; // buy|sell|purchase|sale|partial sale|exchange
  tx_date: string;
  notif_date?: string;
  amount_col: string; // A–K
  comment?: string;
}
interface Extraction {
  doc_id: string;
  filing_url: string;
  filer_name: string;
  filing_date?: string;
  nil?: boolean;
  confidence?: string;
  rows?: ExtractionRow[];
}

const indexCache = new Map<number, PtrIndexEntry[]>();
async function indexEntryFor(
  docId: string,
  filingDateISO: string,
): Promise<PtrIndexEntry | null> {
  const year = parseInt((filingDateISO || "").slice(0, 4), 10);
  const years = [year, year - 1, year + 1].filter((y) => y > 2000);
  for (const y of years) {
    if (!indexCache.has(y)) {
      try {
        indexCache.set(y, await fetchHousePtrIndex(y));
      } catch {
        indexCache.set(y, []);
      }
    }
    const hit = indexCache.get(y)!.find((e) => e.doc_id === docId);
    if (hit) return hit;
  }
  return null;
}

(async () => {
  const raw = readFileSync(inputPath, "utf8").trim();
  // Accept either a JSON array or crash-safe JSONL (one filing object per line).
  const extractions: Extraction[] = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
  console.error(
    `[ocr-ingest] ${extractions.length} filing(s) from ${inputPath} — ${SAVE ? "SAVE" : "DRY"}`,
  );

  const out: CongressionalTrade[] = [];
  let nilCount = 0,
    skipExchange = 0;

  for (const f of extractions) {
    const idx = await indexEntryFor(f.doc_id, f.filing_date ?? "");
    const first =
      idx?.first ?? f.filer_name.trim().split(/\s+/).slice(0, -1).join(" ");
    const last = idx?.last ?? f.filer_name.trim().split(/\s+/).slice(-1)[0]!;
    const state = idx?.state ?? "";
    const district = idx?.state_district ?? "";
    const filingISO = f.filing_date ?? toISO(idx?.filing_date ?? "");

    if (f.nil || !f.rows || f.rows.length === 0) {
      nilCount++;
      console.error(
        `[ocr-ingest] NIL  ${f.doc_id} ${f.filer_name} ${filingISO} — nothing to report`,
      );
      continue;
    }

    let rowNo = 0;
    for (const r of f.rows) {
      const txType = normalizeType(r.type);
      if (!txType) {
        skipExchange++;
        continue;
      }
      rowNo++;
      const col = (r.amount_col || "").trim().toUpperCase();
      const amount_range = BRACKET[col] ?? "";
      const txISO = toISO(r.tx_date);
      out.push({
        id: `house-${f.doc_id}-ocr-${rowNo}`,
        ticker: (r.ticker ?? "").toUpperCase(),
        asset_name: r.asset_name.trim(),
        asset_type: r.asset_type || "Stock",
        member_name: `${first} ${last}`.trim(),
        member_first: first,
        member_last: last,
        bioguide_id: "", // populated later via congress-legislators backfill
        chamber: "house",
        party: "",
        state,
        state_district: district,
        office: `${last}, ${first} (Representative)`.trim(),
        transaction_type: txType,
        transaction_date: txISO,
        disclosure_date: filingISO,
        reporting_lag_days: businessDaysBetween(txISO, filingISO),
        amount_range,
        amount_min: amountMin(amount_range),
        amount_max: amountMax(amount_range),
        owner: normalizeOwner(r.owner ?? "Self"),
        comment: r.comment ?? "",
        ptr_id: f.doc_id,
        report_url: f.filing_url,
        data_source: "HOUSE_CLERK_PTR",
        extraction_method: "vision_ocr",
      });
    }
  }

  console.error(
    `[ocr-ingest] mapped ${out.length} trade row(s); ${nilCount} nil filing(s); ${skipExchange} exchange/other skipped`,
  );
  // Show a compact preview
  for (const t of out.slice(0, 25)) {
    console.error(
      `  ${t.id}  ${t.member_name.padEnd(22)} ${t.transaction_type.padEnd(4)} ${(t.ticker || t.asset_name).slice(0, 22).padEnd(22)} ${t.transaction_date}  ${t.amount_range}  [${t.owner}]`,
    );
  }
  if (out.length > 25) console.error(`  … +${out.length - 25} more`);

  if (SAVE) {
    const res = await saveCongressionalTrades(out);
    console.error(`[ocr-ingest] SAVED ${res.saved} -> ${res.collection}`);
  } else {
    console.error(`[ocr-ingest] DRY — no writes. Re-run with --save.`);
  }
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ocr-ingest] FATAL:", e);
    process.exit(1);
  });
