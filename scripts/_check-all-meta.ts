/**
 * Read-only sanity check: list lastSyncedAt for every scheduler's /meta doc.
 * Isolates "is Form 4 specifically broken" from "is Firebase scheduler
 * infrastructure broken across the project".
 */
import { getLiveDb } from "../src/firestore.js";

const JOBS_DEPLOYED_TODAY = new Set([
  "institutional13FSync",
  "insiderTradesSync",
  "form5Sync",
  "senatePtrSync",
  "housePtrSync",
]);

const ALL_JOBS = [
  // The 5 we deployed today (Phase A write-side)
  "institutional13FSync",
  "insiderTradesSync",
  "form5Sync",
  "senatePtrSync",
  "housePtrSync",
  // Others — frequent-cron control set
  "materialEventsSync", // 8-K hourly
  "proxyFilingsSync",
  "treasuryAuctionsSync",
  "blsIndicatorsSync",
  "fredIndicatorsSync",
  "cslSync",
  "faraSync",
  "govinfoSync",
  "eiaIndicatorsSync",
  "oigExclusionsSync",
  "consumerComplaintsSync",
  "xbrlFundamentalsSync",
  "plannedInsiderSalesSync", // form144 hourly
  "initialOwnershipBaselinesSync", // form3 hourly
  "activistOwnershipSync", // hourly
  "federalContractsSync",
  "federalGrantsSync",
  "lobbyingFilingsSync",
  "legislatorsSync",
  "form278Sync",
  "fecCandidatesSync",
  "fecCommitteesSync",
  "fecScheduleASync",
  "fecScheduleESync",
  "secFtdSync",
  "cftcCotSync",
  "tenderOffersSync",
  "congressLegislationSync",
  "federalRegisterSync",
  "ofacSdnSync",
  "registrationStatementsSync",
  "nportFilingsSync",
];

function asDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v !== null && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  if (typeof v === "string") return new Date(v);
  return null;
}

function fmtAge(t: Date | null): string {
  if (!t) return "(no record)";
  const ageMs = Date.now() - t.getTime();
  const ageMin = ageMs / 60000;
  if (ageMin < 60) return `${ageMin.toFixed(1)} min`;
  if (ageMin < 1440) return `${(ageMin / 60).toFixed(1)} hr`;
  return `${(ageMin / 1440).toFixed(1)} day`;
}

async function main(): Promise<void> {
  const db = await getLiveDb();
  console.log(`current time: ${new Date().toISOString()}\n`);

  const results: Array<{
    name: string;
    deployed: boolean;
    lastSyncedAt: Date | null;
    docsWritten: unknown;
    durationMs: unknown;
  }> = [];

  for (const j of ALL_JOBS) {
    const snap = await db.collection("meta").doc(j).get();
    if (!snap.exists) {
      results.push({
        name: j,
        deployed: JOBS_DEPLOYED_TODAY.has(j),
        lastSyncedAt: null,
        docsWritten: "—",
        durationMs: "—",
      });
      continue;
    }
    const d = snap.data() as Record<string, unknown>;
    results.push({
      name: j,
      deployed: JOBS_DEPLOYED_TODAY.has(j),
      lastSyncedAt: asDate(d.lastSyncedAt),
      docsWritten: d.docsWritten ?? "—",
      durationMs: d.durationMs ?? "—",
    });
  }

  // Sort: most-recent first
  results.sort((a, b) => {
    const at = a.lastSyncedAt?.getTime() ?? 0;
    const bt = b.lastSyncedAt?.getTime() ?? 0;
    return bt - at;
  });

  console.log("DEPLOYED column: ★ = redeployed in 5-function Phase A scoped deploy today");
  console.log("");
  console.log(
    "  ★  " + "lastSyncedAt".padEnd(22) + " age".padEnd(12) + " docs".padStart(8) + " ms".padStart(8) + "  job",
  );
  console.log(
    "  " + "─".repeat(95),
  );
  for (const r of results) {
    const mark = r.deployed ? "★" : " ";
    const ts = r.lastSyncedAt?.toISOString() ?? "(none)";
    const age = fmtAge(r.lastSyncedAt);
    const docs =
      typeof r.docsWritten === "number"
        ? r.docsWritten.toLocaleString()
        : String(r.docsWritten);
    const dur =
      typeof r.durationMs === "number"
        ? Math.round(r.durationMs / 1000) + "s"
        : String(r.durationMs);
    console.log(
      `  ${mark}  ${ts.padEnd(22)} ${age.padEnd(12)} ${docs.padStart(8)} ${dur.padStart(8)}  ${r.name}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
