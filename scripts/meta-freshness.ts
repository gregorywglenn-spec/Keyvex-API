/**
 * Throwaway diagnostic — dump every /meta job doc with its current age.
 * Lets us set health-check thresholds against reality before expanding JOBS.
 *
 *   npx tsx scripts/meta-freshness.ts
 */
import { getLiveDb } from "../src/firestore.js";

function ageStr(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function tsFrom(data: Record<string, unknown>): Date | null {
  const fields = ["lastSyncedAt", "lastRunAt", "lastFinishedAt", "completedAt", "lastChecked"];
  let best: Date | null = null;
  for (const f of fields) {
    const v = data[f] as { toDate?: () => Date } | undefined;
    if (v && typeof v.toDate === "function") {
      const d = v.toDate();
      if (!best || d > best) best = d;
    }
  }
  return best;
}

async function main() {
  const db = await getLiveDb();
  const snap = await db.collection("meta").get();
  const now = Date.now();
  const rows: { id: string; age: string; ageMs: number; docs: unknown; errors: unknown }[] = [];
  snap.forEach((doc) => {
    const data = doc.data();
    const ts = tsFrom(data);
    const ageMs = ts ? now - ts.getTime() : Number.POSITIVE_INFINITY;
    rows.push({
      id: doc.id,
      age: ts ? ageStr(ageMs) : "NO-TIMESTAMP",
      ageMs,
      docs: data.docsWritten ?? "",
      errors: data.errors ?? "",
    });
  });
  rows.sort((a, b) => a.ageMs - b.ageMs);
  console.log(`\n${snap.size} job-meta docs in /meta:\n`);
  console.log("AGE".padEnd(14) + "DOCS".padEnd(8) + "ERR".padEnd(6) + "JOB");
  console.log("-".repeat(70));
  for (const r of rows) {
    console.log(
      r.age.padEnd(14) +
        String(r.docs).padEnd(8) +
        String(r.errors).padEnd(6) +
        r.id,
    );
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
