# NEXT SESSION — start here, do only this

You (the fresh session) are locked to this. Do not drift, do not expand scope.

## Read first, in order
1. `docs/KEYVEX-QUALITY-BENCHMARK.md` — the target (≥98% complete + correct vs the
   government source, ALL transaction types buy/sell/exchange, beat competitors).
2. `docs/KEYVEX-DATA-INVENTORY.md` — where we are. **0 of 39 datasets are verified.**
3. `docs/KEYVEX-RECONCILIATION-SYSTEM.md` — the method (one framework, every dataset
   reconciled identically + continuously).

## The goal (Greg's words)
Every congressional trade in KeyVex, correctly parsed, with ongoing updates correctly
parsed — then the same standard across all ~39 datasets. Verified by Greg clicking the
government's own records, never asserted by the AI.

## The ONLY task this session
Build the **reconciliation framework + the Congress (House) adapter** from the
RECONCILIATION-SYSTEM doc. Deliver **gauge G1 for Congress**: a report Greg runs that
lists every PTR the House Clerk index has that KeyVex is missing — each with a
**clickable source link** and **per-type counts (buy / sell / exchange)** so a whole
type can't read zero unseen. Then STOP and show Greg.

## Hard rules
- **The builder is never the grader.** Output something Greg verifies by clicking
  links — do not report a coverage number as fact he must trust.
- **Do not claim anything "verified"** until Greg confirms it himself.
- **No silent exclusions** — exchanges are trades; nothing gets dropped without it
  being a surfaced, documented decision.
- **One dataset at a time.** Congress first. Do not touch others this session.
- **No drift.** If the conversation wanders, point back to this file. If you finish
  G1, stop — don't start G2 or another dataset without Greg.

## Known issues already found (do NOT chase this session — the system will handle them)
- `insider_transactions_v2` (flagship, 9.9M rows) is **69 days stale** — stopped
  updating 2026-03-31. Likely a broken cron.
- `federal_contracts` (~5 weeks of history) and `federal_grants` (~1 month) are
  **truncated** — missing years.
- ~18 datasets have no recognized date field — couldn't even be temporally assessed.

These are logged. The reconciliation framework is what finds and fixes this class of
thing on a schedule, which is why it comes first.
