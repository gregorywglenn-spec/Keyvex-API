/**
 * SEC FAILS-TO-DELIVER (FTD) BULK BACKFILL — full history available from SEC (March 2004+).
 *
 *   npx tsx scripts/backfill-ftd-bulk.ts                     # default: trailing 3-year window
 *   npx tsx scripts/backfill-ftd-bulk.ts --start=2023-01 --end=2024-12
 *   npx tsx scripts/backfill-ftd-bulk.ts --all              # EVERYTHING back to 2004 (~20M rows — see warning)
 *   npx tsx scripts/backfill-ftd-bulk.ts --only=202401a     # one half-month (or --only=2008q3 for a quarterly)
 *   npx tsx scripts/backfill-ftd-bulk.ts --dry --start=2023-01 --end=2023-01   # parse + verify, NO writes
 *
 * SEC publishes FTD data in two eras under THREE different path prefixes:
 *   - 2004q1 → 2009q2 : QUARTERLY files  cnsp_sec_fails_<YYYY>q<N>.zip
 *   - 2009-07 → present: HALF-MONTH files cnsfails<YYYYMM><a|b>.zip
 *     ('a' = settlement dates 1-15, 'b' = 16-EOM)
 * Some files carry a "_0"/"_NN" disambiguation suffix and live under FOIA / "other" prefixes.
 * Rather than reconstruct filenames, this loader SCRAPES the SEC index page for the real
 * links — so all prefixes and suffixes are handled automatically.
 *
 * DEDUP: reuses parseFtdText() (exported from the scraper) + saveSecFailsToDeliver(), so every
 * record gets the IDENTICAL doc-id key as the weekly cron: `{YYYY-MM-DD}-{cusip}`. Overlapping
 * half-months MERGE rather than duplicate. Resumable per-period via .tmp progress file.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import AdmZip from "adm-zip";
import { parseFtdText } from "../src/scrapers/sec-ftd.js";
import { saveSecFailsToDeliver } from "../src/firestore.js";

const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";
const INDEX_URL =
  "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data";
const HOST = "https://www.sec.gov";
const PROG = ".tmp/ftd-bulk-progress.json";

const DRY = process.argv.includes("--dry");
const ALL = process.argv.includes("--all");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const START = process.argv.find((a) => a.startsWith("--start="))?.split("=")[1]; // YYYY-MM
const END = process.argv.find((a) => a.startsWith("--end="))?.split("=")[1]; // YYYY-MM

mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG)
  ? JSON.parse(readFileSync(PROG, "utf8"))
  : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

// ─── A discovered FTD file: its period key + sortable YYYY-MM + absolute URL ──
interface FtdFile {
  key: string; // "202401a" (half-month) or "2008q3" (quarterly)
  ym: string; // "2024-01" — used for --start/--end range filtering (quarter → first month)
  url: string;
}

/** Network fetch with retry/backoff (matches the Form D bulk template). */
async function fetchBuf(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(250);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e: any) {
      if (a === 5) throw e;
      console.error(`[ftd] net "${e?.cause?.code ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  return null;
}

async function fetchIndexHtml(): Promise<string> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(250);
      const res = await fetch(INDEX_URL, { headers: { "User-Agent": UA } });
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (a + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e: any) {
      if (a === 5) throw e;
      console.error(`[ftd] index net "${e?.cause?.code ?? e}" retry ${a + 1}`);
      await sleep(3000 * (a + 1));
    }
  }
  throw new Error("could not fetch FTD index");
}

/** Discover every FTD zip on the SEC index page, deriving a stable period key. */
function discover(html: string): FtdFile[] {
  const hrefs = new Set<string>();
  const re = /href="([^"]*fails-deliver-data\/[^"]*\.zip)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hrefs.add(m[1]);

  const byKey = new Map<string, FtdFile>();
  for (const href of hrefs) {
    const url = href.startsWith("http") ? href : `${HOST}${href}`;
    const name = href.split("/").pop()!;
    let key: string | null = null;
    let ym: string | null = null;

    // Half-month: cnsfails<YYYY><MM><a|b>[_N].zip
    let hm = /^cnsfails(\d{4})(\d{2})([ab])/i.exec(name);
    if (hm) {
      key = `${hm[1]}${hm[2]}${hm[3].toLowerCase()}`;
      ym = `${hm[1]}-${hm[2]}`;
    } else {
      // Quarterly: cnsp_sec_fails_<YYYY>q<N>.zip
      const q = /^cnsp_sec_fails_(\d{4})q([1-4])/i.exec(name);
      if (q) {
        key = `${q[1]}q${q[2]}`;
        ym = `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0")}`;
      }
    }
    if (!key || !ym) {
      console.error(`[ftd] WARN unrecognized filename, skipping: ${name}`);
      continue;
    }
    // Prefer the canonical (non-suffixed) URL if duplicate keys appear.
    const existing = byKey.get(key);
    if (!existing || (/_\d+\.zip$/i.test(existing.url) && !/_\d+\.zip$/i.test(url))) {
      byKey.set(key, { key, ym, url });
    }
  }
  // newest first
  return [...byKey.values()].sort((a, b) => (a.ym < b.ym ? 1 : a.ym > b.ym ? -1 : a.key < b.key ? 1 : -1));
}

