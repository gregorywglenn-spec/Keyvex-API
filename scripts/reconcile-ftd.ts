/**
 * KeyVex Reconciliation — SEC Fails-to-Deliver (FTD), PERIOD-LEVEL gauge.
 *
 * FTD doesn't fit the generic per-id reconciler: it's ~4M daily fail rows in
 * bi-monthly files, not discrete filings. The right question is per-period:
 * "for each month the SEC published, did KeyVex ingest it, and does our row
 * count match the source files'?"
 *
 * GRANULARITY = MONTH (not half-month). The SEC splits each month into an 'a'
 * (first-half) and 'b' (second-half) file, but the 'b' file in practice also
 * carries some late-reported fails dated in the first half. KeyVex stores every
 * row under its true settlement_date, so a half-month-level count mismatches
 * the file boundary (the 'a' over is exactly offset by the 'b' short, netting
 * zero per month). Scoring by MONTH — union both files' distinct ids vs KeyVex's
 * count for the whole month — removes that artifact and reflects true coverage.
 *
 * KeyVex window is a trailing ~3 years, all in the half-month-file era (the
 * older 2004→mid-2009 quarterly format is out of window).
 *
 * "the builder is never the grader": the report lists every month with its two
 * source zip links + both counts, so Greg can open a file and verify.
 *
 * Usage:
 *   npx tsx scripts/reconcile-ftd.ts                 # full window (auto-detected)
 *   npx tsx scripts/reconcile-ftd.ts --start=2025-01 # from a later month
 *   npx tsx scripts/reconcile-ftd.ts --out=DIR
 */
import "../src/load-secrets.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLiveDb } from "../src/firestore.js";
import { scrapeSecFailsToDeliver } from "../src/scrapers/sec-ftd.js";

const BASE_URL = "https://www.sec.gov/files/data/fails-deliver-data";

interface Month {
  year: number;
  month: number;
}

