/**
 * AUDIT-OCR-TRADES — quality control for the vision-OCR'd House PTR rows in
 * congressional_trades (extraction_method == "vision_ocr").
 *
 * Two jobs:
 *   1. SANITY FLAGS — mechanically scan every vision_ocr row for fields that
 *      are missing or impossible, so low-confidence rows surface for review
 *      instead of hiding in the pile.
 *   2. SAMPLE — print a random stratified sample (with the source-PDF URL) so
 *      a human/Opus can hand-check rows against the actual filing and produce
 *      a measured accuracy number.
 *
 *   npx tsx scripts/audit-ocr-trades.ts            # sanity report + 30 sample
 *   npx tsx scripts/audit-ocr-trades.ts --sample=40
 *   npx tsx scripts/audit-ocr-trades.ts --doc=8221322   # one filing's rows
 */
import "../src/load-secrets.js";
import { getLiveDb } from "../src/firestore.js";

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SAMPLE = arg("sample") ? parseInt(arg("sample")!, 10) : 30;
const ONLY_DOC = arg("doc");

const VALID_AMOUNTS = new Set([
  "$1,001 - $15,000",
  "$15,001 - $50,000",
  "$50,001 - $100,000",
  "$100,001 - $250,000",
  "$250,001 - $500,000",
  "$500,001 - $1,000,000",
  "$1,000,001 - $5,000,000",
  "$5,000,001 - $25,000,000",
  "$25,000,001 - $50,000,000",
  "Over $50,000,000",
  "Over $1,000,000",
]);

function flagsFor(t: any): string[] {
  const f: string[] = [];
  if (t.transaction_type !== "buy" && t.transaction_type !== "sell")
    f.push("bad_type");
  if (!t.amount_range || !VALID_AMOUNTS.has(t.amount_range))
    f.push("bad_amount");
  const d = t.transaction_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? "")) f.push("bad_txdate");
  else {
    const yr = parseInt(d.slice(0, 4), 10);
    if (yr < 2008 || yr > 2026) f.push("txdate_out_of_range");
    if (d > t.disclosure_date) f.push("txdate_after_disclosure");
  }
  if (!t.asset_name || t.asset_name.length < 2) f.push("no_asset_name");
  if (t.asset_name && t.asset_name.length > 120) f.push("asset_name_too_long");
  return f;
}

(async () => {
  const db = await getLiveDb();
  let q = db
    .collection("congressional_trades")
    .where("extraction_method", "==", "vision_ocr");
  if (ONLY_DOC) q = q.where("ptr_id", "==", ONLY_DOC) as any;
  const snap = await q.get();
  const rows = snap.docs.map((d) => d.data() as any);
  console.log(`vision_ocr rows: ${rows.length}`);

  // ── Sanity flags ──
  const flagged: { id: string; flags: string[]; row: any }[] = [];
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const f = flagsFor(r);
    if (f.length) {
      flagged.push({ id: r.id, flags: f, row: r });
      for (const x of f) tally[x] = (tally[x] ?? 0) + 1;
    }
  }
  console.log(`\n── SANITY FLAGS ── ${flagged.length}/${rows.length} rows flagged`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k}: ${v}`);
  for (const f of flagged.slice(0, 40))
    console.log(
      `  ! ${f.id}  [${f.flags.join(",")}]  ${f.row.member_name} ${f.row.transaction_type}/${f.row.amount_range}/${f.row.transaction_date} ${f.row.asset_name?.slice(0, 30)}`,
    );
  if (flagged.length > 40) console.log(`  … +${flagged.length - 40} more`);

  // ── Distribution snapshot ──
  const byFiler: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const r of rows) {
    byFiler[r.member_name] = (byFiler[r.member_name] ?? 0) + 1;
    byType[r.transaction_type] = (byType[r.transaction_type] ?? 0) + 1;
  }
  console.log(`\n── DISTRIBUTION ──`);
  console.log("  by type:", JSON.stringify(byType));
  console.log(
    "  top filers:",
    Object.entries(byFiler)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}(${v})`)
      .join(", "),
  );

  // ── Random sample for hand-audit (deterministic-ish: spread across docs) ──
  console.log(`\n── SAMPLE (${SAMPLE}) for hand-audit ──`);
  const byDoc: Record<string, any[]> = {};
  for (const r of rows) (byDoc[r.ptr_id] ??= []).push(r);
  const docs = Object.keys(byDoc);
  const picks: any[] = [];
  let i = 0;
  while (picks.length < Math.min(SAMPLE, rows.length) && docs.length) {
    const doc = docs[i % docs.length]!;
    const bucket = byDoc[doc]!;
    if (bucket.length) picks.push(bucket.shift());
    i++;
    if (i > rows.length * 2) break;
  }
  for (const r of picks)
    console.log(
      `  ${r.ptr_id}-${r.id.split("-ocr-")[1]} ${r.member_name.slice(0, 18).padEnd(18)} ${r.transaction_type.padEnd(4)} ${r.amount_range.padEnd(20)} ${r.transaction_date} ${(r.ticker || r.asset_name).slice(0, 26).padEnd(26)} ${r.report_url}`,
    );
})()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
