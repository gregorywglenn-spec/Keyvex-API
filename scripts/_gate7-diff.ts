/**
 * Gate 7 cutover diff: legacy insider_trades vs bulk insider_transactions_v2
 *
 * Compares by accession_number (both schemas carry this field) over the
 * BULK-COVERED OVERLAP WINDOW: 2022-01-03 → 2026-03-31.
 *
 * (Legacy covers 2022-01-03 → 2026-05-22 per _diag-legacy-shape.ts.
 *  v2 bulk covers 2006q1 → 2026q1.
 *  The 2026-04-01 → 2026-05-22 window is legacy-only because 2026q2
 *  hasn't published yet from SEC — not a coverage gap, a publish lag.)
 *
 * Outputs:
 *   - set diff: overlap, bulk-only-within-window, legacy-only-within-window
 *   - row-count ratio (bulk usually has MORE rows per accession because it
 *     captures the full derivative table that the daily scraper missed)
 *   - sampled legacy-only accessions for root-cause inspection
 *
 * Read-only. Safe to run anytime. ~5-10 min wall time.
 */
import * as fs from "node:fs";
import { getLiveDb } from "../src/firestore.js";

const OVERLAP_START = "2022-01-03";
const OVERLAP_END = "2026-03-31";
const PAGE_SIZE = 1000;

async function enumerateLegacyAccessions(db: FirebaseFirestore.Firestore): Promise<{ accessions: Set<string>; rowCount: number }> {
  console.log(`[legacy] Enumerating accessions ${OVERLAP_START} → ${OVERLAP_END}...`);
  const col = db.collection("insider_trades");
  const accessions = new Set<string>();
  let rowCount = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let pages = 0;

  while (true) {
    let q: FirebaseFirestore.Query = col
      .where("disclosure_date", ">=", OVERLAP_START)
      .where("disclosure_date", "<=", OVERLAP_END)
      .orderBy("disclosure_date")
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const acc = (d.data() as { accession_number?: string }).accession_number;
      if (acc) accessions.add(acc);
      rowCount++;
    }
    cursor = snap.docs[snap.docs.length - 1];
    pages++;
    if (pages % 20 === 0) {
      console.log(`  [legacy] page ${pages}: ${rowCount.toLocaleString()} rows, ${accessions.size.toLocaleString()} distinct accessions`);
    }
    if (snap.size < PAGE_SIZE) break;
  }
  console.log(`[legacy] DONE: ${rowCount.toLocaleString()} rows, ${accessions.size.toLocaleString()} distinct accessions in window`);
  return { accessions, rowCount };
}

async function enumerateV2Accessions(db: FirebaseFirestore.Firestore): Promise<{ accessions: Set<string>; rowCount: number }> {
  console.log(`[v2] Enumerating accessions ${OVERLAP_START} → ${OVERLAP_END} (from insider_filings_v2)...`);
  const col = db.collection("insider_filings_v2");
  const accessions = new Set<string>();
  let rowCount = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let pages = 0;

  while (true) {
    let q: FirebaseFirestore.Query = col
      .where("filing_date", ">=", OVERLAP_START)
      .where("filing_date", "<=", OVERLAP_END)
      .orderBy("filing_date")
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const acc = (d.data() as { accession_number?: string }).accession_number;
      if (acc) accessions.add(acc);
      rowCount++;
    }
    cursor = snap.docs[snap.docs.length - 1];
    pages++;
    if (pages % 50 === 0) {
      console.log(`  [v2] page ${pages}: ${rowCount.toLocaleString()} filings, ${accessions.size.toLocaleString()} distinct accessions`);
    }
    if (snap.size < PAGE_SIZE) break;
  }
  console.log(`[v2] DONE: ${rowCount.toLocaleString()} filings, ${accessions.size.toLocaleString()} distinct accessions in window`);
  return { accessions, rowCount };
}

async function getV2TransactionRowCountForOverlap(db: FirebaseFirestore.Firestore): Promise<number> {
  // Use the count() aggregation for speed (no streaming)
  const c = await db
    .collection("insider_transactions_v2")
    .where("filing_date", ">=", OVERLAP_START)
    .where("filing_date", "<=", OVERLAP_END)
    .count()
    .get();
  return c.data().count;
}

