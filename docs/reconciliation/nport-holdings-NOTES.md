# N-PORT holdings — era reconcile (2026-06-13) — CLOSED

**Verdict: era coverage 6,726 / 6,727 = 99.99%; the single non-extracted
filing is a fully-classified source-side edge case (HTML-only exhibit),
marked terminal so the backlog is a true 0. Holdings extraction for the
era (filings since 2026-05-12, when row-level extraction shipped) is
complete.**

## The number

`scripts/_verify-nport-era-coverage.ts` (artifact:
`nport-holdings-era-coverage.txt`): every N-PORT filing filed since
2026-05-12 vs. whether it has >=1 extracted holding row, by file-date.
**6,726 of 6,727 filings have holdings rows.** Every day is fully covered
except one filing on 2026-05-29.

## The one gap — classified, not hidden

`0001099263-26-007320` — **PIMCO ETF Trust, series PCPI (PIMCO Inflation
PLUS Active ETF)**, NPORT-P, period 2026-03-31, filed 2026-05-29.
- Its `primary_doc.xml` is a 5,978-byte cover page with **zero
  `<invstOrSec>` blocks**. The portfolio is only in a **42 MB
  `pimcoetftrust.htm` NPORT-EX exhibit** — rendered HTML tables, not
  structured data. No structured-XML parser can read it.
- **It's a pre-launch seed filing**: PCPI began trading on Nasdaq
  2026-04-02; this N-PORT covers 2026-03-31, *before launch*. totAssets
  20M (seed capital). Little meaningful portfolio exists for the period.
- **Verified one-off**: 174 of 175 era PIMCO filings parse cleanly; only
  this one is HTML-only.
- **Not a competitive gap**: Quiver Quantitative (checked live in an
  authenticated session, 2026-06-13) exposes NO ETF N-PORT portfolio at
  all — its PCPI page is a security view (price + who-holds-PCPI +
  TradingView-embedded financials), the reverse of N-PORT. KeyVex's
  `get_fund_holdings` is a capability Quiver lacks; the one filing we
  can't parse is data nobody surfaces.

## Disposition

- **Marked terminal** (`holdings_extraction_status: "no_structured_holdings"`
  on the nport_filings doc) so the healing backlog finder skips it — the
  cron no longer re-fetches the 42 MB exhibit every run, and backlog is a
  true 0. Same pattern handles any future genuine-nil / HTML-only filing
  automatically.
- **HTML-exhibit parser: SHELVED.** Building brittle 42 MB trust-wide-HTML
  table parsing to recover a pre-launch seed fund's holdings — for data a
  one-off filing carries and no competitor exposes — is not worth it.
  Revisit ONLY if the marker count shows HTML-only N-PORTs clustering
  (query nport_filings where holdings_extraction_status ==
  "no_structured_holdings"). Today: 1.

## The saga (fixes that got the era to 99.99%)

The era drain surfaced a cluster of scale bugs, all fixed + deployed:
NPORT-EX exhibit-URL derivation; Firestore cursor-projection on the
streaming diff; push-spread stack overflow on mega-fund arrays; 429
retry+backoff; 60s fetch abort-timeout; period-floor diff bug (amendment
churn); per-filing streaming SAVE (heap OOM on accumulate); streaming the
backlog DIFF (1.2M-row snapshot OOM); cron slot move off the crowded SEC
window. Detail in commit history + SWEEP-STATUS.
