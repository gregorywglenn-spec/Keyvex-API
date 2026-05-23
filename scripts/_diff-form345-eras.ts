/**
 * Gate 2 prep — diff column sets across the three sampled SEC bulk Form 3/4/5 eras
 * (2008q1, 2018q1, 2023q1). Reads the .tsv files already extracted by the inspect
 * script (under C:\Temp\keyvex-form345-{quarter}\) and prints a markdown table per
 * table showing era × column presence.
 *
 * No network. No Firestore. Read-only on already-downloaded scratch dirs.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const QUARTERS = ["2008q1", "2018q1", "2023q1"];
const SCRATCH_BASE = process.platform === "win32" ? (process.env.TEMP ?? "C:\\Temp") : "/tmp";

function scratchDir(q: string): string {
  return path.join(SCRATCH_BASE, `keyvex-form345-${q}`);
}

function listTsvFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".tsv"));
}

function readHeader(fp: string): string[] {
  const fd = fs.openSync(fp, "r");
  const buf = Buffer.alloc(64 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const text = buf.slice(0, n).toString("utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.split("\t");
}

function countDataRows(fp: string): number {
  // Stream count newlines (minus 1 for header)
  const sz = fs.statSync(fp).size;
  let lines = 0;
  const fd = fs.openSync(fp, "r");
  const buf = Buffer.alloc(1024 * 1024);
  let pos = 0;
  while (pos < sz) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    for (let i = 0; i < n; i++) if (buf[i] === 0x0a) lines++;
    pos += n;
  }
  fs.closeSync(fd);
  // Subtract 1 for header; subtract another 1 if file ends without newline (rare)
  return Math.max(0, lines - 1);
}

// table -> { columns: Set<string per era>, rowCount per era }
type Era = (typeof QUARTERS)[number];
interface TableInfo {
  columnsByEra: Map<Era, string[]>;
  rowsByEra: Map<Era, number>;
}

const byTable = new Map<string, TableInfo>();

console.log("=== Gate 2 — column-set diff across 2008q1 / 2018q1 / 2023q1 ===");
console.log("");

for (const q of QUARTERS) {
  const dir = scratchDir(q);
  const tsvs = listTsvFiles(dir);
  if (tsvs.length === 0) {
    console.error(`  ${q}: NO TSVs found at ${dir} — did inspect script run for this quarter?`);
    continue;
  }
  for (const f of tsvs) {
    const tableKey = f.toUpperCase().replace(/\.TSV$/, "");
    const fp = path.join(dir, f);
    const cols = readHeader(fp);
    const rows = countDataRows(fp);
    if (!byTable.has(tableKey)) byTable.set(tableKey, { columnsByEra: new Map(), rowsByEra: new Map() });
    const info = byTable.get(tableKey)!;
    info.columnsByEra.set(q, cols);
    info.rowsByEra.set(q, rows);
  }
}

// Sort tables in our preferred order
const TABLE_ORDER = [
  "SUBMISSION",
  "REPORTINGOWNER",
  "NONDERIV_TRANS",
  "DERIV_TRANS",
  "NONDERIV_HOLDING",
  "DERIV_HOLDING",
  "FOOTNOTES",
  "OWNER_SIGNATURE",
];
const sortedTables = [...byTable.keys()].sort((a, b) => {
  const ai = TABLE_ORDER.indexOf(a);
  const bi = TABLE_ORDER.indexOf(b);
  if (ai >= 0 && bi >= 0) return ai - bi;
  if (ai >= 0) return -1;
  if (bi >= 0) return 1;
  return a.localeCompare(b);
});

// Print row-count summary first
console.log("## Row-count summary by era");
console.log("");
console.log(`| Table | 2008q1 | 2018q1 | 2023q1 |`);
console.log(`|---|---:|---:|---:|`);
for (const t of sortedTables) {
  const info = byTable.get(t)!;
  const r08 = info.rowsByEra.get("2008q1") ?? "—";
  const r18 = info.rowsByEra.get("2018q1") ?? "—";
  const r23 = info.rowsByEra.get("2023q1") ?? "—";
  console.log(`| ${t} | ${r08.toLocaleString()} | ${r18.toLocaleString()} | ${r23.toLocaleString()} |`);
}
console.log("");

// Then per-table column diff
for (const t of sortedTables) {
  const info = byTable.get(t)!;
  // Build the union of all columns across eras, in 2023q1 order if available, else 2018q1, else 2008q1
  const orderBasis =
    info.columnsByEra.get("2023q1") ?? info.columnsByEra.get("2018q1") ?? info.columnsByEra.get("2008q1") ?? [];
  const seen = new Set<string>(orderBasis);
  const ordered = [...orderBasis];
  for (const q of QUARTERS) {
    const cols = info.columnsByEra.get(q) ?? [];
    for (const c of cols) {
      if (!seen.has(c)) {
        seen.add(c);
        ordered.push(c);
      }
    }
  }

  const sets = new Map<Era, Set<string>>();
  for (const q of QUARTERS) sets.set(q, new Set(info.columnsByEra.get(q) ?? []));

  // Identify whether the table is stable (all eras have the same column set)
  const colsByEraArr = QUARTERS.map((q) => info.columnsByEra.get(q) ?? []);
  const allPresent = colsByEraArr.every((c) => c.length > 0);
  const stable =
    allPresent &&
    colsByEraArr.every((c, i, arr) => {
      if (i === 0) return true;
      const a = new Set(arr[0]);
      const b = new Set(c);
      if (a.size !== b.size) return false;
      for (const x of a) if (!b.has(x)) return false;
      return true;
    });

  console.log("");
  console.log(`## ${t}${stable ? "  ✓ stable across all 3 eras" : "  ⚠ DIFFERS across eras"}`);
  console.log("");
  console.log(`| Column | 2008q1 | 2018q1 | 2023q1 |`);
  console.log(`|---|:--:|:--:|:--:|`);
  for (const c of ordered) {
    const r = QUARTERS.map((q) => (sets.get(q)?.has(c) ? "✓" : "—")).join(" | ");
    console.log(`| ${c} | ${r} |`);
  }
}

// AFF10B5ONE callout
console.log("");
console.log("## AFF10B5ONE (10b5-1 plan flag)");
console.log("");
for (const q of QUARTERS) {
  const info = byTable.get("SUBMISSION");
  const present = info?.columnsByEra.get(q)?.includes("AFF10B5ONE") ?? false;
  console.log(`  ${q}: ${present ? "PRESENT" : "ABSENT"}`);
}
