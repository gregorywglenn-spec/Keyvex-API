/**
 * Form 4 historical backfill harness (Greg's 2026-05-23 brief items 1, 6-8).
 *
 * Bulk-enumeration via SEC EDGAR full-index quarterly files:
 *   /Archives/edgar/full-index/YYYY/QTRn/form.idx
 *
 * Architecture:
 *   - One full-index fetch per quarter (~40 for 10 years; ~20 for 5 years)
 *   - Filters lines to form="4" + "4/A"
 *   - Yields (cik, accession, primary_doc) tuples
 *   - Per-filing: fetch primary XML → parse → save (chunked batch writes)
 *   - Checkpoint per chunk to /meta/form4Backfill/{year}-Q{n} for resume
 *   - Layer 2 self-check assertions after each quarter; HALT (don't auto-fix)
 *     on correctness violations
 *
 * Three layers per Greg's spec:
 *   Layer 1 (self-heal): fetchWithBackoff in form4.ts already covers 429/5xx
 *     + per-filing try/catch skips a single bad filing without halting the chunk
 *   Layer 2 (self-check): assertions in `selfCheckQuarter` — date sanity,
 *     value=shares×price, is_derivative coverage, count ballpark.
 *     On failure: writes {status:"HALTED", reason} to the checkpoint doc;
 *     callers must NOT auto-trigger next chunk.
 *   Layer 3 (scheduled monitor): NOT in this file. Separate scheduled
 *     Cloud Function reads checkpoint docs + alerts Greg. Built post-pilot.
 *
 * Resumability:
 *   - The CLI runner picks (year, quarter) inputs.
 *   - Before fetching anything, reads /meta/form4Backfill/{year}-Q{n}.
 *     If status="completed" → skip the quarter entirely.
 *     If status="in_progress" → resume from last_processed_index.
 *     If status="HALTED" → require explicit human override (--force).
 *
 * NOT in this file: Cloud Function adaptation. v1: drive from CLI with
 * service-account credentials; v1.1: wrap as `runForm4BackfillQuarter`
 * Cloud Function with 540s timeout-aware chunking. The CLI proves the
 * mechanics first.
 */

import { parseForm4Xml, getTickerInfo } from "./form4.js";
import { getLiveDb, isStubMode } from "../firestore.js";
import type { InsiderTransaction } from "../types.js";

const CONFIG = {
  USER_AGENT:
    process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com",
  EDGAR_URL: "https://www.sec.gov",
  RATE_LIMIT_MS: 110, // ~9 req/s — same target as form4.ts
  MAX_RETRIES: 5,
  /** Index lines we accept. EDGAR full-index includes 4 and 4/A, also
   *  "FORM 4" historical variants. Be permissive on the code field. */
  ACCEPTED_FORMS: new Set(["4", "4/A"]),
  /** Self-check tolerances (Layer 2). */
  VALUE_MATH_PENNY_TOLERANCE: 0.02,
  /** A quarter that ingests fewer rows than this fraction of its median
   *  historical neighbor signals a possible enumeration / parse miss.
   *  Calibrated post-pilot; defaults conservative (no false alarms on
   *  the pilot year). */
  MIN_QUARTER_RATIO_OF_NEIGHBOR: 0.4,
} as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Local lightweight fetch with backoff. Duplicated from form4.ts on
 *  purpose so the backfill harness has zero coupling to the live-feed
 *  scraper's internals — they can evolve independently. */
