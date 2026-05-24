/**
 * Read-only check: are the 16 v2 composite indexes BUILT (READY) or still
 * BUILDING (CREATING)?
 *
 * `firebase deploy --only firestore:indexes` returns success as soon as the
 * indexes are REGISTERED. Building them across 18.4M docs takes minutes
 * to hours depending on Firestore's queue. Until each index is READY, any
 * query that depends on it 400s with FAILED_PRECONDITION INDEX_MISSING.
 *
 * Uses the Firestore Admin REST API:
 *   GET /v1/projects/{project}/databases/(default)/collectionGroups/{collectionId}/indexes
 *
 * Optional flag --watch: polls every 30 seconds until everything is READY
 * (or any index goes ERROR).
 */
import { firebaseRequest } from "../src/firebase-rest.js";

const PROJECT = "capitaledge-api";
const FIRESTORE_API = "https://firestore.googleapis.com";
const COLLECTIONS = [
  "insider_transactions_v2",
  "insider_holdings_v2",
  "insider_filings_v2",
];

interface FirestoreIndex {
  name: string;
  queryScope: string;
  fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }>;
  state: "STATE_UNSPECIFIED" | "CREATING" | "READY" | "NEEDS_REPAIR";
}

interface ListResponse {
  indexes?: FirestoreIndex[];
}

async function listIndexes(collectionId: string): Promise<FirestoreIndex[]> {
  const url = `${FIRESTORE_API}/v1/projects/${PROJECT}/databases/(default)/collectionGroups/${collectionId}/indexes`;
  const data = (await firebaseRequest(url)) as ListResponse;
  const all = data.indexes ?? [];
  // The Admin API sometimes returns indexes from OTHER collection groups
  // alongside the requested one. Filter by name to keep only the indexes
  // that actually belong to `collectionId`. The name format is:
  //   projects/{p}/databases/(default)/collectionGroups/{collectionId}/indexes/{indexId}
  const needle = `/collectionGroups/${collectionId}/indexes/`;
  return all.filter((i) => i.name.includes(needle));
}

function summarizeFields(fields: FirestoreIndex["fields"]): string {
  // Skip the auto-added __name__ field at the end of every composite
  return fields
    .filter((f) => f.fieldPath !== "__name__")
    .map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig ?? ""}`.trim())
    .join(" + ");
}

async function reportOnce(): Promise<{ allReady: boolean; allCreating: number; allReady_n: number; anyError: number }> {
  let allReady = true;
  let creating = 0;
  let ready = 0;
  let errored = 0;

  for (const col of COLLECTIONS) {
    const indexes = await listIndexes(col);
    // Composite indexes only (Firestore Admin API doesn't return single-field auto-indexes here)
    const composites = indexes.filter((i) => i.fields.filter((f) => f.fieldPath !== "__name__").length >= 2);
    console.log(`\n  ${col}  (${composites.length} composite indexes)`);
    for (const idx of composites) {
      const stateMarker =
        idx.state === "READY" ? "✓ READY    " :
        idx.state === "CREATING" ? "⏳ CREATING" :
        idx.state === "NEEDS_REPAIR" ? "⚠ ERROR    " :
        `? ${idx.state}`;
      const fieldsStr = summarizeFields(idx.fields);
      console.log(`    ${stateMarker}  ${fieldsStr}`);
      if (idx.state === "READY") ready++;
      else if (idx.state === "CREATING") {
        creating++;
        allReady = false;
      } else {
        errored++;
        allReady = false;
      }
    }
  }

  console.log(`\n  Total: ${ready} READY · ${creating} CREATING · ${errored} ERROR`);
  return { allReady, allCreating: creating, allReady_n: ready, anyError: errored };
}

async function main() {
  const watch = process.argv.includes("--watch");
  const POLL_SEC = 30;

  console.log("=== v2 composite index build status ===");
  console.log(`  Project: ${PROJECT}`);
  console.log(`  Collections: ${COLLECTIONS.join(", ")}`);
  console.log(`  Mode: ${watch ? `watch (poll every ${POLL_SEC}s)` : "snapshot"}`);

  const start = Date.now();
  while (true) {
    console.log(`\n[${new Date().toISOString()}]`);
    const r = await reportOnce();

    if (r.anyError > 0) {
      console.error(`\n⚠ ${r.anyError} index(es) in ERROR state — investigate via Firebase Console`);
      process.exit(2);
    }

    if (r.allReady) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`\n✓ ALL ${r.allReady_n} v2 composite indexes are READY (${elapsed}s elapsed since watch started)`);
      console.log(`  Date-sorted v2 queries (since/until, sort_by) are now safe to run.`);
      process.exit(0);
    }

    if (!watch) {
      console.log(`\n  ${r.allCreating} index(es) still CREATING — pass --watch to poll until ready`);
      process.exit(1);
    }

    console.log(`\n  ${r.allCreating} index(es) still CREATING — next poll in ${POLL_SEC}s`);
    await new Promise((res) => setTimeout(res, POLL_SEC * 1000));
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
