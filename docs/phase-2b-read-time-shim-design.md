# Phase 2b — Read-Time Source-Metadata Shim — DESIGN SPEC

**Status:** Design spec only. No implementation code in this session. Implementation lands in a separate, future session with this design locked. Pairs with Commit `c4c1192` (Phase 2a — `get_insider_transactions` SEC-conventions docs); both ship together at deploy.

**Purpose:** Phase 2a documented the SEC source-data conventions (the 2050 perpetual-instrument sentinel and the anomalous-year filer-entry pattern) in human-readable tool description text. Phase 2b makes the same interpretation **machine-readable** via a read-time additive flag — `source_metadata` — that preserves SEC's exact byte values and labels the interpretation as KeyVex's, never SEC's. **Never replace, always annotate.**

The principle this shim enforces in code: KeyVex mirrors SEC's bytes exactly; the interpretation lives at the response boundary as labeled metadata; a customer auditing KeyVex against EDGAR finds a byte-for-byte match.

---

## NO-WRITE ATTESTATION (forward-looking, governs implementation)

When implemented, the shim's runtime surface MUST be:

- Pure function over response rows. Input: an array of rows already fetched from Firestore. Output: same array, with optional `source_metadata` field added per row.
- No Firestore calls of any kind (read or write). No `getLiveDb()` import in the shim itself.
- No network calls. No file I/O.
- No mutation of the input rows' existing fields. Specifically: `transaction_date`, `exercise_date`, `expiration_date`, `period_of_report`, `filing_date`, and any other date field are NEVER modified, replaced, normalized, or null-substituted. The byte-exact-to-SEC posture is enforced in code, not just convention.
- No precomputed metadata stored in Firestore. Detection runs at read time, every time.

The implementation file's docstring will state these prohibitions explicitly, mirroring the no-write attestation blocks on `_diag-bulk-v2-date-corruption-count.ts` and the spot-check script. A mechanical grep at commit time will verify no `.set/.update/.delete/.add/.create/.batch` calls exist in the shim source.

---

## Design questions resolved

### Q1 — Placement

**Resolution:** Shared utility at `src/source-metadata.ts` (proposed top-level path; alternative `src/tools/_source-metadata.ts` if scoped-to-tools is preferred), imported and called from BOTH branch handlers in `src/tools/insider-transactions.ts`:

- `handleV2` (line 405): just before the `return { results, ... }` at line ~520 (after all post-filtering, before envelope construction).
- `handleLegacy` (line 432): just before the `return { results, ... }` (after baselines join, after post-filter).

**Insertion-point complication flagged:** the original Phase 2b instruction described "one clean insertion point." In reality the handler has **two** because `handleV2` and `handleLegacy` are fully separate branches (`pickDataSource(args)` routes between them). Each has its own `results` array assembled before return.

**Mitigation:** the shared utility removes the duplication. Both branches call `annotateRowsSourceMetadata(results)` immediately before envelope construction. The shim logic is written once; the call site appears twice. Per-tool diff impact is minimal (one import + two one-line calls).

**Why a top-level path (`src/source-metadata.ts`):**

- The namespace is positioned to grow beyond `get_insider_transactions`. Other tools may later acquire their own SEC-source quirks (e.g., 13F historical thousands-vs-dollars era boundary; XBRL fiscal-period framing ambiguity); they would import the same utility, registering their own field-pattern rules.
- The current scope is one tool, but the design intent is project-wide.
- If we'd rather keep the scope visibly narrow until a second use-case appears, the alternative `src/tools/_source-metadata.ts` is defensible. **Design lean:** top-level.

**No query/filter/handler-logic touched.** The shim sits at the response-assembly boundary only. The post-filter logic (transaction_nature filtering, include_non_open_market, etc.) runs upstream of the shim and is untouched.

