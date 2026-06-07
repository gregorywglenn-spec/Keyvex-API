/**
 * 13F TICKER BACKFILL — resolve CUSIP→ticker for institutional_holdings rows
 * that the historical bulk backfill left with ticker=="" (CUSIP-only).
 *
 *   npx tsx scripts/backfill-13f-tickers.ts --dry    # resolve ~20 samples, NO writes
 *   npx tsx scripts/backfill-13f-tickers.ts          # full backfill (resumable)
 *
 * Mirrors the cron scraper's resolution chain (src/scrapers/13f.ts):
 *   tier 1  cusip_map cache → OpenFIGI /v3/mapping (BATCH) + namesMatch validate
 *   tier 2  EDGAR name fallback (lookupTickerByName)
 *   tier 3  OpenFIGI /v3/search by issuer name + namesMatch validate
 * Every successful resolution is written through to cusip_map so re-runs
 * short-circuit at tier 1.
 *
 * For each resolved CUSIP it UPDATES every empty-ticker holding carrying that
 * CUSIP: sets `ticker` and `company_name` (the issuer name). Writes are
 * batched (400), merge:true, keyed by the holding's existing doc id — so this
 * is dedup-safe and idempotent; it never creates new docs.
 *
 * Resumable: a per-CUSIP progress file in .tmp/. A CUSIP that resolves to
 * nothing (truly delisted / foreign-only) is marked done so it isn't retried
 * forever — its holdings keep ticker:"" but the CUSIP is recorded as tried.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { getLiveDb } from "../src/firestore.js";
import { lookupCusips, searchOpenFigiByName } from "../src/openfigi.js";
import { lookupTickerByName, namesMatch } from "../src/sec-tickers.js";

const DRY = process.argv.includes("--dry");
const PROG = ".tmp/13f-tickers-progress.json";
mkdirSync(".tmp", { recursive: true });

interface ProgressEntry {
  ticker: string;        // resolved ticker, "" if unresolved
  company_name: string;  // issuer name used for the stamp
  tried: true;           // marks a CUSIP done (resolved or proven-unresolvable)
}
const progress: Record<string, ProgressEntry> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};
function saveProgress(): void {
  writeFileSync(PROG, JSON.stringify(progress));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

type FirestoreInstance = import("firebase-admin/firestore").Firestore;

/**
 * Page through institutional_holdings where ticker=="" and collect the DISTINCT
 * CUSIPs (with one representative issuer_name per CUSIP). The same stock repeats
 * across funds/quarters, so the distinct set is ~15-30K, not ~700K.
 *
 * We select only the cusip + issuer_name fields and page by document id to
 * avoid loading the full 700K rows into memory at once.
 */
async function collectDistinctEmptyCusips(
  db: FirestoreInstance,
): Promise<Map<string, string>> {
  const byCusip = new Map<string, string>();
  const PAGE = 5000;
  let lastId: string | null = null;
  let scanned = 0;

  for (;;) {
    let q = db
      .collection("institutional_holdings")
      .where("ticker", "==", "")
      .select("cusip", "issuer_name")
      .orderBy("__name__")
      .limit(PAGE);
    if (lastId) q = q.startAfter(lastId);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const d = doc.data() as { cusip?: string; issuer_name?: string };
      const cusip = (d.cusip ?? "").trim();
      if (!cusip) continue;
      // Keep the first non-empty issuer_name we see for this CUSIP.
      if (!byCusip.has(cusip)) {
        byCusip.set(cusip, (d.issuer_name ?? "").trim());
      } else if (!byCusip.get(cusip) && d.issuer_name) {
        byCusip.set(cusip, d.issuer_name.trim());
      }
    }

    scanned += snap.size;
    lastId = snap.docs[snap.docs.length - 1]!.id;
    console.error(
      `[13f-tickers] scanned ${scanned} empty-ticker rows → ${byCusip.size} distinct CUSIPs so far`,
    );
    if (snap.size < PAGE) break;
  }

  return byCusip;
}

