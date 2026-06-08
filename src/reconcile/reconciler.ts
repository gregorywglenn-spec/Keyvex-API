/**
 * KeyVex Reconciliation System — the generic Reconciler.
 *
 * Runs ANY adapter (see docs/KEYVEX-RECONCILIATION-SYSTEM.md, component #2).
 * Does the dataset-independent work:
 *   1. Pull the authoritative source-id set (adapter.sourceIds) → denominator.
 *   2. Snapshot KeyVex (the scoped collection) → ids present + per-type census.
 *   3. Diff → G1 coverage % + the EXACT missing-id list (each with a link).
 *   4. (opt-in) Classify each missing id → recoverable / nil / unreadable /
 *      gone, so unexplained-missing can be driven to 0.
 *
 * Nothing here knows anything about Congress, SEC, FEC, etc. — all of that
 * lives in the per-dataset adapter. This is written once and reused forever.
 */

import { getLiveDb } from "../firestore.js";
import type {
  ReconContext,
  ReconResult,
  SourceAdapter,
  SourceItem,
  MissingClass,
  TypeCount,
} from "./types.js";

export interface RunOptions {
  years?: number[];
  /**
   * Classify missing ids by fetching the source doc. `0`/undefined = skip
   * (fast; missing stays "unclassified"). A number = classify up to that many.
   * "all" = classify every missing id (slow but gives unexplained-missing).
   */
  classify?: number | "all";
  /** parallel fetches during classification */
  classifyConcurrency?: number;
}

/**
 * Snapshot the KeyVex side of one adapter: the set of ids present and the
 * per-type census. Uses `.select()` to pull only the two fields we need so a
 * six-figure collection is a bounded read, not a full-document download.
 */
async function snapshotKeyvex(adapter: SourceAdapter): Promise<{
  ids: Set<string>;
  typeCounts: Record<string, number>;
  totalRecords: number;
}> {
  const db = await getLiveDb();
  let q: FirebaseFirestore.Query = db.collection(adapter.collection);
  if (adapter.keyvexFilter) {
    const f = adapter.keyvexFilter;
    q = q.where(f.field, f.op, f.value as never);
  }
  const fields = [adapter.keyvexIdField];
  if (adapter.typeField) fields.push(adapter.typeField);
  q = q.select(...fields);

  const snap = await q.get();
  const ids = new Set<string>();
  const typeCounts: Record<string, number> = {};
  for (const doc of snap.docs) {
    const data = doc.data();
    const id = data[adapter.keyvexIdField];
    if (id !== undefined && id !== null && id !== "") ids.add(String(id));
    if (adapter.typeField) {
      // Empty / missing type is itself a category worth surfacing — bucket it
      // as "(none)" rather than dropping it, so nothing reads zero by omission.
      const rawType = data[adapter.typeField];
      const t =
        rawType === undefined || rawType === null || rawType === ""
          ? "(none)"
          : String(rawType);
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
  }
  return { ids, typeCounts, totalRecords: snap.size };
}

/** Bounded-concurrency map (no external dep). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
      worker(),
    ),
  );
  return out;
}

function yearOf(item: SourceItem): string {
  const y = item.meta?.["year"];
  return y === undefined || y === null ? "—" : String(y);
}

/** Tally a year-grouped count from a list of source items. */
function groupByYear(items: SourceItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const y = yearOf(it);
    out[y] = (out[y] ?? 0) + 1;
  }
  return out;
}

