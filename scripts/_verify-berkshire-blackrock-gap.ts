/**
 * Independent verification of the Berkshire + BlackRock ingestion-gap claims
 * in the v2 handoff. Reads:
 *   - EDGAR submissions API (source of truth for filings)
 *   - Firestore institutional_holdings (what we actually have)
 *
 * READ-ONLY. No writes. No scraper runs.
 */
import { getLiveDb } from "../src/firestore.js";

const USER_AGENT = "KeyVexMCP/0.1 contact@keyvex.com";
const SEC_DATA = "https://data.sec.gov";

interface SubmissionsResponse {
  filings?: {
    recent?: {
      form: string[];
      filingDate: string[];
      reportDate: string[];
      accessionNumber: string[];
    };
  };
}

async function fetchEdgar(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`EDGAR ${res.status} on ${url}`);
  return res.json();
}

async function inspect(name: string, cik: string): Promise<void> {
  console.log(`\n══ ${name} (CIK ${cik}) ══`);

  // 1. What does EDGAR say?
  const subs = (await fetchEdgar(
    `${SEC_DATA}/submissions/CIK${cik}.json`,
  )) as SubmissionsResponse;
  const r = subs.filings?.recent;
  if (!r) {
    console.log("  EDGAR: no recent filings (anomaly — investigate separately)");
    return;
  }

  // List most-recent 13F-HR + 13F-HR/A entries
  const matches: Array<{ form: string; filing: string; report: string; acc: string }> = [];
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i] ?? "";
    if (form === "13F-HR" || form === "13F-HR/A") {
      matches.push({
        form,
        filing: r.filingDate[i] ?? "",
        report: r.reportDate[i] ?? "",
        acc: r.accessionNumber[i] ?? "",
      });
      if (matches.length >= 4) break;
    }
  }
  if (matches.length === 0) {
    console.log("  EDGAR: NO 13F-HR filings in recent set (top 1000 filings probably).");
    return;
  }
  console.log("  EDGAR (most-recent 13F-HR entries):");
  for (const m of matches) {
    console.log(
      `    ${m.form.padEnd(10)} filed=${m.filing}  period=${m.report}  acc=${m.acc}`,
    );
  }

  // 2. What does Firestore have for the periods EDGAR knows about?
  const db = await getLiveDb();
  console.log("  Firestore institutional_holdings counts by quarter:");
  for (const m of matches) {
    const q = m.report; // e.g. "2026-03-31"
    if (!q) continue;
    const snap = await db
      .collection("institutional_holdings")
      .where("fund_cik", "==", cik)
      .where("quarter", "==", q)
      .count()
      .get();
    const c = snap.data().count;
    const mark = c === 0 ? "  ← GAP" : "";
    console.log(`    quarter=${q}: ${c} rows${mark}`);
  }

  // 3. What's the NEWEST quarter we have for this CIK at all?
  const allByCik = await db
    .collection("institutional_holdings")
    .where("fund_cik", "==", cik)
    .orderBy("quarter", "desc")
    .limit(1)
    .get();
  if (allByCik.empty) {
    console.log("  Firestore: zero rows for this CIK anywhere.");
  } else {
    const newestQuarter = (allByCik.docs[0]!.data() as Record<string, unknown>)
      .quarter;
    console.log(`  Firestore: newest quarter in store = ${String(newestQuarter)}`);
  }
}

async function main(): Promise<void> {
  console.log(`Verifying handoff v2's Berkshire + BlackRock claims`);
  console.log(`Current time: ${new Date().toISOString()}`);
  await inspect("Berkshire Hathaway", "0001067983");
  await inspect("BlackRock", "0001364742");
  await inspect("Vanguard Group", "0000102909");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
