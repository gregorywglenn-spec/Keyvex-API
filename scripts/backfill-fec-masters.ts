/**
 * FEC MASTERS BULK BACKFILL — candidate + committee reference, all cycles 2016+.
 *
 *   npx tsx scripts/backfill-fec-masters.ts            # cycles 2016..2026
 *   npx tsx scripts/backfill-fec-masters.ts --dry --only=2024
 *
 * Downloads FEC bulk cn{YY}.zip (candidate master) + cm{YY}.zip (committee master)
 * per 2-year cycle, parses the pipe-delimited files, and MERGES into fec_candidates /
 * fec_committees keyed by the immutable candidate_id / committee_id. Writes ONLY the
 * bulk-authoritative fields (id, name, codes, easy *_full) — deliberately NOT the
 * API-enriched arrays (cycles/election_years/candidate_ids) or dates, so merge can't
 * regress richer records the API cron already wrote. Dedup-safe (stable keys).
 * Resumable per cycle, network-retry. SEC/FEC family → parallel to lobbying.
 */
import "../src/load-secrets.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import AdmZip from "adm-zip";
import { saveFecCandidates, saveFecCommittees } from "../src/firestore.js";
import type { FecCandidate, FecCommittee } from "../src/types.js";

const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const UA = "KeyVexMCP/0.1 contact@keyvex.com";
const BASE = "https://www.fec.gov/files/bulk-downloads";
const PROG = ".tmp/fec-masters-progress.json";
mkdirSync(".tmp", { recursive: true });
const done: Record<string, boolean> = existsSync(PROG) ? JSON.parse(readFileSync(PROG, "utf8")) : {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = new Date().toISOString();

const CYCLES = ONLY ? [Number(ONLY)] : [2016, 2018, 2020, 2022, 2024, 2026];
const PARTY: Record<string, string> = { DEM: "Democratic Party", REP: "Republican Party", LIB: "Libertarian Party", GRE: "Green Party", IND: "Independent", NON: "Nonpartisan", OTH: "Other" };
const OFFICE: Record<string, string> = { H: "House", S: "Senate", P: "President" };

async function fetchZip(url: string): Promise<Buffer | null> {
  for (let a = 0; a < 6; a++) {
    try {
      await sleep(200);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e: any) { if (a === 5) throw e; console.error(`[fec-masters] net "${e?.cause?.code ?? e}" ${url} retry ${a + 1}`); await sleep(3000 * (a + 1)); }
  }
  return null;
}
function rows(zip: AdmZip): string[][] {
  const e = zip.getEntries().find((x) => x.entryName.endsWith(".txt"));
  if (!e) return [];
  return e.getData().toString("latin1").split(/\r?\n/).filter(Boolean).map((l) => l.split("|"));
}

async function doCycle(cy: number) {
  if (done[String(cy)]) { console.error(`[fec-masters] skip ${cy}`); return; }
  const yy = String(cy).slice(2);
  // candidates (cn)
  const cnBuf = await fetchZip(`${BASE}/${cy}/cn${yy}.zip`);
  const cands: FecCandidate[] = [];
  if (cnBuf) for (const c of rows(new AdmZip(cnBuf))) {
    if (!c[0]) continue;
    cands.push({
      candidate_id: c[0], name: c[1] || "", party: c[2] || "", party_full: PARTY[c[2]] || c[2] || "",
      office: c[5] || "", office_full: OFFICE[c[5]] || "", state: c[4] || "", district: c[6] || "",
      district_number: /^\d+$/.test(c[6] || "") ? Number(c[6]) : null,
      incumbent_challenge: c[7] || "", candidate_status: c[8] || "", scraped_at: NOW,
    } as FecCandidate);
  }
  // committees (cm)
  const cmBuf = await fetchZip(`${BASE}/${cy}/cm${yy}.zip`);
  const cmtes: FecCommittee[] = [];
  if (cmBuf) for (const c of rows(new AdmZip(cmBuf))) {
    if (!c[0]) continue;
    cmtes.push({
      committee_id: c[0], name: c[1] || "", treasurer_name: c[2] || "", committee_type: c[9] || "",
      designation: c[8] || "", organization_type: c[12] || "", party: c[10] || "", party_full: PARTY[c[10]] || c[10] || "",
      state: c[6] || "", filing_frequency: c[11] || "", scraped_at: NOW,
    } as FecCommittee);
  }
  console.error(`[fec-masters] ${cy}: ${cands.length} candidates, ${cmtes.length} committees`);
  if (DRY) {
    console.error(`   sample cand: ${JSON.stringify(cands[0])}`);
    console.error(`   sample cmte: ${JSON.stringify(cmtes[0])}`);
    return;
  }
  let sc = 0, sm = 0;
  for (let i = 0; i < cands.length; i += 400) sc += (await saveFecCandidates(cands.slice(i, i + 400))).saved;
  for (let i = 0; i < cmtes.length; i += 400) sm += (await saveFecCommittees(cmtes.slice(i, i + 400))).saved;
  done[String(cy)] = true; writeFileSync(PROG, JSON.stringify(done));
  console.error(`[fec-masters] ${cy} DONE: ${sc} candidates, ${sm} committees saved`);
}

async function main() {
  console.error(`[fec-masters] cycles: ${CYCLES.join(", ")}${DRY ? " (DRY)" : ""}`);
  for (const cy of CYCLES) await doCycle(cy);
  console.error("[fec-masters] COMPLETE");
}
main().then(() => process.exit(0)).catch((e) => { console.error("[fec-masters] FATAL", e); process.exit(1); });
