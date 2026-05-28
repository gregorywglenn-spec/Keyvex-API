/**
 * Inspect-pilot for the SEC Form 3/4/5 Structured Data Sets.
 *
 * Greg's 2026-05-23 brief: grab ONE quarter (2023q1) first to verify
 * (1) the bulk path actually works under our headers, (2) the AFF10B5ONE
 * field is present in the SUBMISSION table, (3) the column headers
 * across tables before committing to a full-decade load.
 *
 * URL pattern:
 *   https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/YYYYqN_form345.zip
 *
 * Output expectations:
 *   - Confirm download + unzip
 *   - List every file inside the zip + its row count
 *   - Print column headers verbatim for SUBMISSION, NONDERIV_TRANS,
 *     DERIV_TRANS, REPORTINGOWNER, NONDERIV_HOLDING, DERIV_HOLDING,
 *     FOOTNOTES (whichever exist)
 *   - Highlight AFF10B5ONE presence/absence
 *   - DOES NOT write to Firestore
 *
 * After this runs, Greg eyeballs the headers + decides.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";

const QUARTER = process.argv[2] ?? "2023q1";
const ZIP_URL = `https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/${QUARTER}_form345.zip`;
const UA = "KeyVex Research contact@keyvex.com";
// Use a per-quarter scratch dir under /tmp so multiple runs don't collide
const SCRATCH_DIR = path.join(
  process.platform === "win32" ? (process.env.TEMP ?? "C:\\Temp") : "/tmp",
  `keyvex-form345-${QUARTER}`,
);
const ZIP_PATH = path.join(SCRATCH_DIR, `${QUARTER}_form345.zip`);

async function main() {
  console.log("=== Form 3/4/5 Structured Data Sets — inspect pilot ===");
  console.log(`  quarter: ${QUARTER}`);
  console.log(`  url:     ${ZIP_URL}`);
  console.log(`  scratch: ${SCRATCH_DIR}`);
  console.log("");

  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  // ─── 1. Download ─────────────────────────────────────────────────────
  console.log("[1] Downloading...");
  const t0 = Date.now();
  const res = await fetch(ZIP_URL, {
    headers: { "User-Agent": UA, Accept: "application/zip, */*" },
  });
  if (!res.ok) {
    console.error(`  HTTP ${res.status} ${res.statusText}`);
    console.error(`  Response headers: ${JSON.stringify([...res.headers], null, 2)}`);
    const body = await res.text().catch(() => "(could not read body)");
    console.error(`  Body (first 500 chars): ${body.slice(0, 500)}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ZIP_PATH, buf);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  OK — ${buf.length} bytes in ${sec}s`);
  console.log("");

  // ─── 2. Unzip ─────────────────────────────────────────────────────────
  console.log("[2] Unzipping...");
  const zip = new AdmZip(ZIP_PATH);
  const entries = zip.getEntries();
  console.log(`  ${entries.length} entries in archive:`);
  for (const e of entries) {
    console.log(`    ${e.entryName.padEnd(36)}  ${String(e.header.size).padStart(10)} bytes  ${e.header.method}`);
  }
  zip.extractAllTo(SCRATCH_DIR, true);
  console.log(`  extracted to ${SCRATCH_DIR}`);
  console.log("");

  // ─── 3. Locate + parse readme if present ─────────────────────────────
  const allFiles = fs.readdirSync(SCRATCH_DIR);
  const readmeFile = allFiles.find((f) => /readme/i.test(f));
  if (readmeFile) {
    console.log(`[3] Found README: ${readmeFile}`);
    const rp = path.join(SCRATCH_DIR, readmeFile);
    const sz = fs.statSync(rp).size;
    console.log(`    size: ${sz} bytes`);
    if (readmeFile.toLowerCase().endsWith(".txt") || readmeFile.toLowerCase().endsWith(".md")) {
      const txt = fs.readFileSync(rp, "utf8");
      console.log("    First 2000 chars:");
      console.log("    " + txt.slice(0, 2000).split("\n").join("\n    "));
    } else {
      console.log("    (binary readme — open separately if needed)");
    }
    console.log("");
  }

  // ─── 4. Print column headers + counts for each .tsv ──────────────────
  const tsvFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".tsv") || f.toLowerCase().endsWith(".txt"));
  console.log(`[4] Tab-delimited tables (${tsvFiles.length}):`);
  console.log("");
  const PRIORITY = [
    "SUBMISSION",
    "REPORTINGOWNER",
    "NONDERIV_TRANS",
    "DERIV_TRANS",
    "NONDERIV_HOLDING",
    "DERIV_HOLDING",
    "FOOTNOTES",
    "OWNER_SIGNATURE",
  ];
  // Sort: priority first, then alphabetical
  const sorted = tsvFiles.sort((a, b) => {
    const an = a.toUpperCase().replace(/\.(TSV|TXT)$/, "");
    const bn = b.toUpperCase().replace(/\.(TSV|TXT)$/, "");
    const ai = PRIORITY.indexOf(an);
    const bi = PRIORITY.indexOf(bn);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return an.localeCompare(bn);
  });

  // Track if AFF10B5ONE found anywhere
  let aff10b5oneTables: string[] = [];

  for (const f of sorted) {
    const fp = path.join(SCRATCH_DIR, f);
    const sz = fs.statSync(fp).size;
    // Stream-read just enough to get header + a sample row + row count
    const buf = fs.readFileSync(fp, "utf8");
    const lines = buf.split(/\r?\n/);
    const header = lines[0] ?? "";
    const cols = header.split("\t");
    const dataRows = lines.length - 1 - (lines[lines.length - 1] === "" ? 1 : 0);
    console.log(`────────────────────────────────────────────────────`);
    console.log(`${f}  (${sz} bytes, ${dataRows} data rows, ${cols.length} columns)`);
    console.log(`  COLUMNS:`);
    for (const c of cols) console.log(`    - ${c}`);
    if (header.includes("AFF10B5ONE")) {
      aff10b5oneTables.push(f);
    }
    // Show first 2 data rows as a sample
    if (lines.length > 1) {
      console.log(`  SAMPLE ROW 1:`);
      const row1 = (lines[1] ?? "").split("\t");
      for (let i = 0; i < Math.min(cols.length, row1.length); i++) {
        console.log(`    ${cols[i]?.padEnd(28)} = ${(row1[i] ?? "").slice(0, 80)}`);
      }
    }
    console.log("");
  }

  // ─── 5. Headline finding for Greg ────────────────────────────────────
  console.log("====================================================");
  console.log("HEADLINE FINDINGS");
  console.log("====================================================");
  console.log(`  Quarter:               ${QUARTER}`);
  console.log(`  Zip size:              ${buf.length} bytes`);
  console.log(`  Tables (TSV files):    ${tsvFiles.length}`);
  console.log(`  Readme present:        ${readmeFile ?? "NO"}`);
  console.log(
    `  AFF10B5ONE found in:   ${aff10b5oneTables.length > 0 ? aff10b5oneTables.join(", ") : "NOT FOUND in any table"}`,
  );
  console.log(
    `  → 10b5-1 plan flag is ${aff10b5oneTables.length > 0 ? "PRESENT — verify field for Derek's needs" : "ABSENT — the SEC bulk set may not carry it for this quarter"}`,
  );
  console.log("");
  console.log("  Standing by for Greg's review of column lists above");
  console.log("  before deciding load-vs-skip on the remaining 39 quarters.");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
