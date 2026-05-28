# Phase 2b Extension — period_of_report Annotation — DESIGN

**Status:** Extension to Phase 2b (shim commit 22db470, parent design spec
c95364c). Activates the period_of_report coverage that the original Phase 2b
spec designed-for in its "Extension shape for parked cases" section, and
retires the missing_required_field rule's canonical first-use-case as
not-applicable.

**Pairs with:** docs/phase-2b-read-time-shim-design.md (the parent design,
which this extension does NOT revise — see "Honesty over polish" below).

---

## Standing Protection #1 — verified upstream source before activation

This extension was authorized only after verifying the 142-row period_of_report
population against the authoritative SEC source via full distinct-value
enumeration, AND verifying the legacy InsiderTransaction schema declaration
before activating the missing_required_field rule against the 6-row "missing
filing_date" framing.

The investigation surfaced three findings:

1. **Confirmation.** The anomalous-year pattern holds on period_of_report
   exactly as it holds on transaction_date. Activation is one DETECT_FIELDS
   entry and one FUTURE_THRESHOLDS entry, with no new flag type, no new
   function, and no type-side change.

2. **Filing-agent correlation.** The 0001-01-01 sub-population (the dominant
   cluster in the 142) traces to a single filing-agent intermediary across
   20 accessions / 12 tickers / decade-plus of filings. Not independent
   typos coincidentally landing on Unix epoch; one upstream toolchain's
   default-on-bad-input behavior. Sharpens the cause-attribution materially.
   See "Pattern shapes" below.

3. **Dissolution.** The missing_required_field rule's canonical first-use-
   case doesn't survive inspection. See "missing_required_field — first-
   use-case dissolved" below.

Standing Protection #1 receipts for this commit — including the structural
recognition that ended the iteration cycle — are documented in the "Three
Standing Protection #1 receipts" section below.

---

## Population characterization — the 142 period_of_report rows

**Source:** insider_transactions_v2 collection. Diagnostics at
`.tmp/sample-parked-rows.ts` (accession contribution), `.tmp/epoch-
subpopulation.ts` (distinct-value enumeration), and `.tmp/singleton-
enum.ts` (singleton classification). All read-only, idempotent, untracked.

**Headline numbers:**

```
Total corrupt rows (deduped):              142
  past-side (period < 1990):               141
  future-side (period > 2027):               1
Distinct accessions contributing:           49
Mean rows per accession:                    2.90
```

The 141/1 past/future split is load-bearing for the FUTURE_THRESHOLDS
value choice — it validates `period_of_report: "2027-01-01"` against the
data shape; 141 past-side rows are caught by the universal ANCIENT_FLOOR
regardless of threshold, and the single future-side row sits cleanly
beyond the chosen value.

**Top-5 accession contributors by row count (navigational aid):**

```
rows  ticker  company
----  ------  -----------------------------------
  16  FICO    FAIR ISAAC CORP
  13  NLCI    NATIONAL CINEMEDIA, INC.
  10  VBTX    VERITEX HOLDINGS, INC.
   8  DOOR    MASONITE INTERNATIONAL CORP
   7  UPS     UNITED PARCEL SERVICE INC
```

Accession IDs and per-row details (transaction_date, reporting_owner_name,
filing_date, etc.) available in `.tmp/sample-parked-rows.ts` output. The
top-5 ranks by single-accession row count and is offered as a navigational
aid only — not a claim about per-accession-dominant period_of_report
values, since the cluster diagnostic doesn't enumerate per-accession-per-
value distribution.

---

## Pattern shapes — three cause-classes plus one outlier

The 142 rows carry three structural cause-classes plus one future-side
outlier. Per-class row counts are preserved in the diagnostic outputs
rather than the spec, since the rule fires uniformly across all 142 rows
and per-class counts don't drive any code path or any agent-readable
distinction.

### Class 1 — SEC filing-agent default-epoch (architectural finding)

`period_of_report = "0001-01-01"` exactly. All contributing accessions
share the filing-agent CIK prefix `0001225208-`. Filings span a decade-
plus across 12 ticker companies (UPS, APD, BR, ICFI, PCMI, MSA, PEG, SCG,
IFF, BBDC, WY, MPV). This is not independent filer typos coincidentally
landing on the same Unix-epoch-shaped value — it's a single upstream
filing-agent intermediary's toolchain substituting `0001-01-01` for
missing/invalid period_of_report when assembling Form 4/5 XML for EDGAR
submission across its decade-long client base.

The correlation is the load-bearing finding from the diagnostic. The
"SEC default-on-bad-input epoch" language carries forward, but with the
cause attribution refined from "system-side, unspecified" to "specific
upstream intermediary's toolchain." The filing-agent's identity (the
entity behind CIK 0001225208) isn't named in this spec — resolving the
CIK to its registered name is tangential to the rule's behavior; the
spec stays focused on the data shape rather than naming third parties.

