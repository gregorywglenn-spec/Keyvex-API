/**
 * Phase B — Heal Worker (INERT SCAFFOLD as of 2026-05-25).
 *
 * This file is the architectural placeholder for the heal worker that
 * processes the sync_queue. It is PHYSICALLY INERT — every entry point
 * that could touch the network, Firestore, or a status field throws an
 * AuthorizationError unless TWO independent gates are both satisfied:
 *
 *   1. Environment variable HEAL_AUTHORIZED === "true"  (set by operator)
 *   2. Caller passes command === "heal" explicitly       (not the default)
 *
 * Both must be set. Neither alone is enough. This guarantees:
 *
 *   - Accidental imports of this module do nothing.
 *   - `command === "measure"` cannot fall through to heal logic.
 *   - A stale CI env with HEAL_AUTHORIZED set will still throw if the
 *     command flag is wrong.
 *
 * The Index Pass (scripts/phase-b-index-pass.ts) does NOT import this
 * module at all. It reads Firestore directly. The worker stays unloaded
 * during measurement.
 *
 * When Greg authorizes the heal run as a separate command, this file
 * gets the actual fetch/parse/recompute/atomic-flip logic — at that
 * point the AuthorizationError guards become live gates rather than
 * permanent stops.
 */

import type {
  HealAuthorization,
  HealCommand,
  SyncQueueEntry,
} from "./types.js";

// ─── Authorization gate ─────────────────────────────────────────────────────

export class HealNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealNotAuthorizedError";
  }
}

/**
 * Throws unless BOTH gates are satisfied. Call before any side effect.
 *
 * This is intentionally throw-based rather than return-boolean so a caller
 * cannot accidentally ignore a `false` and proceed. There is no path
 * through this function that returns and side-effects.
 */
export function assertHealAuthorized(command: HealCommand): void {
  const envFlag = process.env.HEAL_AUTHORIZED;
  if (command !== "heal") {
    throw new HealNotAuthorizedError(
      `Heal worker invoked with command="${command}". The worker only ` +
        `accepts command="heal" — and only when HEAL_AUTHORIZED=true is ` +
        `set in the environment. Refusing to proceed.`,
    );
  }
  if (envFlag !== "true") {
    throw new HealNotAuthorizedError(
      `Heal worker invoked with command="heal" but HEAL_AUTHORIZED env var ` +
        `is "${envFlag ?? "(unset)"}". The worker requires HEAL_AUTHORIZED=true ` +
        `to be set explicitly in the environment as a second gate. Refusing ` +
        `to proceed. (Phase B doctrine: measure before you heal — see ` +
        `docs/architecture-phase-b-sync-queue.md.)`,
    );
  }
}

/**
 * Type-level guard that an authorization payload is valid. Compile-time
 * convenience; runtime enforcement is still `assertHealAuthorized` above.
 */
export function isFullyAuthorized(
  auth: HealAuthorization,
): auth is HealAuthorization & {
  command: "heal";
  HEAL_AUTHORIZED: "true";
} {
  return auth.command === "heal" && auth.HEAL_AUTHORIZED === "true";
}

// ─── Public worker entry points — ALL INERT THIS PASS ────────────────────

/**
 * Enqueue a single entry into the sync_queue.
 *
 * INERT: never writes during this pass. The Index Pass produces in-memory
 * counts; the actual queue writes happen in the heal pass after Greg's
 * separate authorization.
 */
export async function enqueueSyncEntry(
  _entry: Omit<SyncQueueEntry, "status" | "attempt_count" | "created_at">,
  command: HealCommand,
): Promise<void> {
  assertHealAuthorized(command);
  // Heal logic intentionally not implemented in this scaffold pass.
  // When implemented, this will: (1) compute deterministic entry_id,
  // (2) merge-write to /sync_queue/{entry_id} with status=PENDING,
  // attempt_count=0, max_attempts=3, created_at=now.
  throw new Error(
    "enqueueSyncEntry: heal logic not implemented in scaffold pass",
  );
}

/**
 * Claim + process the next PENDING entry from the queue.
 *
 * INERT: never fetches or writes during this pass.
 */
export async function processNextEntry(command: HealCommand): Promise<void> {
  assertHealAuthorized(command);
  throw new Error(
    "processNextEntry: heal logic not implemented in scaffold pass",
  );
}

/**
 * Process all PENDING entries until the queue drains or a stop condition
 * fires. This is the long-running worker loop.
 *
 * INERT: never runs during this pass.
 */
export async function runHealWorkerUntilDrained(
  command: HealCommand,
  _opts?: {
    /** Token-bucket rate in requests per second. Default 5 (matches
     *  src/scrapers/13f.ts RATE_LIMIT_MS=200 guardrail). */
    rateReqPerSec?: number;
    /** Max wallclock seconds before voluntary stop. Default Infinity
     *  (run until drained or interrupted). */
    maxWallclockSeconds?: number;
  },
): Promise<void> {
  assertHealAuthorized(command);
  throw new Error(
    "runHealWorkerUntilDrained: heal logic not implemented in scaffold pass",
  );
}
