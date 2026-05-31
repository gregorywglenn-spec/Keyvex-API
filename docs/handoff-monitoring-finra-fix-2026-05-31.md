# Handoff — Scraper monitoring + FINRA empty-body fix (2026-05-31)

Day-of-week: Sunday. Server v0.44.0. Written for the next AI Claude session so you can
pick up cold without re-deriving any of this.

---

## TL;DR

Two things shipped this stretch, all on `origin/main`:

1. **Fixed a real crash in the FINRA OTC weekly scraper** (`otcMarketWeeklySync`) — it
   died every run because FINRA returns an *empty HTTP body* (not `[]`) when a filter
   matches zero rows, and `res.json()` threw before the existing zero-row guard could
   catch it.
2. **Stood up a two-layer monitoring plan** — an always-on automated health-check
   (already in the cloud) PLUS a new Mon/Wed/Fri Claude-driven review that applies
   judgment a freshness check can't.

Commits pushed (in order): `a334012` → `d893002` → `f885374`.
**NOT yet deployed.** Code is fixed on disk + GitHub; production is still running the old
code. Deploy is gated on Greg's explicit go (see "What's left" at the bottom).

---

## Problem 1 — FINRA OTC scraper crashing every run

### Symptom
`scheduledFinraOtcWeekly` threw `Unexpected end of JSON input` and never wrote a
`/meta/otcMarketWeeklySync` doc — so the health-check correctly showed it as a dead job
("no-meta" = never successfully completed).

### Root cause
In `src/scrapers/finra-otc.ts`, the pagination loop read the `record-total` response
header, then *unconditionally* called `const rows = await res.json()`. FINRA's OTC
Transparency API has a quirk: when a filter matches **zero rows**, it returns an
HTTP 200 with **a completely empty body** — not the `[]` you'd expect. `res.json()` on an
empty body throws `Unexpected end of JSON input`. That throw happened *before* the
existing `if (rows.length === 0) break;` guard could ever run, so the whole weekly run
crashed.

This is the **common case for recent weeks**: FINRA publishes OTC data on a lag, so a
scraper asking for "last week" often hits a filter that legitimately has zero rows
published yet. A normal "no data" was being treated as a fatal error.

### Fix (commit `f885374`)
Two defensive changes in the pagination loop:
- **Early bail:** after reading the `record-total` header on page 0, `break` immediately
  if it's `0` — don't even attempt to parse an empty body. Log it as a normal skip.
- **Defensive parse:** replaced `await res.json()` with `await res.text()` + an
  empty-string check + a `try/catch` around `JSON.parse`. Any short/empty/unparseable
  body now ends pagination cleanly instead of throwing and killing the run.

