/**
 * C-FIRESTORE: Berkshire ingestion diagnosis (read-only, Firestore-half).
 *
 * Goal: distinguish "never attempted by cron" from "attempted, failed to
 * write" for Berkshire's two missing-in-store filings (per v3 handoff):
 *   - 2025-09-30 (filed 2025-11-14, missing 6+ months from store)
 *   - 2026-03-31 (filed 2026-05-15, missing 10 days from store)
 *
 * The log-read half (per Greg's adjustment) waits on the IAM grant for
 * roles/logging.viewer on the service account. That's Greg's lane, not
 * something to grant from inside this session. This script does the
 * Firestore-half work that's possible right now without that grant:
 *
 *   1. List every institutional_holdings doc for fund_cik=0001067983.
 *   2. Group by (accession_number, quarter) — one group per filing.
 *   3. For each filing group: row count, updateTime range, presence of
 *      Phase A verification_status field.
 *   4. Cross-reference against EDGAR's recent 13F-HR list for the same
 *      CIK to identify gaps.
 *
 * Signals it produces (mapping to Greg's framing):
 *
 *   - Filings present in EDGAR but absent in Firestore → STRONG evidence
 *     the cron either never attempted them OR attempted-and-failed.
 *
 *   - For filings present in Firestore: updateTime cluster.
 *     * Tight cluster (seconds) = single batch write (likely manual
 *       backfill OR a single cron run).
 *     * Spread out (different ticks days/weeks apart) = unusual; Phase A
 *       writes are atomic per-fund per-tick so this would be a re-tick.
 *
 *   - verification_status field presence:
 *     * PRESENT on all docs = ingested AFTER 2026-05-24 (Phase A rollout)
 *     * MISSING on all docs = ingested BEFORE 2026-05-24
 *     * MIXED = a quarter was first-written pre-Phase-A then a holding
 *       got individually re-merged post-Phase-A (unusual)
 *
 *   - Newest updateTime cluster within ~7 days of "now" + tick-cadence
 *     pattern (e.g., 6h apart) = active cron writing
 *   - Newest updateTime cluster weeks/months stale + far from tick
 *     cadence = manual backfill that hasn't been retouched
 *
 * READ-ONLY. No writes. No log access required.
 */

import { getLiveDb } from "../src/firestore.js";

const BERKSHIRE_CIK = "0001067983";
const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";

// EDGAR truth for cross-reference — most-recent 13F-HR list for Berkshire.
interface EdgarFiling {
  form: string;
  filingDate: string;
  reportDate: string; // = quarter end
  accession: string;
}
async function fetchBerkshireEdgarTruth(): Promise<EdgarFiling[]> {
  const url = `https://data.sec.gov/submissions/CIK${BERKSHIRE_CIK}.json`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`EDGAR HTTP ${res.status}`);
  const data = (await res.json()) as {
    filings?: {
      recent?: {
        form: string[];
        filingDate: string[];
        reportDate: string[];
        accessionNumber: string[];
      };
    };
  };
  const r = data.filings?.recent;
  if (!r) return [];
  const out: EdgarFiling[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if (form === "13F-HR" || form === "13F-HR/A") {
      out.push({
        form,
        filingDate: r.filingDate[i] ?? "",
        reportDate: r.reportDate[i] ?? "",
        accession: r.accessionNumber[i] ?? "",
      });
    }
    if (out.length >= 12) break;
  }
  return out;
}

interface FilingGroup {
  accession: string;
  quarter: string;
  filing_date: string;
  docCount: number;
  earliestUpdate: Date;
  latestUpdate: Date;
  spreadMs: number;
  hasVerificationStatusCount: number;
  noVerificationStatusCount: number;
}