**Why NOT the deeper Firestore layer** (`src/firestore.ts`): would conflate pure-source-data fetching (firestore.ts's job) with interpretation (a higher-layer concern). Tool-handler placement keeps each layer's responsibility clean and avoids touching the same files Axis-7 will eventually touch when its design lands.

### Q2 — Execution model

**Resolution:** Read-time only. The shim is a pure function: receives an array of already-fetched rows, returns the same array with optional `source_metadata` added per row. Zero Firestore writes. Zero byte-mutation of existing row fields. No Firestore reads either — operates entirely on the in-memory result set.

**Per-request cost:** O(rows × fields × patterns). With ~50 rows per typical response × 3 date fields per row × 2 active detection rules = ~300 string comparisons per response. Sub-millisecond. Negligible against the existing Firestore read latency (~50-100ms typical).

**Stateless.** No caching, no memoization, no shared mutable state. Pure function, fully testable in isolation.

**No-write guarantee in code, not just convention:**

1. The shim's source file imports nothing from `firestore.ts` / `getLiveDb` / `firebase-admin`. Verified by mechanical grep at commit time.
2. The shim's exported function signature accepts row data (already fetched) and returns row data (annotated). No DB handle parameter exists in any signature.
3. The implementation never calls a write method on any object. Mechanical grep verifies absence of `.set/.update/.delete/.add/.create/.batch` etc. The same NO-WRITE ATTESTATION pattern used on the dry-run script applies here.

### Q3 — Detection rules (two-step, sentinel-precedence over anomalous-year fallthrough)

**Resolution:** Per row, per date field, run **Step 1 first**. If Step 1 fires, the field is flagged with the assertive sentinel flag; Step 2 does NOT run on that field. If Step 1 does not fire, Step 2 runs as fallthrough. This precedence prevents the sentinel rows (which ARE > 2050-01-01 and thus would also satisfy Step 2's anomalous-year threshold) from getting the calibrated "likely filer entry" flag — they get the correct assertive sentinel flag instead.

**Step 1 — Sentinel-precedence (exact-string match, assertive):**

Applies to fields: `exercise_date`, `expiration_date`.

```
const SENTINEL_STRINGS = new Set([
  "2050-12-31",  // most common ("no expiration" on DSUs, perpetual derivatives)
  "2050-08-31",  // observed on certain NQ Stock Options
  // List is extensible — if other SEC perpetual-instrument sentinel
  // strings surface in the future, add them here. NOT a year-range
  // match: a 2050-but-not-listed-string date falls through to Step 2.
]);

// Pattern detection (Step 1):
if (SENTINEL_STRINGS.has(row[field])) {
  flags.push("sec_perpetual_sentinel");
  // Step 2 does NOT run on this field.
}
```

**Why exact-string match, not year-range:** keeps false-positives at zero. If a legitimate option ever expires on, say, `2050-06-15` (some other date in 2050), it won't be silently labeled as a sentinel when it isn't one. It would fall through to Step 2 and get the calibrated anomalous-year flag, which is honest about what we observed without overclaiming the SEC-convention reading.

**Why "extensible list" not exhaustive enumeration:** the spot-check identified `2050-12-31` and `2050-08-31` as the observed sentinel strings. Other 2050-strings may exist; the design adds them to `SENTINEL_STRINGS` as they're identified through ongoing operation. New strings get added with a small commit; no rule-engine rewrite needed.

**Step 2 — Anomalous-year fallthrough (recount field-aware thresholds, calibrated):**

Applies to fields: `transaction_date`, `exercise_date`, `expiration_date`.

```
const ANCIENT_FLOOR = "1990-01-01";  // pre-EDGAR-electronic; older = filer error

// Field-aware future thresholds (per types.ts:1128 finding + recount validation):
//   transaction_date:  > "2027-01-01" — static; matches recount exactly.
//                                       Reviewed annually (see "Periodic
//                                       review cadence" below).
//   exercise_date:     > "2050-01-01" — forward-looking; legitimately future
//                                       for unvested options; only flag if
//                                       > 24 years out.
//   expiration_date:   > "2050-01-01" — same logic, long-dated options
//                                       legitimately exist.
const FUTURE_THRESHOLDS = {
  transaction_date: "2027-01-01",
  exercise_date:    "2050-01-01",
  expiration_date:  "2050-01-01",
};

// Pattern detection (Step 2, after Step 1 didn't fire):
if (row[field] < ANCIENT_FLOOR || row[field] > FUTURE_THRESHOLDS[field]) {
  flags.push("anomalous_year_likely_filer_entry");
}
```

**Static thresholds, with documented periodic review.** Earlier in this spec's drafting, a dynamic threshold for `transaction_date` (computed as `currentYear + 2`-01-01) was considered. **Rejected** in favor of the static threshold matching the recount exactly. Reasoning:

- A dynamic threshold makes the shim's flagging behavior **change silently with wall-clock time** — a date that's flagged-anomalous in 2026 becomes un-flagged in 2027 without any code change or review. For a customer-facing interpretation layer, that's the wrong failure mode: response shape would mutate non-deterministically across time, audit traces would diverge, and unit tests pinned at one date would fail later for non-bug reasons (the test's assumption going stale, not the code).
- The static threshold's failure mode is bounded and graceful: a legitimate near-future `transaction_date` (e.g., a 2027 trade in 2026) might receive the `anomalous_year_likely_filer_entry` flag, but the flag's identifier literally carries "likely" — an agent reading it weighs it against context. Soft miss with calibrated language, not silent behavior drift.
- Legitimate `transaction_date` values in the near-future are exceedingly rare. Form 4 reports executed trades on the trade date, not future-dated trades. The dynamic threshold's "safety margin" was protecting against essentially nothing.

**Periodic review cadence (operational discipline):** the static `transaction_date` threshold (currently `>2027-01-01`) should be reviewed at least annually, and bumped when the current year approaches threshold − 2 (i.e., when current year ≥ 2025 + threshold-margin years, but currently safe through end of 2026). When bumped, the new value should be at least 3 years forward (e.g., bump `>2027-01-01` → `>2030-01-01`), the change shipped via a small commit, and the battle-test pass run to confirm no existing query shape regresses.

**Why exercise/expiration thresholds stay at `>2050-01-01`:** these are forward-looking fields where long-dated options legitimately exist. The 2050 boundary was validated by the recount as the appropriate upper limit for the field semantics. No periodic-review needed — the threshold is not time-relative; it's set against the longest plausible option horizon.

**Why ancient floor stays static at 1990:** electronic filing predates 1990 only marginally; `<1990` is a true universally-bad-year signal that doesn't drift with calendar time. No review needed.

**No flag for clean rows.** When neither Step 1 nor Step 2 fires on any field, the row receives NO `source_metadata` field. See Q5.

### Q4 — Flag shape (unified namespace, arrays per field)

**Resolution:** One top-level field per row: `source_metadata`, an object keyed by field name, with an array of flag strings per field.

```typescript
type SourceMetadataFlags = {
  [fieldName: string]: SourceMetadataFlag[];
};

type SourceMetadataFlag =
  // Phase 2b initial — active in shipped implementation:
  | "sec_perpetual_sentinel"                  // assertive (Q3 Step 1)
  | "anomalous_year_likely_filer_entry"       // calibrated (Q3 Step 2)
  // Phase 2b extension — designed for, not active in initial ship:
  | "missing_required_field"                  // covers 6 insider_trades rows w/ no filing_date
  | "anomalous_year_likely_filer_entry";      // also applies to period_of_report (142 rows)
```

**Example serialized rows:**

Sentinel row (e.g., DSU exercise/expiration):
```json
{
  "ticker": "...",
  "transaction_date": "2006-01-04",
  "exercise_date": "2050-12-31",
  "expiration_date": "2050-12-31",
  "source_metadata": {
    "exercise_date": ["sec_perpetual_sentinel"],
    "expiration_date": ["sec_perpetual_sentinel"]
  }
}
```

Filer-entry anomalous-year row (e.g., 2014 amendment of 2012 event):
```json
{
  "ticker": "...",
  "transaction_date": "0012-11-21",
  "exercise_date": "0012-11-21",
  "expiration_date": "0017-11-21",
  "filing_date": "2014-03-21",
  "source_metadata": {
    "transaction_date": ["anomalous_year_likely_filer_entry"],
    "exercise_date": ["anomalous_year_likely_filer_entry"],
    "expiration_date": ["anomalous_year_likely_filer_entry"]
  }
}
```

**Exact flag strings (registered now in this design, for stability):**

| Flag string | Confidence register | Trigger | Phase 2b initial? |
|---|---|---|---|
| `sec_perpetual_sentinel` | Assertive (fact about SEC's schema) | Exact-string match on listed sentinel values (Q3 Step 1) | ✅ active |
| `anomalous_year_likely_filer_entry` | Calibrated (likely cause; observed pattern) | Field-aware out-of-range year (Q3 Step 2) | ✅ active |
| `missing_required_field` | Calibrated (observed absence) | Field is null/undefined where the schema expects it (e.g., 6 insider_trades rows) | ❌ designed; not active |

**The "likely" calibration carries into the flag value itself**, satisfying Greg's two-register requirement. An agent reading the flag string sees the confidence level without needing to cross-reference the tool description.

**Arrays per field, not single-flag-per-field:** future-proof against the case where one field carries multiple flags simultaneously (e.g., an anomalous-year row in a corner case that also has another SEC-source quirk). Today this is rare; arrays cost ~3 bytes per row when only one flag fires.

**One unified `source_metadata` namespace, not per-field top-level booleans:** avoids field proliferation as more patterns ship. With 3 candidate patterns active and 2+ more designed-for, top-level booleans would add ~6 fields to most rows; the unified namespace adds zero fields to clean rows (per Q5) and one nested object to flagged rows.

### Q5 — Empty-metadata behavior

**Resolution:** When no flag fires on any field of a row, the row has NO `source_metadata` field at all. Not `source_metadata: {}`, not `source_metadata: null` — the field is omitted entirely.

**Rationale:**

- **Presence is a signal.** An agent receiving 50 rows where 47 have no `source_metadata` field and 3 do can instantly identify which rows need interpretive attention. If every row carried an empty object, the signal would be lost in noise.
- **Response-size reduction (~99%).** ~99% of `insider_transactions_v2` rows are clean (the ~30K-anomalous-out-of-~10M-row ratio). Empty `source_metadata` objects would add ~25 bytes × 99% of rows for no value. Skipping the field on clean rows saves ~25 bytes per clean row — substantial across millions of agent responses.
- **JSON-natural shape.** Agents iterating responses with `if (row.source_metadata) { ... }` get clean semantics. No need for `if (row.source_metadata && Object.keys(row.source_metadata).length > 0) { ... }`.

**Implementation note:** the utility's signature returns `T | (T & { source_metadata: SourceMetadataFlags })` — discriminated by presence of the field, not by emptiness of the object.

### Q6 — Both `data_source` paths

**Resolution:** Shim INFRASTRUCTURE runs on both paths (`bulk_v2` → `insider_transactions_v2` AND `legacy` → `insider_trades`). Both branch handlers call the same `annotateRowsSourceMetadata(results)` utility.

**Active rules in Phase 2b initial ship:**

| Path | Active rules | Expected flag prevalence |
|---|---|---|
| `bulk_v2` (`insider_transactions_v2`) | Step 1 sentinel + Step 2 anomalous-year, on `transaction_date` / `exercise_date` / `expiration_date` | ~183 sentinel-flagged rows + ~29,400 anomalous-year-flagged rows (≈ 0.3% of the ~10M row collection) |
| `legacy` (`insider_trades`) | Step 1 sentinel + Step 2 anomalous-year, same fields | Smaller absolute counts (legacy collection is ~91% smaller); same proportional behavior |

**The 6 missing-`filing_date` rows in `insider_trades`** are a separate detection rule (`missing_required_field`) that is **designed-for but not built** in Phase 2b initial. The rule would fire when `filing_date` is null/undefined/empty on a row where the schema expects it. The 6 rows would receive `source_metadata: { filing_date: ["missing_required_field"] }`. This rule's implementation is a small follow-on and can land in a Phase 2b.1 follow-up commit, but is not part of the initial 2b ship — keeps the initial implementation scope crisp.

**Decision: uniform coverage of both paths, even though prevalence is asymmetric.** Reasons:

- An agent calling `get_insider_transactions(data_source: 'legacy')` and receiving rows with 2050-12-31 expiration dates expects the same interpretive help as the bulk_v2 caller.
- Code path symmetry — both branches call the same utility — is simpler than gating the shim by `data_source`.
- Future SEC-source quirks may appear in either collection; uniform coverage means the shim is ready.

### Q7 — Inline-on-row + backward-compat

**Resolution:** Inline on each row (`{...row, source_metadata: {...}}`), additive, optional, fully backward-compatible.

**Inline-on-row shape (chosen) vs. parallel-array shape (rejected):**

Inline (chosen):
```json
{
  "results": [
    { "ticker": "...", "transaction_date": "2024-01-01", ... },
    { "ticker": "...", "transaction_date": "0012-02-17", ..., "source_metadata": { ... } }
  ]
}
```

Parallel (rejected):
```json
{
  "results": [ {...}, {...} ],
  "source_metadata": [ null, { "transaction_date": [...] } ]
}
```

**Why inline:** agents reading a row find the interpretation directly on the row, not via index lookup into a parallel array. Parallel-array shape requires extra plumbing to correlate; inline is the agent-natural form. The cost (slightly larger row when flagged) is offset by Q5's "omit on clean rows" rule.

**Backward-compatibility assertion:** the shim adds a new optional field; existing tool consumers that don't look for `source_metadata` continue working unchanged. The `InsiderTransactionsEnvelope` and `InsiderTransactionsV2CompatEnvelope` types in `src/types.ts` get a new optional `source_metadata?: SourceMetadataFlags` field added to the row interface; existing fields and the envelope shape are unchanged.

**Battle-test plan (mandatory before merge-and-deploy):** post-implementation, run `scripts/battle-test.ts` (or the equivalent verified-coverage harness). Pass condition: all existing query shapes return 200 with the response shape they returned before; new field `source_metadata` appears only on rows where the detection rules fire. No existing consumer breaks.

---

## Extension shape for parked cases (designed for, not built in initial 2b)

Two cases parked from earlier in the arc remain pending. The shim namespace must hold them cleanly when Phase 2b.1 or a later session ships them:

**142 `period_of_report` corruptions in `insider_transactions_v2`:**

- Same anomalous-year pattern observed on a different date field.
- Detection rule: apply Q3 Step 2 (ancient floor + appropriate future threshold for `period_of_report`) to that field.
- Flag: same `anomalous_year_likely_filer_entry` string, on the `period_of_report` key in the `source_metadata` object.
- Namespace impact: zero — the unified per-field-arrays shape (Q4) already accommodates a new field key without schema change.

**6 missing-`filing_date` rows in `insider_trades`:**

- Different category: not a value-corruption but a field-absence.
- Detection rule: `filing_date == null || filing_date === ""` on rows where the schema expects it.
- Flag: `missing_required_field`, on the `filing_date` key in `source_metadata`.
- Namespace impact: zero — same shape, different flag value (already in the type union in Q4).

**Net:** the design accommodates both parked cases without any namespace change. Both are small one-liner additions to the detection ruleset.

---

## Implementation outline (for the next session — NOT for this session)

When implementation is authorized in a future session, the work shape is:

1. **Create `src/source-metadata.ts`** with the NO-WRITE ATTESTATION header (mirror the dry-run + spot-check scripts' attestation block), the `SourceMetadataFlags` type, `SourceMetadataFlag` union, `SENTINEL_STRINGS` set, `ANCIENT_FLOOR` constant, `futureThreshold` function, and the exported `annotateRowsSourceMetadata<T>(rows: T[]): T[]` utility. ~120 lines.

2. **Add `source_metadata?: SourceMetadataFlags` field** to the row interfaces in `src/types.ts` (`InsiderTransaction`, `InsiderTransactionV2`, or whichever exact type names the rows use). Optional, additive only.

3. **Two one-line calls** in `src/tools/insider-transactions.ts`:
   - In `handleV2`: `const annotatedResults = annotateRowsSourceMetadata(filteredResults);` right before the return statement, replacing `results: filteredResults` with `results: annotatedResults` in the envelope.
   - In `handleLegacy`: same pattern.

4. **Unit tests at `tests/source-metadata.test.ts`** (or the project's test convention — verify the test framework / location at implementation time):
   - Sentinel row (2050-12-31) → expected flag fires, anomalous-year does not.
   - 00XX year row → anomalous-year fires, no sentinel.
   - 203X year row on transaction_date → anomalous-year fires.
   - Clean row → no source_metadata field at all.
   - Multi-field corrupt row → multiple field keys present.
   - 2050-but-not-sentinel-string (hypothetical, e.g., `2050-06-15`) → falls through to Step 2, gets anomalous-year flag.
   - Boundary cases at the dynamic threshold (year exactly = currentYear + 1) → no flag (boundary inclusive).

5. **Mechanical no-write attestation grep** at the implementation file before commit (same as the dry-run script's pre-commit check).

6. **Battle-test pass** confirming the existing 21 tools + all query shapes still return their existing response shapes; `source_metadata` appears only on rows where detection rules fire.

7. **Tool-description follow-on edit** in `src/tools/insider-transactions.ts`: add a single paragraph after the existing SEC-CONVENTIONS section noting that tool responses include a `source_metadata` field on rows where these patterns are detected. (This is the docs update that 2a deliberately deferred so 2a wouldn't promise a behavior that didn't exist.)

8. **Commit + push the batched 2a + 2b together** — single deploy moment for the documentation + the machine-readable flag.

**Estimated implementation effort:** ~1.5 hours focused work. Bulk is the unit tests; the shim logic itself is ~30 minutes.

---

## What this spec deliberately does NOT decide

- **Whether other tools should adopt `source_metadata` for their own SEC-source quirks.** Possible (the top-level path supports it), but each tool's adoption is its own design pass.
- **Whether the 142 `period_of_report` rows or the 6 missing-`filing_date` rows get their rules in Phase 2b initial vs. 2b.1.** Both are designed-for; the activation order is a separate scoping decision.
- **Positioning copy referencing `source_metadata`.** That belongs in Phase 2c — written off this design once it's locked, ideally after the shim ships so the positioning text references real shipped behavior.
- **Memory file mirroring the v4 standing-protection text.** Phase 2d. Independent of this spec.

---

## Approval gate

This is a design spec, not implementation. The "stage-and-show, hold for word" cycle applies to this document:

1. Code drafts (this file).
2. Greg eyeballs the design choices — especially Q3's two-step precedence, Q4's flag-string registration, Q5's omit-on-clean rule, Q6's both-paths coverage, and the dynamic threshold trade-off in Q3.
3. On approval: this spec is committed (small commit, single doc file) so the design is locked in version control. Implementation is a separate session with this spec as the input.
4. On revision: spec is iterated until approved.

**No code is drafted in this session.** No `src/source-metadata.ts`. No changes to `src/tools/insider-transactions.ts` beyond Phase 2a (already committed in `c4c1192`). No changes to `src/types.ts`.

**Standing locks all intact:**

- Phase B / `heal-worker.ts` — LOCKED
- Backfill / reconstruction — permanently CLOSED
- Re-ingest — NOT authorized
- CIK swap — NOT authorized
- Axis-7 fix — NOT authorized
- Orphan cleanup — NOT authorized
- 142 `period_of_report` + 6 missing-`filing_date` rows — parked (design accommodates; implementation deferred)