The Class 1 sub-population is the only sub-population the spec
characterizes by enumerated detail. The remaining sub-populations
(Class 2, Class 3, outlier) are characterized structurally only.

### Class 2 — filer-side keying typos

`00XX-XX-XX` face. Clear two-digit-to-four-digit transposition errors
preserved verbatim through SEC's electronic-filing pipeline. Multiple
00XX year-prefixes are represented; the calibrated flag fires uniformly
across all rows in the class.

### Class 3 — 198X-shaped values with indeterminate cause

Year values in the 1980s. Could be legitimate historical filings
retroactively ingested, filer typos that happened to land on plausible
198X dates, or a distinct corruption class not enumerated by per-row
review. The diagnostic did not enumerate cause for this bucket; doing so
would require a separate per-row review and isn't a prerequisite for
activating the rule. The calibrated flag fires honestly via the
universal ANCIENT_FLOOR.

### Future-side outlier

The single future-side row (AETRIUM, 2030-08-26 on a 2010 filing) sits
beyond `FUTURE_THRESHOLDS.period_of_report = "2027-01-01"` and is
correctly flagged. Its existence validates the threshold value choice
against the data shape.

### Per-class counts deliberately omitted

Per-class row counts are preserved in `.tmp/epoch-subpopulation.ts` and
`.tmp/singleton-enum.ts` for any future use-case that requires them. The
spec's omission is deliberate (see Standing Protection #1 receipt #3).
The rule's behavior — flag every row whose period_of_report falls
outside the threshold range — doesn't depend on the split; the
calibrated `anomalous_year_likely_filer_entry` flag carries the same
agent-readable signal across all 142 rows by design.

---

## Architectural framing — mirror of existing rule

The extension is a one-file edit to `src/source-metadata.ts` plus a one-edit
amendment to the tool description in `src/tools/insider-transactions.ts`:

- **DETECT_FIELDS** array: append `"period_of_report"`.
- **FUTURE_THRESHOLDS** map: add `period_of_report: "2027-01-01"` (same
  threshold as transaction_date; same semantic — near-past calendar date,
  not a long-dated future). The data confirms: catches the 1 future-side
  AETRIUM row; the 141 ancient-side rows are caught by the universal
  ANCIENT_FLOOR. Review cadence inherits transaction_date's annual schedule.
- **SENTINEL_FIELDS**: documentation-only update. period_of_report is NOT
  added — 0 of 142 anomalous rows carry the sentinel shape; period_of_report
  is a reporting-period date, not a derivative expiration. Comment documents
  the non-membership preemptively.
- **AnnotableRow** type: append `period_of_report?: string | null`.
- **JSDoc and code-comment housekeeping**: strip "designed-for, not active
  in initial ship" staging language from the SourceMetadataFlag union doc
  and the DETECT_FIELDS block comment; replace with "Coverage history" and
  active-state field listings. Three cause-classes documented structurally
  in the SourceMetadataFlag JSDoc; per-class row counts deliberately
  omitted.

**No new flag type.** No new function. No type-side change to
`InsiderTransaction` or `InsiderTransactionV2Compat` — `SourceMetadataFlags`
is `Record<string, SourceMetadataFlag[]>` with no field-name allowlist; the
period_of_report key is structurally valid against the existing type.

**No call-site change.** Both `handleV2` and `handleLegacy` already route
through the shared `annotateRowsSourceMetadata` helper (commit 22db470). The
extension's response-shape change flows through automatically.

**Tool-description amendment (one edit in `insider-transactions.ts`).** The
MACHINE-READABLE FLAGS paragraph's rule-description for
anomalous_year_likely_filer_entry expands to name period_of_report as a
covered field and broadens the cause language to "filing-pipeline data
quality issues across the upstream-actor stack" — calibrated identifier
reads honestly against the three-class plus indeterminate-bucket population.

---

## Flag-identifier — kept, not renamed

The flag identifier `anomalous_year_likely_filer_entry` carries "filer_entry"
in its name. The verified population spans broader causes than literal
filer typing — including a filing-agent intermediary's toolchain default
and an indeterminate-cause 198X bucket. The identifier nevertheless ships
unchanged:

- The calibrated "likely" already carries attribution ambiguity. An agent
  reading the flag understands it as pattern-attribution, not certified
  cause.
- Renaming would be a breaking response-shape change for existing consumers
  of the Phase 2b initial ship (commit 22db470).
- The agent-visible benefit of renaming is zero; the agent-visible cost is
  every consumer needing to update their flag-string matching.
