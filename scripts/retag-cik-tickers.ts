/**
 * One-off maintenance: re-tag rows whose `ticker` was mis-resolved by the
 * pre-fix last-write-wins CIK->ticker map (multi-class issuers stored a
 * preferred series — JPM-PM, BAC-PS, GGLBP — instead of the common ticker).
 *
 * Rebuilds the primary-ticker map from company_tickers.json via the shared
 * preferPrimaryTicker() helper, then for each collection streams every doc
 * (paginated by document id — scale-safe, no full-collection snapshot) and,
 * where a NON-EMPTY stored ticker differs from the primary ticker for that
 * CIK, corrects it. Empty tickers (delisted/foreign/unresolved) are left
 * untouched and counted separately.
 *
 * Count-only by default; pass --apply to write. --collection=<name> to scope.
 *   npx tsx scripts/retag-cik-tickers.ts                  # count all
 *   npx tsx scripts/retag-cik-tickers.ts --apply          # fix all
 *   npx tsx scripts/retag-cik-tickers.ts --collection=material_events --apply
 */
import * as fs from "node:fs";
import { FieldPath } from "firebase-admin/firestore";
import { getLiveDb } from "../src/firestore.js";
import { preferPrimaryTicker } from "../src/sec-tickers.js";

const COLLECTIONS = [
  "material_events",
  "planned_insider_sales",
  "activist_ownership",
  "xbrl_fundamentals",
];

const apply = process.argv.includes("--apply");
const only = process.argv
  .find((a) => a.startsWith("--collection="))
  ?.split("=")[1];

// Build the primary CIK->ticker map from the local company_tickers.json probe.
const ct = JSON.parse(fs.readFileSync("ct.json", "utf8")) as Record<
  string,
  { ticker: string; cik_str: number; title: string }
>;
const cikToTicker: Record<string, string> = {};
const cikToTickerSet: Record<string, Set<string>> = {};
for (const v of Object.values(ct)) {
  const t = String(v.ticker).toUpperCase();
  const cik = String(v.cik_str).padStart(10, "0");
  cikToTicker[cik] = preferPrimaryTicker(cikToTicker[cik], t);
  (cikToTickerSet[cik] ??= new Set()).add(t);
}
console.error(`[retag] primary map: ${Object.keys(cikToTicker).length} CIKs`);

const db = await getLiveDb();
const PAGE = 2000;

for (const coll of only ? [only] : COLLECTIONS) {
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let scanned = 0;
  let mism = 0;
  let updated = 0;
  let emptyFillable = 0;
  const samples: string[] = [];

  for (;;) {
    let q = db
      .collection(coll)
      .orderBy(FieldPath.documentId())
      .limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    let batch = db.batch();
    let pending = 0;
    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data() as { ticker?: string; company_cik?: string };
      const cik = d.company_cik;
      if (!cik) continue;
      const want = cikToTicker[cik];
      if (!want) continue;
      const cur = (d.ticker ?? "").toUpperCase();
      if (cur === "") {
        emptyFillable++;
        continue; // leave empties alone (own semantics) — count only
      }
      // SAFETY GUARD: only retag when the stored ticker is itself a catalog
      // sibling of `want` under the SAME CIK (i.e. a class/preferred variant —
      // GGLBP/GOOG under Alphabet, GS-PD under Goldman). This is precisely the
      // multi-class bug. It EXCLUDES name-changes / CVRs / ADRs / dot-vs-hyphen
      // (IAC->PPLI, CELG-RI->BMY, BRK.B->BRK-B) where `cur` is NOT a catalog
      // ticker for that CIK — relabeling those would corrupt the record.
      if (cur !== want && cikToTickerSet[cik]?.has(cur)) {
        mism++;
        if (samples.length < 8) samples.push(`${cik}: ${cur} -> ${want}`);
        if (apply) {
          batch.update(doc.ref, { ticker: want });
          pending++;
          updated++;
          if (pending >= 400) {
            await batch.commit();
            batch = db.batch();
            pending = 0;
          }
        }
      }
    }
    if (apply && pending > 0) await batch.commit();

    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  console.error(
    `[${coll}] scanned=${scanned} mis-tagged=${mism} ${apply ? `updated=${updated}` : "(count only)"} empty-but-resolvable=${emptyFillable}`,
  );
  for (const s of samples) console.error("    e.g.", s);
}
console.error("[retag] done");
