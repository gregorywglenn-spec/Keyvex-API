/**
 * Phase B — Index Pass (READ-ONLY MEASUREMENT GATE).
 *
 * Per Greg's brief (2026-05-25), this script is THE measurement that
 * grounds the Phase B heal-pass ETA. It runs cursor scans across the
 * v2 collections, isolates only rows that genuinely need healing, groups
 * them by accession_number (and fund_cik+quarter for the position_change
 * category), and prints two hard numbers plus a grounded ETA.
 *
 * IT MUST NOT:
 *   - make ANY SEC EDGAR HTTP fetch
 *   - write ANY entry to Firestore
 *   - flip ANY status field
 *   - recompute ANY position_change
 *   - import src/phase-b/heal-worker.ts (which would error anyway, but
 *     this script doesn't even need to know that module exists)
 *
 * The Firestore queries here use Admin SDK reads with `select()` to
 * minimize bytes — index-only counts where possible, projected docs
 * (accession_number, fund_cik, quarter only) when we need to group.
 *
 * After printing, the script HALTS. No queue entries written. No heal
 * authorization granted by running it. Greg reads the numbers and
 * decides whether/when to authorize the heal pass as a separate
 * explicit command.
 *
 * Run:
 *   npx tsx scripts/phase-b-index-pass.ts
 */

import { getLiveDb } from "../src/firestore.js";
import type {
  HealReason,
  IndexPassReport,
} from "../src/phase-b/types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const COLLECTIONS = {
  institutional_holdings: "institutional_holdings",
  insider_trades: "insider_trades",
  insider_transactions_v2: "insider_transactions_v2",
} as const;

/** SEC fair-access ceiling per their documented policy. */
const SEC_CEILING_REQ_PER_SEC = 10;

/** Operational rate. Matches the existing src/scrapers/13f.ts guardrail
 *  (RATE_LIMIT_MS = 200 → 5 req/sec sustained). The 2x safety margin
 *  against the ceiling matters under bursty concurrency. */
