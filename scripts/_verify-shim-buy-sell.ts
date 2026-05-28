/**
 * Verify the v2 shim's synthesized `transaction_type` (buy/sell) matches
 * what the legacy scraper stored for the SAME transactions over the
 * overlap window.
 *
 * Greg's invariant (2026-05-24): "verify the synthesized buy/sell matches
 * what legacy returned for the same transactions over the overlap window
 * — don't just map A→buy/D→sell naively, because grants/gifts/tax-
 * withholding (codes A/G/F) need to match legacy's exact semantics."
 *
 * Strategy:
 *   1. Pull a stratified sample of rows from `insider_trades` (legacy)
 *      that exercises every transaction_code the legacy scraper writes.
 *   2. For each, look up the corresponding row in `insider_transactions_v2`
 *      by (accession_number, transaction_date, transaction_code, shares).
 *   3. Run the shim on the v2 row; compare transaction_type vs legacy's.
 *   4. Report match rate. Fail loud if mismatched on ANY code.
 *
 * Especially check codes A, G, F (the ones Greg called out) — those are
 * where naive A→buy/D→sell would fail because of the acqDisp + code
 * fallback hierarchy in deriveLegacyBuyOrSell.
 *
 * Read-only. Safe to run anytime.
 */
import { getLiveDb } from "../src/firestore.js";
import { applyV2BackwardCompatShim } from "../src/tools/insider-transactions-v2-shim.js";
import type { InsiderTransactionV2 } from "../src/types.js";

// Codes legacy writes (per form4.ts) plus the special "tricky" codes Greg flagged.
const CODES_OF_INTEREST = ["P", "S", "A", "M", "X", "C", "F", "G", "D", "I", "V"];
const SAMPLES_PER_CODE = 25; // 25 × 11 = 275 rows total

interface LegacyRow {
  doc_id: string;
  accession_number: string;
  transaction_date: string;
  transaction_code: string;
  transaction_type: "buy" | "sell";
  shares: number | null;
  acquired_disposed: "A" | "D" | null;
  is_derivative: boolean;
}

interface MatchAttempt {
  code: string;
  legacy: LegacyRow;
  v2: InsiderTransactionV2 | null;
  shimmed_type: "buy" | "sell" | null;
  matches: boolean;
  mismatch_reason?: string;
}

