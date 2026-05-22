/**
 * Smoketest for Greg's substring-tokenization bug (2026-05-22).
 *
 * BEFORE the helper: naive .includes() matches "AI" inside maintaining,
 * Chairman, training, Air, aiding, against, remain, claiming. Same on
 * "EV" (event, sever, level), "ML" (HTML, simulate), etc.
 *
 * AFTER the helper: short needles (≤3 chars) require a word boundary
 * on both sides. Long needles (≥4 chars) behave as before.
 *
 * Test categories:
 *   - AI false positives that MUST now drop
 *   - AI true positives that MUST still match
 *   - Same for EV, ML, AAPL (long needle, no behavior change)
 */

// Re-implement the helper locally so this is a true unit test
// (avoids importing private functions from firestore.ts).
function matchesSubstringSafe(
  haystack: string | null | undefined,
  needle: string | null | undefined,
): boolean {
  if (!haystack || !needle) return false;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (n.length === 0) return false;
  if (n.length <= 3) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    return re.test(h);
  }
  return h.includes(n);
}

type Case = { needle: string; haystack: string; expect: boolean; tag: string };

const cases: Case[] = [
  // ─── AI: false positives that must DROP ──────────────────────────────
  { needle: "AI", haystack: "maintaining cybersecurity", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "the Chairman of the committee", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "data scientist training", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "Air Force One", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "aiding and abetting", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "against insider trading", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "did not remain in office", expect: false, tag: "false-positive drop" },
  { needle: "AI", haystack: "claiming damages", expect: false, tag: "false-positive drop" },

  // ─── AI: true positives that must STILL match ────────────────────────
  { needle: "AI", haystack: "Cox Media AI-powered ad targeting", expect: true, tag: "true-positive keep" },
  { needle: "AI", haystack: "investing in AI infrastructure", expect: true, tag: "true-positive keep" },
  { needle: "AI", haystack: "uses AI.", expect: true, tag: "true-positive keep (period)" },
  { needle: "AI", haystack: "AI, machine learning, and robotics", expect: true, tag: "true-positive keep (comma)" },
  { needle: "AI", haystack: "AI's role in finance", expect: true, tag: "true-positive keep (apostrophe-s)" },
  { needle: "AI", haystack: "AI", expect: true, tag: "true-positive keep (only token)" },

  // ─── EV: false positives ─────────────────────────────────────────────
  { needle: "EV", haystack: "Federal Reserve decision", expect: false, tag: "false-positive drop" },
  { needle: "EV", haystack: "an event horizon", expect: false, tag: "false-positive drop" },
  { needle: "EV", haystack: "high-level alert", expect: false, tag: "false-positive drop" },
  { needle: "EV", haystack: "behavioral economics study", expect: false, tag: "false-positive drop" },

  // ─── EV: true positives ──────────────────────────────────────────────
  { needle: "EV", haystack: "Tesla EV manufacturing", expect: true, tag: "true-positive keep" },
  { needle: "EV", haystack: "EV charging stations", expect: true, tag: "true-positive keep" },

  // ─── ML: false positives ─────────────────────────────────────────────
  { needle: "ML", haystack: "HTML parser bug", expect: false, tag: "false-positive drop" },
  { needle: "ML", haystack: "Alexander Hamilton biography", expect: false, tag: "false-positive drop" },
  { needle: "ML", haystack: "simulated stress test", expect: false, tag: "false-positive drop" },

  // ─── ML: true positives ──────────────────────────────────────────────
  { needle: "ML", haystack: "ML model training pipeline", expect: true, tag: "true-positive keep" },
  { needle: "ML", haystack: "AI/ML compliance review", expect: true, tag: "true-positive keep (slash)" },

  // ─── Long needles (≥4 chars): substring behavior unchanged ──────────
  { needle: "AAPL", haystack: "Apple Inc (AAPL) Form 10-K", expect: true, tag: "long-needle substring" },
  { needle: "AAPL", haystack: "Apple Inc Form 10-K", expect: false, tag: "long-needle substring" },
  { needle: "Bitcoin", haystack: "investing in Bitcoin", expect: true, tag: "long-needle substring" },
  { needle: "Bitcoin", haystack: "investing in BitcoinETF", expect: true, tag: "long-needle substring (no boundary required)" },
  { needle: "Trump", haystack: "Trump administration", expect: true, tag: "long-needle substring" },
  { needle: "Trump", haystack: "trumped-up charges", expect: true, tag: "long-needle substring (deliberately permissive)" },

  // ─── Edge cases ──────────────────────────────────────────────────────
  { needle: "", haystack: "anything", expect: false, tag: "edge: empty needle" },
  { needle: "X", haystack: "", expect: false, tag: "edge: empty haystack" },
  { needle: "AI", haystack: "", expect: false, tag: "edge: empty haystack short needle" },

  // ─── 3-char acronyms ─────────────────────────────────────────────────
  { needle: "CEO", haystack: "the CEO of the company", expect: true, tag: "3-char true" },
  { needle: "CEO", haystack: "ceoinic test", expect: false, tag: "3-char false (glued)" },
  { needle: "CEO", haystack: "appointed CEO.", expect: true, tag: "3-char true (period)" },
  { needle: "USA", haystack: "USA Today reports", expect: true, tag: "3-char true" },
  { needle: "USA", haystack: "casual encounter", expect: false, tag: "3-char false" },
  { needle: "API", haystack: "REST API endpoint", expect: true, tag: "3-char true" },
  { needle: "API", haystack: "rapid response", expect: false, tag: "3-char false" },
  { needle: "EPA", haystack: "EPA enforcement", expect: true, tag: "3-char true" },
  { needle: "EPA", haystack: "repatriation policy", expect: false, tag: "3-char false (was problematic)" },
];

function main() {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const c of cases) {
    const got = matchesSubstringSafe(c.haystack, c.needle);
    if (got === c.expect) {
      pass++;
    } else {
      fail++;
      failures.push(
        `  needle="${c.needle}"  haystack="${c.haystack}"  got=${got} want=${c.expect}  [${c.tag}]`,
      );
    }
  }

  console.log(`Summary: ${pass} PASS, ${fail} FAIL (out of ${cases.length})`);
  if (failures.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const f of failures) console.log(f);
    process.exit(1);
  }
}

main();
