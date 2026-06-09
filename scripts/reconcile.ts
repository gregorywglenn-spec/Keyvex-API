/**
 * KeyVex Reconciliation runner — Greg's command.
 *
 * Runs the generic Reconciler against one dataset adapter and writes the
 * Standing Report (HTML + CSV + MD) to docs/reconciliation/. Open the HTML
 * and click the "missing" links to verify — the builder reports the diff,
 * you confirm it against the government's own records.
 *
 * Usage:
 *   npx tsx scripts/reconcile.ts congress-house
 *   npx tsx scripts/reconcile.ts congress-house --years=2014-2026
 *   npx tsx scripts/reconcile.ts congress-house --classify=all      # resolve recoverable/nil/gone (slow)
 *   npx tsx scripts/reconcile.ts congress-house --classify=200      # classify first 200 missing
 *   npx tsx scripts/reconcile.ts --list                             # list adapters
 *
 * Flags:
 *   --years=A-B or A,B,C   years to scan (adapter default if omitted)
 *   --classify=N|all       classify missing by fetching the source doc
 *   --concurrency=N        parallel fetches during classification (default 4)
 *   --out=DIR              output dir (default docs/reconciliation)
 */
import "../src/load-secrets.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter, ADAPTERS } from "../src/reconcile/adapters/index.js";
import { runReconciliation } from "../src/reconcile/reconciler.js";
import {
  renderHtml,
  renderCsv,
  renderMarkdown,
  renderExtrasCsv,
} from "../src/reconcile/report.js";

function arg(k: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
}
function flag(k: string): boolean {
  return process.argv.includes(`--${k}`);
}

function parseYears(s: string | undefined): number[] | undefined {
  if (!s) return undefined;
  if (s.includes("-")) {
    const [a, b] = s.split("-").map((n) => parseInt(n, 10));
    const out: number[] = [];
    for (let y = a!; y <= b!; y++) out.push(y);
    return out;
  }
  return s.split(",").map((n) => parseInt(n, 10));
}

async function main(): Promise<void> {
  if (flag("list") || process.argv.length < 3) {
    console.error("Available adapters:");
    for (const name of Object.keys(ADAPTERS)) {
      console.error(`  ${name}  —  ${ADAPTERS[name]!.title}`);
    }
    console.error("\nUsage: npx tsx scripts/reconcile.ts <adapter> [--years=A-B] [--classify=N|all]");
    return;
  }

  const name = process.argv[2]!;
  const adapter = getAdapter(name);
  if (!adapter) {
    console.error(`Unknown adapter "${name}". Run with --list to see options.`);
    process.exit(1);
  }

  const years = parseYears(arg("years"));
  const classifyRaw = arg("classify");
  const classify =
    classifyRaw === undefined
      ? undefined
      : classifyRaw === "all"
        ? ("all" as const)
        : parseInt(classifyRaw, 10);
  const classifyConcurrency = arg("concurrency")
    ? parseInt(arg("concurrency")!, 10)
    : 4;
  const outDir = arg("out") ?? join("docs", "reconciliation");

  console.error(`[reconcile] running adapter "${name}"…`);
  const result = await runReconciliation(adapter, {
    years,
    classify,
    classifyConcurrency,
  });

  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${name}-G1`);
  writeFileSync(`${base}.html`, renderHtml(result, { urlForId: adapter.urlForId }));
  writeFileSync(`${base}.csv`, renderCsv(result));
  writeFileSync(`${base}.md`, renderMarkdown(result));
  // Stale/extra list (in KeyVex, not in current source) — verifiable list with
  // links. Always written so the count is auditable; for snapshot datasets this
  // is the primary quality signal.
  if (result.extraInKeyvexCount > 0) {
    writeFileSync(
      `${base}-extras.csv`,
      renderExtrasCsv(result, adapter.urlForId),
    );
  }

  // Console summary (the at-a-glance; the HTML is the verifiable artifact).
  console.error("");
  console.error(`══ ${result.title} — G1 ══`);
  console.error(
    `  coverage:  ${result.coveragePct.toFixed(2)}%  (${result.keyvexIdsPresent.toLocaleString()} / ${result.sourceTotal.toLocaleString()} filings)`,
  );
  console.error(`  missing:   ${result.missing.length.toLocaleString()}`);
  console.error(`  records:   ${result.keyvexTotalRecords.toLocaleString()} docs in KeyVex`);
  console.error(
    `  extra:     ${result.extraInKeyvexCount.toLocaleString()} in KeyVex but NOT in current source${
      result.extraInKeyvexCount > 0 ? "  (stale-record signal — see -extras.csv)" : ""
    }`,
  );
  console.error(`  per-type:`);
  for (const t of result.typeCounts) {
    const mark = t.expected && t.count === 0 ? "  ⚠ READS ZERO" : "";
    console.error(`     ${t.type.padEnd(12)} ${t.count.toLocaleString().padStart(10)}${mark}`);
  }
  if (result.classification) {
    console.error(`  classified ${result.classifiedCount}/${result.missing.length}:`);
    console.error(`     recoverable ${result.classification.recoverable}  nil ${result.classification.nil}  unreadable ${result.classification.unreadable}  gone ${result.classification.gone}  unclassified ${result.classification.unclassified}`);
    if (result.unexplainedMissing !== undefined)
      console.error(`     unexplained-missing (target 0): ${result.unexplainedMissing}`);
  }
  if (result.warnings.length) {
    console.error(`  warnings:`);
    for (const w of result.warnings) console.error(`     - ${w}`);
  }
  console.error("");
  console.error(`  report written:`);
  console.error(`     ${base}.html   ← open this, click the links to verify`);
  console.error(`     ${base}.csv    ← complete missing list`);
  console.error(`     ${base}.md`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[reconcile] FATAL:", e);
    process.exit(1);
  });
