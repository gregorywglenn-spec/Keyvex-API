/**
 * KeyVex Reconciliation System — the Standing Report (component #5).
 *
 * Renders a ReconResult into three artifacts:
 *   - HTML  : the Greg-facing page. Coverage banner, per-type census, and the
 *             full missing list with CLICKABLE government links. The builder
 *             reports nothing as "verified" — Greg confirms by clicking.
 *   - CSV   : the COMPLETE missing list (every row, never truncated) for
 *             spreadsheet / scripted verification.
 *   - MD    : a plain-text mirror for the repo / terminal.
 *
 * No silent exclusions: if the HTML caps its rendered rows for browser sanity,
 * it says so loudly and points at the CSV that holds all of them.
 */

import type { ReconResult, SourceItem } from "./types.js";

// The in-page missing table is capped so the report renders fast even inside a
// lightweight preview pane; the COMPLETE list always lives in the companion CSV
// (the cap is surfaced in the page, never a silent truncation).
const HTML_ROW_CAP = 250;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function classOf(item: SourceItem): string {
  const c = item.meta?.["class"];
  return c ? String(c) : "";
}

// ─── HTML ────────────────────────────────────────────────────────────────────

export function renderHtml(r: ReconResult): string {
  const exchangeHole = r.typeCounts.some(
    (t) => t.expected && t.type === "exchange" && t.count === 0,
  );
  const anyExpectedZero = r.typeCounts.some((t) => t.expected && t.count === 0);

  const typeRows = r.typeCounts
    .map((t) => {
      const flag = t.expected && t.count === 0
        ? ' class="zero"'
        : "";
      const tag = t.expected ? "" : ' <span class="muted">(unexpected)</span>';
      return `<tr${flag}><td>${esc(t.type)}${tag}</td><td class="num">${t.count.toLocaleString()}</td><td>${t.present ? "✓ present" : "✗ <b>READS ZERO</b>"}</td></tr>`;
    })
    .join("\n");

  const years = Object.keys({ ...r.sourceByYear, ...r.missingByYear }).sort();
  const yearRows = years
    .map((y) => {
      const src = r.sourceByYear[y] ?? 0;
      const miss = r.missingByYear[y] ?? 0;
      const have = src - miss;
      const pct = src === 0 ? "—" : fmtPct((have / src) * 100);
      const flag = miss > 0 ? ' class="hasgap"' : "";
      return `<tr${flag}><td>${esc(y)}</td><td class="num">${src.toLocaleString()}</td><td class="num">${have.toLocaleString()}</td><td class="num">${miss.toLocaleString()}</td><td class="num">${pct}</td></tr>`;
    })
    .join("\n");

  const shown = r.missing.slice(0, HTML_ROW_CAP);
  const classified = r.classification !== undefined;
  const missingRows = shown
    .map((m) => {
      const cls = classOf(m);
      const clsCell = classified ? `<td>${esc(cls)}</td>` : "";
      return `<tr><td>${esc(m.id)}</td><td>${esc(String(m.meta?.["year"] ?? ""))}</td><td>${esc(m.label ?? "")}</td>${clsCell}<td><a href="${esc(m.url)}" target="_blank" rel="noopener">open filing ↗</a></td></tr>`;
    })
    .join("\n");

  const classHeader = classified ? "<th>class</th>" : "";
  const capNote =
    r.missing.length > HTML_ROW_CAP
      ? `<p class="warn">Showing first ${HTML_ROW_CAP.toLocaleString()} of ${r.missing.length.toLocaleString()} missing filings below — the <b>complete</b> list is in the companion <code>.csv</code> (nothing is dropped, just paginated for the browser).</p>`
      : "";

  const classBlock = r.classification
    ? `<h2>Missing classified</h2>
       <p class="muted">${r.classifiedCount?.toLocaleString()} of ${r.missing.length.toLocaleString()} missing fetched and classified.
       <b>Unexplained-missing</b> (target 0) = missing − (nil + unreadable + gone)${
         r.unexplainedMissing !== undefined
           ? ` = <b>${r.unexplainedMissing.toLocaleString()}</b>`
           : " — not computable until ALL missing are classified"
       }.</p>
       <table><thead><tr><th>class</th><th>count</th><th>meaning</th></tr></thead><tbody>
       <tr><td>recoverable</td><td class="num">${r.classification.recoverable.toLocaleString()}</td><td>source has data we failed to ingest — a true gap to close</td></tr>
       <tr><td>nil</td><td class="num">${r.classification.nil.toLocaleString()}</td><td>source reports nothing — legitimately nothing to have</td></tr>
       <tr><td>unreadable</td><td class="num">${r.classification.unreadable.toLocaleString()}</td><td>source doc corrupt / unparseable</td></tr>
       <tr><td>gone</td><td class="num">${r.classification.gone.toLocaleString()}</td><td>source link 404s — source itself lost it</td></tr>
       <tr><td>unclassified</td><td class="num">${r.classification.unclassified.toLocaleString()}</td><td>not fetched this run</td></tr>
       </tbody></table>`
    : `<p class="muted">Missing list is <b>unclassified</b> (classification is opt-in — re-run with <code>--classify=all</code> to resolve recoverable vs nil vs gone and compute unexplained-missing).</p>`;

  const warnBlock =
    r.warnings.length > 0
      ? `<div class="warnbox"><b>Warnings (surfaced, not silent):</b><ul>${r.warnings
          .map((w) => `<li>${esc(w)}</li>`)
          .join("")}</ul></div>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KeyVex Reconciliation — ${esc(r.title)} — G1</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 2rem; max-width: 1100px; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; }
  .sub { color: #888; margin: 0 0 1.5rem; }
  .banner { padding: 1rem 1.25rem; border-radius: 10px; margin: 1rem 0; font-size: 1.1rem; }
  .ok { background: #1f8a4c22; border: 1px solid #1f8a4c; }
  .bad { background: #c0392b22; border: 1px solid #c0392b; }
  .big { font-size: 2rem; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; }
  th { font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.zero td, tr.hasgap td { background: #c0392b18; }
  .muted { color: #888; }
  .warn, .warnbox { color: #b9770e; }
  .warnbox { background: #f39c1218; border: 1px solid #f39c12; padding: .75rem 1rem; border-radius: 8px; margin: 1rem 0; }
  a { color: #2a7ae2; }
  code { background: #8882; padding: .1rem .3rem; border-radius: 4px; }
  .verify { background: #2a7ae218; border: 1px solid #2a7ae2; padding: .75rem 1rem; border-radius: 8px; margin: 1.5rem 0; }
</style></head><body>

<h1>KeyVex Reconciliation — ${esc(r.title)}</h1>
<p class="sub">Gauge <b>G1 (completeness)</b> · collection <code>${esc(r.collection)}</code> · generated ${esc(r.generatedAt)}${
    r.years ? ` · years ${esc(String(r.years[0]))}–${esc(String(r.years[r.years.length - 1]))}` : ""
  }</p>

<div class="banner ${r.coveragePct >= 98 ? "ok" : "bad"}">
  <div class="big">${fmtPct(r.coveragePct)} coverage</div>
  ${r.keyvexIdsPresent.toLocaleString()} of ${r.sourceTotal.toLocaleString()} source filings present in KeyVex
  · <b>${r.missing.length.toLocaleString()} missing</b>
  ${r.coveragePct >= 98 ? "· meets the ≥98% floor" : "· below the ≥98% floor"}
</div>

<div class="verify">
  <b>The builder is never the grader.</b> This page reports what the diff found; it is <i>not</i>
  a verified number. Confirm it yourself: open a handful of the “missing” links below — each should
  be a real House Clerk PTR with trades that are genuinely absent from KeyVex. If a “missing” filing
  is actually empty (a “nothing to report” page), that’s a <code>nil</code>, not a gap.
</div>

${warnBlock}

<h2>Per-type census — can any category silently read zero?</h2>
<p class="muted">Counts are over the ${r.keyvexTotalRecords.toLocaleString()} House records KeyVex holds.
Expected types are always shown, even at zero, so a dropped category can’t hide.</p>
${
  anyExpectedZero
    ? `<p class="warn"><b>⚠ A required transaction type reads ZERO.</b>${
        exchangeHole
          ? " <b>exchange = 0</b> — the parser drops Exchange (“E”) rows entirely. This is the known G2 hole: exchanges are trades and must be captured."
          : ""
      }</p>`
    : ""
}
<table><thead><tr><th>transaction_type</th><th>count</th><th>status</th></tr></thead><tbody>
${typeRows}
</tbody></table>

<h2>Coverage by year</h2>
<p class="muted">A whole year with a large gap points at an un-ingested index.</p>
<table><thead><tr><th>year</th><th>source filings</th><th>have</th><th>missing</th><th>coverage</th></tr></thead><tbody>
${yearRows}
</tbody></table>

${classBlock}

<h2>Missing filings (${r.missing.length.toLocaleString()})</h2>
${capNote}
${
  r.missing.length === 0
    ? "<p>None — every source filing in the scanned window is present in KeyVex.</p>"
    : `<table><thead><tr><th>ptr_id</th><th>year</th><th>member</th>${classHeader}<th>source link</th></tr></thead><tbody>
${missingRows}
</tbody></table>`
}

<h2>Informational: ids in KeyVex but not in the scanned source window</h2>
<p class="muted">${r.extraInKeyvexCount.toLocaleString()} ids KeyVex holds that the scanned index years don’t list
(other years, or filings since removed upstream). Not gaps — shown for completeness.${
    r.extraInKeyvexSample.length
      ? " Sample: " + r.extraInKeyvexSample.map((s) => `<code>${esc(s)}</code>`).join(" ")
      : ""
  }</p>

</body></html>`;
}