- The JSDoc and the tool-description prose carry the broadened coverage in
  the surfaces where humans read; the identifier carries the calibration in
  the surface where agents read.

"filer_entry" is read in this spec and in the shim's JSDoc as shorthand for
"filing-pipeline data quality issue covering filer typos, filing-agent
intermediary toolchain defaults, indeterminate-cause clusters, and any
other case where the year falls outside any plausible range."

---

## missing_required_field — first-use-case dissolved

The parent Phase 2b spec (c95364c, "Extension shape for parked cases")
anticipated activating the missing_required_field rule against 6
insider_trades rows characterized as "rows with no filing_date." On
inspection, this population doesn't survive its framing.

**Finding.** All 6 rows have `disclosure_date` populated. The legacy
`InsiderTransaction` interface in `src/types.ts:66+` does not declare a
`filing_date` field at all — the legacy schema uses `disclosure_date` for
the filing-date concept. The "missing filing_date" framing carried from a
dry-run anchor check that expected the V2 field name on legacy rows. There
is no semantic field absence on these 6 rows; there is a field-naming
difference between V2 and legacy that the dry-run check didn't account for.

**Cross-confirmation.** All 6 rows ALSO have anomalous-year `transaction_
date` values (0023-06-23, 0024-10-02, 0025-07-25, 2034-10-30, etc.). They
are already flagged by the existing `anomalous_year_likely_filer_entry`
rule on transaction_date in the shipped Phase 2b shim (commit 22db470).
The rows are not unflagged in production; they're flagged on the field
that actually carries the anomaly.

**Disposition.** `missing_required_field` stays in the `SourceMetadataFlag`
union as designed-for-not-built. The rule is reserved for future
populations where the schema declares a field as required and the field
is empirically absent. Activating it against the 6-row population would
either be a no-op (if the rule checks the V2 field name against legacy
rows that don't declare it) or a false-positive flood (if it relaxes to
"any row missing any V2 field"). The honest move is non-activation; the
rule remains a usefully designed slot for a future actually-applicable
population.

---

## Tests added (extending `tests/source-metadata.test.ts`)

Seven new tests pin the extension's behavior. Each named for the property
it pins. Written in the parent test file's convention: flat `test()` calls
with `node:assert/strict` (established by commit 22db470 for Phase 2b initial).

1. **Ancient-side period_of_report flagging** — representative of Class 2.
   Row with `period_of_report = "0019-08-30"` (00XX-XX-XX face) emits
   `source_metadata: { period_of_report: ["anomalous_year_likely_filer_entry"] }`.
2. **Future-side period_of_report flagging** — outlier. Row with
   `period_of_report = "2030-08-26"` (AETRIUM pattern) emits the same flag.
3. **SEC filing-agent default-epoch case** — representative of Class 1. Row
   with `period_of_report = "0001-01-01"` and clean transaction_date emits
   the same flag on period_of_report alone. Proves the calibrated flag
   covers the three-class population under one banner by design.
4. **Boundary case: `period_of_report = "1990-01-01"`** — in-bounds (not
   flagged). Pins the strict-less-than semantics for the new field.
5. **Boundary case: `period_of_report = "2027-01-01"`** — in-bounds (not
   flagged). Pins the strict-greater-than semantics on the future side.
6. **Q5 preservation: clean row with `period_of_report = "2024-03-15"`** —
   no `source_metadata` field at all, returned by reference. Preserves the
   omit-on-clean rule and the no-allocation path with the new field present.
7. **Per-field flag isolation: period_of_report anomalous, transaction_date
   clean** — source_metadata keyed solely on period_of_report. Pins that
   the new field is independently detected, not implicitly tied to
   transaction_date.

---

## What this extension does not decide

- **Cause-attribution for the 198X-shaped rows (or any other per-class
  enumeration).** Indeterminate by design in this commit; per-class row
  counts and singleton enumeration preserved in `.tmp/` diagnostics if a
  future use-case requires them.
- **Filing-agent identity resolution.** CIK 0001225208 is named by prefix;
  resolving it to its registered intermediary name is tangential to the
  rule's behavior. If a future investigation needs the name, it's a public
  EDGAR lookup away.
- **Activation of `missing_required_field` against a different population.**
  A future actually-applicable population gets its own design pass.
- **Coverage of other date fields** (`filing_date` as a value, derivative-
  or-non-derivative date associations, etc.) beyond the four now in
  `DETECT_FIELDS`. New fields land via new design passes.
- **Renaming the `anomalous_year_likely_filer_entry` flag.** Kept for
  backward-compat; calibrated "likely" carries the attribution ambiguity;
  prose surfaces carry the broadened coverage.

---

## Honesty over polish — the parent spec stays unrevised