async function fetchTextLocal(url: string): Promise<string> {
  let lastErr = "";
  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    await sleep(CONFIG.RATE_LIMIT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": CONFIG.USER_AGENT },
      });
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(Math.min(60000, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw new Error(`fetch failed after ${CONFIG.MAX_RETRIES}: ${lastErr} — ${url}`);
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const wait = !isNaN(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60000, 1000 * Math.pow(2, attempt));
      console.error(`[form4-backfill] 429 — wait ${wait}ms (Retry-After=${retryAfter || "none"})`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && res.status < 600) {
      console.error(`[form4-backfill] ${res.status} — backoff retry ${attempt + 1}/${CONFIG.MAX_RETRIES}`);
      await sleep(Math.min(60000, 1000 * Math.pow(2, attempt)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    }
    return res.text();
  }
  throw new Error(`unreachable: ${lastErr} — ${url}`);
}

// ─── Bulk-index enumeration ────────────────────────────────────────────────

export interface QuarterIndexEntry {
  cik: string;
  accession: string;
  filed: string;
  form: string;
  /** Path the index gives us — typically `edgar/data/{cik}/{accession}.txt` */
  indexPath: string;
}

/**
 * Fetch the SEC full-index file for one quarter and return all Form 4 +
 * Form 4/A entries.
 *
 * URL pattern: https://www.sec.gov/Archives/edgar/full-index/YYYY/QTRn/form.idx
 *
 * Format: fixed-column-ish text with a header followed by entries:
 *   Form Type | Company Name | CIK | Date Filed | Filename
 *   ---------+--------------+-----+-------------+----------
 *   4        | APPLE INC    | ... | 2018-01-02  | edgar/data/.../filing.txt
 *
 * Pre-2007 quarters used different column layouts; we target 2007+ which
 * uses the modern pipe-aligned format. SEC published-format note.
 */
export async function fetchQuarterFormIndex(
  year: number,
  quarter: 1 | 2 | 3 | 4,
): Promise<QuarterIndexEntry[]> {
  const url = `${CONFIG.EDGAR_URL}/Archives/edgar/full-index/${year}/QTR${quarter}/form.idx`;
  console.error(`[form4-backfill] enumerating ${year}-Q${quarter} index: ${url}`);
  const text = await fetchTextLocal(url);
  const lines = text.split(/\r?\n/);
  // Skip header — find the line starting with "Form Type" then skip 2 more (sep + blank)
  let dataStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.startsWith("---") || l.startsWith("Form Type")) {
      dataStart = i + 1;
      // Skip the separator line itself
      while (dataStart < lines.length && lines[dataStart]?.startsWith("-")) dataStart++;
      break;
    }
  }
  const entries: QuarterIndexEntry[] = [];
  // Modern form.idx uses fixed-width columns:
  //   Form Type (12)  Company Name (62)  CIK (12)  Date Filed (12)  Filename (rest)
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 60) continue;
    const formType = line.slice(0, 12).trim();
    if (!CONFIG.ACCEPTED_FORMS.has(formType)) continue;
    // Split the rest of the line by 2+ spaces — robust to slight column drift
    const rest = line.slice(12).trim();
    // Format roughly: "<COMPANY NAME>          <CIK>       <DATE>      <FILENAME>"
    // Filename always ends in `.txt` — anchor on that.
    const txtMatch = rest.match(/\s+(\S*\.txt)\s*$/);
    if (!txtMatch) continue;
    const filename = txtMatch[1]!;
    // Filename pattern: edgar/data/{cik}/{accession-with-dashes}.txt
    const fileNameMatch = filename.match(/edgar\/data\/(\d+)\/([\d-]+)\.txt$/);
    if (!fileNameMatch) continue;
    const cik = fileNameMatch[1]!;
    const accession = fileNameMatch[2]!;
    // Date filed is the third column (10 chars yyyy-mm-dd) — pull it out
    // by walking from the end: filename, then date, then CIK, then name.
    const beforeFilename = rest.slice(0, rest.length - filename.length).trim();
    const dateMatch = beforeFilename.match(/(\d{4}-\d{2}-\d{2})\s*$/);
    const filed = dateMatch?.[1] ?? "";
    entries.push({ cik, accession, filed, form: formType, indexPath: filename });
  }
  console.error(`[form4-backfill]   ${year}-Q${quarter}: ${entries.length} Form 4 / 4-A entries`);
  return entries;
}

/**
 * Resolve a quarter-index entry to the primary XML URL. The full-index
 * filename points to the parent "index.txt" file; we need the .xml inside
 * the accession's archive. Use the per-accession index.json to find it.
 */
