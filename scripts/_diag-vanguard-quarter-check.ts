import { getLiveDb } from "../src/firestore.js";

async function main(): Promise<void> {
  const db = await getLiveDb();
  const snap = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", "0000102909")
    .get();
  const byQuarter: Record<string, { count: number; latestUpdate: Date }> = {};
  const cutoff = new Date("2026-05-25T17:00:00Z").getTime();
  let postCutoff = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const q = (data.quarter as string) ?? "(none)";
    const upd = doc.updateTime?.toDate() ?? new Date(0);
    if (!byQuarter[q]) byQuarter[q] = { count: 0, latestUpdate: new Date(0) };
    byQuarter[q].count++;
    if (upd.getTime() > byQuarter[q].latestUpdate.getTime())
      byQuarter[q].latestUpdate = upd;
    if (upd.getTime() >= cutoff) postCutoff++;
  }
  console.log(`Vanguard total docs: ${snap.docs.length}`);
  console.log(`Post-Step-3 cutoff (>=17:00Z): ${postCutoff}`);
  console.log("By quarter:");
  for (const [q, info] of Object.entries(byQuarter).sort()) {
    console.log(
      `  ${q}: ${info.count} docs, latest updateTime=${info.latestUpdate.toISOString()}`,
    );
  }
  const recent = snap.docs
    .filter((d) => (d.updateTime?.toDate().getTime() ?? 0) >= cutoff)
    .slice(0, 2);
  console.log(`Sample post-Step-3 Vanguard rows:`);
  for (const d of recent) {
    const data = d.data() as Record<string, unknown>;
    console.log(`  doc=${d.id}`);
    console.log(
      `    quarter=${data.quarter}  filing_date=${data.filing_date}`,
    );
    console.log(
      `    verification_status=${data.verification_status}  expected=${data.verification_expected}  actual=${data.verification_actual}  value_exp=${data.verification_value_expected}  value_act=${data.verification_value_actual}`,
    );
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
