/**
 * INSIDER V2 — ALL-QUARTERS COUNT CHECK (the sweep's final gauge).
 *
 * Extends the Gate-6 cross-era check (3 sampled eras) to ALL 81 loaded
 * quarters: per quarter, Firestore doc counts (by source_zip filter) for
 * transactions / holdings / filings vs the row counts built from SEC's own
 * quarterly bulk TSVs.
 *
 *   npx tsx scripts/_verify-bulk-all-quarters.ts --fs-only   # Firestore side only (no SEC traffic)
 *   npx tsx scripts/_verify-bulk-all-quarters.ts             # full check (downloads/caches each quarter zip)
 *   npx tsx scripts/_verify-bulk-all-quarters.ts --quarters=2010q1,2010q2
 *
 * READ-ONLY. Source zips cache in the loader's scratch dir, so re-runs
 * don't re-download. Output doubles as the reconcile artifact —
 * tee/redirect into docs/reconciliation/.
 */
import "../src/load-secrets.js";
import { getLiveDb } from "../src/firestore.js";
import {
  buildQuarterDocs,
  downloadAndExtractQuarter,
  loadQuarterTables,
} from "../src/scrapers/form345-bulk.js";

const FS_ONLY = process.argv.includes("--fs-only");
const ONLY = process.argv.find((a) => a.startsWith("--quarters="))?.split("=")[1]?.split(",");

const QUARTERS: string[] = [];
for (let y = 2006; y <= 2026; y++) {
  for (const q of [1, 2, 3, 4]) {
    if (y === 2026 && q > 1) break; // 2026q2+ not published yet
    QUARTERS.push(`${y}q${q}`);
  }
}
const targets = ONLY ?? QUARTERS;

const db = await getLiveDb();
const txCol = db.collection("insider_transactions_v2");
const holdCol = db.collection("insider_holdings_v2");
const filingCol = db.collection("insider_filings_v2");

let mismatches = 0;
let checked = 0;
console.log("quarter,fs_tx,src_tx,fs_hold,src_hold,fs_filing,src_filing,verdict");
for (const quarter of targets) {
  const zip = `${quarter}_form345.zip`;
  const [t, h, f] = await Promise.all([
    txCol.where("source_zip", "==", zip).count().get(),
    holdCol.where("source_zip", "==", zip).count().get(),
    filingCol.where("source_zip", "==", zip).count().get(),
  ]);
  const fsTx = t.data().count;
  const fsHold = h.data().count;
  const fsFiling = f.data().count;

  if (FS_ONLY) {
    console.log(`${quarter},${fsTx},?,${fsHold},?,${fsFiling},?,fs-only`);
    continue;
  }

  let srcTx = -1, srcHold = -1, srcFiling = -1;
  try {
    // Downloads + extracts (cached zip reused on re-runs); polite pacing.
    const scratch = await downloadAndExtractQuarter(quarter);
    await new Promise((r) => setTimeout(r, 500));
    const tables = loadQuarterTables(scratch);
    const built = buildQuarterDocs(tables, quarter);
    srcTx = built.transactions.length;
    srcHold = built.holdings.length;
    srcFiling = built.filings.length;
  } catch (err) {
    console.log(`${quarter},${fsTx},ERR,${fsHold},ERR,${fsFiling},ERR,source-load-failed: ${(err as Error).message}`);
    mismatches++;
    continue;
  }
  const ok = fsTx === srcTx && fsHold === srcHold && fsFiling === srcFiling;
  if (!ok) mismatches++;
  checked++;
  console.log(`${quarter},${fsTx},${srcTx},${fsHold},${srcHold},${fsFiling},${srcFiling},${ok ? "OK" : "MISMATCH"}`);
}
console.log(`# ${FS_ONLY ? "fs-only pass" : `checked ${checked} quarters, mismatches ${mismatches}`}`);
