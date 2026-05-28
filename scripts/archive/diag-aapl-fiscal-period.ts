import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  console.log("=== Confirm Greg's AAPL Q3 2018 Revenues case ===");
  // Find AAPL Revenues rows with period_end 2018-09-29
  const snap = await db.collection("xbrl_fundamentals")
    .where("ticker", "==", "AAPL")
    .where("concept", "==", "Revenues")
    .where("period_end", "==", "2018-09-29")
    .limit(5).get();
  console.log(`  rows: ${snap.size}`);
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    console.log(`    id=${doc.id}`);
    console.log(`      period_start=${d.period_start}  period_end=${d.period_end}`);
    console.log(`      fiscal_period=${d.fiscal_period}  fiscal_year=${d.fiscal_year}  form=${d.form}`);
    console.log(`      frame=${d.frame}  value=${d.value}  unit=${d.unit}`);
  }

  console.log("\n=== Sample of other AAPL Revenues rows to see the range ===");
  const s2 = await db.collection("xbrl_fundamentals")
    .where("ticker", "==", "AAPL")
    .where("concept", "==", "Revenues")
    .orderBy("period_end", "desc")
    .limit(8).get();
  for (const doc of s2.docs) {
    const d = doc.data() as Record<string, unknown>;
    const span = d.period_start && d.period_end
      ? Math.round((new Date(d.period_end as string).getTime() - new Date(d.period_start as string).getTime()) / 86400000)
      : "?";
    console.log(`  ${d.period_start}..${d.period_end} span=${span}d  fiscal_period=${d.fiscal_period}  frame=${d.frame}  value=${d.value}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