export async function runReconciliation(
  adapter: SourceAdapter,
  opts: RunOptions = {},
): Promise<ReconResult> {
  const warnings: string[] = [];
  const ctx: ReconContext = {
    years: opts.years,
    warn: (m) => {
      warnings.push(m);
      console.error(`[reconcile:${adapter.name}] WARN ${m}`);
    },
  };

  // 1. Denominator: the authoritative set the source says should exist.
  console.error(`[reconcile:${adapter.name}] fetching source ids…`);
  const sourceItems = await adapter.sourceIds(ctx);
  // Dedup defensively — a filing can appear in more than one yearly index.
  const sourceById = new Map<string, SourceItem>();
  for (const it of sourceItems) {
    if (!sourceById.has(it.id)) sourceById.set(it.id, it);
  }
  console.error(
    `[reconcile:${adapter.name}] source has ${sourceById.size} distinct ids`,
  );

  // 2. KeyVex side.
  console.error(`[reconcile:${adapter.name}] snapshotting KeyVex…`);
  const kv = await snapshotKeyvex(adapter);
  console.error(
    `[reconcile:${adapter.name}] KeyVex has ${kv.totalRecords} records, ${kv.ids.size} distinct ids`,
  );

  // 3. Diff.
  const missing: SourceItem[] = [];
  let presentCount = 0;
  for (const [id, item] of sourceById) {
    if (kv.ids.has(id)) presentCount++;
    else missing.push({ ...item, url: item.url || adapter.sourceUrl(item) });
  }
  // ids KeyVex has that aren't in the scanned source window (other years, or
  // ingested-but-since-removed-upstream) — informational, never a "gap".
  const extraInKeyvex: string[] = [];
  for (const id of kv.ids) if (!sourceById.has(id)) extraInKeyvex.push(id);

  const coveragePct =
    sourceById.size === 0 ? 0 : (presentCount / sourceById.size) * 100;

  // per-type census, expected types first (always shown even at 0)
  const expected = adapter.expectedTypes ?? [];
  const seenTypes = new Set(Object.keys(kv.typeCounts));
  const typeCounts: TypeCount[] = [];
  for (const t of expected) {
    const count = kv.typeCounts[t] ?? 0;
    typeCounts.push({ type: t, count, present: count > 0, expected: true });
    seenTypes.delete(t);
  }
  for (const t of [...seenTypes].sort()) {
    const count = kv.typeCounts[t] ?? 0;
    typeCounts.push({ type: t, count, present: count > 0, expected: false });
  }

  const result: ReconResult = {
    adapter: adapter.name,
    title: adapter.title,
    collection: adapter.collection,
    generatedAt: new Date().toISOString(),
    years: opts.years,
    warnings,
    sourceTotal: sourceById.size,
    sourceByYear: groupByYear([...sourceById.values()]),
    keyvexIdsPresent: presentCount,
    keyvexTotalRecords: kv.totalRecords,
    keyvexDistinctIds: kv.ids.size,
    coveragePct,
    missing,
    missingByYear: groupByYear(missing),
    extraInKeyvexCount: extraInKeyvex.length,
    extraInKeyvexSample: extraInKeyvex.slice(0, 25),
    typeCounts,
  };

  // 4. Optional classification of the missing list.
  if (opts.classify && adapter.classifyMissing && missing.length > 0) {
    const cap =
      opts.classify === "all"
        ? missing.length
        : Math.min(opts.classify, missing.length);
    const toClassify = missing.slice(0, cap);
    console.error(
      `[reconcile:${adapter.name}] classifying ${toClassify.length}/${missing.length} missing…`,
    );
    const classes = await mapLimit(
      toClassify,
      opts.classifyConcurrency ?? 4,
      async (item) => {
        try {
          return await adapter.classifyMissing!(item);
        } catch {
          return "unclassified" as MissingClass;
        }
      },
    );
    const tally: Record<MissingClass, number> = {
      recoverable: 0,
      nil: 0,
      unreadable: 0,
      gone: 0,
      unclassified: 0,
    };
    classes.forEach((c, i) => {
      tally[c]++;
      // annotate the missing row so the report can show its class
      (toClassify[i] as SourceItem).meta = {
        ...(toClassify[i]!.meta ?? {}),
        class: c,
      };
    });
    // anything not classified this run is unclassified
    tally.unclassified += missing.length - toClassify.length;
    result.classification = tally;
    result.classifiedCount = toClassify.length;
    if (toClassify.length === missing.length) {
      result.unexplainedMissing =
        tally.recoverable + tally.unclassified; // unclassified shouldn't exist when full, but be honest
    }
  }

  return result;
}
