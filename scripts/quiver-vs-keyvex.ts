/**
 * Quiver vs KeyVex side-by-side benchmark.
 *
 *   npx tsx scripts/quiver-vs-keyvex.ts <TICKER>
 *
 * Pulls the SAME ticker from both:
 *   - Quiver API  : GET /beta/historical/congresstrading/{ticker}  (Bearer QUIVER_API_KEY)
 *   - KeyVex MCP  : get_congressional_trades(ticker)  via mcp.keyvex.com
 * and prints a field-level + count + freshness diff.
 *
 * The Quiver key is read from secrets/.env (QUIVER_API_KEY) and never printed.
 * Endpoints beyond congress trading are added once confirmed from Quiver's API
 * docs — we don't guess endpoints.
 */
import "../src/load-secrets.js";

const ticker = (process.argv[2] || "").toUpperCase();
if (!ticker) {
  console.error("Usage: npx tsx scripts/quiver-vs-keyvex.ts <TICKER>");
  process.exit(1);
}
const KEY = process.env.QUIVER_API_KEY;
if (!KEY) {
  console.error("QUIVER_API_KEY not set in secrets/.env — add it and re-run.");
  process.exit(1);
}

function fieldsOf(rows: Record<string, unknown>[]): string[] {
  const s = new Set<string>();
  for (const r of rows.slice(0, 25)) Object.keys(r).forEach((k) => s.add(k));
  return [...s].sort();
}

async function quiverCongress(tk: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `https://api.quiverquant.com/beta/historical/congresstrading/${tk}`,
    { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Quiver HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as Record<string, unknown>[];
}

async function keyvexCongress(tk: string): Promise<Record<string, unknown>[]> {
  const res = await fetch("https://mcp.keyvex.com/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_congressional_trades", arguments: { ticker: tk, limit: 500 } },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const env = JSON.parse(JSON.parse(line!.slice(6)).result.content[0].text);
  return (env.results ?? []) as Record<string, unknown>[];
}

function maxDate(rows: Record<string, unknown>[], keys: string[]): string {
  let m = "";
  for (const r of rows) for (const k of keys) { const v = String(r[k] ?? ""); if (v > m) m = v; }
  return m || "(none)";
}

async function main() {
  console.log(`\n=== Quiver vs KeyVex — congressional trading — ${ticker} ===\n`);
  const [q, k] = await Promise.all([
    quiverCongress(ticker).catch((e) => { console.error("Quiver error:", e.message); return []; }),
    keyvexCongress(ticker).catch((e) => { console.error("KeyVex error:", e.message); return []; }),
  ]);

  console.log(`QUIVER  rows=${q.length}  latest=${maxDate(q, ["ReportDate", "TransactionDate"])}`);
  console.log(`  fields: ${fieldsOf(q).join(", ")}`);
  if (q[0]) console.log(`  sample: ${JSON.stringify(q[0])}`);
  console.log("");
  console.log(`KEYVEX  rows=${k.length}  latest=${maxDate(k, ["disclosure_date", "transaction_date"])}`);
  console.log(`  fields: ${fieldsOf(k).join(", ")}`);
  if (k[0]) console.log(`  sample: ${JSON.stringify(k[0])}`);
  console.log("");
  console.log("OBSERVATIONS:");
  console.log(`  • row counts: Quiver ${q.length} vs KeyVex ${k.length}`);
  const qf = new Set(fieldsOf(q)), kf = new Set(fieldsOf(k));
  console.log(`  • Quiver-only fields: ${[...qf].filter((f) => !kf.has(f)).join(", ") || "(none)"}`);
  console.log(`  • KeyVex-only fields: ${[...kf].filter((f) => !qf.has(f)).join(", ") || "(none)"}`);
  process.exit(0);
}
main();
