/**
 * FORM D (private placements) BULK BACKFILL — SEC Form D Data Sets, 2016+.
 *
 *   npx tsx scripts/backfill-formd-bulk.ts            # 2016q1 → 2026q1
 *   npx tsx scripts/backfill-formd-bulk.ts --dry --only=2024q1
 *
 * Downloads SEC quarterly Form D ZIPs, joins FORMDSUBMISSION + ISSUERS(primary) +
 * OFFERING + RELATEDPERSONS by ACCESSIONNUMBER, maps to the PrivatePlacement schema,
 * MERGES into private_placements keyed by filing_id=accession (dedup-safe — the daily
 * cron uses the same key). Network-retry, resumable per quarter.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import AdmZip from "adm-zip";
import { savePrivatePlacements } from "../src/firestore.js";
import type { PrivatePlacement } from "../src/types.js";

const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const BASE = "https://www.sec.gov/files/structureddata/data/form-d-data-sets";
const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const PROG = ".tmp/formd-bulk-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

const QUARTERS: string[] = [];
for (let y = 2016; y <= 2026; y++) for (let q = 1; q <= 4; q++) { if (y === 2026 && q > 1) break; QUARTERS.push(`${y}q${q}`); }

const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
function iso(d: string): string {
  const s = (d || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);            // already ISO
  let m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(s.toUpperCase());        // DD-MMM-YYYY
  if (m) return `${m[3]}-${MON[m[2]] ?? "01"}-${m[1]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);                       // M/D/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}
const numOrNull = (s: string) => { const n = parseFloat((s || "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const bool = (s: string) => /^(true|t|y|yes|1)$/i.test((s || "").trim());

async function fetchZip(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(200);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e: any) { if (a === 5) throw e; console.error(`[formd] net "${e?.cause?.code ?? e}" retry ${a + 1}`); await sleep(3000 * (a + 1)); }
  }
  return null;
}
// Parse a TSV entry (by suffix) into array of row-objects keyed by header.
function tsv(zip: AdmZip, suffix: string): Record<string, string>[] {
  const e = zip.getEntries().find((x) => x.entryName.endsWith(suffix));
  if (!e) return [];
  const lines = e.getData().toString("latin1").split(/\r?\n/);
  const cols = (lines[0] ?? "").split("\t");
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) { if (!lines[i]) continue; const v = lines[i].split("\t"); const o: Record<string, string> = {}; for (let c = 0; c < cols.length; c++) o[cols[c]] = v[c] ?? ""; out.push(o); }
  return out;
}

async function doQuarter(q: string) {
  if (done[q]) { console.error(`[formd] skip ${q}`); return; }
  const buf = await fetchZip(`${BASE}/${q}_d.zip`);
  if (!buf) { console.error(`[formd] ${q}: no ZIP`); done[q] = true; writeFileSync(PROG, JSON.stringify(done)); return; }
  const zip = new AdmZip(buf);
  const subs = tsv(zip, "FORMDSUBMISSION.tsv");
  const issuersByAcc = new Map<string, Record<string, string>>();
  for (const r of tsv(zip, "ISSUERS.tsv")) { if (r.IS_PRIMARYISSUER_FLAG === "true" || !issuersByAcc.has(r.ACCESSIONNUMBER)) issuersByAcc.set(r.ACCESSIONNUMBER, r); }
  const offByAcc = new Map<string, Record<string, string>>();
  for (const r of tsv(zip, "OFFERING.tsv")) offByAcc.set(r.ACCESSIONNUMBER, r);
  const rpByAcc = new Map<string, any[]>();
  for (const r of tsv(zip, "RELATEDPERSONS.tsv")) { const a = rpByAcc.get(r.ACCESSIONNUMBER) ?? []; a.push({ first_name: r.FIRSTNAME, middle_name: r.MIDDLENAME, last_name: r.LASTNAME, relationships: [r.RELATIONSHIP_1, r.RELATIONSHIP_2, r.RELATIONSHIP_3].filter(Boolean) }); rpByAcc.set(r.ACCESSIONNUMBER, a); }

  const recs: PrivatePlacement[] = [];
  for (const s of subs) {
    const acc = s.ACCESSIONNUMBER; if (!acc) continue;
    const iss = issuersByAcc.get(acc) ?? {};
    const off = offByAcc.get(acc) ?? {};
    const cikRaw = (iss.CIK || "").replace(/^0+/, "");
    recs.push({
      filing_id: acc, file_date: iso(s.FILING_DATE), filing_type: s.SUBMISSIONTYPE || "D",
      is_amendment: bool(off.ISAMENDMENT) || /\/A/.test(s.SUBMISSIONTYPE || ""),
      date_of_first_sale: off.YETTOOCCUR === "true" ? "" : iso(off.SALE_DATE),
      duration_more_than_one_year: bool(off.MORETHANONEYEAR),
      issuer_cik: iss.CIK || "", issuer_name: iss.ENTITYNAME || "", issuer_city: iss.CITY || "",
      issuer_state: iss.STATEORCOUNTRY || "", issuer_street: iss.STREET1 || "", issuer_zip: iss.ZIPCODE || "",
      issuer_phone: iss.ISSUERPHONENUMBER || "", jurisdiction_of_inc: iss.JURISDICTIONOFINC || "",
      industry_group_type: off.INDUSTRYGROUPTYPE || "", investment_fund_type: off.INVESTMENTFUNDTYPE || "",
      is_40_act: bool(off.IS40ACT), revenue_range: off.REVENUERANGE || "",
      federal_exemptions: (off.FEDERALEXEMPTIONS_ITEMS_LIST || "").split(",").map((x) => x.trim()).filter(Boolean),
      min_investment_accepted: numOrNull(off.MINIMUMINVESTMENTACCEPTED) ?? 0,
      total_offering_amount: off.TOTALOFFERINGAMOUNT || "", total_amount_sold: numOrNull(off.TOTALAMOUNTSOLD) ?? 0,
      total_remaining: off.TOTALREMAINING || "", total_number_already_invested: numOrNull(off.TOTALNUMBERALREADYINVESTED) ?? 0,
      sales_commissions: numOrNull(off.SALESCOMM_DOLLARAMOUNT) ?? 0, finder_fees: numOrNull(off.FINDERSFEE_DOLLARAMOUNT) ?? 0,
      related_persons: rpByAcc.get(acc) ?? [],
      filing_url: `https://www.sec.gov/Archives/edgar/data/${cikRaw}/${acc.replace(/-/g, "")}`,
      primary_document_url: `https://www.sec.gov/Archives/edgar/data/${cikRaw}/${acc.replace(/-/g, "")}`,
      scraped_at: NOW,
    } as unknown as PrivatePlacement);
  }
  console.error(`[formd] ${q}: ${recs.length} Form D filings`);
  if (DRY) { console.error("  sample: " + JSON.stringify(recs[0])?.slice(0, 400)); return; }
  let saved = 0;
  for (let i = 0; i < recs.length; i += 400) saved += (await savePrivatePlacements(recs.slice(i, i + 400))).saved;
  done[q] = true; writeFileSync(PROG, JSON.stringify(done));
  console.error(`[formd] ${q} DONE: saved ${saved}`);
}

async function main() {
  const qs = ONLY ? [ONLY] : QUARTERS;
  console.error(`[formd] ${qs.length} quarters${DRY ? " (DRY)" : ""}`);
  for (const q of qs) await doQuarter(q);
  console.error("[formd] COMPLETE");
}
main().then(() => process.exit(0)).catch((e) => { console.error("[formd] FATAL", e); process.exit(1); });
