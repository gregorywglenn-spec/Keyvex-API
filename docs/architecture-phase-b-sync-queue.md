# KeyVex Phase B — Sync Queue + Heal Worker Architecture

**Status:** SCAFFOLD ONLY as of 2026-05-25. Infrastructure built INERT — no
fetches, no writes, no status flips. Index-Pass-first gate per Greg's brief.

**Authority:** Defines the heal pipeline that closes out the INSUFFICIENT_DATA
rows surfaced by Phase A's data-integrity engine. Phase A wrote the honest
flags; Phase B re-fetches the source filings and resolves the flags into
VERIFIED rows (or marks them FAILED_PERMANENT after a bounded retry budget).

---

## The doctrine — measure before you heal

> The count IS the estimate. No healing fetch runs until UNIQUE_SEC_FILINGS_MAPPED
> exists as a measured integer and Greg has seen it.

Phase B begins with a READ-ONLY Index Pass that scans the v2 collections and
isolates rows that genuinely need healing. The pass produces two hard numbers
plus a grounded ETA. The heal worker stays physically inert until those numbers
are reviewed and Greg explicitly authorizes the heal run as a SEPARATE command.

Two distinct, independently-gated operations:

| Command | What it does | Authorization |
|---|---|---|
| **MEASURE** | Read-only Firestore cursor scan. Counts INSUFFICIENT_DATA rows, groups by accession_number, computes ETA. No SEC fetches. No writes. | Implicit (any time after Phase A) |
| **HEAL** | For each unique filing in the queue: re-fetch source XML, re-parse, recompute deltas, atomically flip status to VERIFIED (or FAILED_PERMANENT after 3 attempts). | Explicit — Greg must invoke separately AFTER reviewing measurement output |

The kill switch lives in `src/phase-b/heal-worker.ts` as a guard that throws on
ANY fetch / write / status flip unless `HEAL_AUTHORIZED=true` is set in the
environment AND the operator passes `--command=heal` explicitly.

---

## What "needs healing" means — fixed scope

Three categories are HEALABLE (the heal worker can re-fetch the source and
resolve the flag):

1. **13F count-check failed.** `institutional_holdings.verification_status === "INSUFFICIENT_DATA"`
   — the parsed table didn't match primary_doc.xml's `tableEntryTotal`. Heal
   path: re-fetch primary_doc.xml + info table, re-parse, recompare, and if
   counts match this time, flip the entire filing's rows VERIFIED.
2. **13F position_change unresolvable.** `institutional_holdings.position_change === "INSUFFICIENT_DATA"`
   — false-new guard fired (prior-quarter baseline missing entirely) or
   phantom-closed guard fired (current filing failed its count check). Heal
   path: fetch the prior-quarter 13F for the same fund_cik, ingest it if
   missing, then recompute deltas for the current quarter.
3. **Insider footnote ref unresolved.** `insider_trades.verification_status === "INSUFFICIENT_DATA"`
   AND `insider_transactions_v2.verification_status === "INSUFFICIENT_DATA"`
   — at least one `footnote_refs[].ref` failed to resolve against the source
   filing's FOOTNOTES table at ingestion. Heal path: re-fetch the source Form 4/5
   XML + the FOOTNOTES table, re-resolve, write the resolved text back.

One category is **TAGGED BUT NOT HEAL-FETCHABLE** (reported as a separate
informational count, never enqueued):

