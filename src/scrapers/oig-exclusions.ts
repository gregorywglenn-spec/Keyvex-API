/**
 * HHS-OIG Exclusions List scraper.
 *
 * Source: https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv
 *
 * No auth. Single ~15 MB CSV download published by HHS Office of Inspector
 * General. Updated monthly with new exclusions, reinstatements, and waivers.
 * Each row = one individual or business excluded from federal healthcare
 * programs (Medicare, Medicaid, etc.).
 *
 * Idempotent saves: doc IDs are derived from NPI when present, else a
 * deterministic hash of (name|business + exclusion_date + state + zip).
 * Monthly re-runs cleanly overwrite via merge:true.
 *
 * Schema (18 columns, fixed order from OIG):
 *   LASTNAME, FIRSTNAME, MIDNAME, BUSNAME,
 *   GENERAL, SPECIALTY,
 *   UPIN, NPI, DOB,
 *   ADDRESS, CITY, STATE, ZIP,
 *   EXCLTYPE, EXCLDATE, REINDATE, WAIVERDATE, WVRSTATE
 *
 * Date format: YYYYMMDD raw; sentinel "00000000" for empty.
 */
import { createHash } from "node:crypto";
import type { OigExclusion } from "../types.js";

const CONFIG = {
  USER_AGENT: "Mozilla/5.0 (KeyVexBot/1.0; +https://keyvex.com)",
  CSV_URL: "https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv",
  SOURCE_PAGE_URL: "https://oig.hhs.gov/exclusions/exclusions_list.asp",
};

/** Parse YYYYMMDD → YYYY-MM-DD; "00000000" or empty → "". */
function isoDate(yyyymmdd: string): string {
  const t = (yyyymmdd ?? "").trim();
  if (!t || t === "00000000") return "";
  if (!/^\d{8}$/.test(t)) return "";
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

/** Reinstate/waiver dates use null when absent. */
function isoDateOrNull(yyyymmdd: string): string | null {
  const s = isoDate(yyyymmdd);
  return s || null;
}

/** RFC4180 single-line CSV split. OIG quotes EVERY field, so the parser
 *  needs to handle quoted commas + escaped quotes (rare in this data). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      fields.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  fields.push(cur);
  return fields;
}

function deriveId(row: OigExclusion): string {
  const npi = (row.npi ?? "").trim();
  if (npi && npi !== "0000000000" && /^\d{10}$/.test(npi)) {
    return `oig-${npi}`;
  }
  // Hash a stable composite. SHA-1 truncated to 12 chars = 48 bits, plenty
  // for ~100K records (collision probability < 1e-9).
  const composite = [
    row.last_name,
    row.first_name,
    row.middle_name,
    row.business_name,
    row.exclusion_date,
    row.state,
    row.zip,
  ]
    .join("|")
    .toUpperCase();
  const hash = createHash("sha1").update(composite).digest("hex").slice(0, 12);
  return `oig-${hash}`;
}

export async function scrapeOigExclusions(): Promise<OigExclusion[]> {
  const scrapedAt = new Date().toISOString();
  console.error("[oig] Downloading exclusions CSV (~15 MB)...");

  const res = await fetch(CONFIG.CSV_URL, {
    headers: { "User-Agent": CONFIG.USER_AGENT, Accept: "text/csv" },
  });
  if (!res.ok) {
    throw new Error(`OIG CSV HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  console.error(`[oig] Downloaded ${text.length} bytes; parsing...`);

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  // Drop the header row.
  const header = parseCsvLine(lines[0] ?? "");
  if (header[0] !== "LASTNAME") {
    throw new Error(
      `OIG CSV unexpected header: ${header.slice(0, 4).join(", ")}`,
    );
  }

  const out: OigExclusion[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    if (fields.length < 18) continue;

    const lastName = (fields[0] ?? "").trim();
    const firstName = (fields[1] ?? "").trim();
    const middleName = (fields[2] ?? "").trim();
    const businessName = (fields[3] ?? "").trim();
    const isBusiness = !!businessName;
    const fullName = isBusiness
      ? businessName
      : [firstName, middleName, lastName].filter(Boolean).join(" ");

    const row: OigExclusion = {
      id: "", // filled by deriveId below
      last_name: lastName,
      first_name: firstName,
      middle_name: middleName,
      business_name: businessName,
      full_name: fullName,
      is_business: isBusiness,
      general_category: (fields[4] ?? "").trim(),
      specialty: (fields[5] ?? "").trim(),
      upin: (fields[6] ?? "").trim(),
      npi: (fields[7] ?? "").trim(),
      date_of_birth: isoDate(fields[8] ?? ""),
      address: (fields[9] ?? "").trim(),
      city: (fields[10] ?? "").trim(),
      state: (fields[11] ?? "").trim(),
      zip: (fields[12] ?? "").trim(),
      exclusion_type: (fields[13] ?? "").trim(),
      exclusion_date: isoDate(fields[14] ?? ""),
      reinstatement_date: isoDateOrNull(fields[15] ?? ""),
      waiver_date: isoDateOrNull(fields[16] ?? ""),
      waiver_state: (fields[17] ?? "").trim(),
      oig_source_url: CONFIG.SOURCE_PAGE_URL,
      scraped_at: scrapedAt,
    };
    row.id = deriveId(row);
    out.push(row);
  }

  console.error(
    `[oig] Parsed ${out.length} exclusions ` +
      `(${out.filter((r) => r.is_business).length} businesses, ` +
      `${out.filter((r) => r.reinstatement_date).length} previously reinstated)`,
  );
  return out;
}
