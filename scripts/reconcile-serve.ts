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
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";

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

/** Rewrite gov PDF links → localhost /filing (renders to viewable images). */
function localizeLinks(html: string): string {
  return html.replace(
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
        .map(
          (r) =>
            `<li><a href="/filing?u=${encodeURIComponent(r.url)}&rot=0">${esc(r.id)} — ${esc(r.member)}</a></li>`,
        )
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
<h1>Remaining missing House filings — ${rows.length}</h1>
<p class="intro">These are scanned filings where OCR returned nothing (marked <code>nil</code>) — but at least some hold real trades read sideways (e.g. Diane Black). Click one, then use the <b>rotate</b> buttons to straighten it. <a href="/">← G1 report</a></p>
${sections}
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
