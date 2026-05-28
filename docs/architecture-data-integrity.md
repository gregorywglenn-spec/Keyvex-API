# KeyVex Data-Integrity Engine — Architecture Spec

**Status:** Phase A LANDED 2026-05-24 (code only — awaiting Greg's deploy).
**Authority:** This document is the canonical vocabulary spec for data-integrity
fields across KeyVex. Any code/doc/PR that uses these terms must conform to the
definitions below. Drift is a bug.

---

## The doctrine — "The Tourniquet"

> Stop all confident false assertions immediately. If a pipeline lacks the
> historical context or parsing completeness to prove a calculation, it must
> emit an explicit uncertainty state.

Two failure modes the engine prevents:

1. **Silent misclassification.** A charitable gift labeled as a "sell" so a
   naive "how much did X sell" query silently counts it. The engine adds
   `transaction_nature` so the kind-of-event is always explicit.
2. **Phantom inference.** A 13F filing with a partial-fetched current quarter
   labels prior positions as "closed" when they may still exist in unfetched
   rows. The engine guards both the false-"new" case (missing prior baseline)
   and the phantom-"closed" case (current filing failed its count check).

---

## Fixed vocabulary

These exact strings, used everywhere. No variants, no alternates, no synonyms.

### `TransactionNature`

| Value | Meaning |
|---|---|
| `"OPEN_MARKET"` | An open-market or private buy/sell trade. |
| `"EQUITY_COMP"` | Compensation-related equity event (grant, exercise, conversion, ESPP). |
| `"NON_OPEN_MARKET_TRANSFER"` | Gift, tax-payment withholding, disposition to issuer, inheritance, voting-trust transfer, tender disposition — any non-trade structural transfer. |
| `"INSUFFICIENT_DATA"` | Cannot determine nature from available data. |

### `VerificationStatus`

| Value | Meaning |
|---|---|
| `"VERIFIED"` | Filing-level integrity check passed at ingestion (count match for 13F, footnote-ref resolution for Form 4). |
| `"INSUFFICIENT_DATA"` | Check failed OR no canonical landmark available to verify against. |

Phase B will add `"PENDING_HEAL"` / `"FAILED_PERMANENT"` once the self-healing
engine ships. **Not in Phase A scope.**

### `position_change` extension (13F holdings)

Existing values `"new"` / `"increased"` / `"decreased"` / `"unchanged"` /
`"closed"` are preserved. Phase A adds:

| Value | Meaning |
|---|---|
| `"INSUFFICIENT_DATA"` | Prior-quarter baseline missing OR current quarter failed its count check. Never compute a delta from partial state. |

---

## SEC Form 4 transaction-code mapping (locked)

**Source of truth:** SEC 1474 (03-26), OMB 3235-0287, expires August 31 2026.
Form 4 General Transaction Codes, pages 11-12.
PDF: https://www.sec.gov/files/form4.pdf

**Algorithm:** `deriveTransactionNature(trans_code)` reads the trans_code XML
node value ONLY. Never reads the acquired/disposed flag (which has the same
letter values `A`/`D` for entirely unrelated meaning). Compound codes like
`"S/K"` are split — first segment determines the nature.

| Code | SEC verbatim description | Bucket |
|---|---|---|
| **P** | Open market or private purchase of non-derivative or derivative security | `OPEN_MARKET` |
| **S** | Open market or private sale of non-derivative or derivative security | `OPEN_MARKET` |
| **A** | Grant, award or other acquisition pursuant to Rule 16b-3(d) | `EQUITY_COMP` |
| **M** | Exercise or conversion of derivative security exempted pursuant to Rule 16b-3 | `EQUITY_COMP` |
| **I** | Discretionary transaction in accordance with Rule 16b-3(f) — 401(k)/ESPP | `EQUITY_COMP` |
| **C** | Conversion of derivative security | `EQUITY_COMP` (behavioral) |
| **X** | Exercise of in-the-money or at-the-money derivative security | `EQUITY_COMP` (behavioral) |
| **O** | Exercise of out-of-the-money derivative security | `EQUITY_COMP` (behavioral) |
| **D** | Disposition to the issuer of issuer equity securities pursuant to Rule 16b-3(e) | `NON_OPEN_MARKET_TRANSFER` |
| **F** | Payment of exercise price or tax liability by delivering or withholding securities incident to receipt/exercise/vesting under Rule 16b-3 | `NON_OPEN_MARKET_TRANSFER` |
| **G** | Bona fide gift | `NON_OPEN_MARKET_TRANSFER` |
| **W** | Acquisition or disposition by will or the laws of descent and distribution | `NON_OPEN_MARKET_TRANSFER` |
| **Z** | Deposit into or withdrawal from voting trust | `NON_OPEN_MARKET_TRANSFER` |
| **U** | Disposition pursuant to a tender of shares in a change of control transaction | `NON_OPEN_MARKET_TRANSFER` |
| **V** | Transaction voluntarily reported earlier than required (FLAG, not standalone code) | `INSUFFICIENT_DATA` |
| **E** | Expiration of short derivative position | `INSUFFICIENT_DATA` |
| **H** | Expiration (or cancellation) of long derivative position with value received | `INSUFFICIENT_DATA` |
| **L** | Small acquisition under Rule 16a-6 | `INSUFFICIENT_DATA` |
| **J** | Other acquisition or disposition (describe transaction) | `INSUFFICIENT_DATA` |
| **K** | Transaction in equity swap or instrument with similar characteristics (MODIFIER) | `INSUFFICIENT_DATA` |

**Fall-through rule:** any code not in this table — including null, empty
string, lowercase, multi-char beyond compound — → `INSUFFICIENT_DATA`.

### Note on C / X / O — "behavioral-convention" bucketing

These are SEC "Derivative Securities Codes" (NOT Rule 16b-3 codes). They're
bucketed as `EQUITY_COMP` based on the behavioral observation that in insider
Form 4 filings, derivatives being exercised/converted are overwhelmingly
comp-granted. A strict-SEC reading would put them in `INSUFFICIENT_DATA`.

Marked as a candidate for future split into a dedicated `"DERIVATIVE_EXERCISE"`
bucket if/when we want to surface the distinction. Documented in
`src/tools/insider-transactions-v2-shim.ts` at the mapping site.

---

## Congressional PTR mapping

**Separate code path from Form 4.** Congressional PTRs have no regulatory
trans_code field. Detection lives in the free-text `comment` field via regex:

```
/\b(contribution|contributed|gift(?:ed|ing|s)?|donat\w*|charitab\w*)\b/i
```

| Condition | `transaction_nature` |
|---|---|
| `comment` matches the transfer regex | `NON_OPEN_MARKET_TRANSFER` |
| `comment` clean AND `transaction_type` is `"buy"` or `"sell"` | `OPEN_MARKET` |
| `comment` clean AND no recognizable `transaction_type` | `INSUFFICIENT_DATA` |

**Critical:** the existing `transaction_type` field ("buy"/"sell") is NEVER
overwritten. Pelosi's row keeps `transaction_type: "sell"` for back-compat;
`transaction_nature: "NON_OPEN_MARKET_TRANSFER"` is added alongside.

---

## 13F integrity checks

### §1 — Count check (canonical landmark)

Every 13F filing includes a `primary_doc.xml` with a SUMMARY PAGE that declares:

```xml
<infoTableEntryTotal>N</infoTableEntryTotal>
```

This is the AUTHORITATIVE row count for the filing. The loader fetches it
alongside the holdings XML, compares to the parsed-row count, and stamps:

- `verification_status: "VERIFIED"` when parsed count == declared count
- `verification_status: "INSUFFICIENT_DATA"` otherwise (including when
  primary_doc.xml is missing or unparseable — **the no-count rule:** absence
  of landmark NEVER defaults to VERIFIED)

The expected/actual counts are persisted alongside (`verification_expected`,
`verification_actual`) for downstream observability.

### §2 — Phantom-"closed" guard

The position-change calculator only emits synthetic "closed" rows when the
current quarter's filing is `VERIFIED`. If `verification_status` is
`INSUFFICIENT_DATA`:

- NO synthetic "closed" rows are emitted
- All current-quarter holdings get `position_change: "INSUFFICIENT_DATA"`

This prevents the failure mode where a partial-fetched current quarter looks
like a complete fund liquidation.

### §3 — False-"new" guard

When the prior-quarter lookup returns ZERO holdings (either the fund had no
prior filing OR we haven't ingested it), all current-quarter holdings get
`position_change: "INSUFFICIENT_DATA"` — never confidently labeled "new". A
phantom-acquisition narrative is just as misleading as a phantom liquidation.

**Count-check reuse:** the §1 result is stamped on every holding at ingestion
and read back from the first row in `applyPositionChanges`. Computed ONCE
per filing, reused for the §2 guard. Never recomputed.

---

## Form 4 integrity check

Per Greg's §1 spec: parse-integrity validates *internal relational reference
resolution*, NOT filing-level coverage. The bulk loader stamps:

- `verification_status: "VERIFIED"` when every row's footnote IDs successfully
  resolve to known footnote text
- `verification_status: "INSUFFICIENT_DATA"` when any footnote ref resolves
  to the `"(footnote not found)"` sentinel — indicating a dangling FN_ID
  pointer (parser dropped a token, or the FOOTNOTES.tsv was truncated)

Form 4 *filing-level coverage* (whether we have every Form 4 the SEC published
for a quarter) is a separate concern, handled by Gate 8's scraper enumeration
logic.

---

## Aggregation semantic — "honest by default" (v0.52.0)

Both `get_insider_transactions` and `get_congressional_trades` honor the
`include_non_open_market: boolean` parameter. **REFINED 2026-05-24 (v0.52.0)**
after a cold-query verification found EQUITY_COMP rows leaking through into
a default sell query — same Tourniquet disease as the gift-as-sell bug,
different category.

### Behavior matrix

| Caller state | Default | Behavior |
|---|---|---|
| `transaction_type: "buy"\|"sell"` set, no flag | `false` | Keep `OPEN_MARKET` + `INSUFFICIENT_DATA`. **Drop both** `EQUITY_COMP` **and** `NON_OPEN_MARKET_TRANSFER`. A direction query asks for sales/purchases into the market — comp events and transfers don't qualify. |
| `transaction_type` set, flag = `true` | (explicit) | Keep everything (opt-out of the honest default) |
| `transaction_type` set, flag = `false` | (explicit) | Keep `OPEN_MARKET` + `INSUFFICIENT_DATA` (same as default) |
| No `transaction_type`, no flag | `true` | Keep everything (no opinion when no direction is set) |
| No `transaction_type`, flag = `true` | (explicit) | Keep everything (matches default) |
| No `transaction_type`, flag = `false` | (explicit) | Keep `OPEN_MARKET` + `INSUFFICIENT_DATA` (opt-in clean view) |

### INSUFFICIENT_DATA passthrough (the Tourniquet sub-rule)

`INSUFFICIENT_DATA` rows **always pass through the filter, never silently
dropped**, even on the strict `false` setting. Silently dropping unclassified
rows would re-create the bug Phase A was built to fix — at a different layer.

When any `INSUFFICIENT_DATA` rows survive the filter, the response envelope
carries `unclassifiable_records_retained: N` so the agent sees the count
explicitly. Absent when N is zero (no noise on clean result sets).

### Critical invariants

1. The `transaction_type` field on each returned row is NEVER mutated by
   this filter — only whether the row appears at all in the result set.
2. `INSUFFICIENT_DATA` is never the basis for silently dropping a row.
3. The same rule applies symmetrically to `buy` and `sell` directions —
   a grant (code A) is no more an open-market purchase than an RSU
   settlement is an open-market sale.

---

## Storage shapes

### v2 collections (`insider_transactions_v2`)

`transaction_nature?: TransactionNature` (optional — forward-write only for
Phase A; historical rows omit it, the MCP shim derives on-the-fly).

`verification_status?: VerificationStatus` (optional — only set on Phase-A-
ingested rows).

### Legacy collection (`insider_trades`)

Same two optional fields. Historical rows omit, new ingestion writes forward.
The shim/handler re-derives for read-time consistency.

### 13F collection (`institutional_holdings`)

Extended `position_change` enum to include `"INSUFFICIENT_DATA"`, plus three
new fields: `verification_status?`, `verification_expected?`,
`verification_actual?`.

**Critically:** `institutional_holdings` does **NOT** carry `transaction_nature`.
A 13F holding is a position snapshot, not a transaction event — there is no
SEC trans_code on the row and no buy/sell/gift/comp distinction to derive.
The 13F integrity signal lives entirely in `verification_status` +
`position_change="INSUFFICIENT_DATA"`. Any test that expects
`transaction_nature` on a 13F row is mis-targeted.

### Congressional collections (`congressional_trades`)

Same `transaction_nature?` field. No `verification_status` (Phase A doesn't
define a comparable landmark for these — congressional PTRs lack the SEC's
declared-count metadata).

---

## What's NOT in Phase A

- ❌ Historical write-backfill (Option A: forward-write only, shim derives at read time)
- ❌ `sync_queue` Firestore collection — Phase B
- ❌ Self-healing fetcher worker — Phase B
- ❌ Retry budgets / token-bucket rate limiter — Phase B
- ❌ Atomic recomputation after heal — Phase B
- ❌ Any production deploy by this branch — gate explicitly halts after local tests
