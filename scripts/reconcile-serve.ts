/**
 * Local viewer for reconciliation reports — works inside the localhost-only
 * preview pane.
 *
 * Why this exists: the preview can only load `localhost`, and the report's
 * "missing" links point at disclosures-clerk.house.gov (blocked in preview).
 * Worse, the preview pane can't render a raw PDF inline (it shows an empty
 * window). So this server:
 *   - serves the generated G1 HTML,
 *   - rewrites every House Clerk PDF link to a localhost `/filing` route that
 *     fetches the real government PDF server-side, RENDERS it to PNG images,
 *     and wraps them in an HTML page the preview CAN display — so you see the
 *     actual government document, visually, over localhost,
 *   - keeps `/proxy` for the raw PDF bytes (download / external browser),
 *   - serves the complete missing list at `/csv`.
 *
 * /filing and /proxy only ever fetch from disclosures-clerk.house.gov — not an
 * open proxy.
 *
 * Usage:
 *   npx tsx scripts/reconcile-serve.ts                 # serves congress-house-G1
 *   npx tsx scripts/reconcile-serve.ts --report=congress-house-G1 --port=7878
 */
import "../src/load-secrets.js";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import * as cheerio from "cheerio";
import { createSession } from "../src/scrapers/senate.js";
import { getLiveDb } from "../src/firestore.js";

const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

// Port precedence: --port flag, then $PORT (the preview system injects this),
// then a default. The preview pane controls the port via $PORT.
const PORT = arg("port")
  ? parseInt(arg("port")!, 10)
  : process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : 7878;
const REPORT = arg("report") ?? "congress-house-G1";
const DIR = arg("dir") ?? join("docs", "reconciliation");
const ALLOWED_HOST = "disclosures-clerk.house.gov";
const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const MAX_RENDER_PAGES = 12;

const htmlPath = join(DIR, `${REPORT}.html`);
if (!existsSync(htmlPath)) {
  console.error(`Report not found: ${htmlPath}`);
  console.error(`Run:  npx tsx scripts/reconcile.ts congress-house --classify=all`);
  process.exit(1);
}

/**
 * Rewrite gov links → localhost routes so the preview (localhost-only) can open
 * them. House PDFs → /filing (rendered to images). Senate eFD PTR pages →
 * /senate-ptr (fetched through an authenticated session + rendered as a table).
 */