/**
 * Resolve one CUSIP through the cron's exact chain. `cache` is the tier-1
 * result already fetched in bulk via lookupCusips (cusip_map + OpenFIGI batch).
 * Returns { ticker, company_name } — ticker "" if unresolvable.
 */
async function resolveOne(
  db: FirestoreInstance,
  cusip: string,
  issuerName: string,
  tier1: { ticker: string; name: string | null } | undefined,
  writeCache: boolean,
): Promise<{ ticker: string; company_name: string }> {
  // Tier 1: OpenFIGI mapping (already batched), validated against issuer name
  if (tier1?.ticker) {
    if (namesMatch(issuerName, tier1.name)) {
      return { ticker: tier1.ticker, company_name: issuerName || (tier1.name ?? "") };
    }
    // name mismatch — fall through to tiers 2/3 like the cron does
  }

  // Tiers 2/3 require an issuer name to search on.
  if (!issuerName) {
    return { ticker: "", company_name: "" };
  }

  // Tier 2: EDGAR name fallback
  try {
    const ticker = await lookupTickerByName(issuerName);
    if (ticker) {
      // write-through to cusip_map so re-runs short-circuit
      if (writeCache) {
        await db
          .collection("cusip_map")
          .doc(cusip)
          .set(
            {
              cusip,
              ticker,
              name: issuerName,
              market_sector: null,
              last_verified: new Date().toISOString(),
              source: "edgar_name_fallback",
            },
            { merge: true },
          );
      }
      return { ticker, company_name: issuerName };
    }
  } catch (err) {
    console.error(
      `[13f-tickers]   ${cusip} (${issuerName}): EDGAR name fallback failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Tier 3: OpenFIGI search-by-name (rate-limited internally), validated
  try {
    const match = await searchOpenFigiByName(issuerName);
    if (match?.ticker && namesMatch(issuerName, match.name)) {
      if (writeCache) {
        await db
          .collection("cusip_map")
          .doc(cusip)
          .set(
            {
              cusip,
              ticker: match.ticker,
              name: match.name ?? issuerName,
              market_sector: null,
              last_verified: new Date().toISOString(),
              source: "openfigi_name_search",
            },
            { merge: true },
          );
      }
      return { ticker: match.ticker, company_name: issuerName };
    }
  } catch (err) {
    console.error(
      `[13f-tickers]   ${cusip} (${issuerName}): OpenFIGI search failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { ticker: "", company_name: "" };
}

/**
 * Stamp ticker + company_name onto every empty-ticker holding carrying `cusip`.
 * Batched (400), merge:true, keyed by existing doc id. Updates in place.
 */
async function stampHoldings(
  db: FirestoreInstance,
  cusip: string,
  ticker: string,
  companyName: string,
): Promise<number> {
  const snap = await db
    .collection("institutional_holdings")
    .where("cusip", "==", cusip)
    .where("ticker", "==", "")
    .get();
  if (snap.empty) return 0;

  let stamped = 0;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of docs.slice(i, i + 400)) {
      batch.set(
        doc.ref,
        { ticker, company_name: companyName },
        { merge: true },
      );
    }
    await batch.commit();
    stamped += Math.min(400, docs.length - i);
  }
  return stamped;
}

// ─── DRY-TEST ────────────────────────────────────────────────────────────────

