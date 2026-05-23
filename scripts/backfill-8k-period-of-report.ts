/**
 * Backfill `period_of_report` on rows where the fresh-feed scraper left
 * it empty (Greg's 2026-05-23 finding — root cause: FTS field-name typo
 * `period_of_report` vs actual `period_ending`).
 *
 * Applies to: material_events (8-K) AND proxy_filings (DEF 14A/etc.) —
 * both scrapers had the same typo on the EDGAR FTS read path.
 *
 * Strategy: walk every row with empty period_of_report, group by CIK,
 * fetch each CIK's submissions API once, look up reportDate per
 * accession, batch-write updates.
 *
 * Idempotent (skips already-filled rows). Caches submissions API per
 * CIK so a fund with 100 8-Ks costs 1 API call.
 *
 * Run:
 *   npx tsx scripts/backfill-8k-period-of-report.ts [--collection=NAME] [--dry-run] [--limit=N]
 *
 * Defaults to material_events. Pass --collection=proxy_filings for the proxy variant.
 */
import { getLiveDb } from "../src/firestore.js";

const SEC_BASE = "https://data.sec.gov";
const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SLEEP_MS = 120; // SEC rate-limit headroom (6 req/sec ceiling, ~8 req/sec hard limit)

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface SubmissionsRecent {
  accessionNumber: string[];
  filingDate: string[];
  reportDate?: string[];
  form: string[];
}
interface SubmissionsResp {
  filings?: { recent?: SubmissionsRecent };
}

const subsCache = new Map<string, SubmissionsResp>();

async function getSubmissions(cikPadded: string): Promise<SubmissionsResp | null> {
  if (subsCache.has(cikPadded)) return subsCache.get(cikPadded)!;
  const url = `${SEC_BASE}/submissions/CIK${cikPadded}.json`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`  [subs] ${cikPadded}: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as SubmissionsResp;
    subsCache.set(cikPadded, data);
    return data;
  } catch (e) {
    console.error(`  [subs] ${cikPadded}: ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const maxRows = limitArg ? parseInt(limitArg.split("=")[1] ?? "0", 10) : Infinity;
  const collArg = process.argv.find((a) => a.startsWith("--collection="));
  const COLLECTION = collArg ? collArg.split("=")[1] ?? "material_events" : "material_events";

  const db = await getLiveDb();
  console.log(`Walking ${COLLECTION} for empty period_of_report... (dryRun=${dryRun})`);

  // Step 1: gather all empty-period rows
  const empties: Array<{ docId: string; accession: string; cik: string; filingDate: string }> = [];
  let scanned = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  while (true) {
    let q: FirebaseFirestore.Query = db.collection(COLLECTION).limit(2000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data() as Record<string, unknown>;
      const por = (d.period_of_report ?? "") as string;
      if (!por) {
        empties.push({
          docId: doc.id,
          accession: (d.accession_number ?? doc.id) as string,
          cik: (d.company_cik ?? "") as string,
          filingDate: (d.filing_date ?? "") as string,
        });
        if (empties.length >= maxRows) break;
      }
    }
    if (empties.length >= maxRows) break;
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
  }
  console.log(`  scanned ${scanned} rows, ${empties.length} have empty period_of_report`);

  // Step 2: group by CIK
  const byCik = new Map<string, Array<{ docId: string; accession: string; filingDate: string }>>();
  for (const e of empties) {
    if (!e.cik) continue;
    if (!byCik.has(e.cik)) byCik.set(e.cik, []);
    byCik.get(e.cik)!.push({ docId: e.docId, accession: e.accession, filingDate: e.filingDate });
  }
  console.log(`  distinct CIKs to fetch: ${byCik.size}`);

  // Step 3: per-CIK lookup + collect updates
  const updates: Array<{ docId: string; period_of_report: string }> = [];
  let cikIdx = 0;
  let lookupHits = 0;
  let lookupMisses = 0;
  for (const [cik, rows] of byCik.entries()) {
    cikIdx++;
    if (cikIdx % 50 === 0 || cikIdx === byCik.size) {
      console.log(`  [${cikIdx}/${byCik.size}] CIKs processed (${updates.length} fills queued)`);
    }
    const subs = await getSubmissions(cik);
    await sleep(SLEEP_MS);
    if (!subs?.filings?.recent) continue;
    const r = subs.filings.recent;
    const accIndex = new Map<string, number>();
    for (let i = 0; i < r.accessionNumber.length; i++) {
      accIndex.set(r.accessionNumber[i]!, i);
    }
    for (const row of rows) {
      const i = accIndex.get(row.accession);
      if (i === undefined) {
        lookupMisses++;
        continue;
      }
      const reportDate = r.reportDate?.[i];
      if (reportDate) {
        updates.push({ docId: row.docId, period_of_report: reportDate });
        lookupHits++;
      } else {
        lookupMisses++;
      }
    }
  }
  console.log(`\nLookup: ${lookupHits} hits, ${lookupMisses} misses`);
  console.log(`Updates queued: ${updates.length}`);

  // Step 4: batch-write
  if (dryRun) {
    console.log("DRY RUN — no writes. Sample first 5 updates:");
    for (const u of updates.slice(0, 5)) console.log(`  ${u.docId} → period_of_report=${u.period_of_report}`);
    process.exit(0);
  }
  const coll = db.collection(COLLECTION);
  const BATCH_SIZE = 400;
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = updates.slice(i, i + BATCH_SIZE);
    for (const u of chunk) {
      batch.update(coll.doc(u.docId), { period_of_report: u.period_of_report });
    }
    await batch.commit();
    written += chunk.length;
    console.log(`  wrote ${written}/${updates.length}`);
  }
  console.log(`\nDone. Wrote ${written} period_of_report fills.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