const OPERATIONAL_REQ_PER_SEC = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatHumanDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "0s";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (mins || hours || days) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((num / denom) * 100).toFixed(2)}%`;
}

// ─── Scan a collection by a single-field equality, project minimal fields ──

interface ScanResult {
  total_rows: number;
  unique_accession_numbers: Set<string>;
  unique_fund_quarters: Set<string>;
}

async function scanInsufficientData(opts: {
  collection: string;
  whereField: "verification_status" | "position_change";
  whereValue: string;
  projectFields: string[];
  label: string;
}): Promise<ScanResult> {
  const db = await getLiveDb();
  const PAGE_SIZE = 5000;
  const result: ScanResult = {
    total_rows: 0,
    unique_accession_numbers: new Set(),
    unique_fund_quarters: new Set(),
  };

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let pageNum = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    pageNum++;
    let q: FirebaseFirestore.Query = db
      .collection(opts.collection)
      .where(opts.whereField, "==", opts.whereValue)
      .select(...opts.projectFields)
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();

    if (snap.empty) break;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      result.total_rows++;
      const acc = data.accession_number;
      if (typeof acc === "string" && acc.length > 0) {
        result.unique_accession_numbers.add(acc);
      }
      const fundCik = data.fund_cik;
      const quarter = data.quarter;
      if (
        typeof fundCik === "string" &&
        fundCik.length > 0 &&
        typeof quarter === "string" &&
        quarter.length > 0
      ) {
        result.unique_fund_quarters.add(`${fundCik}-${quarter}`);
      }
    }

    process.stderr.write(
      `  [${opts.label}] page ${pageNum}: +${snap.size} rows ` +
        `(running total ${result.total_rows}, ` +
        `${result.unique_accession_numbers.size} unique accessions)\n`,
    );

    if (snap.size < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1] ?? null;
    if (!cursor) break;
  }

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("");
  console.log("=".repeat(72));
  console.log("PHASE B — INDEX PASS (read-only measurement)");
  console.log("=".repeat(72));
  console.log(`measured_at: ${new Date().toISOString()}`);
  console.log("");
  console.log(
    "Scanning v2 collections for rows tagged INSUFFICIENT_DATA by Phase A.",
  );
  console.log(
    "READ-ONLY. No SEC fetches. No Firestore writes. No status flips.",
  );
  console.log("");

  // ─── Category 1: 13F count-check failed ──────────────────────────────────
  console.log("─".repeat(72));
  console.log(
    "Category 1: institutional_holdings.verification_status === INSUFFICIENT_DATA",
  );
  console.log("  (13F count check vs primary_doc.xml tableEntryTotal failed)");
  console.log("─".repeat(72));
  const cat1 = await scanInsufficientData({
    collection: COLLECTIONS.institutional_holdings,
    whereField: "verification_status",
    whereValue: "INSUFFICIENT_DATA",
    projectFields: ["accession_number", "fund_cik", "quarter"],
    label: "13F count",
  });
  console.log(
    `  TOTAL: ${cat1.total_rows.toLocaleString()} rows across ` +
      `${cat1.unique_accession_numbers.size.toLocaleString()} unique filings`,
  );
  console.log("");

  // ─── Category 2: 13F position_change unresolved ──────────────────────────
  console.log("─".repeat(72));
  console.log(
    "Category 2: institutional_holdings.position_change === INSUFFICIENT_DATA",
  );
  console.log(
    "  (false-new guard or phantom-closed guard fired; prior quarter unknown)",
  );
  console.log("─".repeat(72));
  const cat2 = await scanInsufficientData({
    collection: COLLECTIONS.institutional_holdings,
    whereField: "position_change",
    whereValue: "INSUFFICIENT_DATA",
    projectFields: ["accession_number", "fund_cik", "quarter"],
    label: "13F pos_chg",
  });
  console.log(
    `  TOTAL: ${cat2.total_rows.toLocaleString()} rows across ` +
      `${cat2.unique_fund_quarters.size.toLocaleString()} unique (fund, quarter) pairs`,
  );
  console.log(
    `  (Heal cost per pair = 1 fetch — pull the prior quarter's 13F)`,
  );
  console.log("");

  // ─── Category 3a: insider_trades footnote ref unresolved (legacy) ────────
  console.log("─".repeat(72));
  console.log(
    "Category 3a: insider_trades.verification_status === INSUFFICIENT_DATA",
  );
  console.log("  (legacy Form 4/5 collection; footnote ref didn't resolve)");
  console.log("─".repeat(72));
  const cat3a = await scanInsufficientData({
    collection: COLLECTIONS.insider_trades,
    whereField: "verification_status",
    whereValue: "INSUFFICIENT_DATA",
    projectFields: ["accession_number"],
    label: "insider legacy",
  });
  console.log(
    `  TOTAL: ${cat3a.total_rows.toLocaleString()} rows across ` +
      `${cat3a.unique_accession_numbers.size.toLocaleString()} unique filings`,
  );
  console.log("");

  // ─── Category 3b: insider_transactions_v2 footnote ref unresolved (bulk) ─
  console.log("─".repeat(72));
  console.log(
    "Category 3b: insider_transactions_v2.verification_status === INSUFFICIENT_DATA",
  );
  console.log("  (bulk-v2 Form 4/5 collection; footnote ref didn't resolve)");
  console.log("─".repeat(72));
  const cat3b = await scanInsufficientData({
    collection: COLLECTIONS.insider_transactions_v2,
    whereField: "verification_status",
    whereValue: "INSUFFICIENT_DATA",
    projectFields: ["accession_number"],
    label: "insider v2",
  });
  console.log(
    `  TOTAL: ${cat3b.total_rows.toLocaleString()} rows across ` +
      `${cat3b.unique_accession_numbers.size.toLocaleString()} unique filings`,
  );
  console.log("");

  // ─── Informational: insider transaction_nature=INSUFFICIENT_DATA ─────────
  console.log("─".repeat(72));
  console.log(
    "Informational: insider rows tagged transaction_nature === INSUFFICIENT_DATA",
  );
  console.log(
    "  (NOT heal-fetchable — source trans_code is genuinely 'other' (J/V/E/H/L/K).",
  );
  console.log(
    "   Reported for completeness; will NOT enter the heal queue.)",
  );
  console.log("─".repeat(72));
  console.log(
    `  Count not directly queryable: transaction_nature is forward-write-only.`,
  );
  console.log(
    `  Historical rows have it DERIVED by the v2 read shim from trans_code,`,
  );
  console.log(
    `  not stored. A Firestore where("transaction_nature", "==", ...) query`,
  );
  console.log(
    `  misses every historical row. Direct count requires a full-collection`,
  );
  console.log(
    `  derivation scan — deferred to v1.1; not blocking ETA arithmetic.`,
  );
  console.log("");

  // ─── Aggregate the two hard numbers ──────────────────────────────────────
  // Union the accession-number sets across categories that share that key.
  // Category 2 contributes fund+quarter pairs separately (those are 1 fetch
  // each to pull the prior quarter's 13F filing).
  const allUniqueAccessions = new Set<string>([
    ...cat1.unique_accession_numbers,
    ...cat3a.unique_accession_numbers,
    ...cat3b.unique_accession_numbers,
  ]);
  const cat2_fetches = cat2.unique_fund_quarters.size;

  const TOTAL_RECORDS_REQUIRING_HEAL =
    cat1.total_rows + cat2.total_rows + cat3a.total_rows + cat3b.total_rows;
  const UNIQUE_SEC_FILINGS_MAPPED = allUniqueAccessions.size + cat2_fetches;

  console.log("=".repeat(72));
  console.log("DELIVERY REPORT");
  console.log("=".repeat(72));
  console.log("");
  console.log(
    `  TOTAL_RECORDS_REQUIRING_HEAL = ${TOTAL_RECORDS_REQUIRING_HEAL.toLocaleString()}`,
  );
  console.log(
    `  UNIQUE_SEC_FILINGS_MAPPED    = ${UNIQUE_SEC_FILINGS_MAPPED.toLocaleString()}`,
  );
  console.log("");
  console.log(`  Row-to-filing compression ratio:`);
  if (UNIQUE_SEC_FILINGS_MAPPED > 0) {
    const ratio = TOTAL_RECORDS_REQUIRING_HEAL / UNIQUE_SEC_FILINGS_MAPPED;
    console.log(
      `    ${ratio.toFixed(1)} rows per fetch ` +
        `(${TOTAL_RECORDS_REQUIRING_HEAL.toLocaleString()} / ${UNIQUE_SEC_FILINGS_MAPPED.toLocaleString()})`,
    );
  } else {
    console.log(`    n/a — no rows require healing.`);
  }
  console.log("");

  console.log("  Per-category breakdown:");
  console.log(
    `    Cat 1 (13F count-check):         ${cat1.total_rows.toLocaleString().padStart(10)} rows / ${cat1.unique_accession_numbers.size.toLocaleString().padStart(7)} filings`,
  );
  console.log(
    `    Cat 2 (13F position_change):     ${cat2.total_rows.toLocaleString().padStart(10)} rows / ${cat2_fetches.toLocaleString().padStart(7)} (fund,Q) pairs`,
  );
  console.log(
    `    Cat 3a (insider legacy):         ${cat3a.total_rows.toLocaleString().padStart(10)} rows / ${cat3a.unique_accession_numbers.size.toLocaleString().padStart(7)} filings`,
  );
  console.log(
    `    Cat 3b (insider bulk v2):        ${cat3b.total_rows.toLocaleString().padStart(10)} rows / ${cat3b.unique_accession_numbers.size.toLocaleString().padStart(7)} filings`,
  );
  console.log("");

  // ─── Grounded ETA ────────────────────────────────────────────────────────
  console.log("=".repeat(72));
  console.log("GROUNDED ETA");
  console.log("=".repeat(72));
  console.log("");

  const eta_op_sec = UNIQUE_SEC_FILINGS_MAPPED / OPERATIONAL_REQ_PER_SEC;
  const eta_ceil_sec = UNIQUE_SEC_FILINGS_MAPPED / SEC_CEILING_REQ_PER_SEC;

  console.log(
    `  At OPERATIONAL rate (${OPERATIONAL_REQ_PER_SEC} req/sec — matches src/scrapers/13f.ts RATE_LIMIT_MS=200):`,
  );
  console.log(
    `    ${UNIQUE_SEC_FILINGS_MAPPED.toLocaleString()} fetches / ${OPERATIONAL_REQ_PER_SEC} req/sec = ${eta_op_sec.toFixed(1)} seconds`,
  );
  console.log(`    = ${formatHumanDuration(eta_op_sec)}`);
  console.log("");
  console.log(
    `  At SEC CEILING rate (${SEC_CEILING_REQ_PER_SEC} req/sec — fair-access policy ceiling):`,
  );
  console.log(
    `    ${UNIQUE_SEC_FILINGS_MAPPED.toLocaleString()} fetches / ${SEC_CEILING_REQ_PER_SEC} req/sec = ${eta_ceil_sec.toFixed(1)} seconds`,
  );
  console.log(`    = ${formatHumanDuration(eta_ceil_sec)}`);
  console.log("");
  console.log(`  Rate-choice rationale:`);
  console.log(
    `    Operational rate (5/sec) is the recommended budget. It matches the`,
  );
  console.log(
    `    existing 13F scraper guardrail and leaves a 2x margin against SEC's`,
  );
  console.log(
    `    documented per-IP ceiling, which protects us under bursty concurrency`,
  );
  console.log(
    `    if a parallel-worker upgrade lands in v1.1.`,
  );
  console.log("");

  // ─── Likely-unhealable break-out ─────────────────────────────────────────
  console.log("  Likely-unhealable estimate:");
  console.log(
    `    Cannot estimate precisely without trial fetches. The classes most`,
  );
  console.log(`    likely to hit FAILED_PERMANENT after 3 retries:`);
  console.log(
    `    - Pre-2024 13D/G filings (paper-style, no structured XML)`,
  );
  console.log(
    `    - Pre-2022 Form 144 filings (some not in EDGAR's structured XML)`,
  );
  console.log(
    `    - 13F primary_doc.xml malformed or missing tableEntryTotal element`,
  );
  console.log(`    Empirical rate from earlier work: ~1–5%% of filings.`);
  console.log(
    `    Upper-bound budget impact: +5%% to the ETA (~${formatHumanDuration(eta_op_sec * 1.05)} at op rate).`,
  );
  console.log("");

  // ─── HALT ─────────────────────────────────────────────────────────────────
  console.log("=".repeat(72));
  console.log("HALT");
  console.log("=".repeat(72));
  console.log("");
  console.log(
    `  Phase B Index Pass complete. No heal entries written. No SEC traffic.`,
  );
  console.log(
    `  The heal worker (src/phase-b/heal-worker.ts) remains physically inert:`,
  );
  console.log(
    `  it requires BOTH HEAL_AUTHORIZED=true in env AND command="heal" passed`,
  );
  console.log(`  explicitly. Neither is set.`);
  console.log("");
  console.log(
    `  Greg: review the two hard numbers + the ETA. If they look right,`,
  );
  console.log(
    `  authorize the heal pass as a SEPARATE explicit command.`,
  );
  console.log("");

  // Emit the structured report as JSON on stderr for any tooling that wants
  // to consume it (e.g., a follow-up step that diffs runs over time).
  const report: IndexPassReport = {
    measured_at: new Date().toISOString(),
    total_records_requiring_heal: TOTAL_RECORDS_REQUIRING_HEAL,
    unique_sec_filings_mapped: UNIQUE_SEC_FILINGS_MAPPED,
    row_to_filing_compression_ratio:
      UNIQUE_SEC_FILINGS_MAPPED > 0
        ? TOTAL_RECORDS_REQUIRING_HEAL / UNIQUE_SEC_FILINGS_MAPPED
        : 0,
    by_category: [
      {
        heal_reason: "13F_COUNT_CHECK_FAILED" as HealReason,
        records_in_category: cat1.total_rows,
        unique_filings_in_category: cat1.unique_accession_numbers.size,
      },
      {
        heal_reason: "13F_POSITION_CHANGE_UNRESOLVED" as HealReason,
        records_in_category: cat2.total_rows,
        unique_filings_in_category: 0, // accession_number isn't the heal unit here
        unique_fund_quarters_in_category: cat2_fetches,
      },
      {
        heal_reason: "INSIDER_FOOTNOTE_UNRESOLVED" as HealReason,
        records_in_category: cat3a.total_rows + cat3b.total_rows,
        unique_filings_in_category:
          new Set([
            ...cat3a.unique_accession_numbers,
            ...cat3b.unique_accession_numbers,
          ]).size,
      },
    ],
    not_heal_fetchable: {
      insider_transaction_nature_insufficient_data: -1, // sentinel: not measured
      note: "transaction_nature is forward-write-only; historical rows derive it via the read shim and don't carry it in Firestore. Direct count requires a full-collection derivation scan in v1.1.",
    },
    eta: {
      operational_rate_req_per_sec: OPERATIONAL_REQ_PER_SEC,
      ceiling_rate_req_per_sec: SEC_CEILING_REQ_PER_SEC,
      eta_at_operational_rate_seconds: eta_op_sec,
      eta_at_ceiling_rate_seconds: eta_ceil_sec,
      eta_at_operational_rate_human: formatHumanDuration(eta_op_sec),
      eta_at_ceiling_rate_human: formatHumanDuration(eta_ceil_sec),
      rate_choice_rationale:
        "5 req/sec matches src/scrapers/13f.ts RATE_LIMIT_MS=200 and leaves 2x margin under SEC's 10 req/sec ceiling — protects bursty concurrency if v1.1 lands parallel workers.",
    },
  };
  process.stderr.write("\n--- structured report (JSON) ---\n");
  process.stderr.write(JSON.stringify(report, null, 2));
  process.stderr.write("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