function localizeLinks(html: string): string {
  return html
    .replace(
      /https:\/\/efdsearch\.senate\.gov\/search\/view\/ptr\/([a-f0-9-]+)\/?/g,
      (_u, id) => `/senate-ptr?id=${id}`,
    )
    .replace(
      /https:\/\/disclosures-clerk\.house\.gov\/[^\s"'<>]+/g,
      (u) => `/filing?u=${encodeURIComponent(u)}`,
    );
}

function validateGovUrl(target: string): URL | null {
  try {
    const parsed = new URL(target);
    return parsed.hostname === ALLOWED_HOST ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchGovPdf(parsed: URL): Promise<Buffer | { status: number }> {
  const upstream = await fetch(parsed.toString(), {
    headers: { "User-Agent": UA },
  });
  if (!upstream.ok) return { status: upstream.status };
  return Buffer.from(await upstream.arrayBuffer());
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Parse the missing CSV into rows (for the /missing list + prev/next nav). */
interface MissingRow {
  id: string;
  year: string;
  member: string;
  url: string;
}
function loadMissing(): MissingRow[] {
  const csvPath = join(DIR, `${REPORT}.csv`);
  if (!existsSync(csvPath)) return [];
  const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1);
  const rows: MissingRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // columns: ptr_id,year,member,class,source_url  (member has no comma)
    const parts = line.split(",");
    if (parts.length < 5) continue;
    rows.push({
      id: parts[0]!,
      year: parts[1]!,
      member: parts[2]!,
      url: parts.slice(4).join(","),
    });
  }
  return rows;
}

/** Render PDF pages to base64 PNGs at a given clockwise rotation + base px. */
function renderPdfImages(
  buf: Buffer,
  rotCW: number,
  basePx = 1400,
): { imgs: string[]; pages: number; error?: string } {
  try {
    const doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
    const total = doc.countPages();
    const n = Math.min(total, MAX_RENDER_PAGES);
    const imgs: string[] = [];
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      const scale = basePx / Math.max(b[2] - b[0], b[3] - b[1]);
      let mtx = mupdf.Matrix.scale(scale, scale);
      const r = ((rotCW % 360) + 360) % 360;
      if (r) mtx = mupdf.Matrix.concat(mtx, mupdf.Matrix.rotate(r));
      const pix = page.toPixmap(mtx, mupdf.ColorSpace.DeviceRGB, false, true);
      imgs.push(
        `<img src="data:image/png;base64,${Buffer.from(pix.asPNG()).toString("base64")}" alt="page ${i + 1}">`,
      );
    }
    return { imgs, pages: total };
  } catch (e) {
    return { imgs: [], pages: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Render one filing as a viewable page: rotate controls (server-side, so the
 * sideways scans straighten cleanly) + prev/next through the missing list.
 */
function renderFilingHtml(
  buf: Buffer,
  sourceUrl: string,
  rotCW: number,
  zoom: number,
  nav: { idx: number; total: number; prev?: string; next?: string; label?: string },
): string {
  const basePx = Math.round(1400 * zoom);
  const { imgs, pages, error } = renderPdfImages(buf, rotCW, basePx);
  const note = error
    ? `<p class="note">Could not render (${esc(error)}). Raw PDF: <a href="/proxy?u=${encodeURIComponent(sourceUrl)}">bytes</a>.</p>`
    : pages > MAX_RENDER_PAGES
      ? `<p class="note">Showing first ${MAX_RENDER_PAGES} of ${pages} pages.</p>`
      : "";
  const u = encodeURIComponent(sourceUrl);
  const rotBtn = (deg: number) =>
    `<a class="btn${deg === rotCW ? " on" : ""}" href="/filing?u=${u}&rot=${deg}&zoom=${zoom}">${deg}°</a>`;
  const zoomBtn = (z: number) =>
    `<a class="btn${z === zoom ? " on" : ""}" href="/filing?u=${u}&rot=${rotCW}&zoom=${z}">${z}×</a>`;
  const navBtn = (href: string | undefined, label: string) =>
    href
      ? `<a class="btn" href="${href}">${label}</a>`
      : `<span class="btn off">${label}</span>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(nav.label ?? "House Clerk filing")}</title>
<style>
  body{margin:0;background:#333;color:#eee;font:14px -apple-system,Segoe UI,sans-serif}
  .bar{padding:.55rem .8rem;background:#222;position:sticky;top:0;border-bottom:1px solid #555;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}
  .bar .sp{flex:1}
  a{color:#6ab0ff}
  .btn{display:inline-block;padding:.25rem .6rem;border:1px solid #6ab0ff55;border-radius:6px;text-decoration:none;color:#cfe6ff}
  .btn.on{background:#6ab0ff;color:#08233f;font-weight:700}
  .btn.off{opacity:.4;border-color:#666}
  .lab{font-weight:600}
  img{display:block;width:100%;max-width:${Math.round(1100 * zoom)}px;margin:1rem auto;background:#fff;box-shadow:0 2px 8px #0008}
  .note{padding:.5rem 1rem;color:#f5b041}
</style></head><body>
<div class="bar">
  <span class="lab">${esc(nav.label ?? "")}</span>
  <span class="muted">(${nav.idx}/${nav.total})</span>
  <span style="margin-left:.5rem">rotate:</span> ${rotBtn(0)} ${rotBtn(90)} ${rotBtn(180)} ${rotBtn(270)}
  <span style="margin-left:.5rem">zoom:</span> ${zoomBtn(1)} ${zoomBtn(2)} ${zoomBtn(3)}
  <span class="sp"></span>
  ${navBtn(nav.prev, "← prev")} ${navBtn(nav.next, "next →")}
  <a class="btn" href="/missing">list</a>
  <a class="btn" href="${esc(sourceUrl)}" target="_blank" rel="noopener">gov ↗</a>
</div>
${note}
${imgs.length ? imgs.join("\n") : '<p class="note">No pages rendered.</p>'}
</body></html>`;
}

/** The 79-filing worklist index page. */
function renderMissingList(): string {
  const rows = loadMissing();
  const byYear: Record<string, MissingRow[]> = {};
  for (const r of rows) (byYear[r.year] ??= []).push(r);
  const sections = Object.keys(byYear)
    .sort()
    .map((y) => {
      const items = byYear[y]!
        .map((r) => {
          const href = r.url.includes("efdsearch.senate.gov")
            ? `/senate-ptr?id=${r.id}`
            : `/filing?u=${encodeURIComponent(r.url)}&rot=0`;
          return `<li><a href="${href}">${esc(r.id)} — ${esc(r.member)}</a></li>`;
        })
        .join("\n");
      return `<h2>${esc(y)} <span class="muted">(${byYear[y]!.length})</span></h2><ul>${items}</ul>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remaining missing — ${rows.length}</title>
<style>
  body{margin:0;background:#1c1c1c;color:#eee;font:15px -apple-system,Segoe UI,sans-serif;padding:1.2rem 1.5rem;max-width:900px}
  h1{font-size:1.3rem} h2{font-size:1rem;border-bottom:1px solid #555;padding-bottom:.2rem;margin-top:1.4rem}
  a{color:#6ab0ff} ul{line-height:1.9;margin:.3rem 0} .muted{color:#888}
  .intro{background:#f39c1218;border:1px solid #f39c12;padding:.7rem 1rem;border-radius:8px;color:#f5c97a}
</style></head><body>
<h1>Remaining missing filings — ${rows.length}</h1>
<p class="intro">${
    REPORT.includes("senate")
      ? "Senate PTRs the eFD index lists that KeyVex lacks. Click one — it's fetched live from the eFD and shown as a table, with each row flagged <b>kept</b> vs <b>DROPPED</b> (non-equity / exchange) so you can see why it's missing."
      : "Scanned filings where OCR returned nothing — but some hold real trades read sideways (e.g. Diane Black). Click one, then use the <b>rotate</b> buttons to straighten it."
  } <a href="/">← G1 report</a></p>
${sections}
</body></html>`;
}

// ─── Senate eFD PTR viewer (authenticated fetch + table render) ───────────────

let efdSession: { fetch: typeof fetch; csrfToken: string } | null = null;
async function getEfdSession(force = false): Promise<{ fetch: typeof fetch }> {
  if (efdSession && !force) return efdSession;
  efdSession = await createSession();
  return efdSession;
}

function srcDateToISO(d: string): string {
  const m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return d;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/**
 * Source-vs-stored verifier for one Senate PTR. Fetches the eFD detail page
 * (agreement-gated session) AND queries what KeyVex now stores for that ptr_id,
 * then renders BOTH tables so the capture-all re-scrape can be checked against
 * the government source row-for-row. Each eFD source row is flagged ✓ in KeyVex
 * / ✗ missing by matching ticker + date + amount.
 */
async function renderSenatePtrHtml(
  ptrId: string,
  nav: { idx: number; total: number; prev?: string; next?: string; label?: string },
): Promise<string> {
  const detailUrl = `https://efdsearch.senate.gov/search/view/ptr/${ptrId}/`;
  let html = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const s = await getEfdSession(attempt > 0);
      const res = await s.fetch(detailUrl, {
        headers: {
          "User-Agent": "KeyVexMCP/0.1 contact@keyvex.com",
          Referer: "https://efdsearch.senate.gov/search/",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
      break;
    } catch (e) {
      if (attempt >= 1)
        return `<p style="color:#f5b041;padding:1rem">Could not load PTR ${esc(ptrId)} (${esc(e instanceof Error ? e.message : String(e))}). <a href="${esc(detailUrl)}" target="_blank">open at eFD ↗</a></p>`;
    }
  }

  // KeyVex side: what we stored for this filing.
  const db = await getLiveDb();
  const stored = (
    await db.collection("congressional_trades").where("ptr_id", "==", ptrId).get()
  ).docs.map((d) => d.data() as Record<string, unknown>);
  const storedKeys = new Set(
    stored.map(
      (t) =>
        `${String(t.ticker ?? "").toUpperCase()}|${t.transaction_date}|${t.amount_range}`,
    ),
  );

  const $ = cheerio.load(html);
  const isPaper = /\.pdf|embed|paper/i.test(html) && $("table tr").length < 2;
  const srcRows: string[] = [];
  let srcCount = 0,
    matched = 0;
  $("table tr").each((i, row) => {
    if (i === 0) return;
    const cells = $(row)
      .find("td")
      .map((_, td) => $(td).text().trim())
      .get();
    if (cells.length < 8) return;
    srcCount++;
    const ticker = (cells[3] ?? "").toUpperCase().trim();
    const key = `${ticker}|${srcDateToISO(cells[1] ?? "")}|${cells[7] ?? ""}`;
    const inKv = storedKeys.has(key);
    if (inKv) matched++;
    const status = inKv
      ? '<span style="color:#3fb950">✓ in KeyVex</span>'
      : '<span style="color:#f85149">✗ missing</span>';
    srcRows.push(
      `<tr><td>${esc(cells[1] ?? "")}</td><td>${esc(cells[2] ?? "")}</td><td>${esc(ticker)}</td><td>${esc(cells[4] ?? "")}</td><td>${esc(cells[5] ?? "")}</td><td>${esc(cells[6] ?? "")}</td><td>${esc(cells[7] ?? "")}</td><td>${status}</td></tr>`,
    );
  });

  const storedRows = stored
    .map(
      (t) =>
        `<tr><td>${esc(String(t.transaction_date ?? ""))}</td><td>${esc(String(t.owner ?? ""))}</td><td>${esc(String(t.ticker ?? ""))}</td><td>${esc(String(t.asset_name ?? ""))}</td><td>${esc(String(t.asset_type ?? ""))}</td><td>${esc(String(t.transaction_type ?? ""))}</td><td>${esc(String(t.amount_range ?? ""))}</td></tr>`,
    )
    .join("");

  const navBtn = (href: string | undefined, label: string) =>
    href ? `<a class="btn" href="${href}">${label}</a>` : `<span class="btn off">${label}</span>`;
  const allMatch = srcCount > 0 && matched === srcCount;
  const summary = isPaper
    ? '<p class="note">Looks like a PAPER PTR (PDF amendment) — no HTML trade table.</p>'
    : `<p class="note">eFD source: <b>${srcCount}</b> rows · KeyVex stored: <b>${stored.length}</b> · matched: <b style="color:${allMatch ? "#3fb950" : "#f5b041"}">${matched}/${srcCount}</b>${allMatch ? " ✓ complete" : srcCount > matched ? " — some source rows not matched (check ✗ below; may be parse/format diff)" : ""}.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(nav.label ?? ptrId)}</title>
<style>
  body{margin:0;background:#1c1c1c;color:#eee;font:14px -apple-system,Segoe UI,sans-serif}
  .bar{padding:.55rem .8rem;background:#222;position:sticky;top:0;border-bottom:1px solid #555;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}
  .bar .sp{flex:1}
  a{color:#6ab0ff}
  .btn{display:inline-block;padding:.25rem .6rem;border:1px solid #6ab0ff55;border-radius:6px;text-decoration:none;color:#cfe6ff}
  .btn.off{opacity:.4;border-color:#666}
  .lab{font-weight:600}
  h3{margin:1rem .8rem .2rem;font-size:.95rem}
  table{border-collapse:collapse;width:100%;margin:.3rem 0}
  th,td{border:1px solid #444;padding:.35rem .5rem;text-align:left;font-size:13px;vertical-align:top}
  th{background:#2a2a2a}
  .note{padding:.5rem .8rem;color:#f5b041}
</style></head><body>
<div class="bar">
  <span class="lab">${esc(nav.label ?? "")}</span><span class="muted">(${nav.idx}/${nav.total})</span>
  <span class="sp"></span>
  ${navBtn(nav.prev, "← prev")} ${navBtn(nav.next, "next →")}
  <a class="btn" href="/senate-all">all</a>
  <a class="btn" href="${esc(detailUrl)}" target="_blank" rel="noopener">eFD ↗</a>
</div>
${summary}
<h3>eFD source (government record)</h3>
${srcRows.length ? `<table><thead><tr><th>tx date</th><th>owner</th><th>ticker</th><th>asset</th><th>asset type</th><th>tx</th><th>amount</th><th>in KeyVex?</th></tr></thead><tbody>${srcRows.join("")}</tbody></table>` : '<p class="note">No source rows parsed (paper PTR or unexpected layout).</p>'}
<h3>KeyVex stored (${stored.length})</h3>
${storedRows ? `<table><thead><tr><th>tx date</th><th>owner</th><th>ticker</th><th>asset</th><th>asset type</th><th>type</th><th>amount</th></tr></thead><tbody>${storedRows}</tbody></table>` : '<p class="note">KeyVex stores nothing for this ptr_id.</p>'}
</body></html>`;
}

/** Browse list of ALL Senate filings KeyVex holds (from Firestore). */
let senateAllCache: { id: string; member: string; date: string }[] | null = null;
async function loadSenateAll(): Promise<{ id: string; member: string; date: string }[]> {
  if (senateAllCache) return senateAllCache;
  const db = await getLiveDb();
  const snap = await db
    .collection("congressional_trades")
    .where("chamber", "==", "senate")
    .select("ptr_id", "member_name", "disclosure_date")
    .get();
  const byId = new Map<string, { id: string; member: string; date: string }>();
  for (const d of snap.docs) {
    const t = d.data() as Record<string, unknown>;
    const id = String(t.ptr_id ?? "");
    if (id && !byId.has(id))
      byId.set(id, {
        id,
        member: String(t.member_name ?? ""),
        date: String(t.disclosure_date ?? ""),
      });
  }
  senateAllCache = [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  return senateAllCache;
}
async function renderSenateAllList(): Promise<string> {
  const all = await loadSenateAll();
  const items = all
    .map(
      (r) =>
        `<li><a href="/senate-ptr?id=${r.id}">${esc(r.date)} — ${esc(r.member)}</a> <span class="muted">${esc(r.id)}</span></li>`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Senate filings — ${all.length}</title>
<style>
  body{margin:0;background:#1c1c1c;color:#eee;font:14px -apple-system,Segoe UI,sans-serif;padding:1rem 1.3rem;max-width:900px}
  h1{font-size:1.2rem} a{color:#6ab0ff} ul{line-height:1.8} .muted{color:#777;font-size:12px}
</style></head><body>
<h1>All Senate filings KeyVex holds — ${all.length}</h1>
<p class="muted">Newest first. Click any to see the eFD source vs what KeyVex stored. <a href="/">← G1 report</a></p>
<ul>${items}</ul>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/" || url.pathname === `/${REPORT}.html`) {
    const html = localizeLinks(readFileSync(htmlPath, "utf8"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/csv") {
    const csvPath = join(DIR, `${REPORT}.csv`);
    if (!existsSync(csvPath)) {
      res.writeHead(404).end("csv not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(readFileSync(csvPath, "utf8"));
    return;
  }

  // The remaining-missing worklist index.
  if (url.pathname === "/missing") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderMissingList());
    return;
  }

  // Browse list of ALL Senate filings KeyVex holds.
  if (url.pathname === "/senate-all") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await renderSenateAllList());
    return;
  }

  // Render a Senate eFD PTR: eFD source vs KeyVex stored (verifier).
  if (url.pathname === "/senate-ptr") {
    const id = (url.searchParams.get("id") ?? "").trim();
    if (!/^[a-f0-9-]{8,}$/i.test(id)) {
      res.writeHead(400).end("bad ptr id");
      return;
    }
    // Prev/next nav over the full filing list (the missing list is empty now).
    const all = await loadSenateAll();
    const idx = all.findIndex((m) => m.id === id);
    const cur = idx >= 0 ? all[idx] : undefined;
    const nav = {
      idx: idx >= 0 ? idx + 1 : 0,
      total: all.length,
      prev: idx > 0 ? `/senate-ptr?id=${all[idx - 1]!.id}` : undefined,
      next:
        idx >= 0 && idx < all.length - 1
          ? `/senate-ptr?id=${all[idx + 1]!.id}`
          : undefined,
      label: cur ? `${cur.member} (${cur.date})` : `PTR ${id}`,
    };
    try {
      const out = await renderSenatePtrHtml(id, nav);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(out);
    } catch (e) {
      res.writeHead(502).end(`error: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }

  // Render a gov PDF to a viewable HTML page of images (rotatable + nav).
  if (url.pathname === "/filing") {
    const parsed = validateGovUrl(url.searchParams.get("u") ?? "");
    if (!parsed) {
      res.writeHead(403).end("only disclosures-clerk.house.gov is allowed");
      return;
    }
    const rot = parseInt(url.searchParams.get("rot") ?? "0", 10) || 0;
    const zoom = Math.min(4, Math.max(1, parseInt(url.searchParams.get("zoom") ?? "1", 10) || 1));
    // Locate this filing in the missing list for prev/next + a human label.
    const missing = loadMissing();
    const here = parsed.toString();
    const idx = missing.findIndex((m) => here.includes(m.id));
    const cur = idx >= 0 ? missing[idx] : undefined;
    const nav = {
      idx: idx >= 0 ? idx + 1 : 0,
      total: missing.length,
      prev:
        idx > 0
          ? `/filing?u=${encodeURIComponent(missing[idx - 1]!.url)}&rot=0`
          : undefined,
      next:
        idx >= 0 && idx < missing.length - 1
          ? `/filing?u=${encodeURIComponent(missing[idx + 1]!.url)}&rot=0`
          : undefined,
      label: cur ? `${cur.id} — ${cur.member} (${cur.year})` : "House Clerk filing",
    };
    try {
      const buf = await fetchGovPdf(parsed);
      if (!Buffer.isBuffer(buf)) {
        res.writeHead(buf.status).end(`upstream ${buf.status}`);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderFilingHtml(buf, here, rot, zoom, nav));
    } catch (e) {
      res.writeHead(502).end(`error: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }

  // Raw PDF bytes (download / external browser).
  if (url.pathname === "/proxy") {
    const parsed = validateGovUrl(url.searchParams.get("u") ?? "");
    if (!parsed) {
      res.writeHead(403).end("only disclosures-clerk.house.gov is proxied");
      return;
    }
    try {
      const buf = await fetchGovPdf(parsed);
      if (!Buffer.isBuffer(buf)) {
        res.writeHead(buf.status).end(`upstream ${buf.status}`);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline",
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(502).end(`proxy error: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[reconcile-serve] serving ${REPORT} at http://localhost:${PORT}/`);
  console.error(`[reconcile-serve] gov PDFs rendered to images via /filing`);
});