// ─── CSV (complete missing list, never truncated) ──────────────────────────────

export function renderCsv(r: ReconResult): string {
  const head = "ptr_id,year,member,class,source_url";
  const rows = r.missing.map((m) => {
    const cells = [
      m.id,
      String(m.meta?.["year"] ?? ""),
      m.label ?? "",
      classOf(m),
      m.url,
    ].map((c) => {
      const s = String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    return cells.join(",");
  });
  return [head, ...rows].join("\n") + "\n";
}

// ─── Markdown (terminal / repo mirror) ─────────────────────────────────────────

export function renderMarkdown(r: ReconResult): string {
  const lines: string[] = [];
  lines.push(`# KeyVex Reconciliation — ${r.title} — G1`);
  lines.push("");
  lines.push(`- generated: ${r.generatedAt}`);
  lines.push(`- collection: \`${r.collection}\``);
  if (r.years) lines.push(`- years scanned: ${r.years[0]}–${r.years[r.years.length - 1]}`);
  lines.push("");
  lines.push(
    `## G1 coverage: ${fmtPct(r.coveragePct)}  (${r.keyvexIdsPresent.toLocaleString()} / ${r.sourceTotal.toLocaleString()} filings; ${r.missing.length.toLocaleString()} missing)`,
  );
  lines.push(r.coveragePct >= 98 ? "meets the ≥98% floor." : "**below the ≥98% floor.**");
  lines.push("");
  if (r.warnings.length) {
    lines.push("### Warnings (surfaced, not silent)");
    for (const w of r.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## Per-type census (no category may silently read zero)");
  lines.push("| transaction_type | count | status |");
  lines.push("|---|--:|---|");
  for (const t of r.typeCounts) {
    const name = t.expected ? t.type : `${t.type} (unexpected)`;
    lines.push(`| ${name} | ${t.count.toLocaleString()} | ${t.present ? "present" : "**READS ZERO**"} |`);
  }
  lines.push("");
  lines.push("## Coverage by year");
  lines.push("| year | source | have | missing | coverage |");
  lines.push("|---|--:|--:|--:|--:|");
  const years = Object.keys({ ...r.sourceByYear, ...r.missingByYear }).sort();
  for (const y of years) {
    const src = r.sourceByYear[y] ?? 0;
    const miss = r.missingByYear[y] ?? 0;
    const have = src - miss;
    const pct = src === 0 ? "—" : fmtPct((have / src) * 100);
    lines.push(`| ${y} | ${src} | ${have} | ${miss} | ${pct} |`);
  }
  lines.push("");
  if (r.classification) {
    lines.push("## Missing classified");
    lines.push(`classified ${r.classifiedCount} of ${r.missing.length}.`);
    lines.push(`- recoverable: ${r.classification.recoverable}`);
    lines.push(`- nil: ${r.classification.nil}`);
    lines.push(`- unreadable: ${r.classification.unreadable}`);
    lines.push(`- gone: ${r.classification.gone}`);
    lines.push(`- unclassified: ${r.classification.unclassified}`);
    if (r.unexplainedMissing !== undefined)
      lines.push(`- **unexplained-missing (target 0): ${r.unexplainedMissing}**`);
    lines.push("");
  } else {
    lines.push("_Missing list unclassified — re-run with `--classify=all`._");
    lines.push("");
  }
  lines.push(`## Missing filings: ${r.missing.length.toLocaleString()} (full list in the .csv; links in the .html)`);
  return lines.join("\n") + "\n";
}
