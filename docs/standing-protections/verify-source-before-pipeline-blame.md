# Standing Protection: Verify the source before blaming the pipeline

> This is a project-archived copy of a standing protection earned during the v4 count-check arc (2026-05-26). The user-scope memory companion lives outside the repo for cross-session inheritance; this copy lives in the repo for project-history durability — so a future contributor (any Claude session, any human reviewer) opening this codebase cold inherits the lesson from version control, not from one user's memory state.

---

**When data values look wrong, the FIRST question is "what does the upstream source actually contain?" — not "where in our pipeline did we mangle it?"** Pipeline-attribution is the last resort, after the source itself has been ruled out.

## The rule

Before designing remediation for any data-correctness finding — sizing a backfill, gating a fix, drafting a reconstruction — verify the values against their authoritative upstream source. Cached or locally-retained source files are the cheapest first check (one row, one grep, ~30 seconds, zero risk). When source isn't cached, the upstream API or primary filing is the next stop. Pipeline-attribution is the **last** resort, not the first.

This is the data-side companion to the documentation-side verify-facts-don't-assume rule. Same failure mode — building elaborate scaffolding on an unverified premise — applied to different artifacts: docs there, data values here.

## The canonical failure (2026-05-26, v4 count-check arc)

A multi-session investigation arc characterized ~29,400 anomalous date values in `insider_transactions_v2` as "bulk_v2 TSV ingestion path corruption" — a pipeline bug to be reconstructed via a Phase 2 backfill. The arc built a sized blast-radius count, designed a dry-run reconstruction script with field-aware thresholds, captured spot-check evidence the consensus rule would have written 27,639 systematically-wrong forward-field reconstructions, and gated the actual backfill behind a committee review.

The gate caught the catastrophic write. But the deeper failure was upstream of the gate: **the premise that the data was internally corrupted by KeyVex's pipeline was never verified at the root.** A one-row grep of the cached SEC bulk TSV would have refuted the premise on the first day. The grep was finally done at the END of the arc — and the source TSV literally contained `31-DEC-2050` and `17-FEB-0012` as published bytes from SEC. The values weren't corrupted by KeyVex; SEC's primary filings carried them verbatim (perpetual-instrument sentinels + filer data-entry typos). The parser is innocent.

Verification record: commit `93c81d0` (v4 amendment 2 of `docs/handoff-phase-a-v4-count-check-arc-2026-05-25.md`). Spot-check evidence: 19-row stratified sample against SEC primary XML, 22/22 byte-matches. Cost saved by the gate: ~27,639 fabricated-against-source date writes that would have violated KeyVex's pure-publisher posture.

Cost spent before the gate fired: a full multi-session arc's worth of sizing, design, and review. The cheap source-grep — done at the end — would have shortcut the entire arc to "not a pipeline bug; document the source's known quirks."

## The operational mandate

When a data-correctness finding lands, the ordering of investigation is:

1. **Source-first.** What does the authoritative upstream source contain for this row / record / field? Verify directly:
   - If source is cached locally (TSV, JSON, raw scrape) — grep one row. ~30 seconds, zero risk.
   - If source isn't cached — fetch the relevant primary filing / API row. Curl or read.
   - Spot-check a small stratified sample if the population is large; the v4 amendment 2 bound ("strong directional, not a census") is the calibration shape.

2. **Parser/ingestion second.** Only if source has been ruled out does the pipeline become the suspect. Read the parser code; verify the transformation step by step against a known-good input.

3. **Pipeline-attribution third.** Only if both source and parser are confirmed clean does the bug live in the pipeline. Even then, suspect storage/serialization layers (Firestore write-time? Index? Read-side hydration?) before suspecting business logic.

The order matters because the cost-of-wrong-attribution compounds at each step. A backfill designed against an unverified pipeline-bug premise can fabricate against the source. A reconstruction tuned against an unverified parser-bug premise can introduce inconsistencies. Verifying the source first is the cheapest insurance against every downstream mistake.

## When this rule fires

Any time you encounter:

- Values that "look wrong" (out-of-range dates, suspicious magnitudes, missing fields)
- A diagnostic count showing N corrupt records
- A stakeholder saying "the data is broken"
- A finding that motivates a design discussion about remediation

Before sizing the fix, designing the remediation, or naming the cause: **verify against source.** If source contains the value as-stored, the data isn't broken in the pipeline sense; it's a faithful mirror of a quirky source, and remediation lives in interpretation (documentation, read-time annotation), not in rewriting.

## Sibling protections

- **`feedback_verify_facts_dont_assume.md`** (CORE PROTOCOL, lives in user-scope memory outside this repo) — the documentation-side rule. 14-hour OAuth chase cost. Same failure mode applied to docs (paraphrases substituting for primary sources) rather than data (pipeline-blame substituting for source-verification). A reader who wants the docs-side rule should ask the project lead for access to the user-scope memory, or treat this protection as the load-bearing version for repo-internal work.
- **`feedback_verify_inbound_specs.md`** (also user-scope) — verify inbound specs against established state. Same family: verify-before-acting.

## Cost asymmetry

- **Cost of getting this wrong:** multi-session arc of sizing + design + gating. Worst case: a fabrication-against-source backfill ships that destroys the pure-publisher posture KeyVex's brand rests on (the 27,639-row write the v4 arc's gate caught was that worst case).
- **Cost of doing the check:** ~30 seconds. One grep, one row, one byte-comparison.

**Always pay the verification cost. Source-first.**
