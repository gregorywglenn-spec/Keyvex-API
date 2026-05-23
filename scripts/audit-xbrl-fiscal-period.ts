/**
 * Audit Greg's 2026-05-22 finding: fiscal_period field in xbrl_fundamentals
 * is unreliable. Example: AAPL Revenues row period_start=2018-07-01,
 * period_end=2018-09-29 (~90-day quarter), frame="CY2018Q3" — but
 * fiscal_period="FY". Span and frame both say quarter; fiscal_period says
 * full year.
 *
 * Root cause (verified in xbrl.ts:326): scraper writes
 *   fiscal_period: args.obs.fp ?? ""
 * trusting SEC's filing-level `fp` field. That field describes the
 * FILING TYPE ("10-K" → "FY", "10-Q" → "Q1/Q2/Q3"), not the per-
 * observation period. A 10-K contains BOTH the FY cumulative AND the
 * Q4-standalone observations; SEC tags both with fp="FY" because
 * they're inside a 10-K. fiscal_period is therefore garbage for any
 * agent ratio/margin math that filters or groups by it.
 *
 * This script scans the whole xbrl_fundamentals collection and reports:
 *   - row count
 *   - distribution of (derived_kind, fiscal_period, frame_kind) tuples
 *   - count of CLEAR mismatches (90-day-span row with fp="FY", etc.)
 *   - sample mismatch rows for spot-check
 *
 * Doesn't write anything. Run with:
 *   npx tsx scripts/audit-xbrl-fiscal-period.ts
 */
import { getLiveDb } from "../src/firestore.js";

function deriveKindFromSpan(periodStart: string | null, periodEnd: string | null): string {
  if (!periodStart || !periodEnd) return "TI"; // point-in-time (balance sheet)
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  if (isNaN(start) || isNaN(end)) return "?";
  const days = Math.round((end - start) / 86400000);
  if (days >= 80 && days <= 100) return "Q"; // ~quarter
  if (days >= 175 && days <= 195) return "H"; // ~half-year (rare)
  if (days >= 265 && days <= 285) return "9M"; // ~9-month cumulative YTD
  if (days >= 355 && days <= 380) return "FY"; // ~full year
  return `?${days}d`;
}

function deriveKindFromFrame(frame: string): string {
  if (!frame) return "?";
  // SEC frame format: CY2018, CY2018Q1, CY2018Q1I (instant)
  if (/Q[1-4]I?$/.test(frame)) return "Q";
  if (/^CY\d{4}I?$/.test(frame)) return frame.endsWith("I") ? "TI" : "FY";
  return "?";
}

async function main() {
  const db = await getLiveDb();
  console.log("=== Scanning xbrl_fundamentals (this may take ~2 min) ===");

  let total = 0;
  const tupleCounts = new Map<string, number>();
  const samples: Record<string, Array<Record<string, unknown>>> = {};
  let clearMismatches = 0; // span says quarter, fp says FY (or vice versa)
  let frameDisagrees = 0; // derived span and frame agree but fp disagrees with both

  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  while (true) {
    let q: FirebaseFirestore.Query = db.collection("xbrl_fundamentals").limit(2000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      total++;
      const d = doc.data() as {
        ticker?: string;
        concept?: string;
        period_start?: string | null;
        period_end?: string | null;
        fiscal_period?: string;
        frame?: string;
        form?: string;
      };
      const dk = deriveKindFromSpan(d.period_start ?? null, d.period_end ?? null);
      const fk = deriveKindFromFrame(d.frame ?? "");
      const fp = (d.fiscal_period ?? "").toUpperCase();
      // Normalize fp: SEC uses "FY"/"Q1"/"Q2"/"Q3"/"Q4". Collapse to "FY"/"Q"/"?" for comparison.
      const fpNorm = fp === "FY" ? "FY" : /^Q[1-4]$/.test(fp) ? "Q" : fp === "" ? "?" : fp;
      const tuple = `derived=${dk} frame=${fk} fp=${fpNorm}`;
      tupleCounts.set(tuple, (tupleCounts.get(tuple) ?? 0) + 1);

      // CLEAR mismatch: derived kind is Q OR FY AND fp is the opposite
      if ((dk === "Q" && fpNorm === "FY") || (dk === "FY" && fpNorm === "Q")) {
        clearMismatches++;
        if (dk === fk && dk !== fpNorm) frameDisagrees++;
        const key = `${dk}-vs-${fpNorm}`;
        if (!samples[key]) samples[key] = [];
        if (samples[key].length < 3) {
          samples[key].push({
            ticker: d.ticker,
            concept: d.concept,
            period_start: d.period_start,
            period_end: d.period_end,
            fiscal_period: d.fiscal_period,
            frame: d.frame,
            form: d.form,
          });
        }
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 2000) break;
  }

  console.log(`\n=== TOTAL: ${total.toLocaleString()} xbrl_fundamentals rows ===\n`);

  console.log("Distribution of (derived_kind, frame_kind, fiscal_period_kind) tuples:");
  const sorted = Array.from(tupleCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [tuple, count] of sorted.slice(0, 25)) {
    const pct = ((100 * count) / total).toFixed(1);
    console.log(`  ${count.toString().padStart(7)} (${pct.padStart(5)}%)  ${tuple}`);
  }
  if (sorted.length > 25) {
    console.log(`  ...and ${sorted.length - 25} other less-common tuples`);
  }

  console.log(`\n=== CLEAR MISMATCHES (span says Q but fp=FY, or vice versa) ===`);
  console.log(`  ${clearMismatches.toLocaleString()} rows (${((100 * clearMismatches) / total).toFixed(1)}% of collection)`);
  console.log(`  of those, ${frameDisagrees.toLocaleString()} also disagree with frame (so derived + frame agree, fp is wrong)`);

  console.log(`\n=== SAMPLE MISMATCH ROWS ===`);
  for (const [key, rows] of Object.entries(samples)) {
    console.log(`\n  ${key} (showing first ${rows.length}):`);
    for (const r of rows) {
      const span = r.period_start && r.period_end
        ? Math.round((new Date(r.period_end as string).getTime() - new Date(r.period_start as string).getTime()) / 86400000)
        : "?";
      console.log(`    ${r.ticker} ${r.concept} ${r.period_start}..${r.period_end} span=${span}d fp=${r.fiscal_period} frame=${r.frame} form=${r.form}`);
    }
  }

  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