function selectWindow(all: FtdFile[]): FtdFile[] {
  if (ONLY) return all.filter((f) => f.key === ONLY);
  if (ALL) return all;
  // explicit range, or default trailing 3 years
  let start = START;
  let end = END;
  if (!start && !end) {
    const d = new Date();
    end = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    start = `${d.getUTCFullYear() - 3}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return all.filter((f) => (!start || f.ym >= start) && (!end || f.ym <= end));
}

async function doFile(f: FtdFile) {
  if (done[f.key]) {
    console.error(`[ftd] skip ${f.key} (already done)`);
    return;
  }
  const buf = await fetchBuf(f.url);
  if (!buf) {
    console.error(`[ftd] ${f.key}: no ZIP (404) — marking done`);
    done[f.key] = true;
    writeFileSync(PROG, JSON.stringify(done));
    return;
  }
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length === 0) {
    console.error(`[ftd] ${f.key}: WARN empty zip`);
    done[f.key] = true;
    writeFileSync(PROG, JSON.stringify(done));
    return;
  }
  const text = entries[0]!.getData().toString("utf8");
  const recs = parseFtdText(text, NOW);
  console.error(`[ftd] ${f.key}: parsed ${recs.length} rows (${(buf.length / 1024 / 1024).toFixed(1)} MB zip)`);

  if (DRY) {
    const s = recs[0];
    console.error("  doc-id key sample : " + (s ? s.id : "(none)"));
    console.error("  first row         : " + JSON.stringify(s));
    console.error("  last row          : " + JSON.stringify(recs[recs.length - 1]));
    return;
  }

  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) {
    saved += (await saveSecFailsToDeliver(recs.slice(i, i + 400))).saved;
  }
  done[f.key] = true;
  writeFileSync(PROG, JSON.stringify(done));
  console.error(`[ftd] ${f.key} DONE: saved ${saved}`);
}

async function main() {
  console.error("[ftd] fetching SEC index…");
  const all = discover(await fetchIndexHtml());
  console.error(`[ftd] discovered ${all.length} FTD files (${all[all.length - 1]?.key} … ${all[0]?.key})`);
  const sel = selectWindow(all);
  if (sel.length === 0) {
    console.error("[ftd] window selected 0 files — check --start/--end/--only");
    return;
  }
  console.error(
    `[ftd] processing ${sel.length} files${DRY ? " (DRY — no writes)" : ""}: ${sel[sel.length - 1].key} … ${sel[0].key}`,
  );
  // oldest → newest so a resumed run extends forward naturally
  for (const f of [...sel].reverse()) await doFile(f);
  console.error("[ftd] COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ftd] FATAL", e);
    process.exit(1);
  });