async function inspectLegacyOnlyAccessions(
  db: FirebaseFirestore.Firestore,
  accessions: string[],
): Promise<void> {
  if (accessions.length === 0) return;
  console.log(`\n[inspect] Investigating ${Math.min(accessions.length, 20)} legacy-only accessions (sample)...`);
  const sample = accessions.slice(0, 20);

  // Group by year of accession to spot patterns
  const yearCounts = new Map<string, number>();
  for (const a of accessions) {
    const m = a.match(/^\d{10}-(\d{2})/);
    if (m && m[1]) {
      const yr = `20${m[1]}`;
      yearCounts.set(yr, (yearCounts.get(yr) ?? 0) + 1);
    }
  }
  console.log(`  legacy-only by accession-year:`);
  for (const [yr, n] of [...yearCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`    ${yr}: ${n.toLocaleString()}`);
  }

  // For 5 sampled accessions, pull legacy details + look for v2 by accession
  console.log(`\n  Per-accession inspection (first 5):`);
  for (const acc of sample.slice(0, 5)) {
    const legacySnap = await db
      .collection("insider_trades")
      .where("accession_number", "==", acc)
      .limit(5)
      .get();
    const v2FilingSnap = await db.collection("insider_filings_v2").doc(acc).get();
    const v2TxSnap = await db
      .collection("insider_transactions_v2")
      .where("accession_number", "==", acc)
      .limit(5)
      .get();

    console.log(`\n    accession: ${acc}`);
    console.log(`      legacy rows:                ${legacySnap.size}`);
    if (legacySnap.docs[0]) {
      const d = legacySnap.docs[0].data() as Record<string, unknown>;
      console.log(`      legacy disclosure_date:     ${JSON.stringify(d.disclosure_date)}`);
      console.log(`      legacy ticker / officer:    ${JSON.stringify(d.ticker)} / ${JSON.stringify(d.officer_name)}`);
      console.log(`      legacy data_source:         ${JSON.stringify(d.data_source)}`);
    }
    console.log(`      v2 filing present:          ${v2FilingSnap.exists}`);
    console.log(`      v2 transactions present:    ${v2TxSnap.size}`);
  }
}

async function main() {
  const startedAt = Date.now();
  const db = await getLiveDb();
  console.log("================================================================");
  console.log("GATE 7 — Cutover diff: legacy vs bulk_v2");
  console.log("================================================================");
  console.log(`  Overlap window: ${OVERLAP_START} → ${OVERLAP_END}`);
  console.log(`  Legacy collection:  insider_trades  (daily EDGAR scraper)`);
  console.log(`  Bulk collection:    insider_transactions_v2 / insider_filings_v2`);
  console.log("");

  // Enumerate accessions in parallel
  const [legacy, v2, v2TxTotal] = await Promise.all([
    enumerateLegacyAccessions(db),
    enumerateV2Accessions(db),
    getV2TransactionRowCountForOverlap(db),
  ]);

  // Compute set differences
  const legacyOnly: string[] = [];
  const bulkOnly: string[] = [];
  const inBoth: string[] = [];
  for (const a of legacy.accessions) {
    if (v2.accessions.has(a)) inBoth.push(a);
    else legacyOnly.push(a);
  }
  for (const a of v2.accessions) {
    if (!legacy.accessions.has(a)) bulkOnly.push(a);
  }

  const overlapPct = (inBoth.length / legacy.accessions.size) * 100;

  console.log("");
  console.log("================================================================");
  console.log("DIFF RESULTS");
  console.log("================================================================");
  console.log(`  Legacy accessions in window:      ${legacy.accessions.size.toLocaleString()}`);
  console.log(`  v2 accessions in window:          ${v2.accessions.size.toLocaleString()}`);
  console.log("");
  console.log(`  Accessions in BOTH (overlap):     ${inBoth.length.toLocaleString()}`);
  console.log(`    → ${overlapPct.toFixed(1)}% of legacy accessions are also in v2`);
  console.log(`  Accessions LEGACY-ONLY:           ${legacyOnly.length.toLocaleString()}`);
  console.log(`    → present in daily scraper but NOT in bulk dataset (investigate)`);
  console.log(`  Accessions BULK-ONLY:             ${bulkOnly.length.toLocaleString()}`);
  console.log(`    → present in bulk but NOT in legacy (expected: scraper missed them, late filings, etc.)`);
  console.log("");
  console.log(`  Row-count comparison (totals in window):`);
  console.log(`    legacy insider_trades rows:                ${legacy.rowCount.toLocaleString()}`);
  console.log(`    v2 insider_transactions_v2 rows:           ${v2TxTotal.toLocaleString()}`);
  console.log(`    ratio v2/legacy:                           ${(v2TxTotal / legacy.rowCount).toFixed(2)}x`);
  console.log(`    (>1 expected — bulk captures more deriv-table rows the legacy parser missed)`);

  // Save full diff lists for offline inspection
  const outDir = "C:\\Users\\home8\\AppData\\Local\\Temp";
  fs.writeFileSync(`${outDir}\\gate7-legacy-only.txt`, legacyOnly.sort().join("\n"));
  fs.writeFileSync(`${outDir}\\gate7-bulk-only.txt`, bulkOnly.sort().join("\n"));
  fs.writeFileSync(`${outDir}\\gate7-in-both.txt`, inBoth.sort().join("\n"));
  console.log("");
  console.log(`  Full diff lists written to ${outDir}\\gate7-*.txt`);

  // Inspect legacy-only accessions (the concerning bucket)
  await inspectLegacyOnlyAccessions(db, legacyOnly);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`Wall time: ${elapsed}s`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