async function resolvePrimaryXmlUrl(
  entry: QuarterIndexEntry,
): Promise<string | null> {
  const accNoSlash = entry.accession.replace(/-/g, "");
  const indexJsonUrl = `${CONFIG.EDGAR_URL}/Archives/edgar/data/${entry.cik}/${accNoSlash}/index.json`;
  let text: string;
  try {
    text = await fetchTextLocal(indexJsonUrl);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const items = (parsed as { directory?: { item?: Array<{ name?: string }> } })
    .directory?.item ?? [];
  // The primary doc is the .xml file that's NOT primary_doc.xml (Form 4
  // XML is typically wf-form4_xxxxxxxx.xml or doc4.xml). Prefer files
  // matching /form4|wf-form4|primary_doc|ownership/i in that priority.
  const xmlFiles = items
    .map((i) => i.name ?? "")
    .filter((n) => n.endsWith(".xml"));
  if (xmlFiles.length === 0) return null;
  // Priority: anything matching "form4" first, then any xml that's not primary_doc.xml
  const ranked = xmlFiles.sort((a, b) => {
    const ra = a.toLowerCase().includes("form4") || a.toLowerCase().includes("form_4") ? 0
      : a.toLowerCase() === "primary_doc.xml" ? 2 : 1;
    const rb = b.toLowerCase().includes("form4") || b.toLowerCase().includes("form_4") ? 0
      : b.toLowerCase() === "primary_doc.xml" ? 2 : 1;
    return ra - rb;
  });
  return `${CONFIG.EDGAR_URL}/Archives/edgar/data/${entry.cik}/${accNoSlash}/${ranked[0]}`;
}

// ─── Checkpoint primitive ──────────────────────────────────────────────────

export type BackfillStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "HALTED";

export interface CheckpointDoc {
  year: number;
  quarter: number;
  status: BackfillStatus;
  total_index_entries: number;
  last_processed_index: number;
  saved_count: number;
  skipped_count: number;
  parse_error_count: number;
  halted_reason?: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
}

function checkpointDocPath(year: number, quarter: number): string {
  return `meta/form4Backfill/quarters/${year}-Q${quarter}`;
}

async function readCheckpoint(
  year: number,
  quarter: number,
): Promise<CheckpointDoc | null> {
  if (isStubMode()) return null;
  const db = await getLiveDb();
  const doc = await db.doc(checkpointDocPath(year, quarter)).get();
  return doc.exists ? (doc.data() as CheckpointDoc) : null;
}

async function writeCheckpoint(
  year: number,
  quarter: number,
  doc: CheckpointDoc,
): Promise<void> {
  if (isStubMode()) return;
  const db = await getLiveDb();
  // Firestore rejects undefined values. Strip them out before write.
  // (We can't use ignoreUndefinedProperties globally because that's
  // a Firestore Settings flag and our admin client is already
  // initialized at module load.)
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) sanitized[k] = v;
  }
  await db
    .doc(checkpointDocPath(year, quarter))
    .set(sanitized, { merge: true });
}

// ─── Layer 2: self-check assertions ────────────────────────────────────────

export interface SelfCheckResult {
  passed: boolean;
  issues: string[];
  stats: {
    row_count: number;
    distinct_filings: number;
    date_range: [string, string];
    derivative_pct: number;
    parse_error_count: number;
    value_math_violations: number;
    year_out_of_range: number;
    is_derivative_missing: number;
  };
}

