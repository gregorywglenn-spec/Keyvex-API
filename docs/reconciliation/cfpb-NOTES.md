# CFPB consumer complaints — reconcile finding (2026-06-10)

**Verdict: structural scope gap, not a leak bug.** The collection is a ~8-13%
sample of recent days and 0% of anything older than the cron's rolling window.
The fix is a scope/cost decision (Greg's call), tracked in SWEEP-STATUS.

## The numbers (probe: `.tmp/cfpb-window-probe.ts`, run 2026-06-10)

Collection total: **38,604** docs.

| date_received | CFPB API count | KeyVex count |
|---|---|---|
| 2026-06-08 | 15,374 | 2,028 |
| 2026-06-05 | 17,755 | 2,066 |
| 2026-06-01 | 22,241 | 738 |
| 2026-05-20 | 27,508 | **0** |
| 2026-05-01 | 26,622 | **0** |

Verify any row yourself: `https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/?size=1&date_received_min=2026-05-20&date_received_max=2026-05-20`
(the `hits.total.value` field) vs `get_consumer_complaints(since/until)`.

## Why it happens (three compounding causes)

1. **The cron caps at 2,000/run** (`maxRecords` default) against ~15-27K
   complaints received per day — captures ≤13% of even its own window.
2. **The window is 2 days and never revisits.** CFPB publishes complaints
   days-to-weeks AFTER receipt (company-response redaction period), so a
   received-day's published count GROWS for weeks. A 2-day window forever
   misses everything published later — and anything received before the
   cron's first run simply doesn't exist in KeyVex.
3. **ES paging limit:** the search API's `frm`+`size` paging caps around 10K
   per query — even an uncapped cron can't page through a 15-27K day without
   sub-day windows. Raising the cap alone cannot reach capture-all.

## Why this matters for the tool surface

`get_consumer_complaints` recommends itself for "complaint volume against a
specific company" — volume answers from a 13%-of-recent-days sample are
systematically wrong (and silently so). The description's "v1A scope: rolling
N-most-recent window" note under-communicates this. Patched 2026-06-10 to say
explicitly: sample, NOT volume-safe, follow cfpb_source_url for true counts.

## The fix options (decision needed — cost + scope)

- **A (capture-all, recommended): bulk-CSV ingestion.** CFPB publishes the
  complete complaint database (~5M rows) as a daily-refreshed CSV download.
  One-time ~5M Firestore writes + ~5GB storage, then a daily delta. This is
  the only path to honest volume answers. Own session (new ingestion path +
  cost sign-off).
- **B (partial): uncapped windowed cron with sub-day windows + a ~45-day
  revisit horizon for publication lag.** ~300-800K docs/month ongoing; still
  not history. Strictly worse than A per dollar.
- **C (status quo, now honest): keep the sample; tool description rewritten
  to forbid volume conclusions.** Done 2026-06-10 as the interim state.

## Status

- Audited 2026-06-10; finding documented; tool description honesty-patched
  (+ mcp redeploy); fix gated on Greg's A/B/C decision.