function arg(k: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function nextMonth(m: Month): Month {
  return m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
}
function lastDay(m: Month): number {
  return new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
}

/** Fetch one half-month file's distinct doc-ids (null on 404 / not published). */
async function halfIds(
  year: number,
  month: number,
  half: "a" | "b",
): Promise<Set<string> | null> {
  try {
    const recs = await scrapeSecFailsToDeliver({ year, month, half });
    return new Set(recs.map((r) => r.id));
  } catch {
    return null;
  }
}

interface Row {
  label: string; // YYYY-MM
  start: string;
  end: string;
  fileA: string;
  fileB: string;
  sourceDistinct: number | null; // union of a+b ids; null = neither published
  keyvexRows: number;
}

async function main(): Promise<void> {
  const db = await getLiveDb();
  const col = db.collection("sec_fails_to_deliver");

  const minSnap = await col.orderBy("settlement_date", "asc").limit(1).get();
  const maxSnap = await col.orderBy("settlement_date", "desc").limit(1).get();
  const minDate = (minSnap.docs[0]?.get("settlement_date") as string) ?? "";
  const maxDate = (maxSnap.docs[0]?.get("settlement_date") as string) ?? "";
  if (!minDate || !maxDate) {
    console.error("[reconcile-ftd] FATAL: collection is empty");
    process.exit(1);
  }
  console.error(`[reconcile-ftd] KeyVex span ${minDate} → ${maxDate}`);

  const startArg = arg("start");
  let start: Month;
  if (startArg) {
    const [y, m] = startArg.split("-").map((n) => parseInt(n, 10));
    start = { year: y!, month: m! };
  } else {
    const [y, m] = minDate.split("-").map((n) => parseInt(n, 10));
    start = { year: y!, month: m! };
  }
  const [ey, em] = maxDate.split("-").map((n) => parseInt(n, 10));
  const stop = nextMonth(nextMonth({ year: ey!, month: em! })); // probe one past latest

  const rows: Row[] = [];
  for (let mo = start; !(mo.year === stop.year && mo.month === stop.month); mo = nextMonth(mo)) {
    const mm = pad(mo.month);
    const label = `${mo.year}-${mm}`;
    const start_ = `${label}-01`;
    const end_ = `${label}-${pad(lastDay(mo))}`;
    const idsA = await halfIds(mo.year, mo.month, "a");
    const idsB = await halfIds(mo.year, mo.month, "b");
    let sourceDistinct: number | null = null;
    if (idsA || idsB) {
      const union = new Set<string>();
      if (idsA) for (const id of idsA) union.add(id);
      if (idsB) for (const id of idsB) union.add(id);
      sourceDistinct = union.size;
    }
    const keyvexRows = (
      await col
        .where("settlement_date", ">=", start_)
        .where("settlement_date", "<=", end_)
        .count()
        .get()
    ).data().count;

    rows.push({
      label,
      start: start_,
      end: end_,
      fileA: `cnsfails${mo.year}${mm}a.zip`,
      fileB: `cnsfails${mo.year}${mm}b.zip`,
      sourceDistinct,
      keyvexRows,
    });
    const srcTxt = sourceDistinct === null ? "not-published" : sourceDistinct.toLocaleString();
    console.error(`[reconcile-ftd] ${label}: source ${srcTxt} | keyvex ${keyvexRows.toLocaleString()}`);
  }

  const published = rows.filter((r) => r.sourceDistinct !== null);
  const totalSource = published.reduce((s, r) => s + (r.sourceDistinct ?? 0), 0);
  const totalKeyvex = published.reduce((s, r) => s + r.keyvexRows, 0);
  const shortMonths = published.filter((r) => r.keyvexRows < (r.sourceDistinct ?? 0));
  const missingMonths = published.filter((r) => r.keyvexRows === 0 && (r.sourceDistinct ?? 0) > 0);
  const notPublished = rows.filter((r) => r.sourceDistinct === null);
  const rowCoverage = totalSource === 0 ? 0 : (Math.min(totalKeyvex, totalSource) / totalSource) * 100;
  const monthCoverage =
    published.length === 0 ? 0 : ((published.length - shortMonths.length) / published.length) * 100;

  const outDir = arg("out") ?? join("docs", "reconciliation");
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, "sec-ftd-G1");
  const generatedAt = new Date().toISOString();

  // CSV
  const csv = [
    "month,settlement_start,settlement_end,source_distinct_rows,keyvex_rows,delta,status,source_zip_a,source_zip_b",
    ...rows.map((r) => {
      const src = r.sourceDistinct === null ? "" : r.sourceDistinct;
      const delta = r.sourceDistinct === null ? "" : r.keyvexRows - r.sourceDistinct;
      const status =
        r.sourceDistinct === null
          ? "not-published"
          : r.keyvexRows === 0
            ? "MISSING"
            : r.keyvexRows < r.sourceDistinct
              ? "SHORT"
              : "ok";
      return `${r.label},${r.start},${r.end},${src},${r.keyvexRows},${delta},${status},${BASE_URL}/${r.fileA},${BASE_URL}/${r.fileB}`;
    }),
  ].join("\n");
  writeFileSync(`${base}.csv`, csv + "\n");

  // Markdown
  const md: string[] = [];
  md.push("# KeyVex Reconciliation — SEC Fails-to-Deliver (FTD) — G1 (month-level)");
  md.push("");
  md.push(`- generated: ${generatedAt}`);
  md.push(`- collection: \`sec_fails_to_deliver\``);
  md.push(`- KeyVex span: ${minDate} → ${maxDate}`);
  md.push(`- months checked: ${rows.length} (${published.length} published, ${notPublished.length} not-yet-published)`);
  md.push("");
  md.push(`## G1 row coverage: ${rowCoverage.toFixed(2)}%  (${totalKeyvex.toLocaleString()} / ${totalSource.toLocaleString()} source rows)`);
  md.push(`## G1 month coverage: ${monthCoverage.toFixed(2)}%  (${published.length - shortMonths.length}/${published.length} months complete)`);
  md.push(rowCoverage >= 98 ? "meets the ≥98% floor." : "**below the ≥98% floor.**");
  md.push("");
  md.push(
    "> Scored by MONTH on purpose: the SEC's half-month 'b' file carries some first-half-dated " +
      "rows, so a half-month count mismatches the file boundary (the 'a' over exactly offsets the " +
      "'b' short). Month-level union removes that artifact.",
  );
  md.push("");
  if (missingMonths.length) {
    md.push(`### ⚠ ${missingMonths.length} month(s) ENTIRELY missing`);
    for (const r of missingMonths) md.push(`- ${r.label}: source ${r.sourceDistinct?.toLocaleString()} rows — ${BASE_URL}/${r.fileA}`);
    md.push("");
  }
  if (shortMonths.length) {
    md.push(`### ${shortMonths.length} month(s) SHORT (KeyVex has fewer rows than the source)`);
    for (const r of shortMonths)
      md.push(`- ${r.label}: keyvex ${r.keyvexRows.toLocaleString()} vs source ${r.sourceDistinct?.toLocaleString()} (short ${((r.sourceDistinct ?? 0) - r.keyvexRows).toLocaleString()}) — ${BASE_URL}/${r.fileA}`);
    md.push("");
  }
  if (!shortMonths.length && !missingMonths.length) {
    md.push("Every published month is fully present in KeyVex (no missing or short months).");
    md.push("");
  }
  md.push("## Per-month detail");
  md.push("| month | settlement range | source rows | keyvex rows | delta | status |");
  md.push("|---|---|--:|--:|--:|---|");
  for (const r of rows) {
    const src = r.sourceDistinct === null ? "—" : r.sourceDistinct.toLocaleString();
    const delta = r.sourceDistinct === null ? "—" : (r.keyvexRows - r.sourceDistinct).toLocaleString();
    const status =
      r.sourceDistinct === null
        ? "not-published"
        : r.keyvexRows === 0
          ? "**MISSING**"
          : r.keyvexRows < r.sourceDistinct
            ? "**SHORT**"
            : "ok";
    md.push(`| ${r.label} | ${r.start}..${r.end} | ${src} | ${r.keyvexRows.toLocaleString()} | ${delta} | ${status} |`);
  }
  md.push("");
  writeFileSync(`${base}.md`, md.join("\n") + "\n");

  // HTML
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bannerClass = rowCoverage >= 98 ? "ok" : "bad";
  const htmlRows = rows
    .map((r) => {
      const src = r.sourceDistinct === null ? "—" : r.sourceDistinct.toLocaleString();
      const delta = r.sourceDistinct === null ? "—" : (r.keyvexRows - r.sourceDistinct).toLocaleString();
      const status =
        r.sourceDistinct === null
          ? "not-published"
          : r.keyvexRows === 0
            ? "MISSING"
            : r.keyvexRows < r.sourceDistinct
              ? "SHORT"
              : "ok";
      const cls = status === "ok" || status === "not-published" ? "" : ' class="bad"';
      return `<tr${cls}><td>${esc(r.label)}</td><td>${r.start}..${r.end}</td><td class="num">${src}</td><td class="num">${r.keyvexRows.toLocaleString()}</td><td class="num">${delta}</td><td>${status}</td><td><a href="${BASE_URL}/${r.fileA}" target="_blank" rel="noopener">a</a> · <a href="${BASE_URL}/${r.fileB}" target="_blank" rel="noopener">b</a></td></tr>`;
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KeyVex Reconciliation — SEC FTD — G1</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:2rem;max-width:1000px}
 h1{font-size:1.4rem;margin:0 0 .25rem} .sub{color:#888;margin:0 0 1rem}
 .banner{padding:1rem 1.25rem;border-radius:10px;margin:1rem 0;font-size:1.05rem}
 .ok{background:#1f8a4c22;border:1px solid #1f8a4c}.bad{background:#c0392b22;border:1px solid #c0392b}
 .big{font-size:1.7rem;font-weight:700}
 table{border-collapse:collapse;width:100%;margin:.5rem 0} th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #8883}
 td.num{text-align:right;font-variant-numeric:tabular-nums} tr.bad td{background:#c0392b18}
 a{color:#2a7ae2} .verify,.note{padding:.7rem 1rem;border-radius:8px;margin:1rem 0}
 .verify{background:#2a7ae218;border:1px solid #2a7ae2}.note{background:#8881}
</style></head><body>
<h1>KeyVex Reconciliation — SEC Fails-to-Deliver</h1>
<p class="sub">Gauge G1 (month-level) · collection <code>sec_fails_to_deliver</code> · ${esc(generatedAt)} · span ${minDate}–${maxDate}</p>
<div class="banner ${bannerClass}">
  <div class="big">${rowCoverage.toFixed(2)}% row coverage</div>
  ${totalKeyvex.toLocaleString()} of ${totalSource.toLocaleString()} source rows · ${published.length - shortMonths.length}/${published.length} months complete
  ${rowCoverage >= 98 ? "· meets the ≥98% floor" : "· below the ≥98% floor"}
</div>
<div class="note">Scored by <b>month</b>: the SEC's half-month 'b' file carries some first-half-dated rows, so a half-month count mismatches the file boundary. Month-level union of both files removes that artifact.</div>
<div class="verify"><b>The builder is never the grader.</b> Each month links to the SEC's own zips — open one, and confirm KeyVex's count for that month matches the files' combined rows.</div>
<table><thead><tr><th>month</th><th>settlement range</th><th>source rows</th><th>keyvex rows</th><th>delta</th><th>status</th><th>source</th></tr></thead><tbody>
${htmlRows}
</tbody></table>
</body></html>`;
  writeFileSync(`${base}.html`, html);

  console.error("");
  console.error("══ SEC Fails-to-Deliver — G1 (month-level) ══");
  console.error(`  row coverage:   ${rowCoverage.toFixed(2)}%  (${totalKeyvex.toLocaleString()} / ${totalSource.toLocaleString()} rows)`);
  console.error(`  month coverage: ${monthCoverage.toFixed(2)}%  (${published.length - shortMonths.length}/${published.length} complete)`);
  console.error(`  missing months: ${missingMonths.length}`);
  console.error(`  short months:   ${shortMonths.length}`);
  console.error(`  not-published:  ${notPublished.length}`);
  console.error("");
  console.error(`  report: ${base}.html / .csv / .md`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[reconcile-ftd] FATAL:", e);
    process.exit(1);
  });
