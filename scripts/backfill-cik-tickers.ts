/**
 * Backfill empty `ticker` fields via company_cik → ticker (EDGAR map).
 *
 * Testing-day finding #9/#10: several SEC collections carry records with an
 * empty ticker even though company_cik is present, so `ticker:"X"` queries miss
 * them (company_name search still works). EDGAR's company_tickers.json gives a
 * reliable CIK→ticker map (no rate limit, single fetch), so we resolve and
 * stamp the ticker. Stored CIK/CUSIP/name stay byte-faithful; ticker is derived
 * enrichment (same posture as the 13F ticker backfill).
 *
 * Idempotent: only touches docs where ticker=="" and the CIK resolves.
 * Resumable: per-collection cursor in .tmp/cik-tickers-progress.json.
 *
 * Run: npx tsx scripts/backfill-cik-tickers.ts [--dry]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getLiveDb } from "../src/firestore.js";

const DRY = process.argv.includes("--dry");
const COLLECTIONS = [
  "activist_ownership",
  "material_events",
  "proxy_filings",
  "planned_insider_sales",
];
const PROG = ".tmp/cik-tickers-progress.json";
mkdirSync(".tmp", { recursive: true });
const prog: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};

async function loadCikMap(): Promise<Record<string, string>> {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": "KeyVexMCP/0.1 contact@keyvex.com" },
  });
  if (!res.ok) throw new Error(`EDGAR company_tickers HTTP ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    { ticker: string; cik_str: number; title: string }
  >;
  const map: Record<string, string> = {};
  for (const e of Object.values(data)) {
    const padded = String(e.cik_str).padStart(10, "0");
    // First-write-wins prefers the common-share ticker (catalog lists common
    // before preferred series for a given CIK in practice).
    if (!map[padded]) map[padded] = e.ticker.toUpperCase();
  }
  return map;
}

function pad(cik: string): string {
  return cik.replace(/^0+/, "").padStart(10, "0");
}

async function main(): Promise<void> {
  const db = await getLiveDb();
  const cikMap = await loadCikMap();
  console.error(
    `[cik-tickers] loaded ${Object.keys(cikMap).length} CIK→ticker entries${DRY ? " (DRY RUN)" : ""}`,
  );

  for (const coll of COLLECTIONS) {
    if (prog[coll]) {
      console.error(`[cik-tickers] skip ${coll} (already done)`);
      continue;
    }
    let scanned = 0,
      resolved = 0,
      unresolved = 0;
    const snap = await db
      .collection(coll)
      .where("ticker", "==", "")
      .get();
    console.error(`[cik-tickers] ${coll}: ${snap.size} empty-ticker docs`);

    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      scanned++;
      const cik = (doc.data() as { company_cik?: string }).company_cik ?? "";
      const ticker = cik ? (cikMap[pad(cik)] ?? "") : "";
      if (!ticker) {
        unresolved++;
        continue;
      }
      resolved++;
      if (!DRY) {
        batch.update(doc.ref, { ticker });
        inBatch++;
        if (inBatch >= 400) {
          await batch.commit();
          batch = db.batch();
          inBatch = 0;
        }
      }
    }
    if (!DRY && inBatch > 0) await batch.commit();
    console.error(
      `[cik-tickers] ${coll}: scanned ${scanned}, resolved ${resolved}, unresolved ${unresolved}`,
    );
    if (!DRY) {
      prog[coll] = true;
      writeFileSync(PROG, JSON.stringify(prog));
    }
  }
  console.error("[cik-tickers] COMPLETE");
  process.exit(0);
}

main().catch((e) => {
  console.error("[cik-tickers] FATAL", e);
  process.exit(1);
});
