/**
 * In-memory per-IP sliding-window rate limiter for the MCP HTTP function.
 *
 * Used in place of bearer-token auth for the public Anthropic Connectors
 * Directory listing (auth type: `none`). Caps how many requests a single
 * IP can send per minute so a bad actor can't run up the Cloud Run bill.
 *
 * ─── Trade-off (read before tuning) ──────────────────────────────────────
 *
 * State is per-Cloud-Function-instance. Cloud Functions spawn new container
 * instances under load (up to `maxInstances` configured on the onRequest
 * options). A motivated attacker who lands their requests across multiple
 * containers can multiply the effective cap by the active instance count.
 *
 * Worst-case math with current config (concurrency: 10, maxInstances: 50,
 * MAX_REQUESTS_PER_WINDOW: 60 per minute):
 *   60 req/min × 50 instances = 3,000 req/min sustained per IP, worst case
 *
 * The real bill-cap backstop is `maxInstances` itself, not this rate limit.
 * If sustained abuse appears in practice, upgrade to a centralized store
 * (Firestore counter document, or Redis if we add Memorystore). For v1 (free
 * public-data tier, no per-user accounts), in-memory is the right cost shape.
 */

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60;
const CLEANUP_INTERVAL_MS = 5 * 60_000; // prune dead IP entries every 5 min

// Map from IP → ascending timestamps (ms) of recent requests within window.
const hits = new Map<string, number[]>();
let lastCleanup = Date.now();

/**
 * Tunables exported for visibility (response payloads, tests). Treat as
 * read-only at runtime.
 */
export const RATE_LIMIT_CONFIG = Object.freeze({
  windowMs: WINDOW_MS,
  maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW,
});

/**
 * Returns true if the request from `ip` should be allowed, false if it
 * exceeds the rate limit. Mutates the in-memory bucket on every call.
 *
 * @param ip   normalized client IP (caller is responsible for extracting it
 *             from X-Forwarded-For / req.ip; this function does no parsing)
 * @param now  injected for tests; defaults to Date.now()
 */
export function checkRateLimit(ip: string, now: number = Date.now()): boolean {
  const cutoff = now - WINDOW_MS;
  const timestamps = (hits.get(ip) ?? []).filter((t) => t > cutoff);

  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    // Reject: keep the pruned timestamp list but do not add the current
    // request. We don't want a sustained-abuse pattern to indefinitely
    // refresh the window — the attacker only progresses past the wall once
    // their earliest in-window request ages out.
    hits.set(ip, timestamps);
    maybeCleanup(now);
    return false;
  }

  timestamps.push(now);
  hits.set(ip, timestamps);
  maybeCleanup(now);
  return true;
}

/**
 * Periodic prune so the Map doesn't grow unbounded with one-shot IPs.
 * Cheap O(n) walk every 5 minutes — at our request volume, n is small.
 */
function maybeCleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  const cutoff = now - WINDOW_MS;
  for (const [ip, timestamps] of hits.entries()) {
    const fresh = timestamps.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(ip);
    else hits.set(ip, fresh);
  }
}

/**
 * Test-only reset. Not exported via index; import directly in tests.
 */
export function __resetRateLimitForTests(): void {
  hits.clear();
  lastCleanup = Date.now();
}