Note the variable name: the request payload is already called `body` in that function, so
the response text is `responseText` (a naive `const body = await res.text()` collides and
fails typecheck — that's a 30-second gotcha if you touch this again).

Typecheck is clean (`npx tsc --noEmit`).

### Still open (offered, not yet done)
**Why does FINRA return 0 rows for recent weeks?** The fix makes the scraper survive the
empty response gracefully, but it doesn't change the fact that we may be *asking for a
week FINRA hasn't published yet*. The scraper currently targets roughly a 14-day offset;
FINRA's actual publication lag may exceed that. Worth investigating whether the offset
should widen so we're requesting a window that's actually populated. This is a data-
freshness question, not a crash — lower priority than the deploy.

---

## Problem 2 — no reliable alerting when a scraper dies

### Context
Greg wanted (a) reliable alerts the moment an MCP-server scraper fails, and (b) on top of
that, a periodic Claude-driven *deeper* review — because a pure freshness check can't
catch "the job ran fine but produced garbage / 0 rows / rising error counts."

### What we built — the two-layer plan

**Layer 1: automated health-check (the smoke detector). Already live in the cloud.**
- `functions/src/health-check.ts` → `runHealthCheck({db, slackWebhookUrl?, logger?})`,
  fired by a scheduled Cloud Function **every 30 minutes** in Google's cloud. Runs
  regardless of whether anyone's PC is on.
- Monitors all **44 jobs** via the exported `JOBS` array, across 7 cadence tiers, each
  with its own warn/fail age thresholds (`TIER` constant: min30, hourly, every4h, daily,
  weekly, semimonthly, monthly).
- Firing logic (on `/meta/healthCheck`): notify on a **status change**, OR re-nag every
  6h while a job stays broken, OR send a daily green heartbeat while everything's healthy.
  Only advances `lastNotifiedAt`/`lastNotifiedStatus` after a *successful* Slack POST.
- **commit `a334012`** expanded this from a partial list to all 44 scraper metas — single
  source of truth.

**Layer 2: Mon/Wed/Fri Claude review (the judgment layer). New this stretch.**
- This is what makes it "Claude looking at them" rather than just a second cron. It reads
  every scraper's state, applies judgment ("13F wrote 0 docs three runs in a row, that's
  off" vs "materialEvents wrote 0 this hour, that's just a quiet hour"), and writes up a
  short Slack summary.
- **Two scripts (commit `d893002`):**
  - `scripts/weekly-review.ts` — **deterministic gather pass, read-only.** Imports
    `getLiveDb` + the authoritative `JOBS` list (single source of truth — imported from
    health-check.ts, never copied). Reads every `/meta` doc, computes per-job
    status/age/docsWritten/errors, flags anomalies, prints a worst-first table + a
    machine-readable `--- JSON ---` block. **Never writes Firestore, never hits Slack.**
    It's the meter-reading; the judgment + write-up is the scheduled Claude task's job.
  - `scripts/post-slack.ts` — tiny reusable poster. Reads `SLACK_HEALTHCHECK_WEBHOOK` from
    env, POSTs a message verbatim, exits 0/1 so the caller knows if it landed. The caller
    supplies the load-bearing `[capitaledge-api]` prefix.
- **Scheduled task:** created via the `scheduled-tasks` MCP, cron `0 9 * * 1,3,5`
  (9 AM local, Mon/Wed/Fri). Each run starts fresh with no memory, so its prompt is
  self-contained: run `weekly-review.ts`, apply judgment, post via `post-slack.ts`.

### Important operational facts about the monitor plan
- **Slack channel is SHARED with Derek's `capital-edge-d5038` project.** Any heartbeat,
  alert, or review post also lands in Derek's view of the channel. The `[capitaledge-api]`
  prefix is **load-bearing** — it's how the shared channel tells our alerts from Derek's.
  Give Derek a heads-up before the first post from any new automation.
- **The scheduled Claude task only runs while Greg's desktop app is open.** If the app is
  closed when a run is due, it fires on next launch (best-effort, NOT cloud-reliable).
  Greg's stance: *"I do not turn this thing off."* The reliable always-on layer is the
  cloud health-check (Layer 1); the Claude review (Layer 2) is the deeper-but-best-effort
  judgment pass on top.
- **Prerequisite before the first Slack post:** `SLACK_HEALTHCHECK_WEBHOOK` must be in
  `secrets/.env` (gitignored, local-dev only — Cloud Functions read it from Firebase
  Secret Manager). It is NOT there yet. Until it is, `post-slack.ts` and therefore the
  scheduled task can run the review but **cannot post**. The task is self-protecting: it
  runs the review, fails the post gracefully, and hands Greg the message to relay
  manually.

---

## Current fleet state (live, 2026-05-31 ~13:13 UTC)

44 monitored · 0 warn · 3 no-meta · 1 anomaly. **Nothing is actually broken.**

| Job | State | Reading |
|---|---|---|
| `otcMarketWeeklySync` | no-meta | The FINRA crash. **Fixed in code, not yet deployed** — still crashes in prod until deploy. |
| `oigExclusionsSync` | no-meta | Monthly, fires the **5th**. Pending first cron — not dead. |
| `legislatorsHistoricalSync` | no-meta | Monthly, fires the **1st**. Pending first cron — not dead. |
| `materialEventsSync` | anomaly | `docsWritten=0` on its hourly tick = no new 8-K filings that hour. Benign. |

Everything else green and fresh (insider trades, Form 4/5 baselines, 13F, FRED/BLS, FEC,
congress, OFAC, etc.).

---

## What's left (gated on Greg)

- **Deploy.** All three commits are pushed but production still runs old code.
  `firebase deploy --only firestore:indexes,functions` (or scope to the changed functions).
  Until deployed: the 44-meta health-check expansion, the FINRA fix, and the review
  scripts are not live. Deploy needs Greg's explicit go.
- **Add `SLACK_HEALTHCHECK_WEBHOOK` to `secrets/.env`** before the first Claude-review
  Slack post can land. Do NOT fetch/print the webhook value yourself.
- **Heads-up to Derek** before the first post (shared channel).
- **(Optional/lower priority)** investigate FINRA's publication lag vs the scraper's
  ~14-day offset so we request a window that's actually populated.

---

## Standing rules in force (don't relearn these the hard way)
- Write + commit + push is fine when Greg says so; **deploy needs explicit go each time.**
- The `[capitaledge-api]` Slack prefix is load-bearing; the webhook is shared with Derek.
- `writeJobMeta(jobName, …)` is only called *after* a successful save, so a missing
  `/meta/<job>` doc means that scraper has **never** successfully completed (dead OR
  pending first cron) — not "ran and wrote nothing."
- Pure-publisher posture: monitoring/reporting reads data, never derives signals.
