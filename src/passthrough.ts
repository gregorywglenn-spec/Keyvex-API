/**
 * Live-first passthrough helper.
 *
 * Several MCP tools (federal contracts, federal grants, consumer complaints,
 * FEC contributions) sit on top of giant upstream datasets where Firestore
 * only holds a recent cached subset (a rolling cron window). For the
 * DEDICATED tool call we want to query the live source API per request so
 * the agent sees the full, current universe — falling back to the cached
 * Firestore subset only if the live source is slow or unavailable.
 *
 * `liveFirst` races the live fetch against a hard timeout. On success it
 * returns the live results tagged source:"live". On ANY error or timeout it
 * awaits the cache fallback and returns source:"cache" plus a
 * coverage_warning so the agent knows it's seeing the cached subset, not the
 * live universe.
 *
 * The 8s default timeout is a HARD bound: the public `mcp` Cloud Function
 * must never hang on a flaky upstream API. If live doesn't answer in time we
 * serve the cache and move on.
 */

export interface LiveFirstResult<T> {
  results: T[];
  source: "live" | "cache";
  coverage_warning?: string;
}

export interface LiveFirstOptions {
  /** Hard timeout for the live fetch, in ms. Default 8000. */
  timeoutMs?: number;
  /** Human label for the source, used in the fallback coverage_warning. */
  label: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Run `liveFn` racing a timeout. On success → live results. On error/timeout
 * → await `cacheFn` and return cached results + a coverage_warning.
 *
 * Both functions return arrays of the SAME normalized type so the caller can
 * apply its own limit/sort/has_more uniformly regardless of which path won.
 */
export async function liveFirst<T>(
  liveFn: () => Promise<T[]>,
  cacheFn: () => Promise<T[]>,
  opts: LiveFirstOptions,
): Promise<LiveFirstResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`live ${opts.label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const results = await Promise.race([liveFn(), timeout]);
    return { results, source: "live" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[passthrough] live ${opts.label} failed (${msg}); falling back to cache`);
    const results = await cacheFn();
    return {
      results,
      source: "cache",
      coverage_warning: `Live ${opts.label} API unavailable; returning cached subset only.`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