async function main() {
  const db = await getLiveDb();
  const legacyCol = db.collection("insider_trades");
  const v2Col = db.collection("insider_transactions_v2");

  console.log("=================================================================");
  console.log("SHIM VERIFY — synthesized buy/sell vs legacy");
  console.log("=================================================================\n");
  console.log(`Sample plan: ${SAMPLES_PER_CODE} legacy rows per code, codes: ${CODES_OF_INTEREST.join(", ")}\n`);

  const attempts: MatchAttempt[] = [];

  for (const code of CODES_OF_INTEREST) {
    process.stdout.write(`code=${code.padEnd(2)} ... `);
    const snap = await legacyCol
      .where("transaction_code", "==", code)
      .limit(SAMPLES_PER_CODE)
      .get();

    if (snap.empty) {
      console.log(`  no legacy rows with this code; skipping`);
      continue;
    }

    let foundInV2 = 0;
    let mismatched = 0;

    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const legacy: LegacyRow = {
        doc_id: d.id,
        accession_number: data.accession_number as string,
        transaction_date: data.transaction_date as string,
        transaction_code: data.transaction_code as string,
        transaction_type: data.transaction_type as "buy" | "sell",
        shares: (data.shares as number | null) ?? null,
        acquired_disposed: (data.acquired_disposed as "A" | "D" | null) ?? null,
        is_derivative: data.is_derivative as boolean,
      };

      // Find the matching v2 row by (accession, transaction_date, trans_code, trans_shares).
      // For rare cases of multiple matches, we'll just take the first.
      let v2Query: FirebaseFirestore.Query = v2Col
        .where("accession_number", "==", legacy.accession_number)
        .where("trans_code", "==", legacy.transaction_code)
        .where("transaction_date", "==", legacy.transaction_date);
      if (legacy.shares !== null) {
        v2Query = v2Query.where("trans_shares", "==", legacy.shares);
      }
      const v2Snap = await v2Query.limit(5).get();

      let v2: InsiderTransactionV2 | null = null;
      if (!v2Snap.empty) {
        // If multiple, also try to disambiguate by acquired_disposed
        const candidates = v2Snap.docs.map((dd) => dd.data() as InsiderTransactionV2);
        v2 =
          candidates.find((c) => c.trans_acquired_disp_cd === legacy.acquired_disposed) ??
          candidates[0] ??
          null;
        foundInV2++;
      }

      const shimmed = v2 ? applyV2BackwardCompatShim(v2).transaction_type : null;
      const matches = shimmed !== null && shimmed === legacy.transaction_type;

      attempts.push({
        code,
        legacy,
        v2,
        shimmed_type: shimmed,
        matches,
        mismatch_reason: !v2
          ? "v2 row not found"
          : !matches
            ? `legacy=${legacy.transaction_type} vs shim=${shimmed}`
            : undefined,
      });

      if (v2 && !matches) mismatched++;
    }
    console.log(`${foundInV2}/${snap.size} matched in v2, ${mismatched} mismatch(es)`);
  }

  // Aggregate report
  console.log("\n=================================================================");
  console.log("RESULTS BY CODE");
  console.log("=================================================================");
  console.log(`code | n  | found | matches | mismatch | notFound`);
  console.log(`-----|----|-------|---------|----------|---------`);
  const codes = [...new Set(attempts.map((a) => a.code))];
  for (const code of codes) {
    const rows = attempts.filter((a) => a.code === code);
    const n = rows.length;
    const found = rows.filter((a) => a.v2 !== null).length;
    const matches = rows.filter((a) => a.matches).length;
    const mismatch = rows.filter((a) => a.v2 !== null && !a.matches).length;
    const notFound = rows.filter((a) => a.v2 === null).length;
    console.log(
      `${code.padEnd(4)} | ${String(n).padStart(2)} | ${String(found).padStart(5)} | ${String(matches).padStart(7)} | ${String(mismatch).padStart(8)} | ${String(notFound).padStart(8)}`,
    );
  }

  // Failure detail: every mismatch + first 5 notFounds
  const realMismatches = attempts.filter((a) => a.v2 !== null && !a.matches);
  if (realMismatches.length > 0) {
    console.log(`\n⚠ ${realMismatches.length} buy/sell MISMATCH(ES) — investigate before deploy:`);
    for (const m of realMismatches) {
      console.log(`\n  ${m.legacy.doc_id}`);
      console.log(`    legacy.transaction_type:  ${m.legacy.transaction_type}`);
      console.log(`    legacy.transaction_code:  ${m.legacy.transaction_code}`);
      console.log(`    legacy.acquired_disposed: ${m.legacy.acquired_disposed}`);
      console.log(`    shimmed (from v2):        ${m.shimmed_type}`);
      console.log(`    v2.trans_code:            ${m.v2!.trans_code}`);
      console.log(`    v2.trans_acquired_disp_cd:${m.v2!.trans_acquired_disp_cd}`);
    }
  }

  const notFounds = attempts.filter((a) => a.v2 === null);
  if (notFounds.length > 0) {
    console.log(`\n[info] ${notFounds.length} legacy rows had no v2 match (expected: legacy may have rows the bulk doesn't, see Gate 7 diff — but bulk had 0 legacy-only rows for our overlap so this should be rare):`);
    for (const nf of notFounds.slice(0, 5)) {
      console.log(`  ${nf.legacy.doc_id}  code=${nf.legacy.transaction_code}`);
    }
  }

  const total = attempts.length;
  const matchedN = attempts.filter((a) => a.matches).length;
  const foundN = attempts.filter((a) => a.v2 !== null).length;
  const matchPct = foundN === 0 ? 0 : (matchedN / foundN) * 100;

  console.log("\n=================================================================");
  console.log("SUMMARY");
  console.log("=================================================================");
  console.log(`  Total legacy rows sampled:        ${total}`);
  console.log(`  Found matching v2 row:            ${foundN} (${((foundN / total) * 100).toFixed(1)}%)`);
  console.log(`  Of those, shim matches legacy:    ${matchedN} (${matchPct.toFixed(2)}%)`);
  console.log(`  Mismatches (buy/sell disagree):   ${realMismatches.length}`);

  const pass = realMismatches.length === 0 && foundN > 0;
  console.log(`\n=== ${pass ? "✓ SHIM VERIFIED — buy/sell synthesis matches legacy" : "⚠ MISMATCHES PRESENT — FIX BEFORE DEPLOY"} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFY FAIL:", e);
  process.exit(1);
});
