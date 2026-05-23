/**
 * Form 3/4/5 bulk-load orchestrator — Gate 6 (full 2006q1 → present load).
 *
 * Iterates quarters sequentially:
 *   1. Skip quarters already marked "completed" in the local checkpoint
 *      file (resume-friendly — kill and restart is safe).
 *   2. Download + extract + parse + save each quarter.
 *   3. Per-quarter result recorded to checkpoint immediately after a
 *      successful write batch (atomic JSON file write).
 *   4. 404 on a quarter zip = "not yet published by SEC" → record as
 *      "not_published" and continue (the SEC's quarterly publish lag is
 *      ~2-3 weeks after quarter-end).
 *   5. Other errors = record as "failed" with error text and continue
 *      (do NOT halt the whole run for one bad quarter).
 *
 * The per-quarter loader (scrapeForm345BulkQuarter) is itself idempotent
 * (SEC stable surrogate keys → same Firestore doc IDs → merge writes).
 * So re-running a "completed" quarter is safe; the checkpoint just
 * prevents waste.
 *
 * Checkpoint file: <repo>/secrets/form345-bulk-checkpoint.json
 *   (gitignored alongside service-account.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  saveInsiderFilingsV2,
  saveInsiderHoldingsV2,
  saveInsiderTransactionsV2,
} from "../firestore.js";
import { scrapeForm345BulkQuarter } from "./form345-bulk.js";

// ─── Checkpoint file ────────────────────────────────────────────────────────

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(MODULE_DIR, "..", "..");
const CHECKPOINT_PATH = resolve(
  PROJECT_ROOT,
  "secrets/form345-bulk-checkpoint.json",
);

export interface QuarterCheckpoint {
  status: "completed" | "failed" | "not_published" | "in_progress";
  tx_count?: number;
  hold_count?: number;
  filing_count?: number;
  skipped?: Record<string, number>;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

export interface CheckpointFile {
  last_run_at: string;
  schema_version: 1;
  quarters: Record<string, QuarterCheckpoint>;
}

function loadCheckpoint(): CheckpointFile {
  if (!fs.existsSync(CHECKPOINT_PATH)) {
    return {
      last_run_at: new Date().toISOString(),
      schema_version: 1,
      quarters: {},
    };
  }
  const text = fs.readFileSync(CHECKPOINT_PATH, "utf8");
  try {
    const parsed = JSON.parse(text) as CheckpointFile;
    return parsed;
  } catch (e) {
    throw new Error(`Bad checkpoint at ${CHECKPOINT_PATH}: ${(e as Error).message}`);
  }
}

function writeCheckpoint(c: CheckpointFile): void {
  fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
  // Atomic write: stage to .tmp, rename. Avoids half-written file on crash.
  const tmp = CHECKPOINT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CHECKPOINT_PATH);
}

// ─── Quarter enumeration ───────────────────────────────────────────────────

/** Returns ["2006q1","2006q2", ... ,"2026q1"] (inclusive). */
export function enumerateQuarters(
  startYear: number,
  startQ: number,
  endYear: number,
  endQ: number,
): string[] {
  const out: string[] = [];
  let y = startYear;
  let q = startQ;
  while (y < endYear || (y === endYear && q <= endQ)) {
    out.push(`${y}q${q}`);
    q += 1;
    if (q > 4) {
      q = 1;
      y += 1;
    }
  }
  return out;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  /** Inclusive start quarter. Default 2006q1. */
  startQuarter?: string;
  /** Inclusive end quarter. Default = current calendar quarter (best-effort). */
  endQuarter?: string;
  /** If true, re-run quarters even if checkpoint marks them completed. */
  force?: boolean;
  /** If true, parse and build but skip Firestore writes. */
  dryRun?: boolean;
  /** Limit max quarters per invocation (for testing). 0 = no limit. */
  maxQuarters?: number;
}

function currentQuarterString(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11
  const q = Math.floor(m / 3) + 1;
  return `${y}q${q}`;
}

function parseQuarter(s: string): { y: number; q: number } {
  const m = s.match(/^(\d{4})q([1-4])$/i);
  if (!m || !m[1] || !m[2]) throw new Error(`Bad quarter: ${s}`);
  return { y: parseInt(m[1], 10), q: parseInt(m[2], 10) };
}