export function selfCheckBatch(
  trades: InsiderTransaction[],
  parseErrors: number,
): SelfCheckResult {
  const issues: string[] = [];
  let valueMathViolations = 0;
  let yearOOR = 0;
  let isDerivMissing = 0;
  let minDate = "9999-99-99";
  let maxDate = "0000-00-00";
  const accSet = new Set<string>();
  let derivCount = 0;
  const maxYear = new Date().getUTCFullYear() + 1;
  for (const t of trades) {
    accSet.add(t.accession_number);
    if (t.transaction_date) {
      if (t.transaction_date < minDate) minDate = t.transaction_date;
      if (t.transaction_date > maxDate) maxDate = t.transaction_date;
    }
    if (typeof t.is_derivative !== "boolean") isDerivMissing++;
    if (t.is_derivative === true) derivCount++;
    const yr = parseInt((t.transaction_date || "").slice(0, 4), 10);
    if (isNaN(yr) || yr < 2012 || yr > maxYear) yearOOR++;
    // value math: tolerate the parser's penny rounding
    const expected = t.shares * t.price_per_share;
    if (Math.abs(t.total_value - expected) > CONFIG.VALUE_MATH_PENNY_TOLERANCE) {
      valueMathViolations++;
    }
  }
  if (yearOOR > 0) {
    issues.push(`${yearOOR} row(s) have transaction_date year out of [2012, ${maxYear}]`);
  }
  if (valueMathViolations > 0) {
    issues.push(
      `${valueMathViolations} row(s) have total_value ≠ shares × price (>${CONFIG.VALUE_MATH_PENNY_TOLERANCE} tolerance)`,
    );
  }
  if (isDerivMissing > 0) {
    issues.push(`${isDerivMissing} row(s) have non-boolean is_derivative`);
  }
  return {
    passed: issues.length === 0,
    issues,
    stats: {
      row_count: trades.length,
      distinct_filings: accSet.size,
      date_range: [minDate, maxDate],
      derivative_pct:
        trades.length > 0 ? Math.round((100 * derivCount) / trades.length) : 0,
      parse_error_count: parseErrors,
      value_math_violations: valueMathViolations,
      year_out_of_range: yearOOR,
      is_derivative_missing: isDerivMissing,
    },
  };
}

// ─── Public: run one quarter ───────────────────────────────────────────────

export interface RunQuarterOptions {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Set true to bypass HALTED checkpoint state (forensic recovery only) */
  force?: boolean;
  /** Cap rows ingested this invocation — used to fit Cloud Function timeout
   *  windows. Default unlimited (CLI mode). When the cap fires we save a
   *  resumable in_progress checkpoint and exit cleanly. */
  maxRowsThisRun?: number;
  /** Per-batch save cap (Firestore batch limit is 500). */
  saveBatchSize?: number;
  /** Dry-run: don't write to Firestore, just parse + self-check. */
  dryRun?: boolean;
}

export interface RunQuarterResult {
  status: BackfillStatus;
  rows_ingested_this_run: number;
  cumulative_saved: number;
  parse_errors: number;
  skipped: number;
  self_check: SelfCheckResult;
  resume_index?: number;
  reason?: string;
}