The parent design (c95364c) carries two small drafting artifacts:
- A duplicate entry in the Q4 type union (`anomalous_year_likely_filer_
  entry` listed twice — doc-side typo only; TypeScript would dedupe).
- A reference to "dynamic threshold" boundary tests in step 4 of the
  implementation outline (draft phrasing from the rejected dynamic-
  threshold approach; Q3 was revised to static thresholds before commit).

Both are documented as reconciliation notes A and B in the shim source's
file-level docstring (commit 22db470). The parent spec is not revised by
this extension. The extension references the parent as it was committed;
the rendering-into-code is the source of truth for any disagreement
between spec and implementation. A future-reader can trace the lineage
without confusion: parent spec describes the design at the moment of
design-lock; shim source describes the design at the moment of build;
this extension describes what changed and what dissolved on the way
through.

---

## Three Standing Protection #1 receipts in this commit

1. **Filing-agent finding.** The initial draft of this design carried a
   "7 rows / 2 accessions / UPS+APD" characterization of the SEC-default-
   epoch sub-population — inherited from prior turn commentary without
   source verification. The diagnostic revised it to 20 accessions / 12
   tickers / single-filing-agent-CIK-correlation. The architectural
   finding (filing-agent correlation) had been suppressed entirely by
   the under-counted framing. Standing Protection #1 surfaced both the
   numerical correction and the load-bearing structural finding the
   under-count was hiding.

2. **missing_required_field dissolution.** The 6-row "missing
   filing_date" framing inherited from the dry-run check was
   investigated against the legacy schema declaration; the framing
   dissolved (schema doesn't declare the field), the rule stays
   designed-for-not-built rather than shipping a no-op or false-
   positive-flooding activation.

3. **Population de-specification.** Three review cycles after the
   filing-agent finding landed, the spec carried Class 2 / Class 3 /
   outlier row counts that each required fresh verification on every
   restage. After iteration 5's diagnostic surfaced one more numerical
   correction (72 vs 78 / 28 vs 22), the pattern itself became
   evidence: the population characterization below the architectural-
   finding level wasn't load-bearing for the rule, and its surface area
   was generating verification cost without corresponding decision
   value. The non-load-bearing specifics were removed from the spec
   rather than enumerated to a higher precision. Diagnostic outputs
   preserved in `.tmp/` for any future use-case requiring per-class
   counts. The third receipt is the protection's second-order value
   paying out — revealing which claims aren't worth shipping at all,
   not just which claims are wrong.

Pattern across the three receipts: every restage surfaced an
under-verified detail until the spec recognized that the paragraph
itself wanted to be smaller. Cost: three diagnostic scripts and one
structural revision. Value: a spec that ships only what's load-bearing
for the rule's design, with population-characterization detail
preserved in diagnostic outputs that can be queried on demand.

---

## Verification

Load-bearing claims in this spec trace to enumerated source evidence:

- **142 total** — `.tmp/sample-parked-rows.ts`
- **141 past / 1 future split** — `.tmp/sample-parked-rows.ts`
- **49 accessions, mean 2.9 rows per accession** — `.tmp/sample-parked-rows.ts`
- **Top-5 accession row counts** — `.tmp/sample-parked-rows.ts`
- **Class 1: 0001-01-01 across 20 accessions sharing CIK prefix
  0001225208-, 12 specific tickers, decade-plus span** — `.tmp/epoch-
  subpopulation.ts`
- **Class 1's UPS row representative for test #3** — `.tmp/sample-
  parked-rows.ts`
- **AETRIUM 2030-08-26 future-side outlier** — `.tmp/epoch-
  subpopulation.ts` + `.tmp/singleton-enum.ts`
- **0 of 142 rows carry the 2050 sentinel shape (SENTINEL_FIELDS non-
  membership)** — `.tmp/epoch-subpopulation.ts`
- **6 insider_trades rows have disclosure_date populated, no filing_
  date in legacy schema** — `src/types.ts:66+` + sample inspection in
  prior turn commentary

Non-load-bearing claims (per-class row counts, singleton enumeration,
clustered-value table, 198X year-range specifics, "likely intended"
Class 2 mappings) are not made in this spec. Diagnostic outputs are
preserved at `.tmp/epoch-subpopulation.ts` and `.tmp/singleton-enum.ts`
for any future use-case requiring per-class counts.

---

## Standing locks — all intact

- Phase B / heal-worker.ts — LOCKED
- Backfill / reconstruction — permanently CLOSED
- Re-ingest — NOT authorized
- CIK swap — NOT authorized
- Axis-7 Issue B (5,000-cap, 30 sites) — PARKED for B3 tokenized-index
  architectural pass
- Orphan cleanup — NOT authorized
- `missing_required_field` rule — designed-for-not-built (this extension
  confirms the status after dissolving the canonical first-use-case)