export async function runFullLoad(
  options: OrchestratorOptions = {},
): Promise<CheckpointFile> {
  const start = parseQuarter(options.startQuarter ?? "2006q1");
  const end = parseQuarter(options.endQuarter ?? currentQuarterString());
  const quarters = enumerateQuarters(start.y, start.q, end.y, end.q);

  console.error(
    `[orchestrator] Planned: ${quarters.length} quarters from ${quarters[0]} → ${quarters[quarters.length - 1]}`,
  );
  if (options.dryRun) {
    console.error("[orchestrator] DRY-RUN mode — no Firestore writes");
  }
  if (options.force) {
    console.error("[orchestrator] FORCE mode — re-running even completed quarters");
  }
  console.error("");

  const checkpoint = loadCheckpoint();
  checkpoint.last_run_at = new Date().toISOString();

  const totals = {
    quartersAttempted: 0,
    quartersCompleted: 0,
    quartersSkippedExisting: 0,
    quartersNotPublished: 0,
    quartersFailed: 0,
    docsWrittenTx: 0,
    docsWrittenHold: 0,
    docsWrittenFiling: 0,
  };

  const runStartedAt = Date.now();

  for (let i = 0; i < quarters.length; i++) {
    const quarter = quarters[i]!;
    const existing = checkpoint.quarters[quarter];
    if (!options.force && existing?.status === "completed") {
      console.error(
        `[orchestrator] [${i + 1}/${quarters.length}] ${quarter} — already completed (skip), tx=${existing.tx_count}, hold=${existing.hold_count}, filing=${existing.filing_count}`,
      );
      totals.quartersSkippedExisting += 1;
      continue;
    }

    totals.quartersAttempted += 1;
    const qStart = Date.now();
    console.error(
      `[orchestrator] [${i + 1}/${quarters.length}] ${quarter} — starting...`,
    );
    checkpoint.quarters[quarter] = {
      status: "in_progress",
      started_at: new Date().toISOString(),
    };
    writeCheckpoint(checkpoint);

    try {
      const built = await scrapeForm345BulkQuarter(quarter);

      if (!options.dryRun) {
        const filingRes = await saveInsiderFilingsV2(built.filings);
        const txRes = await saveInsiderTransactionsV2(built.transactions);
        const holdRes = await saveInsiderHoldingsV2(built.holdings);
        totals.docsWrittenFiling += filingRes.saved;
        totals.docsWrittenTx += txRes.saved;
        totals.docsWrittenHold += holdRes.saved;
      }

      if (options.dryRun) {
        // Dry-run rebuilt the docs but didn't write Firestore. Don't mark
        // "completed" — a future real run must re-do this quarter to actually
        // write. Use in_progress + dry_run note so the entry isn't lost.
        checkpoint.quarters[quarter] = {
          status: "in_progress",
          tx_count: built.transactions.length,
          hold_count: built.holdings.length,
          filing_count: built.filings.length,
          skipped: built.skipped as unknown as Record<string, number>,
          error: "DRY_RUN — parsed + built but NOT written to Firestore. Re-run without --dry-run to write.",
          started_at: checkpoint.quarters[quarter]?.started_at,
          completed_at: new Date().toISOString(),
        };
      } else {
        checkpoint.quarters[quarter] = {
          status: "completed",
          tx_count: built.transactions.length,
          hold_count: built.holdings.length,
          filing_count: built.filings.length,
          skipped: built.skipped as unknown as Record<string, number>,
          started_at: checkpoint.quarters[quarter]?.started_at,
          completed_at: new Date().toISOString(),
        };
      }
      writeCheckpoint(checkpoint);
      totals.quartersCompleted += 1;

      const wall = ((Date.now() - qStart) / 1000).toFixed(1);
      console.error(
        `[orchestrator] [${i + 1}/${quarters.length}] ${quarter} — ✓ tx=${built.transactions.length.toLocaleString()} hold=${built.holdings.length.toLocaleString()} filing=${built.filings.length.toLocaleString()} in ${wall}s`,
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const is404 = /HTTP 404/i.test(msg);
      if (is404) {
        checkpoint.quarters[quarter] = {
          status: "not_published",
          error: msg,
          started_at: checkpoint.quarters[quarter]?.started_at,
          completed_at: new Date().toISOString(),
        };
        writeCheckpoint(checkpoint);
        totals.quartersNotPublished += 1;
        console.error(
          `[orchestrator] [${i + 1}/${quarters.length}] ${quarter} — NOT YET PUBLISHED (404) — continuing`,
        );
      } else {
        checkpoint.quarters[quarter] = {
          status: "failed",
          error: msg,
          started_at: checkpoint.quarters[quarter]?.started_at,
          completed_at: new Date().toISOString(),
        };
        writeCheckpoint(checkpoint);
        totals.quartersFailed += 1;
        console.error(
          `[orchestrator] [${i + 1}/${quarters.length}] ${quarter} — ✗ FAILED: ${msg.slice(0, 200)}`,
        );
        // Do NOT halt — continue with next quarter
      }
    }

    if (options.maxQuarters && totals.quartersAttempted >= options.maxQuarters) {
      console.error(
        `[orchestrator] hit --max-quarters=${options.maxQuarters} cap — stopping early`,
      );
      break;
    }
  }

  const totalSec = ((Date.now() - runStartedAt) / 1000).toFixed(0);
  console.error("");
  console.error("============================================================");
  console.error("FULL-LOAD SUMMARY");
  console.error("============================================================");
  console.error(`  Wall time:                ${totalSec}s`);
  console.error(`  Quarters planned:         ${quarters.length}`);
  console.error(`  Quarters attempted:       ${totals.quartersAttempted}`);
  console.error(`  Quarters completed:       ${totals.quartersCompleted}`);
  console.error(`  Quarters skipped (done):  ${totals.quartersSkippedExisting}`);
  console.error(`  Quarters not_published:   ${totals.quartersNotPublished}`);
  console.error(`  Quarters failed:          ${totals.quartersFailed}`);
  console.error(`  Total tx rows written:    ${totals.docsWrittenTx.toLocaleString()}`);
  console.error(`  Total holding rows:       ${totals.docsWrittenHold.toLocaleString()}`);
  console.error(`  Total filing rows:        ${totals.docsWrittenFiling.toLocaleString()}`);

  if (totals.quartersFailed > 0) {
    console.error("");
    console.error("  ⚠ Failed quarters (re-run later or investigate):");
    for (const [q, c] of Object.entries(checkpoint.quarters)) {
      if (c.status === "failed") {
        console.error(`    ${q}: ${c.error?.slice(0, 120)}`);
      }
    }
  }

  return checkpoint;
}

export function getCheckpoint(): CheckpointFile {
  return loadCheckpoint();
}
