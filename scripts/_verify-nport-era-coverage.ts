/**
 * N-PORT holdings ERA COVERAGE — the close-out artifact for the
 * reconciliation sweep. For every N-PORT filing filed since the holdings
 * extraction shipped (2026-05-12), report: does it have >=1 extracted
 * holding row? Output is the coverage %, a by-file-date table, and the
 * exact gap list (each classified). READ-ONLY; streams both collections
 * (id-strings only) so memory stays flat on the 1.2M-row holdings set.
 *
 *   npx tsx scripts/_verify-nport-era-coverage.ts
 */
import "../src/load-secrets.js";
import { getLiveDb } from "../src/firestore.js";

const ERA_FLOOR = "2026-05-12";
const db = await getLiveDb();

// 1. holdings side: set of filing_ids that have >=1 row (stream, id only).
const have = new Set<string>();
await new Promise<void>((resolve, reject) => {
  const s = db
    .collection("nport_holdings")
    .where("period_ending", ">=", "2000-01-01")
    // period_ending MUST be in the projection — the stream's mid-stream
    // retry builds its resume cursor from the last doc's where field.
    .select("filing_id", "period_ending")
    .stream();
  s.on("data", (d: FirebaseFirestore.QueryDocumentSnapshot) => {
    const id = d.get("filing_id");
    if (id) have.add(String(id));
  });
  s.on("end", () => resolve());
  s.on("error", reject);
});
console.log(`holdings: ${have.size} distinct filings have >=1 row`);

// 2. filings side: every era filing, by day.
const fs = await db
  .collection("nport_filings")
  .where("file_date", ">=", ERA_FLOOR)
  .select("filing_id", "file_date", "filer_name", "filing_type")
  .get();

const byDay: Record<string, { total: number; covered: number }> = {};
const gaps: { id: string; date: string; filer: string; type: string }[] = [];
for (const d of fs.docs) {
  const x = d.data();
  const day = String(x.file_date ?? "").slice(0, 10);
  const e = (byDay[day] = byDay[day] ?? { total: 0, covered: 0 });
  e.total++;
  if (have.has(String(x.filing_id))) e.covered++;
  else gaps.push({ id: String(x.filing_id), date: day, filer: String(x.filer_name ?? ""), type: String(x.filing_type ?? "") });
}

let total = 0, covered = 0;
console.log("\nfile_date,total,covered");
for (const day of Object.keys(byDay).sort()) {
  const e = byDay[day]!;
  total += e.total;
  covered += e.covered;
  console.log(`${day},${e.total},${e.covered}`);
}
const pct = total === 0 ? 0 : (covered / total) * 100;
console.log(`\nERA TOTAL: ${covered}/${total} = ${pct.toFixed(2)}%`);
console.log(`\nGAPS (${gaps.length}):`);
for (const g of gaps) console.log(`  ${g.id}  ${g.date}  ${g.type}  ${g.filer}`);
process.exit(0);
