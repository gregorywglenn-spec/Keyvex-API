/**
 * Backfill empty filer_ticker on registration_statements via filer_cik -> ticker.
 *
 * Testing-day #17: registration_statements stores the issuer under filer_ticker/
 * filer_cik (the filer IS the issuer for S-1/S-3). 66% have an empty filer_ticker;
 * ~6% of those resolve via EDGAR's CIK->ticker map (established companies like
 * BofA/U-Haul/Dillard's whose ticker wasn't resolved at scrape time). The rest
 * are genuinely tickerless (S-1 IPOs pre-ticker, private, foreign) and stay empty.
 * Makes those issuers reachable by the tool's filer_ticker filter + unified_search.
 *
 * Paginated by doc id (cursor), resumable. Run: npx tsx scripts/backfill-registration-tickers.ts [--dry]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getLiveDb } from "../src/firestore.js";

const DRY = process.argv.includes("--dry");
const COLL = "registration_statements";
const PROG = ".tmp/registration-tickers-progress.json";
mkdirSync(".tmp", { recursive: true });
const prog: { lastId?: string; resolved?: number; scanned?: number } = existsSync(
  PROG,
)
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
    const p = String(e.cik_str).padStart(10, "0");
    if (!map[p]) map[p] = e.ticker.toUpperCase();
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
    `[reg-tickers] EDGAR map ${Object.keys(cikMap).length} entries${DRY ? " (DRY)" : ""}; resuming after ${prog.lastId ?? "(start)"}`,
  );
  let scanned = prog.scanned ?? 0;
  let resolved = prog.resolved ?? 0;
  const PAGE = 2000;

  for (;;) {
    let q = db
      .collection(COLL)
      .where("filer_ticker", "==", "")
      .orderBy("__name__")
      .limit(PAGE);
    if (prog.lastId) q = q.startAfter(prog.lastId);
    const snap = await q.get();
    if (snap.empty) break;

    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      scanned++;
      const cik = (doc.data() as { filer_cik?: string }).filer_cik ?? "";
      const t = cik ? (cikMap[pad(cik)] ?? "") : "";
      if (t) {
        resolved++;
        if (!DRY) {
          batch.update(doc.ref, { filer_ticker: t });
          if (++inBatch >= 400) {
            await batch.commit();
            batch = db.batch();
            inBatch = 0;
          }
        }
      }
    }
    if (!DRY && inBatch > 0) await batch.commit();
    prog.lastId = snap.docs[snap.docs.length - 1]!.id;
    prog.scanned = scanned;
    prog.resolved = resolved;
    if (!DRY) writeFileSync(PROG, JSON.stringify(prog));
    console.error(
      `[reg-tickers] scanned ${scanned}, resolved ${resolved} (last ${prog.lastId})`,
    );
    if (snap.size < PAGE) break;
  }
  console.error(`[reg-tickers] COMPLETE: scanned ${scanned}, resolved ${resolved}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[reg-tickers] FATAL", e);
  process.exit(1);
});
