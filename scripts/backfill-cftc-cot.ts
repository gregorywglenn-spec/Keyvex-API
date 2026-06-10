/**
 * CFTC COMMITMENTS OF TRADERS (COT) HISTORICAL BACKFILL — legacy futures-only.
 *
 *   npx tsx scripts/backfill-cftc-cot.ts                       # default: last 10 years, SAVES
 *   npx tsx scripts/backfill-cftc-cot.ts --dry                 # parse-only, no writes
 *   npx tsx scripts/backfill-cftc-cot.ts --years=20            # last 20 years
 *   npx tsx scripts/backfill-cftc-cot.ts --start=1995-01-01    # explicit start floor
 *   npx tsx scripts/backfill-cftc-cot.ts --dry --start=2018-01-01 --end=2018-12-31
 *
 * Pages the Socrata dataset jun7-fc8e (publicreporting.cftc.gov) across the full
 * date window via $limit/$offset, normalizes each row to the CftcCotReport schema
 * (mirroring src/scrapers/cftc-cot.ts:normalize), and MERGES into the
 * cftc_cot_reports collection via saveCftcCotReports — keyed by
 * `${cftc_contract_market_code}-${report_date}` (the SAME doc id the weekly cron
 * uses), so re-runs and overlap with the cron de-dupe instead of duplicating.
 *
 * Resumable: a .tmp/ progress file records the last committed $offset; a re-run
 * resumes from there. Network-retry with backoff. Default WRITES; --dry suppresses.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveCftcCotReports } from "../src/firestore.js";
import type { CftcCotReport } from "../src/types.js";

const UA = process.env.KEYVEX_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const BASE = "https://publicreporting.cftc.gov/resource/jun7-fc8e.json";
const PAGE_SIZE = 5000; // Socrata caps at 50K/page; 5K keeps batches manageable.
const RATE_LIMIT_MS = 200; // 5 req/sec — Socrata is generous, no documented hard limit.
const SAVE_BATCH = 400; // matches saveCftcCotReports internal batch size.

const DRY = process.argv.includes("--dry");
const yearsArg = process.argv.find((a) => a.startsWith("--years="))?.split("=")[1];
const startArg = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1];
const endArg = process.argv.find((a) => a.startsWith("--end="))?.split("=")[1];

const YEARS = yearsArg ? parseInt(yearsArg, 10) : 10;
const startDate =
  startArg ??
  (() => {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - YEARS);
    return d.toISOString().slice(0, 10);
  })();
const endDate = endArg ?? new Date().toISOString().slice(0, 10);

const PROG = ".tmp/cftc-cot-backfill-progress.json";
mkdirSync(".tmp", { recursive: true });
interface Progress {
  start: string;
  end: string;
  offset: number;
  saved: number;
}
const fresh: Progress = { start: startDate, end: endDate, offset: 0, saved: 0 };
let prog: Progress = fresh;
if (existsSync(PROG)) {
  const loaded = JSON.parse(readFileSync(PROG, "utf8")) as Progress;
  // Only resume if the window matches; otherwise start clean for the new window.
  if (loaded.start === startDate && loaded.end === endDate) prog = loaded;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

// ─── Raw API shape (subset we map) ────────────────────────────────────────────
interface RawCotRow {
  market_and_exchange_names?: string;
  report_date_as_yyyy_mm_dd?: string;
  yyyy_report_week_ww?: string;
  contract_market_name?: string;
  cftc_contract_market_code?: string;
  cftc_market_code?: string;
  cftc_region_code?: string;
  cftc_commodity_code?: string;
  commodity_name?: string;
  open_interest_all?: string | number;
  noncomm_positions_long_all?: string | number;
  noncomm_positions_short_all?: string | number;
  noncomm_postions_spread_all?: string | number;
  comm_positions_long_all?: string | number;
  comm_positions_short_all?: string | number;
  nonrept_positions_long_all?: string | number;
  nonrept_positions_short_all?: string | number;
  change_in_open_interest_all?: string | number;
  change_in_noncomm_long_all?: string | number;
  change_in_noncomm_short_all?: string | number;
  change_in_comm_long_all?: string | number;
  change_in_comm_short_all?: string | number;
  change_in_nonrept_long_all?: string | number;
  change_in_nonrept_short_all?: string | number;
  pct_of_oi_noncomm_long_all?: string | number;
  pct_of_oi_noncomm_short_all?: string | number;
  pct_of_oi_comm_long_all?: string | number;
  pct_of_oi_comm_short_all?: string | number;
  pct_of_oi_nonrept_long_all?: string | number;
  pct_of_oi_nonrept_short_all?: string | number;
  traders_tot_all?: string | number;
  traders_noncomm_long_all?: string | number;
  traders_noncomm_short_all?: string | number;
  traders_comm_long_all?: string | number;
  traders_comm_short_all?: string | number;
  conc_net_le_4_tdr_long_all?: string | number;
  conc_net_le_4_tdr_short_all?: string | number;
  conc_net_le_8_tdr_long_all?: string | number;
  conc_net_le_8_tdr_short_all?: string | number;
}

function toNum(v: string | number | undefined): number {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Mirrors src/scrapers/cftc-cot.ts:normalize so the doc id (and therefore the
// dedup key) is byte-identical to what the weekly cron writes.
function normalize(raw: RawCotRow, scrapedAt: string): CftcCotReport | null {
  const code = raw.cftc_contract_market_code?.trim();
  const date = raw.report_date_as_yyyy_mm_dd;
  if (!code || !date) return null;
  const isoDate = date.slice(0, 10);
  const docId = `${code}-${isoDate}`;
  const ncLong = toNum(raw.noncomm_positions_long_all);
  const ncShort = toNum(raw.noncomm_positions_short_all);
  const cLong = toNum(raw.comm_positions_long_all);
  const cShort = toNum(raw.comm_positions_short_all);
  const nrLong = toNum(raw.nonrept_positions_long_all);
  const nrShort = toNum(raw.nonrept_positions_short_all);
  return {
    id: docId,
    cftc_contract_market_code: code,
    contract_market_name: (raw.contract_market_name ?? "").trim(),
    market_and_exchange_names: (raw.market_and_exchange_names ?? "").trim(),
    commodity_name: (raw.commodity_name ?? "").trim(),
    commodity_code: (raw.cftc_commodity_code ?? "").trim(),
    market_code: (raw.cftc_market_code ?? "").trim(),
    region_code: (raw.cftc_region_code ?? "").trim(),
    report_date: isoDate,
    report_week: raw.yyyy_report_week_ww ?? "",
    open_interest: toNum(raw.open_interest_all),
    noncomm_long: ncLong,
    noncomm_short: ncShort,
    noncomm_net: ncLong - ncShort,
    noncomm_spread: toNum(raw.noncomm_postions_spread_all),
    comm_long: cLong,
    comm_short: cShort,
    comm_net: cLong - cShort,
    nonrept_long: nrLong,
    nonrept_short: nrShort,
    nonrept_net: nrLong - nrShort,
    change_open_interest: toNum(raw.change_in_open_interest_all),
    change_noncomm_long: toNum(raw.change_in_noncomm_long_all),
    change_noncomm_short: toNum(raw.change_in_noncomm_short_all),
    change_comm_long: toNum(raw.change_in_comm_long_all),
    change_comm_short: toNum(raw.change_in_comm_short_all),
    change_nonrept_long: toNum(raw.change_in_nonrept_long_all),
    change_nonrept_short: toNum(raw.change_in_nonrept_short_all),
    pct_noncomm_long: toNum(raw.pct_of_oi_noncomm_long_all),
    pct_noncomm_short: toNum(raw.pct_of_oi_noncomm_short_all),
    pct_comm_long: toNum(raw.pct_of_oi_comm_long_all),
    pct_comm_short: toNum(raw.pct_of_oi_comm_short_all),
    pct_nonrept_long: toNum(raw.pct_of_oi_nonrept_long_all),
    pct_nonrept_short: toNum(raw.pct_of_oi_nonrept_short_all),
    traders_total: toNum(raw.traders_tot_all),
    traders_noncomm_long: toNum(raw.traders_noncomm_long_all),
    traders_noncomm_short: toNum(raw.traders_noncomm_short_all),
    traders_comm_long: toNum(raw.traders_comm_long_all),
    traders_comm_short: toNum(raw.traders_comm_short_all),
    conc_net_le_4_long: toNum(raw.conc_net_le_4_tdr_long_all),
    conc_net_le_4_short: toNum(raw.conc_net_le_4_tdr_short_all),
    conc_net_le_8_long: toNum(raw.conc_net_le_8_tdr_long_all),
    conc_net_le_8_short: toNum(raw.conc_net_le_8_tdr_short_all),
    source_url: `https://www.cftc.gov/dea/futures/deacmesf.htm`,
    scraped_at: scrapedAt,
  };
}

const WHERE = `report_date_as_yyyy_mm_dd between '${startDate}T00:00:00' and '${endDate}T23:59:59'`;

async function fetchPage(offset: number): Promise<RawCotRow[]> {
  const url = new URL(BASE);
  url.searchParams.set("$where", WHERE);
  url.searchParams.set("$limit", String(PAGE_SIZE));
  url.searchParams.set("$offset", String(offset));
  // Stable order so $offset paging is consistent across pages.
  url.searchParams.set("$order", "report_date_as_yyyy_mm_dd ASC, cftc_contract_market_code ASC");
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(RATE_LIMIT_MS);
      const res = await fetch(url.toString(), {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.status === 429 || res.status >= 500) {
        console.error(`[cftc-cot-bf] HTTP ${res.status} at offset ${offset}, retry ${a + 1}`);
        await sleep(2000 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return (await res.json()) as RawCotRow[];
    } catch (e: any) {
      if (a === 5) throw e;
      console.error(`[cftc-cot-bf] net "${e?.cause?.code ?? e}" at offset ${offset}, retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return [];
}

async function main() {
  console.error(
    `[cftc-cot-bf] window ${startDate} → ${endDate}${DRY ? " (DRY)" : ""}` +
      (prog.offset > 0 ? ` (resuming at offset ${prog.offset}, ${prog.saved} saved so far)` : ""),
  );

  let firstSample: CftcCotReport | null = null;

  for (;;) {
    const rows = await fetchPage(prog.offset);
    if (rows.length === 0) break;

    const recs = rows
      .map((r) => normalize(r, NOW))
      .filter((x): x is CftcCotReport => x !== null);

    if (!firstSample && recs.length) firstSample = recs[0];

    if (DRY) {
      console.error(`[cftc-cot-bf]   offset ${prog.offset}: ${rows.length} rows → ${recs.length} parsed`);
    } else {
      for (let i = 0; i < recs.length; i += SAVE_BATCH) {
        await saveCftcCotReports(recs.slice(i, i + SAVE_BATCH));
      }
      prog.saved += recs.length;
    }

    prog.offset += rows.length;
    if (!DRY) writeFileSync(PROG, JSON.stringify(prog));

    console.error(
      `[cftc-cot-bf]   page done: offset now ${prog.offset}` +
        (DRY ? "" : ` (saved ${prog.saved})`),
    );

    if (rows.length < PAGE_SIZE) break; // last page
  }

  if (firstSample) {
    console.error("[cftc-cot-bf] sample (first parsed row):");
    console.error(
      JSON.stringify(
        {
          id: firstSample.id,
          cftc_contract_market_code: firstSample.cftc_contract_market_code,
          report_date: firstSample.report_date,
          commodity_name: firstSample.commodity_name,
          contract_market_name: firstSample.contract_market_name,
          open_interest: firstSample.open_interest,
          noncomm_net: firstSample.noncomm_net,
          comm_net: firstSample.comm_net,
        },
        null,
        2,
      ),
    );
    console.error(`[cftc-cot-bf] dedup doc id = "${firstSample.id}" (code-reportDate)`);
  } else {
    console.error("[cftc-cot-bf] no rows parsed in window");
  }

  console.error(
    `[cftc-cot-bf] COMPLETE — scanned ${prog.offset} rows${DRY ? " (DRY, nothing saved)" : `, saved ${prog.saved}`}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[cftc-cot-bf] FATAL", e);
    process.exit(1);
  });
