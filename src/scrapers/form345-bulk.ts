/**
 * SEC Bulk Insider Dataset loader — Forms 3/4/5 quarterly TSV bundles.
 *
 * Source: https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/YYYYqN_form345.zip
 *
 * Replaces the EDGAR Form 4 historical scraper. The bulk dataset gives us
 * 20 years of Form 3/4/5 in 80 quarterly zips totalling ~1.1 GB — vs ~21
 * days of FTS-paced EDGAR scraping for 5 years.
 *
 * Per Greg's FINAL load brief + Gate 2 approval:
 *   1. THREE collections: insider_transactions_v2, insider_holdings_v2,
 *      insider_filings_v2 (the v2 suffix gets dropped after Gate 7 retires
 *      the legacy scraped collection; "v2" reflects the coexistence period).
 *   2. NONDERIV + DERIV merged into ONE transactions collection with a
 *      transaction_type discriminator field. Same for holdings.
 *   3. Footnote text INLINED onto each row (single read returns transaction
 *      + caveats — no second lookup needed).
 *   4. Era indicator at load time: schema_era = "pre_2023" | "2023_plus".
 *      aff10b5one = "NOT_TRACKED" sentinel for pre-2023 records (never bare
 *      null — agents can distinguish "field didn't exist in this era" from
 *      "field present but null/zero").
 *   5. Era boundary LOCKED at 2022q4 → 2023q1 (verified via inspect-form345-bulk.ts
 *      on 2008q1, 2018q1, 2022q4, 2023q1; matches SEC Rule 10b5-1 amendment
 *      compliance date of April 1, 2023).
 *   6. Source tag "sec_bulk" on every row; idempotent doc IDs keyed by
 *      accession + table-marker + SEC's stable surrogate key (SK).
 *
 * NEVER deploy. Greg deploys.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import AdmZip from "adm-zip";
import { deriveTransactionNature } from "../tools/insider-transactions-v2-shim.js";
import type {
  BulkReportingOwner,
  InlineFootnoteRef,
  InsiderFilingV2,
  InsiderHoldingV2,
  InsiderTransactionV2,
  SchemaEra,
} from "../types.js";

const USER_AGENT = "KeyVex Research contact@keyvex.com";
const SEC_BULK_BASE =
  "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets";

// Era boundary (verified Gate 1 + Gate 1.5):
//   2006q1 → 2022q4  = pre_2023 (AFF10B5ONE column did NOT exist)
//   2023q1 → present = 2023_plus (AFF10B5ONE column present, matches SEC
//                                 Rule 10b5-1 amendment compliance date)
export function eraForQuarter(quarter: string): SchemaEra {
  const m = quarter.match(/^(\d{4})q([1-4])$/i);
  if (!m || !m[1]) throw new Error(`Bad quarter format: ${quarter} (expected YYYYqN)`);
  const year = parseInt(m[1], 10);
  return year >= 2023 ? "2023_plus" : "pre_2023";
}

// ─── Date parsing ───────────────────────────────────────────────────────────
// SEC bulk dataset ships dates as Oracle-style "DD-MON-YYYY" (e.g. "28-MAR-2018").
// Convert to ISO "YYYY-MM-DD" on parse so the rest of the system is consistent.

const MON_TO_NUM: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

export function parseSecDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const mm = MON_TO_NUM[m[2].toUpperCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

// Parse "0" / "1" booleans the SEC uses in TSVs
function parseBool(s: string | undefined): boolean {
  if (s === undefined || s === null) return false;
  return s.trim() === "1";
}

// Parse numeric, returning null on blank — NOT zero (the distinction matters
// for fields like trans_price_per_share where 0 vs null have different meanings)
function parseNum(s: string | undefined): number | null {
  if (s === undefined || s === null) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseAD(s: string | undefined): "A" | "D" | null {
  if (!s) return null;
  const t = s.trim().toUpperCase();
  return t === "A" || t === "D" ? t : null;
}

function parseDI(s: string | undefined): "D" | "I" | null {
  if (!s) return null;
  const t = s.trim().toUpperCase();
  return t === "D" || t === "I" ? t : null;
}

function parseAff(s: string | undefined): "1" | "0" | "" {
  if (s === undefined || s === null) return "";
  const t = s.trim();
  if (t === "1") return "1";
  if (t === "0") return "0";
  return "";
}

// Parse "F1" / "F11, F12" / etc. into an array of refs
function parseFnRefs(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// ─── Download + extract ─────────────────────────────────────────────────────

export function scratchDirFor(quarter: string): string {
  const base = process.platform === "win32" ? process.env.TEMP ?? "C:\\Temp" : "/tmp";
  return path.join(base, `keyvex-form345-${quarter}`);
}

export async function downloadAndExtractQuarter(
  quarter: string,
  options: { force?: boolean } = {},
): Promise<string> {
  const scratch = scratchDirFor(quarter);
  fs.mkdirSync(scratch, { recursive: true });
  const zipPath = path.join(scratch, `${quarter}_form345.zip`);

  // Re-use already-downloaded zip unless --force
  const zipExists = fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0;
  if (!zipExists || options.force) {
    const url = `${SEC_BULK_BASE}/${quarter}_form345.zip`;
    console.error(`[form345-bulk] Downloading ${url}...`);
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/zip, */*" },
    });
    if (!res.ok) {
      throw new Error(`SEC bulk download HTTP ${res.status} for ${quarter}: ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
    console.error(`[form345-bulk] Saved ${buf.length} bytes to ${zipPath}`);
  } else {
    console.error(`[form345-bulk] Using cached zip at ${zipPath}`);
  }

  // Extract (overwrite — cheap and avoids partial-extract bugs)
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(scratch, true);

  // Sanity check the 8 expected tables exist
  const expected = [
    "SUBMISSION.tsv",
    "REPORTINGOWNER.tsv",
    "NONDERIV_TRANS.tsv",
    "DERIV_TRANS.tsv",
    "NONDERIV_HOLDING.tsv",
    "DERIV_HOLDING.tsv",
    "FOOTNOTES.tsv",
    "OWNER_SIGNATURE.tsv",
  ];
  for (const t of expected) {
    if (!fs.existsSync(path.join(scratch, t))) {
      throw new Error(`Missing expected table ${t} in ${scratch}`);
    }
  }

  return scratch;
}

// ─── TSV reader (line-by-line; full file into memory is fine — biggest tsv ~40MB) ──

function parseTsv(filePath: string): { headers: string[]; rows: Record<string, string>[] } {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) return { headers: [], rows: [] };
  const headers = lines[0].split("\t");
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (!header) continue;
      row[header] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return { headers, rows };
}

// ─── Joiner ────────────────────────────────────────────────────────────────

interface QuarterTables {
  submissions: Map<string, Record<string, string>>;        // accession → SUBMISSION row
  owners: Map<string, Record<string, string>[]>;           // accession → REPORTINGOWNER rows
  nonderivTrans: Record<string, string>[];                 // raw NONDERIV_TRANS rows
  derivTrans: Record<string, string>[];                    // raw DERIV_TRANS rows
  nonderivHoldings: Record<string, string>[];              // raw NONDERIV_HOLDING rows
  derivHoldings: Record<string, string>[];                 // raw DERIV_HOLDING rows
  footnotes: Map<string, Map<string, string>>;             // accession → (FN_ID → FN_TXT)
  signatures: Map<string, Array<{ name: string; date: string }>>;
}

export function loadQuarterTables(scratchDir: string): QuarterTables {
  console.error(`[form345-bulk] Reading TSVs from ${scratchDir}...`);
  const t0 = Date.now();

  const submissions = new Map<string, Record<string, string>>();
  for (const row of parseTsv(path.join(scratchDir, "SUBMISSION.tsv")).rows) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) continue;
    submissions.set(acc, row);
  }

  const owners = new Map<string, Record<string, string>[]>();
  for (const row of parseTsv(path.join(scratchDir, "REPORTINGOWNER.tsv")).rows) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) continue;
    let list = owners.get(acc);
    if (!list) {
      list = [];
      owners.set(acc, list);
    }
    list.push(row);
  }

  const nonderivTrans = parseTsv(path.join(scratchDir, "NONDERIV_TRANS.tsv")).rows;
  const derivTrans = parseTsv(path.join(scratchDir, "DERIV_TRANS.tsv")).rows;
  const nonderivHoldings = parseTsv(path.join(scratchDir, "NONDERIV_HOLDING.tsv")).rows;
  const derivHoldings = parseTsv(path.join(scratchDir, "DERIV_HOLDING.tsv")).rows;

  const footnotes = new Map<string, Map<string, string>>();
  for (const row of parseTsv(path.join(scratchDir, "FOOTNOTES.tsv")).rows) {
    const acc = row.ACCESSION_NUMBER;
    const fnId = row.FOOTNOTE_ID;
    if (!acc || !fnId) continue;
    let fnMap = footnotes.get(acc);
    if (!fnMap) {
      fnMap = new Map();
      footnotes.set(acc, fnMap);
    }
    fnMap.set(fnId, row.FOOTNOTE_TXT ?? "");
  }

  const signatures = new Map<string, Array<{ name: string; date: string }>>();
  for (const row of parseTsv(path.join(scratchDir, "OWNER_SIGNATURE.tsv")).rows) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) continue;
    let list = signatures.get(acc);
    if (!list) {
      list = [];
      signatures.set(acc, list);
    }
    list.push({
      name: row.OWNERSIGNATURENAME ?? "",
      date: row.OWNERSIGNATUREDATE ?? "",
    });
  }

  console.error(
    `[form345-bulk] Loaded ${submissions.size} submissions, ${owners.size} owner-accessions, ` +
      `${nonderivTrans.length} nonderiv-trans, ${derivTrans.length} deriv-trans, ` +
      `${nonderivHoldings.length} nonderiv-holdings, ${derivHoldings.length} deriv-holdings, ` +
      `${footnotes.size} footnote-accessions, ${signatures.size} signature-accessions ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  return {
    submissions,
    owners,
    nonderivTrans,
    derivTrans,
    nonderivHoldings,
    derivHoldings,
    footnotes,
    signatures,
  };
}

// ─── Builders ──────────────────────────────────────────────────────────────

function buildOwners(ownerRows: Record<string, string>[] | undefined): BulkReportingOwner[] {
  if (!ownerRows || ownerRows.length === 0) return [];
  return ownerRows.map((r) => {
    // RPTOWNER_RELATIONSHIP is a CSV-ish list of relationship flags. The bulk
    // dataset doesn't separate is_director / is_officer / is_ten_percent_owner /
    // is_other into columns — they're packed into RPTOWNER_RELATIONSHIP as one
    // string with tokens. Parse it.
    const rel = (r.RPTOWNER_RELATIONSHIP ?? "").toUpperCase();
    return {
      cik: (r.RPTOWNERCIK ?? "").padStart(10, "0"),
      name: r.RPTOWNERNAME ?? "",
      is_director: rel.includes("DIRECTOR"),
      is_officer: rel.includes("OFFICER"),
      is_ten_percent_owner: rel.includes("10") || rel.includes("TEN") || rel.includes("PERCENT"),
      is_other: rel.includes("OTHER"),
      officer_title: r.RPTOWNER_TITLE?.trim() || null,
      other_relationship_text: r.RPTOWNER_TXT?.trim() || null,
    };
  });
}

function buildSourceUrl(accession: string): string {
  // Accession 0001234567-25-000123 → EDGAR archive directory
  //   /Archives/edgar/data/<unpadded_cik>/<accession_no_dashes>/<accession>-index.html
  // But CIK isn't on the bulk row directly — use accession-only browse URL.
  // SEC accepts the no-dashes form in their browse endpoint:
  const accNoDash = accession.replace(/-/g, "");
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=&filenum=&type=&dateb=&owner=include&count=40&search_text=${accNoDash}`;
}

function pad10(cik: string | undefined | null): string {
  if (!cik) return "";
  return cik.padStart(10, "0");
}

function uppercaseTicker(t: string | undefined | null): string {
  if (!t) return "";
  return t.trim().toUpperCase();
}

function isAmendment(documentType: string | undefined | null): boolean {
  if (!documentType) return false;
  return documentType.endsWith("/A");
}

// Resolve a list of *_FN columns on a row against the footnote table for the
// accession. Each (field, ref) pair becomes one InlineFootnoteRef entry; refs
// that don't resolve to a known FN_ID get text="(footnote not found)" so the
// agent can distinguish "no footnote" from "reference present but unresolved".
function inlineFootnotes(
  row: Record<string, string>,
  fnColumns: Record<string, string>, // map field-name → source-column name (e.g. trans_shares → TRANS_SHARES_FN)
  footnoteMap: Map<string, string> | undefined,
): InlineFootnoteRef[] {
  const result: InlineFootnoteRef[] = [];
  for (const [field, srcCol] of Object.entries(fnColumns)) {
    const raw = row[srcCol];
    if (!raw) continue;
    const refs = parseFnRefs(raw);
    for (const ref of refs) {
      const text = footnoteMap?.get(ref) ?? "(footnote not found)";
      result.push({ field, ref, text });
    }
  }
  return result;
}

// ─── Transaction builder (used for both nonderiv + deriv) ────────────────────

const NONDERIV_FN_COLUMNS: Record<string, string> = {
  security_title: "SECURITY_TITLE_FN",
  transaction_date: "TRANS_DATE_FN",
  deemed_execution_date: "DEEMED_EXECUTION_DATE_FN",
  trans_code: "EQUITY_SWAP_TRANS_CD_FN",
  trans_timeliness: "TRANS_TIMELINESS_FN",
  trans_shares: "TRANS_SHARES_FN",
  trans_price_per_share: "TRANS_PRICEPERSHARE_FN",
  trans_acquired_disp_cd: "TRANS_ACQUIRED_DISP_CD_FN",
  shrs_owned_following_trans: "SHRS_OWND_FOLWNG_TRANS_FN",
  valu_owned_following_trans: "VALU_OWND_FOLWNG_TRANS_FN",
  direct_indirect_ownership: "DIRECT_INDIRECT_OWNERSHIP_FN",
  nature_of_ownership: "NATURE_OF_OWNERSHIP_FN",
};

const DERIV_FN_COLUMNS: Record<string, string> = {
  ...NONDERIV_FN_COLUMNS,
  trans_total_value: "TRANS_TOTAL_VALUE_FN",
  conv_exercise_price: "CONV_EXERCISE_PRICE_FN",
  exercise_date: "EXCERCISE_DATE_FN", // SEC misspelled this column ("Excercise")
  expiration_date: "EXPIRATION_DATE_FN",
  underlying_security_title: "UNDLYNG_SEC_TITLE_FN",
  underlying_security_shares: "UNDLYNG_SEC_SHARES_FN",
  underlying_security_value: "UNDLYNG_SEC_VALUE_FN",
};

function buildTransaction(args: {
  row: Record<string, string>;
  transactionType: "nonderiv" | "deriv";
  submission: Record<string, string>;
  ownerRows: Record<string, string>[] | undefined;
  footnoteMap: Map<string, string> | undefined;
  quarter: string;
  era: SchemaEra;
  loadedAt: string;
}): InsiderTransactionV2 | null {
  const { row, transactionType, submission, ownerRows, footnoteMap, quarter, era, loadedAt } = args;

  const accession = submission.ACCESSION_NUMBER;
  if (!accession) return null; // Caller's submissions Map keys are non-empty, but typechecker can't prove it
  const skKey = transactionType === "nonderiv" ? "NONDERIV_TRANS_SK" : "DERIV_TRANS_SK";
  const skRaw = row[skKey];
  if (!skRaw) {
    console.error(`[form345-bulk] ${accession}: missing ${skKey} on ${transactionType} row — skipping`);
    return null;
  }
  const sk = parseInt(skRaw, 10);
  if (Number.isNaN(sk)) {
    console.error(`[form345-bulk] ${accession}: bad ${skKey} "${skRaw}" — skipping`);
    return null;
  }
  const marker = transactionType === "nonderiv" ? "NT" : "DT";
  const id = `${accession}-${marker}-${sk}`;

  const transDate = parseSecDate(row.TRANS_DATE);
  if (!transDate) {
    console.error(`[form345-bulk] ${accession}-${marker}-${sk}: bad TRANS_DATE "${row.TRANS_DATE}" — skipping`);
    return null;
  }

  const owners = buildOwners(ownerRows);
  const primary = owners[0] ?? {
    cik: "",
    name: "",
    is_director: false,
    is_officer: false,
    is_ten_percent_owner: false,
    is_other: false,
    officer_title: null,
    other_relationship_text: null,
  };

  // AFF10B5ONE: present only on 2023+. Use NOT_TRACKED sentinel for pre-2023.
  const aff10b5one: InsiderTransactionV2["aff10b5one"] =
    era === "2023_plus" ? parseAff(submission.AFF10B5ONE) : "NOT_TRACKED";

  const fnCols = transactionType === "nonderiv" ? NONDERIV_FN_COLUMNS : DERIV_FN_COLUMNS;

  const doc: InsiderTransactionV2 = {
    id,
    source: "sec_bulk",
    source_zip: `${quarter}_form345.zip`,
    schema_era: era,
    bulk_loaded_at: loadedAt,
    source_url: buildSourceUrl(accession),

    accession_number: accession,
    filing_date: parseSecDate(submission.FILING_DATE) ?? transDate, // filing_date should be present; fall back to transDate as defense
    period_of_report: parseSecDate(submission.PERIOD_OF_REPORT) ?? transDate,
    date_of_orig_sub: parseSecDate(submission.DATE_OF_ORIG_SUB),
    document_type: submission.DOCUMENT_TYPE ?? "",
    is_amendment: isAmendment(submission.DOCUMENT_TYPE),
    company_cik: pad10(submission.ISSUERCIK),
    company_name: submission.ISSUERNAME ?? "",
    ticker: uppercaseTicker(submission.ISSUERTRADINGSYMBOL),
    remarks: submission.REMARKS?.trim() || null,
    no_securities_owned: parseBool(submission.NO_SECURITIES_OWNED),
    not_subject_sec16: parseBool(submission.NOT_SUBJECT_SEC16),
    form3_holdings_reported: parseBool(submission.FORM3_HOLDINGS_REPORTED),
    form4_trans_reported: parseBool(submission.FORM4_TRANS_REPORTED),

    aff10b5one,

    reporting_owner_cik: primary.cik,
    reporting_owner_name: primary.name,
    is_director: primary.is_director,
    is_officer: primary.is_officer,
    is_ten_percent_owner: primary.is_ten_percent_owner,
    is_other: primary.is_other,
    officer_title: primary.officer_title,
    other_relationship_text: primary.other_relationship_text,
    reporting_owners: owners,

    transaction_type: transactionType,
    sk,
    security_title: row.SECURITY_TITLE ?? "",
    transaction_date: transDate,
    deemed_execution_date: parseSecDate(row.DEEMED_EXECUTION_DATE),
    trans_form_type: row.TRANS_FORM_TYPE ?? "",
    trans_code: row.TRANS_CODE ?? "",
    equity_swap_involved: parseBool(row.EQUITY_SWAP_INVOLVED),
    trans_timeliness: row.TRANS_TIMELINESS?.trim() || null,
    trans_shares: parseNum(row.TRANS_SHARES),
    trans_price_per_share: parseNum(row.TRANS_PRICEPERSHARE),
    trans_total_value: transactionType === "deriv" ? parseNum(row.TRANS_TOTAL_VALUE) : null,
    trans_acquired_disp_cd: parseAD(row.TRANS_ACQUIRED_DISP_CD),
    direct_indirect_ownership: parseDI(row.DIRECT_INDIRECT_OWNERSHIP),
    nature_of_ownership: row.NATURE_OF_OWNERSHIP?.trim() || null,
    shrs_owned_following_trans: parseNum(row.SHRS_OWND_FOLWNG_TRANS),
    valu_owned_following_trans: parseNum(row.VALU_OWND_FOLWNG_TRANS),

    // Derivative-only fields — null on nonderiv rows
    conv_exercise_price: transactionType === "deriv" ? parseNum(row.CONV_EXERCISE_PRICE) : null,
    exercise_date: transactionType === "deriv" ? parseSecDate(row.EXCERCISE_DATE) : null,
    expiration_date: transactionType === "deriv" ? parseSecDate(row.EXPIRATION_DATE) : null,
    underlying_security_title:
      transactionType === "deriv" ? row.UNDLYNG_SEC_TITLE?.trim() || null : null,
    underlying_security_shares:
      transactionType === "deriv" ? parseNum(row.UNDLYNG_SEC_SHARES) : null,
    underlying_security_value:
      transactionType === "deriv" ? parseNum(row.UNDLYNG_SEC_VALUE) : null,

    footnote_refs: inlineFootnotes(row, fnCols, footnoteMap),
  };

  // ─── Phase A: transaction_nature derivation (forward-write only) ──────────
  // SEC trans_code → bucket via the shared deriveTransactionNature helper.
  // Reads trans_code ONLY — never reads trans_acquired_disp_cd.
  doc.transaction_nature = deriveTransactionNature(row.TRANS_CODE);

  // ─── Phase A: parse-integrity check via footnote-ref resolution ──────────
  // Greg's §1 spec for Form 4: "Validate structural parse-integrity by
  // ensuring that every transaction line item ... successfully resolves
  // its internal relational references (matching footnotes, ownership
  // forms) without dropped parsing tokens."
  // If any inlined footnote ref came back as the sentinel "(footnote not
  // found)", the row had a dangling FN_ID pointer — parse-integrity FAIL.
  const hasUnresolvedFootnote = doc.footnote_refs.some(
    (fn) => fn.text === "(footnote not found)",
  );
  doc.verification_status = hasUnresolvedFootnote
    ? "INSUFFICIENT_DATA"
    : "VERIFIED";

  return doc;
}

// ─── Holding builder (similar shape — no transaction date) ─────────────────

const NONDERIV_HOLDING_FN_COLUMNS: Record<string, string> = {
  security_title: "SECURITY_TITLE_FN",
  trans_form_type: "TRANS_FORM_TYPE_FN",
  shrs_owned_following_trans: "SHRS_OWND_FOLWNG_TRANS_FN",
  valu_owned_following_trans: "VALU_OWND_FOLWNG_TRANS_FN",
  direct_indirect_ownership: "DIRECT_INDIRECT_OWNERSHIP_FN",
  nature_of_ownership: "NATURE_OF_OWNERSHIP_FN",
};

const DERIV_HOLDING_FN_COLUMNS: Record<string, string> = {
  ...NONDERIV_HOLDING_FN_COLUMNS,
  conv_exercise_price: "CONV_EXERCISE_PRICE_FN",
  exercise_date: "EXERCISE_DATE_FN", // HOLDING table uses correct spelling
  expiration_date: "EXPIRATION_DATE_FN",
  underlying_security_title: "UNDLYNG_SEC_TITLE_FN",
  underlying_security_shares: "UNDLYNG_SEC_SHARES_FN",
  underlying_security_value: "UNDLYNG_SEC_VALUE_FN",
};

function buildHolding(args: {
  row: Record<string, string>;
  holdingType: "nonderiv" | "deriv";
  submission: Record<string, string>;
  ownerRows: Record<string, string>[] | undefined;
  footnoteMap: Map<string, string> | undefined;
  quarter: string;
  era: SchemaEra;
  loadedAt: string;
}): InsiderHoldingV2 | null {
  const { row, holdingType, submission, ownerRows, footnoteMap, quarter, era, loadedAt } = args;

  const accession = submission.ACCESSION_NUMBER;
  if (!accession) return null;
  const skKey = holdingType === "nonderiv" ? "NONDERIV_HOLDING_SK" : "DERIV_HOLDING_SK";
  const skRaw = row[skKey];
  if (!skRaw) {
    console.error(`[form345-bulk] ${accession}: missing ${skKey} on ${holdingType} holding — skipping`);
    return null;
  }
  const sk = parseInt(skRaw, 10);
  if (Number.isNaN(sk)) {
    console.error(`[form345-bulk] ${accession}: bad ${skKey} "${skRaw}" — skipping`);
    return null;
  }
  const marker = holdingType === "nonderiv" ? "NH" : "DH";
  const id = `${accession}-${marker}-${sk}`;

  const owners = buildOwners(ownerRows);
  const primary = owners[0] ?? {
    cik: "",
    name: "",
    is_director: false,
    is_officer: false,
    is_ten_percent_owner: false,
    is_other: false,
    officer_title: null,
    other_relationship_text: null,
  };

  const aff10b5one: InsiderHoldingV2["aff10b5one"] =
    era === "2023_plus" ? parseAff(submission.AFF10B5ONE) : "NOT_TRACKED";

  const fnCols =
    holdingType === "nonderiv" ? NONDERIV_HOLDING_FN_COLUMNS : DERIV_HOLDING_FN_COLUMNS;

  // For period_of_report we MUST have something — fall back to filing_date as defense.
  const periodOfReport = parseSecDate(submission.PERIOD_OF_REPORT);
  const filingDate = parseSecDate(submission.FILING_DATE);
  if (!periodOfReport && !filingDate) {
    console.error(`[form345-bulk] ${accession}-${marker}-${sk}: no period_of_report or filing_date — skipping`);
    return null;
  }

  const doc: InsiderHoldingV2 = {
    id,
    source: "sec_bulk",
    source_zip: `${quarter}_form345.zip`,
    schema_era: era,
    bulk_loaded_at: loadedAt,
    source_url: buildSourceUrl(accession),

    accession_number: accession,
    filing_date: filingDate ?? periodOfReport!, // one of them is non-null per the guard above
    period_of_report: periodOfReport ?? filingDate!,
    date_of_orig_sub: parseSecDate(submission.DATE_OF_ORIG_SUB),
    document_type: submission.DOCUMENT_TYPE ?? "",
    is_amendment: isAmendment(submission.DOCUMENT_TYPE),
    company_cik: pad10(submission.ISSUERCIK),
    company_name: submission.ISSUERNAME ?? "",
    ticker: uppercaseTicker(submission.ISSUERTRADINGSYMBOL),
    remarks: submission.REMARKS?.trim() || null,
    no_securities_owned: parseBool(submission.NO_SECURITIES_OWNED),
    not_subject_sec16: parseBool(submission.NOT_SUBJECT_SEC16),
    form3_holdings_reported: parseBool(submission.FORM3_HOLDINGS_REPORTED),
    form4_trans_reported: parseBool(submission.FORM4_TRANS_REPORTED),

    aff10b5one,

    reporting_owner_cik: primary.cik,
    reporting_owner_name: primary.name,
    is_director: primary.is_director,
    is_officer: primary.is_officer,
    is_ten_percent_owner: primary.is_ten_percent_owner,
    is_other: primary.is_other,
    officer_title: primary.officer_title,
    other_relationship_text: primary.other_relationship_text,
    reporting_owners: owners,

    holding_type: holdingType,
    sk,
    security_title: row.SECURITY_TITLE ?? "",
    trans_form_type: row.TRANS_FORM_TYPE?.trim() || null,
    shrs_owned_following_trans: parseNum(row.SHRS_OWND_FOLWNG_TRANS),
    valu_owned_following_trans: parseNum(row.VALU_OWND_FOLWNG_TRANS),
    direct_indirect_ownership: parseDI(row.DIRECT_INDIRECT_OWNERSHIP),
    nature_of_ownership: row.NATURE_OF_OWNERSHIP?.trim() || null,

    // Derivative-only — null on nonderiv
    conv_exercise_price: holdingType === "deriv" ? parseNum(row.CONV_EXERCISE_PRICE) : null,
    exercise_date: holdingType === "deriv" ? parseSecDate(row.EXERCISE_DATE) : null,
    expiration_date: holdingType === "deriv" ? parseSecDate(row.EXPIRATION_DATE) : null,
    underlying_security_title:
      holdingType === "deriv" ? row.UNDLYNG_SEC_TITLE?.trim() || null : null,
    underlying_security_shares:
      holdingType === "deriv" ? parseNum(row.UNDLYNG_SEC_SHARES) : null,
    underlying_security_value:
      holdingType === "deriv" ? parseNum(row.UNDLYNG_SEC_VALUE) : null,

    footnote_refs: inlineFootnotes(row, fnCols, footnoteMap),
  };

  return doc;
}

// ─── Filing-envelope builder ────────────────────────────────────────────────

function buildFiling(args: {
  submission: Record<string, string>;
  ownerRows: Record<string, string>[] | undefined;
  signatureRows: Array<{ name: string; date: string }> | undefined;
  rowCounts: {
    nonderivTrans: number;
    derivTrans: number;
    nonderivHolding: number;
    derivHolding: number;
    footnotes: number;
  };
  quarter: string;
  era: SchemaEra;
  loadedAt: string;
}): InsiderFilingV2 | null {
  const { submission, ownerRows, signatureRows, rowCounts, quarter, era, loadedAt } = args;
  const accession = submission.ACCESSION_NUMBER;
  if (!accession) return null;

  const periodOfReport = parseSecDate(submission.PERIOD_OF_REPORT);
  const filingDate = parseSecDate(submission.FILING_DATE);
  if (!periodOfReport && !filingDate) {
    console.error(`[form345-bulk] ${accession}: no period_of_report or filing_date — skipping filing`);
    return null;
  }

  const aff10b5one: InsiderFilingV2["aff10b5one"] =
    era === "2023_plus" ? parseAff(submission.AFF10B5ONE) : "NOT_TRACKED";

  return {
    id: accession,
    source: "sec_bulk",
    source_zip: `${quarter}_form345.zip`,
    schema_era: era,
    bulk_loaded_at: loadedAt,
    source_url: buildSourceUrl(accession),

    accession_number: accession,
    filing_date: filingDate ?? periodOfReport!,
    period_of_report: periodOfReport ?? filingDate!,
    date_of_orig_sub: parseSecDate(submission.DATE_OF_ORIG_SUB),
    document_type: submission.DOCUMENT_TYPE ?? "",
    is_amendment: isAmendment(submission.DOCUMENT_TYPE),
    company_cik: pad10(submission.ISSUERCIK),
    company_name: submission.ISSUERNAME ?? "",
    ticker: uppercaseTicker(submission.ISSUERTRADINGSYMBOL),
    remarks: submission.REMARKS?.trim() || null,
    no_securities_owned: parseBool(submission.NO_SECURITIES_OWNED),
    not_subject_sec16: parseBool(submission.NOT_SUBJECT_SEC16),
    form3_holdings_reported: parseBool(submission.FORM3_HOLDINGS_REPORTED),
    form4_trans_reported: parseBool(submission.FORM4_TRANS_REPORTED),

    aff10b5one,

    reporting_owners: buildOwners(ownerRows),

    signatures: (signatureRows ?? []).map((s) => ({
      signer_name: s.name,
      signature_date: parseSecDate(s.date),
    })),

    nonderiv_trans_count: rowCounts.nonderivTrans,
    deriv_trans_count: rowCounts.derivTrans,
    nonderiv_holding_count: rowCounts.nonderivHolding,
    deriv_holding_count: rowCounts.derivHolding,
    footnote_count: rowCounts.footnotes,
  };
}

// ─── Top-level orchestrator ────────────────────────────────────────────────

export interface BuildResult {
  transactions: InsiderTransactionV2[];
  holdings: InsiderHoldingV2[];
  filings: InsiderFilingV2[];
  /** Skipped rows by reason — for Gate 5 verification reporting. */
  skipped: {
    transactionsNoSk: number;
    transactionsNoTransDate: number;
    transactionsNoSubmission: number;
    holdingsNoSk: number;
    holdingsNoSubmission: number;
    filingsNoDate: number;
  };
}

export function buildQuarterDocs(
  tables: QuarterTables,
  quarter: string,
): BuildResult {
  const era = eraForQuarter(quarter);
  const loadedAt = new Date().toISOString();
  console.error(`[form345-bulk] Building joined docs for ${quarter} (era=${era}, loaded_at=${loadedAt})`);

  const transactions: InsiderTransactionV2[] = [];
  const holdings: InsiderHoldingV2[] = [];
  const filings: InsiderFilingV2[] = [];
  const skipped = {
    transactionsNoSk: 0,
    transactionsNoTransDate: 0,
    transactionsNoSubmission: 0,
    holdingsNoSk: 0,
    holdingsNoSubmission: 0,
    filingsNoDate: 0,
  };

  // Pre-compute per-accession row counts (for the filing-envelope size hints)
  type RowCounts = {
    nonderivTrans: number;
    derivTrans: number;
    nonderivHolding: number;
    derivHolding: number;
  };
  const rowCountsByAccession = new Map<string, RowCounts>();
  const bump = (acc: string, k: keyof RowCounts) => {
    let r = rowCountsByAccession.get(acc);
    if (!r) {
      r = { nonderivTrans: 0, derivTrans: 0, nonderivHolding: 0, derivHolding: 0 };
      rowCountsByAccession.set(acc, r);
    }
    r[k] += 1;
  };
  for (const r of tables.nonderivTrans) {
    if (r.ACCESSION_NUMBER) bump(r.ACCESSION_NUMBER, "nonderivTrans");
  }
  for (const r of tables.derivTrans) {
    if (r.ACCESSION_NUMBER) bump(r.ACCESSION_NUMBER, "derivTrans");
  }
  for (const r of tables.nonderivHoldings) {
    if (r.ACCESSION_NUMBER) bump(r.ACCESSION_NUMBER, "nonderivHolding");
  }
  for (const r of tables.derivHoldings) {
    if (r.ACCESSION_NUMBER) bump(r.ACCESSION_NUMBER, "derivHolding");
  }

  // Transactions
  for (const row of tables.nonderivTrans) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) {
      skipped.transactionsNoSubmission++;
      continue;
    }
    const sub = tables.submissions.get(acc);
    if (!sub) {
      skipped.transactionsNoSubmission++;
      continue;
    }
    const doc = buildTransaction({
      row,
      transactionType: "nonderiv",
      submission: sub,
      ownerRows: tables.owners.get(acc),
      footnoteMap: tables.footnotes.get(acc),
      quarter,
      era,
      loadedAt,
    });
    if (!doc) {
      if (!row.NONDERIV_TRANS_SK) skipped.transactionsNoSk++;
      else skipped.transactionsNoTransDate++;
      continue;
    }
    transactions.push(doc);
  }
  for (const row of tables.derivTrans) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) {
      skipped.transactionsNoSubmission++;
      continue;
    }
    const sub = tables.submissions.get(acc);
    if (!sub) {
      skipped.transactionsNoSubmission++;
      continue;
    }
    const doc = buildTransaction({
      row,
      transactionType: "deriv",
      submission: sub,
      ownerRows: tables.owners.get(acc),
      footnoteMap: tables.footnotes.get(acc),
      quarter,
      era,
      loadedAt,
    });
    if (!doc) {
      if (!row.DERIV_TRANS_SK) skipped.transactionsNoSk++;
      else skipped.transactionsNoTransDate++;
      continue;
    }
    transactions.push(doc);
  }

  // Holdings
  for (const row of tables.nonderivHoldings) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) {
      skipped.holdingsNoSubmission++;
      continue;
    }
    const sub = tables.submissions.get(acc);
    if (!sub) {
      skipped.holdingsNoSubmission++;
      continue;
    }
    const doc = buildHolding({
      row,
      holdingType: "nonderiv",
      submission: sub,
      ownerRows: tables.owners.get(acc),
      footnoteMap: tables.footnotes.get(acc),
      quarter,
      era,
      loadedAt,
    });
    if (!doc) {
      skipped.holdingsNoSk++;
      continue;
    }
    holdings.push(doc);
  }
  for (const row of tables.derivHoldings) {
    const acc = row.ACCESSION_NUMBER;
    if (!acc) {
      skipped.holdingsNoSubmission++;
      continue;
    }
    const sub = tables.submissions.get(acc);
    if (!sub) {
      skipped.holdingsNoSubmission++;
      continue;
    }
    const doc = buildHolding({
      row,
      holdingType: "deriv",
      submission: sub,
      ownerRows: tables.owners.get(acc),
      footnoteMap: tables.footnotes.get(acc),
      quarter,
      era,
      loadedAt,
    });
    if (!doc) {
      skipped.holdingsNoSk++;
      continue;
    }
    holdings.push(doc);
  }

  // Filings (one per accession)
  for (const [accession, sub] of tables.submissions.entries()) {
    const counts = rowCountsByAccession.get(accession) ?? {
      nonderivTrans: 0,
      derivTrans: 0,
      nonderivHolding: 0,
      derivHolding: 0,
    };
    const footnoteCount = tables.footnotes.get(accession)?.size ?? 0;
    const doc = buildFiling({
      submission: sub,
      ownerRows: tables.owners.get(accession),
      signatureRows: tables.signatures.get(accession),
      rowCounts: {
        ...counts,
        footnotes: footnoteCount,
      },
      quarter,
      era,
      loadedAt,
    });
    if (!doc) {
      skipped.filingsNoDate++;
      continue;
    }
    filings.push(doc);
  }

  console.error(
    `[form345-bulk] Built ${transactions.length} transactions, ${holdings.length} holdings, ` +
      `${filings.length} filings for ${quarter}. Skipped: ${JSON.stringify(skipped)}`,
  );

  return { transactions, holdings, filings, skipped };
}

/**
 * Top-level entry: download + extract + parse + build. Does NOT write to
 * Firestore — the CLI command handles that via the save functions in firestore.ts.
 */
export async function scrapeForm345BulkQuarter(
  quarter: string,
  options: { force?: boolean } = {},
): Promise<BuildResult> {
  const scratch = await downloadAndExtractQuarter(quarter, options);
  const tables = loadQuarterTables(scratch);
  return buildQuarterDocs(tables, quarter);
}
