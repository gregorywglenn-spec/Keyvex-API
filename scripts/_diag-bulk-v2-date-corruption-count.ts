/**
 * Date-corruption count for insider_trades (Axis 1, P0).
 *
 * Wire-Claude's recon characterized the bug: year-digit corruption on
 * date fields in bulk_v2 ingestion path. Month/day intact; high-order
 * year digits mangled. Confirmed faces: 20XX → 00XX (low end) and
 * 20XX → 204X (high end). Sibling date fields (period_of_report,
 * filing_date) intact and usable for reconstruction.
 *
 * This script SIZES the blast radius via read-only Firestore aggregates:
 *
 *   - Count corrupt records on transaction_date, exercise_date,
 *     expiration_date at both extremes (future > 2027-01-01, ancient
 *     < 1990-01-01).
 *   - Control fields (filing_date, period_of_report) expected to return
 *     zero — verifies the sibling-reconstruction strategy is sound at
 *     scale. Non-zero on controls = bigger problem.
 *   - Per-`data_source` breakdown on non-zero results — confirms bug is
 *     bounded to `bulk_v2` ingestion path vs leaking into live-feed.
 *
 * Defensive fallbacks for Firestore's .count() scanned-doc cap (~1M):
 * if .count() errors, fall back to .get() with .select() projecting
 * only the date field, then count in-memory. Slower but bounded.
 *
 * READ-ONLY. No writes. No deletes. No backfill.
 */
import { getLiveDb } from "../src/firestore.js";

// Two collections to probe — they're separate stores accessed via the
// data_source param on get_insider_transactions:
//   - insider_trades            (live-feed Form 4 path, default)
//   - insider_transactions_v2   (bulk_v2 quarterly TSV path)
// Wire-Claude's recon was on insider_transactions_v2 (records carried
// source_zip quarter labels). The first run of this script hit
// insider_trades by mistake and surfaced 6 corrupt docs on the live-feed
// path as a SEPARATE finding. Both collections need sizing.
const COLLECTIONS = ["insider_trades", "insider_transactions_v2"];

const ANCIENT_THRESHOLD = "1990-01-01"; // pre-EDGAR-electronic; anything older is corrupt

// Per-field future thresholds (CORRECTED per types.ts:1128 finding):
//   transaction_date: > today / >2027-01-01 (any future is wrong; trade can't happen ahead)
//   exercise_date: > 2050-01-01 (forward-looking "becomes exercisable" — legitimately future
//     for unvested options; only impossible if >24yr out)
//   expiration_date: > 2050-01-01 (same — long-dated options legitimately exist)
const FUTURE_THRESHOLD_BY_FIELD: Record<string, string> = {
  transaction_date: "2027-01-01",
  exercise_date: "2050-01-01",
  expiration_date: "2050-01-01",
  filing_date: "2027-01-01", // control: filing can't happen in future
  period_of_report: "2027-01-01", // control: period can't be future
};

const DATE_FIELDS_TO_PROBE = [
  "transaction_date",
  "exercise_date",
  "expiration_date",
];

const CONTROL_FIELDS = ["filing_date", "period_of_report"];

type FirestoreDb = Awaited<ReturnType<typeof getLiveDb>>;

interface CountQuery {
  field: string;
  direction: "future" | "ancient";
  threshold: string;
  isControl: boolean;
}

async function safeCount(
  db: FirestoreDb,
  collection: string,
  field: string,
  op: ">" | "<",
  threshold: string,
): Promise<{ count: number; fallback: boolean; error?: string }> {
  // Try .count() aggregate first
  try {
    const aggregateSnap = await db
      .collection(collection)
      .where(field, op, threshold)
      .count()
      .get();
    return { count: aggregateSnap.data().count, fallback: false };
  } catch (e) {
    const msg = (e as Error).message;
    // If aggregate errors (scan-cap, index-missing, etc.), fall back to
    // streaming .get() with field projection
    try {
      const snap = await db
        .collection(collection)
        .where(field, op, threshold)
        .select(field)
        .get();
      return { count: snap.docs.length, fallback: true };
    } catch (e2) {
      return { count: -1, fallback: false, error: `aggregate: ${msg}; fallback: ${(e2 as Error).message}` };
    }
  }
}

async function dataSourceBreakdown(
  db: FirestoreDb,
  collection: string,
  field: string,
  op: ">" | "<",
  threshold: string,
): Promise<Record<string, number>> {
  // Fetch matching docs with data_source projection; group client-side.
  const snap = await db
    .collection(collection)
    .where(field, op, threshold)
    .select("data_source")
    .get();
  const counts: Record<string, number> = {};
  for (const doc of snap.docs) {
    const data = doc.data() as Record<string, unknown>;
    const ds = (data.data_source as string | undefined) ?? "(absent)";
    counts[ds] = (counts[ds] ?? 0) + 1;
  }
  return counts;
}