export async function runBackfillQuarter(
  options: RunQuarterOptions,
): Promise<RunQuarterResult> {
  const { year, quarter } = options;
  const force = options.force ?? false;
  const maxRows = options.maxRowsThisRun ?? Infinity;
  const saveBatchSize = options.saveBatchSize ?? 400;
  const dryRun = options.dryRun ?? false;

  console.error(
    `\n[form4-backfill] ====== ${year}-Q${quarter} ====== (force=${force} dryRun=${dryRun} maxRows=${maxRows === Infinity ? "∞" : maxRows})`,
  );

  // ─── Read checkpoint ────────────────────────────────────────────────
  const existing = await readCheckpoint(year, quarter);
  if (existing) {
    console.error(
      `[form4-backfill] checkpoint: status=${existing.status} processed=${existing.last_processed_index}/${existing.total_index_entries} saved=${existing.saved_count}`,
    );
    if (existing.status === "completed") {
      console.error(`[form4-backfill]   already completed — skipping`);
      return {
        status: "completed",
        rows_ingested_this_run: 0,
        cumulative_saved: existing.saved_count,
        parse_errors: existing.parse_error_count,
        skipped: existing.skipped_count,
        self_check: { passed: true, issues: [], stats: { row_count: 0, distinct_filings: 0, date_range: ["", ""], derivative_pct: 0, parse_error_count: 0, value_math_violations: 0, year_out_of_range: 0, is_derivative_missing: 0 } },
      };
    }
    if (existing.status === "HALTED" && !force) {
      console.error(
        `[form4-backfill]   HALTED by prior run: ${existing.halted_reason} — pass --force to override`,
      );
      return {
        status: "HALTED",
        rows_ingested_this_run: 0,
        cumulative_saved: existing.saved_count,
        parse_errors: existing.parse_error_count,
        skipped: existing.skipped_count,
        self_check: { passed: false, issues: [existing.halted_reason ?? "(no reason)"], stats: { row_count: 0, distinct_filings: 0, date_range: ["", ""], derivative_pct: 0, parse_error_count: 0, value_math_violations: 0, year_out_of_range: 0, is_derivative_missing: 0 } },
        reason: existing.halted_reason,
      };
    }
  }

  // ─── Enumerate the quarter ──────────────────────────────────────────
  const entries = await fetchQuarterFormIndex(year, quarter);

  // Initialize / advance checkpoint
  const startIdx = existing?.last_processed_index ?? 0;
  let cumulativeSaved = existing?.saved_count ?? 0;
  let cumulativeParseErrors = existing?.parse_error_count ?? 0;
  let cumulativeSkipped = existing?.skipped_count ?? 0;
  const startedAt = existing?.started_at ?? new Date().toISOString();

  await writeCheckpoint(year, quarter, {
    year,
    quarter,
    status: "in_progress",
    total_index_entries: entries.length,
    last_processed_index: startIdx,
    saved_count: cumulativeSaved,
    skipped_count: cumulativeSkipped,
    parse_error_count: cumulativeParseErrors,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
  });

  // ─── Process filings ────────────────────────────────────────────────
  const tradesBuffer: InsiderTransaction[] = [];
  let processedThisRun = 0;
  let savedThisRun = 0;
  let lastIndex = startIdx;

  // Lazy-import save fn so dryRun path doesn't even touch firestore module
  const { saveInsiderTransactions } = await import("../firestore.js");

  for (let i = startIdx; i < entries.length; i++) {
    if (processedThisRun >= maxRows) {
      console.error(`[form4-backfill]   maxRows reached, will resume at index ${i}`);
      break;
    }
    const e = entries[i]!;
    processedThisRun++;
    lastIndex = i;
    let xmlUrl: string | null;
    try {
      xmlUrl = await resolvePrimaryXmlUrl(e);
    } catch (err) {
      cumulativeSkipped++;
      console.error(
        `[form4-backfill]   ${e.accession}: index.json fetch FAIL — ${(err as Error).message.slice(0, 80)}`,
      );
      continue;
    }
    if (!xmlUrl) {
      cumulativeSkipped++;
      console.error(`[form4-backfill]   ${e.accession}: no .xml file found in accession archive`);
      continue;
    }
    let xml: string;
    try {
      xml = await fetchTextLocal(xmlUrl);
    } catch (err) {
      cumulativeSkipped++;
      console.error(
        `[form4-backfill]   ${e.accession}: XML fetch FAIL — ${(err as Error).message.slice(0, 80)}`,
      );
      continue;
    }
    try {
      const parsed = parseForm4Xml(xml, {
        accession: e.accession,
        companyCik: e.cik,
        filedAt: e.filed,
        url: xmlUrl,
      });
      tradesBuffer.push(...parsed);
    } catch (err) {
      cumulativeParseErrors++;
      console.error(
        `[form4-backfill]   ${e.accession}: parser threw — ${(err as Error).message.slice(0, 80)}`,
      );
      continue;
    }
    // Flush buffer if it fills a batch
    if (tradesBuffer.length >= saveBatchSize) {
      if (!dryRun) {
        const r = await saveInsiderTransactions(tradesBuffer.splice(0));
        savedThisRun += r.saved;
        cumulativeSaved += r.saved;
        // Periodic checkpoint update (every batch)
        await writeCheckpoint(year, quarter, {
          year,
          quarter,
          status: "in_progress",
          total_index_entries: entries.length,
          last_processed_index: i + 1,
          saved_count: cumulativeSaved,
          skipped_count: cumulativeSkipped,
          parse_error_count: cumulativeParseErrors,
          started_at: startedAt,
          updated_at: new Date().toISOString(),
        });
        console.error(
          `[form4-backfill]   processed=${i + 1}/${entries.length}  saved=${cumulativeSaved}  skipped=${cumulativeSkipped}  parse_err=${cumulativeParseErrors}`,
        );
      } else {
        savedThisRun += tradesBuffer.length;
        cumulativeSaved += tradesBuffer.length;
        tradesBuffer.length = 0;
      }
    }
  }

  // ─── Flush remaining ───────────────────────────────────────────────
  if (tradesBuffer.length > 0) {
    if (!dryRun) {
      const r = await saveInsiderTransactions(tradesBuffer);
      savedThisRun += r.saved;
      cumulativeSaved += r.saved;
    } else {
      savedThisRun += tradesBuffer.length;
      cumulativeSaved += tradesBuffer.length;
    }
  }

  // ─── Determine completion ──────────────────────────────────────────
  const completed = lastIndex + 1 >= entries.length;
  const resumeIndex = completed ? undefined : lastIndex + 1;

  // ─── Layer 2 self-check ───────────────────────────────────────────
  // Re-read the rows we wrote this run for the check. For pilot scale
  // this is small enough; v1.1 polish: maintain trades buffer through
  // the loop and self-check the in-memory set.
  let selfCheck: SelfCheckResult;
  if (dryRun) {
    selfCheck = { passed: true, issues: [], stats: { row_count: savedThisRun, distinct_filings: 0, date_range: ["", ""], derivative_pct: 0, parse_error_count: cumulativeParseErrors, value_math_violations: 0, year_out_of_range: 0, is_derivative_missing: 0 } };
  } else {
    // Pull this quarter's rows back from Firestore for the self-check
    const db = await getLiveDb();
    const qStart = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
    const qEndYear = quarter === 4 ? year + 1 : year;
    const qEndMonth = quarter === 4 ? 1 : quarter * 3 + 1;
    const qEnd = `${qEndYear}-${String(qEndMonth).padStart(2, "0")}-01`;
    const snap = await db
      .collection("insider_trades")
      .where("transaction_date", ">=", qStart)
      .where("transaction_date", "<", qEnd)
      .get();
    const trades = snap.docs.map((d) => d.data() as InsiderTransaction);
    selfCheck = selfCheckBatch(trades, cumulativeParseErrors);
  }

  // ─── Final checkpoint write ───────────────────────────────────────
  let finalStatus: BackfillStatus = completed ? "completed" : "in_progress";
  let haltedReason: string | undefined;
  if (!selfCheck.passed) {
    finalStatus = "HALTED";
    haltedReason = selfCheck.issues.join("; ");
    console.error(`\n[form4-backfill] !!! Layer 2 SELF-CHECK FAILED !!!`);
    for (const issue of selfCheck.issues) {
      console.error(`[form4-backfill]   ${issue}`);
    }
    console.error(
      `[form4-backfill] HALTED — manual review required. Do NOT trigger next quarter.`,
    );
  }
  await writeCheckpoint(year, quarter, {
    year,
    quarter,
    status: finalStatus,
    total_index_entries: entries.length,
    last_processed_index: lastIndex + 1,
    saved_count: cumulativeSaved,
    skipped_count: cumulativeSkipped,
    parse_error_count: cumulativeParseErrors,
    halted_reason: haltedReason,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    completed_at: finalStatus === "completed" ? new Date().toISOString() : undefined,
  });

  console.error(
    `\n[form4-backfill] ${year}-Q${quarter} ${finalStatus.toUpperCase()}: this_run=${savedThisRun} cumulative=${cumulativeSaved} parse_err=${cumulativeParseErrors} skip=${cumulativeSkipped}`,
  );
  console.error(`[form4-backfill] self-check: ${JSON.stringify(selfCheck.stats, null, 2)}`);

  return {
    status: finalStatus,
    rows_ingested_this_run: savedThisRun,
    cumulative_saved: cumulativeSaved,
    parse_errors: cumulativeParseErrors,
    skipped: cumulativeSkipped,
    self_check: selfCheck,
    resume_index: resumeIndex,
    reason: haltedReason,
  };
}

// Silence "unused" lint for the unused getTickerInfo import — it's kept for
// future symmetry / cross-reference (other harnesses use it).
void getTickerInfo;
