/**
 * RECOVER-SENATE-MISSING — ingest the Senate PTRs the eFD index lists that
 * KeyVex is missing (the 65 from G1), using the now capture-all parser
 * (all asset classes + buy/sell/exchange). Per-filing replace = idempotent.
 *
 * Scope: ONLY filings absent from KeyVex (re-enumerated + diffed live, so it's
 * self-correcting). The broader re-scrape of already-present filings (to
 * backfill bond/fund/exchange rows the old equity filter dropped) is a separate
 * decision and is NOT done here.
 *
 *   npx tsx scripts/recover-senate-missing.ts            # dry run (show what each holds)
 *   npx tsx scripts/recover-senate-missing.ts --save     # write
 */
import "../src/load-secrets.js";
import {
  fetchSenatePtrRefsWindowed,
  createSession,
  parseSenatePtr,
  isPaperPtr,
} from "../src/scrapers/senate.js";
import { getLiveDb, saveCongressionalTrades } from "../src/firestore.js";
import type { CongressionalTrade } from "../src/types.js";

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const SAVE = process.argv.includes("--save");
const ALL = process.argv.includes("--all"); // re-scrape EVERY filing (layer-2), not just missing
const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const START = arg("start") ?? "2012-01-01";
const END = arg("end") ?? "2026-12-31";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resume support — a long --all run can drop its eFD session or hit a hiccup;
// processed ptr_ids are journaled so a re-run continues instead of restarting.
mkdirSync(".tmp", { recursive: true });
const PROG = ".tmp/recover-senate-progress.json";
const progress: { done: string[] } =
  existsSync(PROG) && !process.argv.includes("--fresh")
    ? JSON.parse(readFileSync(PROG, "utf8"))
    : { done: [] };
const doneSet = new Set<string>(progress.done);
const flushProg = () =>
  writeFileSync(PROG, JSON.stringify({ done: [...doneSet] }));

(async () => {
  const db = await getLiveDb();
  console.error(`[rs] loading existing Senate ptr_ids…`);
  const have = new Set<string>(
    (
      await db
        .collection("congressional_trades")
        .where("chamber", "==", "senate")
        .select("ptr_id")
        .get()
    ).docs.map((d) => (d.data() as any).ptr_id),
  );
  console.error(`[rs] KeyVex has ${have.size} Senate filings`);

  console.error(`[rs] enumerating eFD ${START}..${END} (monthly windows)…`);
  const refs = await fetchSenatePtrRefsWindowed(START, END, (m) =>
    console.error(`[rs] ${m}`),
  );
  const candidates = ALL ? refs : refs.filter((r) => !have.has(r.ptrId));
  const missing = candidates.filter((r) => !doneSet.has(r.ptrId));
  console.error(
    `[rs] ${ALL ? "ALL filings (layer-2 re-scrape)" : "missing filings"}: ${candidates.length} candidates, ${missing.length} to process (${doneSet.size} already done)`,
  );

  let session = await createSession();
  const stats = { withTrades: 0, paper: 0, empty: 0, error: 0, saved: 0 };
  let buffer: CongressionalTrade[] = [];

  async function flush() {
    if (!buffer.length) return;
    if (SAVE) {
      // per-filing replace handled below per-ptr; here just bulk-save inserts
      const res = await saveCongressionalTrades(buffer);
      stats.saved += res.saved;
    }
    buffer = [];
  }

  // Fetch one PTR's HTML with one session-refresh-and-retry on failure.
  async function fetchDetail(detailUrl: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await sleep(300);
        const res = await session.fetch(detailUrl, {
          headers: {
            "User-Agent": "KeyVexMCP/0.1 contact@keyvex.com",
            Referer: "https://efdsearch.senate.gov/search/",
          },
        });
        if (res.status === 429 || res.status >= 500) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (!res.ok) return null;
        return await res.text();
      } catch {
        if (attempt >= 1) return null;
        session = await createSession(); // refresh expired session, retry once
      }
    }
    return null;
  }

  let processed = 0;
  for (const ref of missing) {
    const meta = {
      firstName: ref.firstName,
      lastName: ref.lastName,
      office: `${ref.lastName}, ${ref.firstName} (Senator)`.trim(),
      ptrId: ref.ptrId,
      reportPath: "",
      dateFiled: ref.dateFiled,
    };
    const html = await fetchDetail(ref.detailUrl);
    if (html === null) {
      stats.error++;
      console.error(`[rs]   ${ref.lastName} (${ref.ptrId}): fetch failed — left for resume`);
      continue; // NOT marked done → a re-run retries it
    }
    let trades: CongressionalTrade[] = [];
    try {
      trades = parseSenatePtr(html, meta as never);
    } catch (e) {
      stats.error++;
      console.error(`[rs]   ${ref.lastName} (${ref.ptrId}): parse error ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (trades.length === 0) {
      if (isPaperPtr(html)) {
        stats.paper++;
        console.error(`[rs]   ${ref.lastName} (${ref.ptrId}): PAPER PTR (PDF) — needs OCR, skipped`);
      } else {
        stats.empty++;
      }
    } else if (SAVE) {
      // per-filing replace, saved IMMEDIATELY (crash-safe): delete stale rows
      // then write the fresh capture-all set before marking the filing done.
      const existing = await db
        .collection("congressional_trades")
        .where("ptr_id", "==", ref.ptrId)
        .get();
      const freshIds = new Set(trades.map((t) => t.id));
      const batch = db.batch();
      let del = 0;
      for (const d of existing.docs)
        if (!freshIds.has(d.id)) {
          batch.delete(d.ref);
          del++;
        }
      if (del) await batch.commit();
      const saveRes = await saveCongressionalTrades(trades);
      stats.saved += saveRes.saved;
      stats.withTrades++;
    } else {
      stats.withTrades++;
    }
    // Successfully read this filing → safe to mark done (data already written).
    doneSet.add(ref.ptrId);
    processed++;
    if (processed % 25 === 0) {
      flushProg();
      console.error(
        `[rs] ${processed}/${missing.length} | ${JSON.stringify(stats)}`,
      );
    }
  }
  flushProg();

  console.error(`\n[rs] DONE. ${missing.length} processed this run.`);
  console.error(`[rs] ${JSON.stringify(stats)}`);
  if (!SAVE) console.error(`[rs] DRY-RUN — nothing written. Re-run with --save.`);
  process.exit(0);
})().catch((e) => {
  console.error("[rs] FATAL:", e);
  process.exit(1);
});