async function dryTest(db: FirestoreInstance): Promise<void> {
  console.error("[13f-tickers] DRY TEST — resolving ~20 sample empty-ticker CUSIPs (no writes)\n");

  // Pull a sample of distinct empty-ticker CUSIPs (with issuer names), plus
  // force-include GME's CUSIP as a known-good canary.
  const sample = new Map<string, string>();
  const GME_CUSIP = "36467W109";
  sample.set(GME_CUSIP, "GAMESTOP CORP");

  // Grab a window of empty-ticker rows and pick distinct CUSIPs from it.
  const snap = await db
    .collection("institutional_holdings")
    .where("ticker", "==", "")
    .select("cusip", "issuer_name")
    .limit(2000)
    .get();
  for (const doc of snap.docs) {
    if (sample.size >= 20) break;
    const d = doc.data() as { cusip?: string; issuer_name?: string };
    const cusip = (d.cusip ?? "").trim();
    if (!cusip || sample.has(cusip)) continue;
    sample.set(cusip, (d.issuer_name ?? "").trim());
  }

  const cusips = Array.from(sample.keys());
  // db OMITTED on purpose in dry mode → lookupCusips hits OpenFIGI live with
  // no cusip_map cache read AND no write-through. Strictly read-only test.
  const tier1Map = await lookupCusips(cusips);

  console.error("\nCUSIP        | TICKER | COMPANY_NAME");
  console.error("-------------|--------|-------------------------------------");
  let resolved = 0;
  for (const cusip of cusips) {
    const issuerName = sample.get(cusip) ?? "";
    const res = await resolveOne(db, cusip, issuerName, tier1Map.get(cusip), false);
    if (res.ticker) resolved++;
    console.error(
      `${cusip.padEnd(12)} | ${(res.ticker || "—").padEnd(6)} | ${
        res.company_name || issuerName || "(no issuer name)"
      }`,
    );
  }
  console.error(
    `\n[13f-tickers] DRY TEST: ${resolved}/${cusips.length} sample CUSIPs resolved.`,
  );
}

// ─── FULL BACKFILL ───────────────────────────────────────────────────────────

async function fullBackfill(db: FirestoreInstance): Promise<void> {
  console.error("[13f-tickers] collecting distinct empty-ticker CUSIPs...");
  const distinct = await collectDistinctEmptyCusips(db);
  console.error(`[13f-tickers] ${distinct.size} distinct empty-ticker CUSIPs total`);

  const allCusips = Array.from(distinct.keys());
  const todo = allCusips.filter((c) => !progress[c]?.tried);
  console.error(
    `[13f-tickers] ${todo.length} CUSIPs to resolve (${allCusips.length - todo.length} already done)`,
  );

  // First, apply any already-resolved (from progress) tickers whose holdings
  // may not yet be stamped (e.g., interrupted mid-stamp on a prior run).
  // Then resolve the remaining unresolved CUSIPs.

  // Resolve in OpenFIGI-friendly batches: lookupCusips handles cache + the
  // OpenFIGI batch mapping + its own rate-limiting. Batch size of 100 keeps
  // each lookupCusips call to one OpenFIGI request on the API-key tier and a
  // handful on free tier.
  const BATCH = 100;
  let resolvedCount = 0;
  let stampedTotal = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const tier1Map = await lookupCusips(chunk, db);

    for (const cusip of chunk) {
      const issuerName = distinct.get(cusip) ?? "";
      const res = await resolveOne(db, cusip, issuerName, tier1Map.get(cusip), true);

      progress[cusip] = {
        ticker: res.ticker,
        company_name: res.company_name,
        tried: true,
      };

      if (res.ticker) {
        resolvedCount++;
        const n = await stampHoldings(db, cusip, res.ticker, res.company_name);
        stampedTotal += n;
        console.error(
          `[13f-tickers] ${cusip} → ${res.ticker} (${res.company_name}) — stamped ${n} holdings`,
        );
      }
    }

    saveProgress();
    console.error(
      `[13f-tickers] progress: ${i + chunk.length}/${todo.length} CUSIPs processed, ${resolvedCount} resolved, ${stampedTotal} holdings stamped`,
    );
    // gentle pacing between batches (lookupCusips already paces OpenFIGI calls)
    await sleep(200);
  }

  console.error(
    `[13f-tickers] COMPLETE: ${resolvedCount}/${todo.length} CUSIPs resolved, ${stampedTotal} holdings stamped`,
  );
}

async function main(): Promise<void> {
  const db = await getLiveDb();
  if (DRY) {
    await dryTest(db);
  } else {
    await fullBackfill(db);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[13f-tickers] FATAL", e);
    process.exit(1);
  });