- **`transaction_nature === "INSUFFICIENT_DATA"`** on insider rows. These come
  from genuinely-unclassifiable SEC trans_codes (J = "other acquisition or
  disposition", V flag as primary code, E, H, L, K). The source code IS the
  data; there is nothing to re-fetch. The Tourniquet honestly tags these and
  the agent reads `transaction_nature` to know.

---

## The sync_queue Firestore collection (POPULATED ONLY DURING HEAL PASS)

Path: `/sync_queue/{entry_id}`

`entry_id` is deterministic so re-enqueues are idempotent:
`{collection}-{accession_number}` for filing-level entries (13F count-check, footnote
re-resolve), `{collection}-{fund_cik}-{quarter}` for 13F position_change healing
(per-fund per-quarter recompute).

### Document shape

```typescript
interface SyncQueueEntry {
  /** Deterministic ID (see above). */
  entry_id: string;

  /** Which source collection the broken rows live in. */
  target_collection:
    | "institutional_holdings"
    | "insider_trades"
    | "insider_transactions_v2";

  /** Why this entry was enqueued. Drives which heal handler runs. */
  heal_reason:
    | "13F_COUNT_CHECK_FAILED"        // → re-fetch primary_doc.xml + info table
    | "13F_POSITION_CHANGE_UNRESOLVED" // → fetch prior quarter + recompute
    | "INSIDER_FOOTNOTE_UNRESOLVED";   // → re-fetch source XML + footnotes

  /** The SEC accession number to re-fetch (filing-level entries). */
  accession_number?: string;

  /** Fund/quarter coordinates (position_change entries). */
  fund_cik?: string;
  quarter?: string;  // "YYYY-QN"

  /** Status state machine. */
  status: HealStatus;

  /** Attempt accounting. */
  attempt_count: number;          // increments on each try
  max_attempts: number;           // hard cap = 3
  last_attempted_at?: string;     // ISO-8601
  last_error?: string;            // string-shortened message (no stack)
  backoff_until?: string;         // ISO-8601, next earliest retry

  /** Audit. */
  created_at: string;             // ISO-8601, when the queue entry was first written
  resolved_at?: string;           // ISO-8601, when status flipped VERIFIED or FAILED_PERMANENT

  /** How many rows in the target collection this entry will heal (informational). */
  affected_row_count: number;
}

type HealStatus =
  | "PENDING"           // enqueued, awaiting first attempt
  | "IN_PROGRESS"       // worker has claimed it
  | "VERIFIED"          // heal succeeded, source rows updated, entry archived
  | "FAILED_PERMANENT"; // hit max_attempts; will not be retried automatically
```

### Status transitions

```
PENDING ──claim──> IN_PROGRESS ──success──> VERIFIED
                       │
                       └──fail──> PENDING (if attempt_count < max_attempts; backoff_until set)
                       │
                       └──fail──> FAILED_PERMANENT (if attempt_count >= max_attempts)
```

Atomicity rule: `IN_PROGRESS → VERIFIED` requires the source rows AND the queue
entry to be updated in the SAME Firestore transaction. Never flip the entry
VERIFIED while source rows still carry the INSUFFICIENT_DATA label — Phase A's
Tourniquet posture extends through Phase B.

---

## Rate limit + retry policy (HEAL PASS ONLY — not measurement pass)

For reference. These apply when Greg authorizes the heal run; they do NOT
apply to the Index Pass, which is read-only Firestore queries with no SEC
traffic at all.

- **Rate limit.** Token bucket at 5 req/sec sustained (matches the existing
  `src/scrapers/13f.ts` `RATE_LIMIT_MS=200` guardrail). SEC's documented
  ceiling is ~10 req/sec per IP; the 2x safety margin matters under bursty
  concurrency.
- **User-Agent.** `KeyVexMCP/0.1 contact@keyvex.com` (matches existing scrapers).
- **Backoff.** Exponential, base 2 seconds, capped at 60 seconds.
- **Retry budget.** `max_attempts = 3`. Fourth failure escalates to
  `FAILED_PERMANENT` and surfaces in a daily summary log; never silently
  retried.
- **Concurrency.** Single-worker bounded (no parallel fetches in v1). Faster
  options (parallel workers respecting one token bucket) are a v1.1 polish.

---

## The Index Pass (this commit — read-only measurement)

`scripts/phase-b-index-pass.ts`:

1. Open Firestore client (read-only intent; no transactions, no writes).
2. For each of the three healable categories above, run a cursor scan with
   `select(['accession_number', 'fund_cik', 'quarter'])` to minimize bytes.
3. Accumulate:
   - `records_requiring_heal` (sum of row counts)
   - `unique_accession_numbers` (Set of strings)
   - `unique_fund_quarters` (Set of `${fund_cik}-${quarter}`)
4. Also count the informational `transaction_nature === "INSUFFICIENT_DATA"`
   bucket (NOT heal-fetchable; reported separately).
5. Print:
   - `TOTAL_RECORDS_REQUIRING_HEAL = N`
   - `UNIQUE_SEC_FILINGS_MAPPED = M`
   - Row-to-filing compression ratio
   - ETA at 5 req/sec (operational) and at 10 req/sec (theoretical ceiling)
   - Likely-unhealable break-out if estimable
6. HALT. No queue entries written. No SEC fetches. No status flips. Return to
   Greg with the numbers and wait for an explicit heal authorization.