async function sizeCollection(
  db: FirestoreDb,
  collection: string,
): Promise<void> {
  console.log("============================================================");
  console.log(`${collection} — date-corruption sizing`);
  console.log("============================================================");
  console.log("");

  const queries: CountQuery[] = [];
  for (const field of DATE_FIELDS_TO_PROBE) {
    const futureT = FUTURE_THRESHOLD_BY_FIELD[field] ?? "2027-01-01";
    queries.push({ field, direction: "future", threshold: futureT, isControl: false });
    queries.push({ field, direction: "ancient", threshold: ANCIENT_THRESHOLD, isControl: false });
  }
  for (const field of CONTROL_FIELDS) {
    const futureT = FUTURE_THRESHOLD_BY_FIELD[field] ?? "2027-01-01";
    queries.push({ field, direction: "future", threshold: futureT, isControl: true });
    queries.push({ field, direction: "ancient", threshold: ANCIENT_THRESHOLD, isControl: true });
  }

  // Total collection size
  console.log("Total collection size:");
  try {
    const totalSnap = await db.collection(collection).count().get();
    console.log(`  ${collection}: ${totalSnap.data().count.toLocaleString()} docs`);
  } catch (e) {
    console.log(`  (count aggregate errored: ${(e as Error).message})`);
  }
  console.log("");

  console.log("Per-field corruption counts:");
  console.log("");

  const nonZeroByField: Array<{ field: string; direction: string; count: number; threshold: string }> = [];

  for (const q of queries) {
    const op = q.direction === "future" ? ">" : "<";
    const tag = q.isControl ? " [control]" : "";
    const label = `${q.field} ${op} ${q.threshold}${tag}`;
    const result = await safeCount(db, collection, q.field, op, q.threshold);
    const countStr = result.count.toLocaleString();
    const fallbackTag = result.fallback ? " (via .get() fallback)" : "";
    if (result.error) {
      console.log(`  ${label.padEnd(60)}: ERROR — ${result.error}`);
    } else {
      console.log(`  ${label.padEnd(60)}: ${countStr.padStart(8)}${fallbackTag}`);
      if (result.count > 0) {
        nonZeroByField.push({
          field: q.field,
          direction: q.direction,
          count: result.count,
          threshold: q.threshold,
        });
      }
    }
  }
  console.log("");

  if (nonZeroByField.length === 0) {
    console.log(`No corruption detected in ${collection} at probed thresholds.`);
    console.log("");
    return;
  }

  console.log("Per-data_source breakdown on non-zero results:");
  console.log("");
  for (const nz of nonZeroByField) {
    const op = nz.direction === "future" ? ">" : "<";
    console.log(`  ${nz.field} ${op} ${nz.threshold}  (total: ${nz.count.toLocaleString()})`);
    try {
      const breakdown = await dataSourceBreakdown(db, collection, nz.field, op, nz.threshold);
      const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
      for (const [ds, c] of sorted) {
        const pct = ((c / nz.count) * 100).toFixed(1);
        console.log(`    ${ds.padEnd(40)}: ${c.toLocaleString().padStart(8)}  (${pct}%)`);
      }
    } catch (e) {
      console.log(`    (breakdown errored: ${(e as Error).message})`);
    }
    console.log("");
  }

  const totalCorrupt = nonZeroByField.reduce((a, x) => a + x.count, 0);
  console.log(`  ${collection} total corrupt instances: ${totalCorrupt.toLocaleString()}`);
  const controlsClean = !nonZeroByField.some((n) =>
    CONTROL_FIELDS.includes(n.field),
  );
  if (controlsClean) {
    console.log(`  ✅ Control fields clean — sibling-reconstruction strategy sound for ${collection}.`);
  } else {
    console.log(`  ⚠️  Control fields show corruption — sibling-reconstruction needs reconsideration.`);
  }
  console.log("");
}

async function main(): Promise<void> {
  console.log("############################################################");
  console.log("Date-corruption sizing across both insider collections");
  console.log(`  ancient threshold (all fields): < ${ANCIENT_THRESHOLD}`);
  console.log(`  future thresholds per field (corrected per types.ts:1128):`);
  for (const [field, t] of Object.entries(FUTURE_THRESHOLD_BY_FIELD)) {
    console.log(`    ${field.padEnd(20)} > ${t}`);
  }
  console.log("############################################################");
  console.log("");

  const db = await getLiveDb();
  for (const collection of COLLECTIONS) {
    await sizeCollection(db, collection);
  }

  console.log("############################################################");
  console.log("DONE");
  console.log("############################################################");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
