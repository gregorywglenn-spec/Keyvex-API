/**
 * CLEANUP-HOUSE-QUALITY — two narrow G2 fixes on House congressional_trades:
 *   1. Uppercase tickers that carry OCR-artifact lowercase letters (CaT->CAT).
 *   2. Remove EXACT within-filing duplicate rows (same ptr_id + type + ticker +
 *      asset_name + transaction_date + amount_range + owner) — keep the
 *      lowest doc id. These are vision/text double-reads, not distinct lots.
 *
 * Dry-run by default (reports counts + samples). Pass --apply to write.
 *   npx tsx scripts/cleanup-house-quality.ts            # dry run
 *   npx tsx scripts/cleanup-house-quality.ts --apply
 */
import "../src/load-secrets.js";
import { getLiveDb } from "../src/firestore.js";

const APPLY = process.argv.includes("--apply");

(async () => {
  const db = await getLiveDb();
  const snap = await db
    .collection("congressional_trades")
    .where("chamber", "==", "house")
    .get();
  console.error(`[cleanup] scanning ${snap.size} House rows`);

  const tickerFixes: { id: string; from: string; to: string }[] = [];
  const groups = new Map<string, { id: string }[]>();

  for (const d of snap.docs) {
    const t = d.data() as Record<string, unknown>;
    const ticker = String(t.ticker ?? "");
    if (ticker && /[a-z]/.test(ticker)) {
      tickerFixes.push({ id: d.id, from: ticker, to: ticker.toUpperCase() });
    }
    // dedup key — uppercase ticker so doubles that differ only by case still group
    const key = [
      t.ptr_id,
      t.transaction_type,
      ticker.toUpperCase(),
      String(t.asset_name ?? "").trim().toLowerCase(),
      t.transaction_date,
      t.amount_range,
      t.owner,
    ].join("||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ id: d.id });
  }

  const dupDeletes: string[] = [];
  for (const [, rows] of groups) {
    if (rows.length > 1) {
      const sorted = rows.map((r) => r.id).sort();
      dupDeletes.push(...sorted.slice(1)); // keep first, delete rest
    }
  }

  console.error(`[cleanup] ticker-case fixes: ${tickerFixes.length}`);
  for (const f of tickerFixes.slice(0, 15))
    console.error(`   ${f.id}: ${f.from} -> ${f.to}`);
  console.error(`[cleanup] exact-duplicate rows to delete: ${dupDeletes.length}`);
  for (const id of dupDeletes.slice(0, 15)) console.error(`   del ${id}`);

  if (!APPLY) {
    console.error(`\n[cleanup] DRY-RUN — nothing written. Re-run with --apply.`);
    process.exit(0);
  }

  let n = 0;
  // ticker fixes
  for (let i = 0; i < tickerFixes.length; i += 400) {
    const b = db.batch();
    for (const f of tickerFixes.slice(i, i + 400))
      b.update(db.collection("congressional_trades").doc(f.id), { ticker: f.to });
    await b.commit();
    n += Math.min(400, tickerFixes.length - i);
  }
  // dup deletes
  let del = 0;
  for (let i = 0; i < dupDeletes.length; i += 400) {
    const b = db.batch();
    for (const id of dupDeletes.slice(i, i + 400))
      b.delete(db.collection("congressional_trades").doc(id));
    await b.commit();
    del += Math.min(400, dupDeletes.length - i);
  }
  console.error(`\n[cleanup] APPLIED: ${n} ticker fixes, ${del} duplicates deleted.`);
  process.exit(0);
})().catch((e) => {
  console.error("[cleanup] FATAL:", e);
  process.exit(1);
});
