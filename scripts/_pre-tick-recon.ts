/**
 * Pre-tick recon for the 16:15Z 13F decisive test.
 * Read-only. Answers four questions Greg flagged in his critique of the
 * handoff doc:
 *
 *   1. Live counts: congressional_trades + institutional_holdings
 *   2. For each of the 10 tracked 13F funds: does a 2026-03-31 row exist?
 *      (identifies which funds are dedup-overwrite vs which would produce
 *      genuinely-new accession rows)
 *   3. Sample one existing 2026-03-31 row per tracked fund — show its
 *      current verification_status / position_change / shares_change to
 *      establish the BEFORE state Greg's wire-side reconciliation can
 *      compare against AFTER the tick.
 *   4. Confirm the prior-quarter (2025-12-31) baseline exists for each
 *      tracked fund (if YES, false-new guard cannot fire on the tick;
 *      if NO, false-new guard WILL fire).
 *
 * NOTHING is written. Branch state unchanged. Heal worker untouched.
 */
import { getLiveDb } from "../src/firestore.js";

// Mirrors the TRACKED_FUNDS list from src/scrapers/13f.ts
const TRACKED_FUNDS: Array<{ name: string; alias: string; cik: string }> = [
  { name: "Berkshire Hathaway", alias: "berkshire", cik: "0001067983" },
  { name: "BlackRock", alias: "blackrock", cik: "0001364742" },
  { name: "Vanguard Group", alias: "vanguard", cik: "0000102909" },
  { name: "Bridgewater Associates", alias: "bridgewater", cik: "0001350694" },
  { name: "Citadel Advisors LLC", alias: "citadel", cik: "0001423053" },
  { name: "Point72 Asset Management", alias: "point72", cik: "0001603466" },
  { name: "D. E. Shaw & Co., Inc.", alias: "deshaw", cik: "0001009207" },
  { name: "Renaissance Technologies", alias: "renaissance", cik: "0001037389" },
  { name: "Two Sigma Investments, LP", alias: "twosigma", cik: "0001179392" },
  { name: "Millennium Management LLC", alias: "millennium", cik: "0001273087" },
];

const CURRENT_QUARTER = "2026-03-31";
const PRIOR_QUARTER = "2025-12-31";

async function main(): Promise<void> {
  const db = await getLiveDb();
  console.log(`Pre-tick recon — ${new Date().toISOString()}`);
  console.log("=".repeat(72));

  // 1. Live counts
  console.log("\n[1] LIVE COLLECTION COUNTS");
  console.log("─".repeat(72));
  const ciCount = await db.collection("congressional_trades").count().get();
  const ihCount = await db.collection("institutional_holdings").count().get();
  console.log(`  congressional_trades:   ${ciCount.data().count.toLocaleString()}`);
  console.log(`  institutional_holdings: ${ihCount.data().count.toLocaleString()}`);

  // 2 + 3 + 4: per-fund inspection
  console.log("\n[2-4] PER-FUND INSPECTION (10 tracked funds)");
  console.log("─".repeat(72));
  console.log(
    "  Fund                 cur(2026-03-31)  prior(2025-12-31)  guard outlook",
  );
  console.log("  " + "─".repeat(68));

  const summary = {
    cur_present: 0,
    cur_absent: 0,
    prior_present: 0,
    prior_absent: 0,
    will_trip_false_new: 0,
  };

  const fundDetails: Array<{
    name: string;
    cik: string;
    currentRows: number;
    priorRows: number;
    sampleCurrentAccession?: string;
    sampleCurrentVerificationStatus?: string;
    sampleCurrentPositionChange?: string;
  }> = [];

  for (const fund of TRACKED_FUNDS) {
    const cur = await db
      .collection("institutional_holdings")
      .where("fund_cik", "==", fund.cik)
      .where("quarter", "==", CURRENT_QUARTER)
      .limit(1)
      .get();

    const curCountAgg = await db
      .collection("institutional_holdings")
      .where("fund_cik", "==", fund.cik)
      .where("quarter", "==", CURRENT_QUARTER)
      .count()
      .get();

    const priorCountAgg = await db
      .collection("institutional_holdings")
      .where("fund_cik", "==", fund.cik)
      .where("quarter", "==", PRIOR_QUARTER)
      .count()
      .get();

    const curRows = curCountAgg.data().count;
    const priorRows = priorCountAgg.data().count;

    if (curRows > 0) summary.cur_present++;
    else summary.cur_absent++;
    if (priorRows > 0) summary.prior_present++;
    else summary.prior_absent++;
    if (priorRows === 0) summary.will_trip_false_new++;

    const guardOutlook =
      priorRows === 0
        ? "FALSE-NEW guard WILL fire (no prior baseline)"
        : "guards quiet (clean tick)";

    console.log(
      `  ${fund.name.padEnd(20)} ${String(curRows).padStart(15)} ${String(priorRows).padStart(18)}  ${guardOutlook}`,
    );

    let sample: Record<string, unknown> | undefined;
    if (curRows > 0 && cur.docs[0]) {
      sample = cur.docs[0].data() as Record<string, unknown>;
    }

    fundDetails.push({
      name: fund.name,
      cik: fund.cik,
      currentRows: curRows,
      priorRows: priorRows,
      sampleCurrentAccession: sample?.accession_number as string | undefined,
      sampleCurrentVerificationStatus:
        (sample?.verification_status as string | undefined) ?? "(unset)",
      sampleCurrentPositionChange:
        (sample?.position_change as string | undefined) ?? "(unset)",
    });
  }

  console.log("\n  SUMMARY:");
  console.log(
    `    Funds with current quarter present: ${summary.cur_present}/10 (will overwrite-merge on tick)`,
  );
  console.log(
    `    Funds with current quarter absent:  ${summary.cur_absent}/10 (will write NEW rows on tick)`,
  );
  console.log(
    `    Funds with prior baseline present:  ${summary.prior_present}/10`,
  );
  console.log(
    `    Funds where FALSE-NEW guard WILL fire on tick: ${summary.will_trip_false_new}/10`,
  );

  // 5. BEFORE snapshot for current-quarter samples
  console.log("\n[5] BEFORE-TICK SNAPSHOT (one sample row per fund w/ current quarter)");
  console.log("─".repeat(72));
  for (const fd of fundDetails) {
    if (fd.currentRows === 0) {
      console.log(`  ${fd.name.padEnd(20)} no current rows in store`);
      continue;
    }
    console.log(
      `  ${fd.name.padEnd(20)} acc=${(fd.sampleCurrentAccession ?? "?").padEnd(22)} ` +
        `vs=${fd.sampleCurrentVerificationStatus.padEnd(20)} pc=${fd.sampleCurrentPositionChange}`,
    );
  }

  // 6. Inspect get_institutional_holdings tool enum
  console.log("\n[6] TOOL ENUM CHECK — get_institutional_holdings.position_change");
  console.log("─".repeat(72));
  console.log("  See src/tools/institutional-holdings.ts for the enum.");
  console.log("  Greg flagged: enum doesn't include INSUFFICIENT_DATA.");
  console.log("  This script doesn't read TS source; verify by direct file read.");

  console.log("\n" + "=".repeat(72));
  console.log("RECON COMPLETE — read-only, no writes anywhere.");
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