async function main(): Promise<void> {
  console.log("==========================================================");
  console.log("C-Firestore — Berkshire ingestion diagnosis");
  console.log(`Now: ${new Date().toISOString()}`);
  console.log(`Fund CIK: ${BERKSHIRE_CIK}`);
  console.log("==========================================================");
  console.log("");

  // ── 1. EDGAR truth ─────────────────────────────────────────────────────
  console.log("STEP 1 — EDGAR truth (most-recent 13F-HR filings):");
  const edgar = await fetchBerkshireEdgarTruth();
  if (edgar.length === 0) {
    console.log("  (none — EDGAR returned no filings; something is broken upstream)");
    process.exit(2);
  }
  for (const f of edgar) {
    console.log(
      `  ${f.form.padEnd(10)} filed=${f.filingDate}  period=${f.reportDate}  acc=${f.accession}`,
    );
  }
  console.log("");

  // ── 2. Firestore introspection ─────────────────────────────────────────
  console.log("STEP 2 — Firestore institutional_holdings rows for Berkshire:");
  const db = await getLiveDb();
  const snap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", BERKSHIRE_CIK)
    .get();

  console.log(`  Total docs for fund_cik=${BERKSHIRE_CIK}: ${snap.docs.length}`);
  console.log("");

  if (snap.docs.length === 0) {
    console.log("  ⚠️  ZERO docs for Berkshire — nothing ever written for this CIK.");
    console.log("  Implication: either the CIK loop never includes Berkshire OR every");
    console.log("  attempt has failed before reaching saveInstitutionalHoldings.");
    console.log("  Log read (deferred) would distinguish those two.");
    return;
  }

  // Group by (accession, quarter). Multiple rows per (accession, quarter)
  // because each holding is a separate doc.
  const groups = new Map<string, FilingGroup>();
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const accession = (data.accession_number as string | undefined) ?? "(no accession)";
    const quarter = (data.quarter as string | undefined) ?? "(no quarter)";
    const filing_date = (data.filing_date as string | undefined) ?? "(no filing_date)";
    const key = `${accession}|${quarter}`;
    const update = doc.updateTime?.toDate() ?? new Date(0);
    const hasVerStatus = data.verification_status !== undefined;
    let g = groups.get(key);
    if (!g) {
      g = {
        accession,
        quarter,
        filing_date,
        docCount: 0,
        earliestUpdate: update,
        latestUpdate: update,
        spreadMs: 0,
        hasVerificationStatusCount: 0,
        noVerificationStatusCount: 0,
      };
      groups.set(key, g);
    }
    g.docCount += 1;
    if (update.getTime() < g.earliestUpdate.getTime()) g.earliestUpdate = update;
    if (update.getTime() > g.latestUpdate.getTime()) g.latestUpdate = update;
    g.spreadMs = g.latestUpdate.getTime() - g.earliestUpdate.getTime();
    if (hasVerStatus) g.hasVerificationStatusCount += 1;
    else g.noVerificationStatusCount += 1;
  }

  // Sort groups by quarter desc
  const grouped = Array.from(groups.values()).sort((a, b) =>
    b.quarter.localeCompare(a.quarter),
  );

  console.log(`  Found ${grouped.length} distinct (accession, quarter) groups in store.`);
  console.log("");
  console.log("  Per-filing breakdown:");
  console.log(
    `    quarter      | accession                   | filing_date | rows  | earliest_update           | latest_update             | spread       | verification_status`,
  );
  console.log(
    `    -------------|-----------------------------|-------------|-------|---------------------------|---------------------------|--------------|---------------------`,
  );
  for (const g of grouped) {
    const earliest = g.earliestUpdate.toISOString();
    const latest = g.latestUpdate.toISOString();
    const spreadDesc =
      g.spreadMs < 60_000
        ? `${(g.spreadMs / 1000).toFixed(1)}s`
        : g.spreadMs < 3_600_000
          ? `${(g.spreadMs / 60_000).toFixed(1)}m`
          : g.spreadMs < 86_400_000
            ? `${(g.spreadMs / 3_600_000).toFixed(1)}h`
            : `${(g.spreadMs / 86_400_000).toFixed(1)}d`;
    const verSummary = `${g.hasVerificationStatusCount}/${g.docCount} stamped`;
    console.log(
      `    ${g.quarter.padEnd(12)} | ${g.accession.padEnd(27)} | ${g.filing_date.padEnd(11)} | ${String(g.docCount).padStart(5)} | ${earliest} | ${latest} | ${spreadDesc.padStart(12)} | ${verSummary}`,
    );
  }
  console.log("");

  // ── 3. Gap analysis ────────────────────────────────────────────────────
  console.log("STEP 3 — Gap analysis (EDGAR ↔ Firestore):");
  const presentQuarters = new Set(grouped.map((g) => g.quarter));
  const presentAccessions = new Set(grouped.map((g) => g.accession));
  const gaps: EdgarFiling[] = [];
  for (const f of edgar) {
    const accInFs = presentAccessions.has(f.accession);
    const periodInFs = presentQuarters.has(f.reportDate);
    if (!accInFs && !periodInFs) gaps.push(f);
    else if (!accInFs && periodInFs) {
      // Quarter has data but under a different accession — likely original
      // 13F-HR is in store, but a later 13F-HR/A amendment isn't. Worth
      // calling out.
      console.log(
        `  NOTE  period=${f.reportDate} present (under different accession) — but ${f.form} ${f.accession} not in store`,
      );
    }
  }
  if (gaps.length === 0) {
    console.log("  No EDGAR filings are missing from Firestore. (Suggests both v3 'gaps' have since been ingested.)");
  } else {
    console.log(`  ${gaps.length} EDGAR filings MISSING from Firestore:`);
    for (const f of gaps) {
      const daysSinceFiled = Math.floor(
        (Date.now() - new Date(f.filingDate).getTime()) / 86_400_000,
      );
      console.log(
        `    ✗ ${f.form.padEnd(10)} filed=${f.filingDate} (${daysSinceFiled}d ago)  period=${f.reportDate}  acc=${f.accession}`,
      );
    }
  }
  console.log("");

  // ── 4. Pattern read ────────────────────────────────────────────────────
  console.log("STEP 4 — Cron-vs-backfill pattern interpretation:");
  if (grouped.length === 0) {
    console.log("  (nothing in store to interpret)");
  } else {
    // Cluster latestUpdate across groups — if everything was written
    // within a single window, that's a manual backfill signature.
    const latestTimes = grouped.map((g) => g.latestUpdate.getTime());
    const minLatest = Math.min(...latestTimes);
    const maxLatest = Math.max(...latestTimes);
    const spreadAcrossGroups = maxLatest - minLatest;
    console.log(
      `  Across ${grouped.length} filings: earliest write = ${new Date(minLatest).toISOString()}`,
    );
    console.log(
      `                                 latest write   = ${new Date(maxLatest).toISOString()}`,
    );
    console.log(
      `                                 spread         = ${(spreadAcrossGroups / 86_400_000).toFixed(1)} days`,
    );
    const versionedRows = grouped.reduce(
      (a, g) => a + g.hasVerificationStatusCount,
      0,
    );
    const unversionedRows = grouped.reduce(
      (a, g) => a + g.noVerificationStatusCount,
      0,
    );
    console.log(
      `  Phase A verification_status field: ${versionedRows} stamped / ${unversionedRows} unstamped (across all docs)`,
    );
    if (versionedRows === 0) {
      console.log(
        `  Implication: NO Berkshire docs carry verification_status — every existing row was written BEFORE 2026-05-24. The cron has not successfully landed a Berkshire write since Phase A shipped.`,
      );
    } else if (unversionedRows === 0) {
      console.log(
        `  Implication: ALL Berkshire docs carry verification_status — every row is from a Phase A-era write. (Inconsistent with a "missing for months" claim unless the missing periods are the absent-altogether ones identified above.)`,
      );
    } else {
      console.log(
        `  Implication: Mixed — some Phase A writes happened, some predate. Look at which filings carry which.`,
      );
    }
  }
  console.log("");

  console.log("==========================================================");
  console.log("Diagnosis complete. Log read deferred until roles/logging.viewer grant.");
  console.log("==========================================================");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
