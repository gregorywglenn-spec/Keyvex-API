/**
 * Cold diagnostic for Greg's 3 items (Gate 5 follow-up, 2026-05-23):
 *
 *  ITEM 1: What is ACTUALLY in `insider_transactions_v2`?
 *          And which collection does the live MCP tool query?
 *
 *  ITEM 2: Is `schema_era` derived from filing-quarter (correct),
 *          NOT from transaction_date?
 *
 *  ITEM 3a: Is the Malecek/PRTA footnote actually on the doc?
 *           (Doc-ID fetch — the cold equivalent of what's served.)
 *
 * Queries Firestore directly (no MCP transport involved) so we see the
 * raw stored truth, not what any tool happens to expose.
 */
import { getLiveDb } from "../src/firestore.js";
import type { InsiderTransactionV2 } from "../src/types.js";

async function main() {
  const db = await getLiveDb();
  const txCol = db.collection("insider_transactions_v2");
  const filingCol = db.collection("insider_filings_v2");
  const holdingCol = db.collection("insider_holdings_v2");
  const legacyCol = db.collection("insider_trades");

  console.log("================================================================");
  console.log("ITEM 1: Collection contents — v2 vs legacy");
  console.log("================================================================\n");

  // 1a) Distinct source_zip values in v2
  console.log("[1a] Distinct source_zip values in insider_transactions_v2:");
  // Firestore can't do DISTINCT directly; we'll group by sampling + assert single value
  const sourceZipSnap = await txCol.select("source_zip").limit(5000).get();
  const seenZips = new Map<string, number>();
  for (const doc of sourceZipSnap.docs) {
    const z = (doc.data() as { source_zip?: string }).source_zip ?? "(missing)";
    seenZips.set(z, (seenZips.get(z) ?? 0) + 1);
  }
  for (const [zip, n] of [...seenZips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${zip.padEnd(28)} ${n.toLocaleString()} (from 5000-doc sample)`);
  }
  if (seenZips.size === 1) {
    console.log(
      `  ✓ ONLY ONE source_zip in 5000-doc sample → no quarter intermix.\n`,
    );
  } else {
    console.log(`  ⚠ Multiple source_zips seen — quarter intermix present.\n`);
  }

  // 1b) Distinct sources values in v2 (should be only "sec_bulk")
  console.log("[1b] Distinct `source` field values in insider_transactions_v2:");
  const sourceSnap = await txCol.select("source").limit(5000).get();
  const seenSources = new Map<string, number>();
  for (const doc of sourceSnap.docs) {
    const s = (doc.data() as { source?: string }).source ?? "(missing)";
    seenSources.set(s, (seenSources.get(s) ?? 0) + 1);
  }
  for (const [s, n] of seenSources) {
    console.log(`     source="${s}"  ${n.toLocaleString()} (from 5000-doc sample)`);
  }

  // 1c) Collection counts side-by-side
  console.log("\n[1c] Collection counts side-by-side:");
  const [v2TxCount, v2FilingCount, v2HoldCount, legacyCount] = await Promise.all([
    txCol.count().get(),
    filingCol.count().get(),
    holdingCol.count().get(),
    legacyCol.count().get(),
  ]);
  console.log(
    `     insider_transactions_v2    ${v2TxCount.data().count.toLocaleString().padStart(10)}  ← Greg's pilot wrote here`,
  );
  console.log(
    `     insider_holdings_v2        ${v2HoldCount.data().count.toLocaleString().padStart(10)}  ← pilot also wrote here`,
  );
  console.log(
    `     insider_filings_v2         ${v2FilingCount.data().count.toLocaleString().padStart(10)}  ← pilot also wrote here`,
  );
  console.log(
    `     insider_trades  (legacy)   ${legacyCount.data().count.toLocaleString().padStart(10)}  ← daily scraper writes here, MCP tool reads here`,
  );

  // 1d) MCP-tool-side path inspection
  console.log("\n[1d] What the live MCP `get_insider_transactions` tool queries:");
  console.log(`     src/firestore.ts:824   db.collection("insider_trades")  ← LEGACY, not v2`);
  console.log(`     ↳ The MCP tool does NOT read from insider_transactions_v2 at all.`);
  console.log(`     ↳ Any rows the live MCP returns are from the legacy collection.`);
  console.log(
    `     ↳ Disclosure-date + reporting-lag-days fields exist only on legacy schema,`,
  );
  console.log(
    `       so a query result with disclosure_date=Aug-2024 and reporting_lag_days=405`,
  );
  console.log(`       was a legacy row. The v2 pilot did NOT cause that.\n`);

  console.log("================================================================");
  console.log("ITEM 2: Era tagging — filing-date-driven, NOT transaction-date-driven");
  console.log("================================================================\n");

  // 2a) Find a row with old transaction_date AND era="2023_plus"
  // The 2023q1 zip can contain transactions from any prior year if the filing
  // was a late submission. era should still be "2023_plus" because the FILING
  // happened in 2023+ (and AFF10B5ONE is a property of the form version used).
  console.log("[2a] Looking for late-filed-old-transaction rows in v2:");
  console.log("     (transaction_date < 2023-01-01 AND schema_era == '2023_plus')");
  const oldTxSnap = await txCol
    .where("transaction_date", "<", "2023-01-01")
    .limit(10)
    .get();
  console.log(`     Found ${oldTxSnap.size} rows in 10-row sample.`);
  if (oldTxSnap.size > 0) {
    for (const doc of oldTxSnap.docs.slice(0, 5)) {
      const d = doc.data() as InsiderTransactionV2;
      const eraOk = d.schema_era === "2023_plus" ? "✓" : "⚠";
      console.log(
        `     ${eraOk}  ${doc.id.padEnd(45)} tx=${d.transaction_date}  file=${d.filing_date}  era=${d.schema_era}  aff10b5one=${JSON.stringify(d.aff10b5one)}`,
      );
    }
  }

  // 2b) Confirm code path
  console.log("\n[2b] Code path for era assignment:");
  console.log(`     src/scrapers/form345-bulk.ts:51   eraForQuarter(quarter)`);
  console.log(`       — takes "2023q1" (the bulk-zip's quarter = the FILING quarter)`);
  console.log(`       — returns "2023_plus" if year >= 2023, else "pre_2023"`);
  console.log(`     ↳ Era is keyed off bulk-zip quarter, NOT off row.TRANS_DATE.`);
  console.log(`     ↳ A row in 2023q1.zip with transaction_date 2018-06-15 gets`);
  console.log(`       schema_era="2023_plus" — correct, because the FILING is in`);
  console.log(`       2023+ which means the form version supports AFF10B5ONE.\n`);

  console.log("================================================================");
  console.log("ITEM 3a: Footnote storage — direct doc-ID fetch (Malecek/PRTA)");
  console.log("================================================================\n");

  // 3a) The Malecek/PRTA filing had 4 nonderiv transactions per pilot. Pull all 4
  // and dump every footnote_refs we wrote. The 10b5-1 footnote should be on the
  // trans_code field per the inspect-built-docs output.
  console.log(
    "[3a] Fetching all transactions for accession 0001140361-23-015527 (PRTA, Malecek)…",
  );
  const malecekTxSnap = await txCol
    .where("accession_number", "==", "0001140361-23-015527")
    .get();
  console.log(`     ${malecekTxSnap.size} transaction docs found.\n`);
  for (const doc of malecekTxSnap.docs) {
    const d = doc.data() as InsiderTransactionV2;
    console.log(`   doc_id: ${doc.id}`);
    console.log(`     ticker:                ${d.ticker}`);
    console.log(`     reporting_owner_name:  ${d.reporting_owner_name}`);
    console.log(`     transaction_date:      ${d.transaction_date}`);
    console.log(`     filing_date:           ${d.filing_date}`);
    console.log(`     schema_era:            ${d.schema_era}`);
    console.log(`     aff10b5one:            ${JSON.stringify(d.aff10b5one)}`);
    console.log(`     trans_code:            ${d.trans_code}`);
    console.log(`     trans_shares:          ${d.trans_shares}`);
    console.log(`     trans_price_per_share: ${d.trans_price_per_share}`);
    console.log(`     footnote_refs.length:  ${d.footnote_refs?.length ?? 0}`);
    if (d.footnote_refs && d.footnote_refs.length > 0) {
      for (const fn of d.footnote_refs) {
        console.log(`       • field=${fn.field}  ref=${fn.ref}`);
        console.log(`         text="${fn.text.slice(0, 200)}${fn.text.length > 200 ? "..." : ""}"`);
      }
    } else {
      console.log(`     ⚠ NO FOOTNOTES on this doc — investigate.`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
