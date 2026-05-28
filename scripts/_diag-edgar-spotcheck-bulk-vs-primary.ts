/**
 * EDGAR primary-filing spot-check for bulk_v2 date attribution.
 *
 * READ-ONLY. HTTP GETs against sec.gov + Firestore reads only.
 *
 * ──────────────────────────────────────────────────────────────────────
 * NO-WRITE ATTESTATION
 * ──────────────────────────────────────────────────────────────────────
 * Firestore surface: .where().limit().get() only (candidate-row reads).
 * Network surface:  fetch(GET) only, to sec.gov.
 *
 * The following methods are NEVER called from this file. Grep to confirm:
 *   .set(  .update(  .delete(  .add(  .create(  .batch(
 *   FieldValue.delete  FieldValue.increment  FieldValue.arrayUnion
 *   WriteBatch  bulkWriter  writeBulk
 *
 * Backfill is permanently closed by director decision; the v4 amendment +
 * full push are held until this spot-check reports.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Question this script tests:
 *   For the ~29K bulk_v2 rows with corrupt-looking dates (00XX-prefix /
 *   203X-tens-mutation faces on transaction_date / exercise_date /
 *   expiration_date), is the same bad date present in SEC's original
 *   Form 4/5 primary XML filing?
 *     primary == bulk == bad date  → CONFIRMED_FILER_ERROR (source-faithful)
 *     primary correct, bulk wrong  → BULK_VS_PRIMARY_DISCREPANCY (SEC-bulk bug)
 *
 * Method:
 *   1. Stratified sample of 20 rows from insider_transactions_v2:
 *        6 NONDERIV transaction_date < 1990 (00XX face on close-semantics)
 *        6 DERIV exercise/expiration_date < 1990 (00XX, forward-semantics)
 *        4 NONDERIV transaction_date in (2027, 2050) (203X tens-mutation)
 *        4 multi-field DERIV (corruption on transaction + exercise/expiration
 *          on the same row — tests whether multi-field corruption co-occurs
 *          in primary or only in bulk)
 *   2. Bias candidate pool to filing_date >= 2010-01-01 (XML mandate landed
 *      ~2009; pre-2009 filings often have no primary XML).
 *   3. For each candidate, fetch EDGAR index.json, find the primary XML
 *      (primary_doc.xml or wk-form[345]_*.xml), fetch it.
 *   4. Content-match to the XML transaction on a 4-FIELD KEY:
 *        security_title + transaction_code + transaction_shares +
 *        transaction_price_per_share
 *      Price is the disambiguator when the same security trades multiple
 *      times at different prices on the same filing. Bulk row's SK is NOT
 *      exposed in the XML, so content-match is the only path.
 *      DATE IS NEVER PART OF THE MATCH KEY (date is the output, never the
 *      key — matching by date would make a real "discrepancy" invisible).
 *      Ambiguity (multiple XML candidates after the 4-field key) is
 *      surfaced, not resolved by guess.
 *   5. For multi-field rows: compare EVERY corrupt field on the row, not
 *      just the discovery-triggering field.
 *
 * Outputs:
 *   - Per-row: doc id, bucket, security_title, match-key evidence,
 *     primary-XML field value(s), bulk-TSV field value(s), match/differ,
 *     verdict per field, overall row verdict.
 *   - Headline: bucket-level breakdown of verdicts.
 *
 * NO PRODUCTION WRITE. NO COMMIT. NO RE-INGEST. Verdict reports + holds.
 */

import { getLiveDb } from "../src/firestore.js";
import { XMLParser } from "fast-xml-parser";

// ─── Constants ──────────────────────────────────────────────────────────

const USER_AGENT = "KeyVex Research contact@keyvex.com";
const SEC_REQ_DELAY_MS = 110; // ~9 req/sec, safe under SEC's 10 req/sec cap
const EDGAR_BASE = "https://www.sec.gov";

const FILING_DATE_FLOOR = "2010-01-01"; // bias toward post-XML-mandate filings

const BUCKETS = {
  "00XX-NONDERIV-trans": 6,
  "00XX-DERIV-exer-exp": 6,
  "203X-NONDERIV-trans": 4,
  "multi-field-DERIV": 4,
} as const;
type BucketName = keyof typeof BUCKETS;

const CANDIDATE_FIRESTORE_LIMIT = 200; // pull this many per discovery query, post-filter from there

// ─── Types ──────────────────────────────────────────────────────────────

interface BulkRow {
  id: string;
  accession_number: string;
  company_cik: string;
  transaction_type: "nonderiv" | "deriv";
  security_title: string;
  trans_code: string;
  trans_shares: number | null;
  trans_price_per_share: number | null;
  transaction_date: string;
  exercise_date: string | null;
  expiration_date: string | null;
  filing_date: string;
  schema_era: string;
  source_zip: string;
}

interface XmlTransaction {
  securityTitle: string;
  transactionCode: string;
  transactionShares: number | null;
  transactionPricePerShare: number | null;
  transactionDate: string | null;
  exerciseDate?: string | null;
  expirationDate?: string | null;
}

type Verdict =
  | "CONFIRMED_FILER_ERROR" // primary == bulk == bad
  | "BULK_VS_PRIMARY_DISCREPANCY" // primary correct, bulk wrong
  | "MIXED" // some fields confirmed, some discrepant
  | "NO_PRIMARY_XML" // filing has no primary XML
  | "AMBIGUOUS_MATCH" // multiple XML candidates after 4-field key
  | "NO_MATCH" // 0 XML candidates after 4-field key
  | "FETCH_FAILED"; // EDGAR HTTP error

interface FieldComparison {
  field: "transaction_date" | "exercise_date" | "expiration_date";
  bulkValue: string;
  primaryValue: string | null;
  result: "MATCH_BAD" | "DIFFER" | "PRIMARY_MISSING";
}

interface RowResult {
  bucket: BucketName;
  bulkRow: BulkRow;
  verdict: Verdict;
  matchEvidence: string;
  candidates: XmlTransaction[];
  fieldComparisons: FieldComparison[];
  error?: string;
}

// ─── Pacing ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastFetchAt = 0;

async function pacedFetch(url: string): Promise<Response> {
  const elapsed = Date.now() - lastFetchAt;
  if (elapsed < SEC_REQ_DELAY_MS) await sleep(SEC_REQ_DELAY_MS - elapsed);
  lastFetchAt = Date.now();
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, application/xml, text/xml, */*",
    },
  });
}

// ─── EDGAR URL builders ─────────────────────────────────────────────────

function unpadCik(cik: string): string {
  const stripped = cik.replace(/^0+/, "");
  return stripped || "0";
}

function accessionNoDashes(accession: string): string {
  return accession.replace(/-/g, "");
}

function buildIndexJsonUrl(cik: string, accession: string): string {
  return `${EDGAR_BASE}/Archives/edgar/data/${unpadCik(cik)}/${accessionNoDashes(accession)}/index.json`;
}

function buildFileUrl(cik: string, accession: string, filename: string): string {
  return `${EDGAR_BASE}/Archives/edgar/data/${unpadCik(cik)}/${accessionNoDashes(accession)}/${filename}`;
}

// ─── EDGAR index.json + primary-XML discovery ───────────────────────────

interface EdgarIndexEntry {
  name: string;
  type?: string;
  size?: string;
}

interface EdgarIndex {
  directory: {
    name: string;
    item: EdgarIndexEntry[];
  };
}

async function fetchIndexJson(
  cik: string,
  accession: string,
): Promise<EdgarIndex | null> {
  const url = buildIndexJsonUrl(cik, accession);
  const res = await pacedFetch(url);
  if (!res.ok) return null;
  return (await res.json()) as EdgarIndex;
}

function pickPrimaryXmlFilename(idx: EdgarIndex): string | null {
  const items = idx.directory.item ?? [];
  // Newer convention (post ~2012): primary_doc.xml
  const primary = items.find((i) => i.name === "primary_doc.xml");
  if (primary) return primary.name;
  // Older convention (~2009-2012): wk-form{3,4,5}_<digits>.xml
  const wkForm = items.find((i) => /^wk-form[345].*\.xml$/i.test(i.name));
  if (wkForm) return wkForm.name;
  // Last resort: any .xml that isn't an index/header/cover file
  const anyXml = items.find(
    (i) =>
      i.name.endsWith(".xml") &&
      !/-(index|headers|metadata|cover)\.xml$/i.test(i.name),
  );
  return anyXml?.name ?? null;
}

async function fetchPrimaryXml(
  cik: string,
  accession: string,
  filename: string,
): Promise<string | null> {
  const url = buildFileUrl(cik, accession, filename);
  const res = await pacedFetch(url);
  if (!res.ok) return null;
  return await res.text();
}

// ─── XML parsing ────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreAttributes: false,
  trimValues: true,
});

function safeGet(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function arrayify<T>(x: T | T[] | undefined | null): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function strVal(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function numLike(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function extractXmlTransactions(
  xmlText: string,
  type: "nonderiv" | "deriv",
): XmlTransaction[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xmlText);
  } catch (e) {
    return [];
  }
  const doc = safeGet(parsed, ["ownershipDocument"]);
  if (!doc) return [];
  const tableKey =
    type === "nonderiv" ? "nonDerivativeTable" : "derivativeTable";
  const txKey =
    type === "nonderiv"
      ? "nonDerivativeTransaction"
      : "derivativeTransaction";
  const rawList = arrayify(safeGet(doc, [tableKey, txKey])) as unknown[];
  return rawList.map((t) => {
    const tObj = t as Record<string, unknown>;
    const out: XmlTransaction = {
      securityTitle: strVal(safeGet(tObj, ["securityTitle", "value"])),
      transactionCode: strVal(
        safeGet(tObj, ["transactionCoding", "transactionCode"]),
      ),
      transactionShares: numLike(
        safeGet(tObj, ["transactionAmounts", "transactionShares", "value"]),
      ),
      transactionPricePerShare: numLike(
        safeGet(tObj, [
          "transactionAmounts",
          "transactionPricePerShare",
          "value",
        ]),
      ),
      transactionDate:
        strVal(safeGet(tObj, ["transactionDate", "value"])) || null,
    };
    if (type === "deriv") {
      out.exerciseDate =
        strVal(safeGet(tObj, ["exerciseDate", "value"])) || null;
      out.expirationDate =
        strVal(safeGet(tObj, ["expirationDate", "value"])) || null;
    }
    return out;
  });
}

// ─── Content matching ───────────────────────────────────────────────────

function numEqualish(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a === b) return true;
  const mag = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= mag * 1e-6;
}

function strEqualish(a: string, b: string): boolean {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

interface MatchResult {
  matches: XmlTransaction[];
  evidence: string;
}

function matchTransaction(
  row: BulkRow,
  xmlTxs: XmlTransaction[],
): MatchResult {
  // Three-field core match
  const threeFieldMatches = xmlTxs.filter(
    (tx) =>
      strEqualish(tx.securityTitle, row.security_title) &&
      tx.transactionCode === row.trans_code &&
      numEqualish(tx.transactionShares, row.trans_shares),
  );

  if (threeFieldMatches.length === 0) {
    return { matches: [], evidence: "0 candidates on 3-field key (title+code+shares)" };
  }
  if (threeFieldMatches.length === 1) {
    return {
      matches: threeFieldMatches,
      evidence: "1 unique candidate on 3-field key (price not needed)",
    };
  }

  // Multiple candidates — disambiguate with price
  if (row.trans_price_per_share == null) {
    return {
      matches: threeFieldMatches,
      evidence: `${threeFieldMatches.length} candidates on 3-field key; bulk row has no price for disambiguation`,
    };
  }
  const priceFiltered = threeFieldMatches.filter((tx) =>
    numEqualish(tx.transactionPricePerShare, row.trans_price_per_share),
  );
  if (priceFiltered.length === 1) {
    return {
      matches: priceFiltered,
      evidence: "1 unique candidate after 4-field key (price disambiguated)",
    };
  }
  if (priceFiltered.length === 0) {
    return {
      matches: threeFieldMatches,
      evidence: `${threeFieldMatches.length} candidates on 3-field key; price=${row.trans_price_per_share} not found in any XML candidate's price field — surfacing all 3-field matches`,
    };
  }
  return {
    matches: priceFiltered,
    evidence: `${priceFiltered.length} candidates remaining after 4-field key (genuinely ambiguous — same security/code/shares/price)`,
  };
}

// ─── Per-row comparison ─────────────────────────────────────────────────

function corruptFieldsOnRow(row: BulkRow): Array<FieldComparison["field"]> {
  const fields: Array<FieldComparison["field"]> = [];
  if (row.transaction_date < "1990-01-01" || row.transaction_date > "2027-01-01") {
    fields.push("transaction_date");
  }
  if (
    row.exercise_date != null &&
    (row.exercise_date < "1990-01-01" || row.exercise_date > "2050-01-01")
  ) {
    fields.push("exercise_date");
  }
  if (
    row.expiration_date != null &&
    (row.expiration_date < "1990-01-01" || row.expiration_date > "2050-01-01")
  ) {
    fields.push("expiration_date");
  }
  return fields;
}

function compareFields(
  row: BulkRow,
  xmlTx: XmlTransaction,
): FieldComparison[] {
  const corrupt = corruptFieldsOnRow(row);
  return corrupt.map((field) => {
    const bulkValue =
      field === "transaction_date"
        ? row.transaction_date
        : field === "exercise_date"
          ? (row.exercise_date ?? "")
          : (row.expiration_date ?? "");
    const primaryValue =
      field === "transaction_date"
        ? xmlTx.transactionDate
        : field === "exercise_date"
          ? (xmlTx.exerciseDate ?? null)
          : (xmlTx.expirationDate ?? null);
    if (primaryValue == null || primaryValue === "") {
      return { field, bulkValue, primaryValue: null, result: "PRIMARY_MISSING" };
    }
    return {
      field,
      bulkValue,
      primaryValue,
      result: primaryValue === bulkValue ? "MATCH_BAD" : "DIFFER",
    };
  });
}

function rowVerdict(comps: FieldComparison[]): Verdict {
  if (comps.length === 0) return "NO_MATCH"; // shouldn't happen
  const hasDiffer = comps.some((c) => c.result === "DIFFER");
  const hasMatch = comps.some((c) => c.result === "MATCH_BAD");
  if (hasDiffer && hasMatch) return "MIXED";
  if (hasDiffer) return "BULK_VS_PRIMARY_DISCREPANCY";
  if (hasMatch) return "CONFIRMED_FILER_ERROR";
  // All PRIMARY_MISSING — treat as no usable comparison
  return "NO_MATCH";
}

// ─── Firestore candidate sampling ───────────────────────────────────────

type FirestoreDb = Awaited<ReturnType<typeof getLiveDb>>;

function docToBulkRow(doc: FirebaseFirestore.QueryDocumentSnapshot): BulkRow {
  const d = doc.data() as Record<string, unknown>;
  return {
    id: doc.id,
    accession_number: String(d.accession_number ?? ""),
    company_cik: String(d.company_cik ?? ""),
    transaction_type:
      d.transaction_type === "nonderiv" || d.transaction_type === "deriv"
        ? d.transaction_type
        : "nonderiv",
    security_title: String(d.security_title ?? ""),
    trans_code: String(d.trans_code ?? ""),
    trans_shares:
      typeof d.trans_shares === "number" ? d.trans_shares : null,
    trans_price_per_share:
      typeof d.trans_price_per_share === "number"
        ? d.trans_price_per_share
        : null,
    transaction_date: String(d.transaction_date ?? ""),
    exercise_date:
      typeof d.exercise_date === "string" ? d.exercise_date : null,
    expiration_date:
      typeof d.expiration_date === "string" ? d.expiration_date : null,
    filing_date: String(d.filing_date ?? ""),
    schema_era: String(d.schema_era ?? ""),
    source_zip: String(d.source_zip ?? ""),
  };
}

async function fetchCandidatePools(
  db: FirestoreDb,
): Promise<Record<BucketName, BulkRow[]>> {
  console.log("Fetching candidate pools from Firestore...");

  // Query 1: transaction_date < 1990 — feeds 00XX-NONDERIV-trans + multi-field
  const trans00xxSnap = await db
    .collection("insider_transactions_v2")
    .where("transaction_date", "<", "1990-01-01")
    .limit(CANDIDATE_FIRESTORE_LIMIT)
    .get();
  const trans00xxAll = trans00xxSnap.docs.map(docToBulkRow);
  console.log(`  transaction_date < 1990: ${trans00xxAll.length} rows`);

  // Query 2: exercise_date < 1990 — feeds 00XX-DERIV-exer-exp (primary)
  const exer00xxSnap = await db
    .collection("insider_transactions_v2")
    .where("exercise_date", "<", "1990-01-01")
    .limit(CANDIDATE_FIRESTORE_LIMIT)
    .get();
  const exer00xxAll = exer00xxSnap.docs.map(docToBulkRow);
  console.log(`  exercise_date < 1990: ${exer00xxAll.length} rows`);

  // Query 3: transaction_date > 2027 — feeds 203X-NONDERIV-trans
  const trans203xSnap = await db
    .collection("insider_transactions_v2")
    .where("transaction_date", ">", "2027-01-01")
    .limit(CANDIDATE_FIRESTORE_LIMIT)
    .get();
  const trans203xAll = trans203xSnap.docs.map(docToBulkRow);
  console.log(`  transaction_date > 2027: ${trans203xAll.length} rows`);

  // Build buckets, bias toward post-2010 filings, dedupe across buckets
  const seenIds = new Set<string>();
  const take = (rows: BulkRow[], limit: number): BulkRow[] => {
    const filtered = rows
      .filter((r) => r.filing_date >= FILING_DATE_FLOOR && !seenIds.has(r.id))
      .sort((a, b) => b.filing_date.localeCompare(a.filing_date)); // newest first
    const picked: BulkRow[] = [];
    for (const r of filtered) {
      if (picked.length >= limit) break;
      picked.push(r);
      seenIds.add(r.id);
    }
    return picked;
  };

  // Bucket: 00XX-NONDERIV-trans (transaction_date < 1990, type=nonderiv)
  const ndTrans00xxPool = take(
    trans00xxAll.filter((r) => r.transaction_type === "nonderiv"),
    BUCKETS["00XX-NONDERIV-trans"] * 3,
  );

  // Bucket: multi-field-DERIV (transaction_date < 1990 AND exercise_date < 1990, type=deriv)
  const multiPool = take(
    trans00xxAll.filter(
      (r) =>
        r.transaction_type === "deriv" &&
        r.exercise_date != null &&
        r.exercise_date < "1990-01-01",
    ),
    BUCKETS["multi-field-DERIV"] * 3,
  );

  // Bucket: 00XX-DERIV-exer-exp (exercise_date < 1990; not already taken into multi-field)
  const dvExer00xxPool = take(
    exer00xxAll.filter(
      (r) =>
        r.transaction_type === "deriv" &&
        // Either transaction_date is clean OR not corrupt — pure forward-field case
        !(r.transaction_date < "1990-01-01") &&
        !(r.transaction_date > "2027-01-01"),
    ),
    BUCKETS["00XX-DERIV-exer-exp"] * 3,
  );

  // Bucket: 203X-NONDERIV-trans (transaction_date in (2027, 2050), type=nonderiv)
  const nd203xPool = take(
    trans203xAll.filter(
      (r) =>
        r.transaction_type === "nonderiv" &&
        r.transaction_date < "2050-01-01",
    ),
    BUCKETS["203X-NONDERIV-trans"] * 3,
  );

  console.log(`Candidate pools (post-${FILING_DATE_FLOOR}, deduped):`);
  console.log(`  00XX-NONDERIV-trans: ${ndTrans00xxPool.length}`);
  console.log(`  00XX-DERIV-exer-exp: ${dvExer00xxPool.length}`);
  console.log(`  203X-NONDERIV-trans: ${nd203xPool.length}`);
  console.log(`  multi-field-DERIV:   ${multiPool.length}`);
  console.log("");

  return {
    "00XX-NONDERIV-trans": ndTrans00xxPool,
    "00XX-DERIV-exer-exp": dvExer00xxPool,
    "203X-NONDERIV-trans": nd203xPool,
    "multi-field-DERIV": multiPool,
  };
}

// ─── Main pipeline ──────────────────────────────────────────────────────

async function evaluateRow(
  bucket: BucketName,
  row: BulkRow,
): Promise<RowResult> {
  // 1. Fetch EDGAR index.json
  let idx: EdgarIndex | null;
  try {
    idx = await fetchIndexJson(row.company_cik, row.accession_number);
  } catch (e) {
    return {
      bucket,
      bulkRow: row,
      verdict: "FETCH_FAILED",
      matchEvidence: "index.json fetch threw",
      candidates: [],
      fieldComparisons: [],
      error: (e as Error).message.slice(0, 200),
    };
  }
  if (!idx) {
    return {
      bucket,
      bulkRow: row,
      verdict: "NO_PRIMARY_XML",
      matchEvidence: "index.json returned non-OK or empty",
      candidates: [],
      fieldComparisons: [],
    };
  }

  // 2. Pick primary XML filename
  const xmlName = pickPrimaryXmlFilename(idx);
  if (!xmlName) {
    return {
      bucket,
      bulkRow: row,
      verdict: "NO_PRIMARY_XML",
      matchEvidence: "no primary_doc.xml or wk-form*.xml in index",
      candidates: [],
      fieldComparisons: [],
    };
  }

  // 3. Fetch + parse XML
  let xmlText: string | null;
  try {
    xmlText = await fetchPrimaryXml(row.company_cik, row.accession_number, xmlName);
  } catch (e) {
    return {
      bucket,
      bulkRow: row,
      verdict: "FETCH_FAILED",
      matchEvidence: `XML fetch threw on ${xmlName}`,
      candidates: [],
      fieldComparisons: [],
      error: (e as Error).message.slice(0, 200),
    };
  }
  if (!xmlText) {
    return {
      bucket,
      bulkRow: row,
      verdict: "FETCH_FAILED",
      matchEvidence: `XML fetch HTTP-failed for ${xmlName}`,
      candidates: [],
      fieldComparisons: [],
    };
  }

  const xmlTxs = extractXmlTransactions(xmlText, row.transaction_type);
  if (xmlTxs.length === 0) {
    return {
      bucket,
      bulkRow: row,
      verdict: "NO_MATCH",
      matchEvidence: `parsed XML has no ${row.transaction_type} transactions`,
      candidates: [],
      fieldComparisons: [],
    };
  }

  // 4. Content-match
  const m = matchTransaction(row, xmlTxs);
  if (m.matches.length === 0) {
    return {
      bucket,
      bulkRow: row,
      verdict: "NO_MATCH",
      matchEvidence: m.evidence,
      candidates: xmlTxs, // surface ALL XML transactions for inspection
      fieldComparisons: [],
    };
  }
  if (m.matches.length > 1) {
    return {
      bucket,
      bulkRow: row,
      verdict: "AMBIGUOUS_MATCH",
      matchEvidence: m.evidence,
      candidates: m.matches,
      fieldComparisons: [],
    };
  }

  // 5. Compare every corrupt field on the row
  const xmlTx = m.matches[0]!;
  const comparisons = compareFields(row, xmlTx);
  const v = rowVerdict(comparisons);
  return {
    bucket,
    bulkRow: row,
    verdict: v,
    matchEvidence: m.evidence,
    candidates: [xmlTx],
    fieldComparisons: comparisons,
  };
}

async function fillBucketFromPool(
  bucket: BucketName,
  pool: BulkRow[],
  target: number,
): Promise<{ results: RowResult[]; poolExhausted: boolean; noXmlSkipped: number }> {
  console.log("");
  console.log(`── Bucket: ${bucket} (target=${target}) ──`);
  const results: RowResult[] = [];
  let noXmlSkipped = 0;
  let candidatesTried = 0;
  for (const row of pool) {
    candidatesTried++;
    const r = await evaluateRow(bucket, row);
    if (r.verdict === "NO_PRIMARY_XML") {
      noXmlSkipped++;
      console.log(
        `  [skip] ${row.id} — no primary XML available (${candidatesTried} candidates tried)`,
      );
      continue;
    }
    // All other verdicts count as a "real" evaluation; include them in the bucket
    results.push(r);
    console.log(
      `  [${results.length}/${target}] ${row.id} -> ${r.verdict}`,
    );
    if (results.length >= target) break;
  }
  return {
    results,
    poolExhausted: results.length < target,
    noXmlSkipped,
  };
}

function printRowDetail(idx: number, total: number, r: RowResult): void {
  const row = r.bulkRow;
  console.log("");
  console.log(`[${idx}/${total}] ${r.bulkRow.id}`);
  console.log(`  bucket:          ${r.bucket}`);
  console.log(`  source_zip:      ${row.source_zip}`);
  console.log(`  filing_date:     ${row.filing_date}`);
  console.log(`  company_cik:     ${row.company_cik}`);
  console.log(`  accession:       ${row.accession_number}`);
  console.log(`  security_title:  ${row.security_title}`);
  console.log(
    `  match-key:       code=${row.trans_code} shares=${row.trans_shares ?? "null"} price=${row.trans_price_per_share ?? "null"}`,
  );
  console.log(`  match-evidence:  ${r.matchEvidence}`);

  if (r.verdict === "AMBIGUOUS_MATCH" || r.verdict === "NO_MATCH") {
    console.log(`  candidates (${r.candidates.length}):`);
    for (const c of r.candidates) {
      console.log(
        `    title="${c.securityTitle}" code=${c.transactionCode} shares=${c.transactionShares} price=${c.transactionPricePerShare} txDate=${c.transactionDate} exerDate=${c.exerciseDate ?? "—"} expDate=${c.expirationDate ?? "—"}`,
      );
    }
  } else if (r.fieldComparisons.length > 0) {
    console.log(`  field comparisons:`);
    for (const c of r.fieldComparisons) {
      const tag =
        c.result === "MATCH_BAD"
          ? "MATCH-BAD (both wrong = filer error)"
          : c.result === "DIFFER"
            ? "DIFFER  ← !! BULK-VS-PRIMARY DISCREPANCY !!"
            : "PRIMARY_MISSING";
      console.log(
        `    ${c.field.padEnd(16)}: bulk=${c.bulkValue}  primary=${c.primaryValue ?? "(missing)"}  -> ${tag}`,
      );
    }
  }
  console.log(`  verdict:         ${r.verdict}`);
  if (r.error) console.log(`  error:           ${r.error}`);
}

function printHeadline(
  allResults: RowResult[],
  perBucketSkipCounts: Record<BucketName, number>,
): void {
  console.log("");
  console.log("############################################################");
  console.log("HEADLINE — bucket-level verdict breakdown");
  console.log("############################################################");

  const buckets = Object.keys(BUCKETS) as BucketName[];
  for (const b of buckets) {
    const rows = allResults.filter((r) => r.bucket === b);
    const verdicts: Record<string, number> = {};
    for (const r of rows) {
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    }
    console.log("");
    console.log(`${b}  (target=${BUCKETS[b]}, evaluated=${rows.length}, no-primary-xml skipped during fill=${perBucketSkipCounts[b]})`);
    if (rows.length === 0) {
      console.log("  (no rows evaluated)");
      continue;
    }
    for (const [v, n] of Object.entries(verdicts).sort()) {
      console.log(`  ${v.padEnd(34)}: ${n}`);
    }
  }

  // Cross-bucket field-level totals
  console.log("");
  console.log("Cross-bucket field-comparison totals (for rows that yielded a comparison):");
  const fieldStats: Record<string, { match: number; differ: number; missing: number }> = {};
  for (const r of allResults) {
    for (const c of r.fieldComparisons) {
      if (!fieldStats[c.field])
        fieldStats[c.field] = { match: 0, differ: 0, missing: 0 };
      if (c.result === "MATCH_BAD") fieldStats[c.field]!.match++;
      else if (c.result === "DIFFER") fieldStats[c.field]!.differ++;
      else fieldStats[c.field]!.missing++;
    }
  }
  for (const [field, s] of Object.entries(fieldStats)) {
    const total = s.match + s.differ + s.missing;
    console.log(`  ${field.padEnd(20)}: total=${total}  match-bad=${s.match}  differ=${s.differ}  primary-missing=${s.missing}`);
  }

  // Net answer
  console.log("");
  console.log("############################################################");
  console.log("NET INTERPRETATION");
  console.log("############################################################");
  const totalMatch = Object.values(fieldStats).reduce((a, s) => a + s.match, 0);
  const totalDiffer = Object.values(fieldStats).reduce((a, s) => a + s.differ, 0);
  const totalMissing = Object.values(fieldStats).reduce((a, s) => a + s.missing, 0);
  console.log(`  Total field-comparisons:           ${totalMatch + totalDiffer + totalMissing}`);
  console.log(`  Primary == Bulk (filer error):     ${totalMatch}`);
  console.log(`  Primary differs from Bulk:         ${totalDiffer}`);
  console.log(`  Primary date missing:              ${totalMissing}`);
  console.log("");
  if (totalDiffer === 0 && totalMatch > 0) {
    console.log("  -> CONFIRMED FILER ERROR (no bulk-vs-primary discrepancies observed).");
    console.log("     The bad dates exist in SEC's primary filings; bulk extract is");
    console.log("     faithful. Documentation should say so.");
  } else if (totalDiffer > 0 && totalMatch === 0) {
    console.log("  -> BULK-VS-PRIMARY DISCREPANCY (every observed mismatch shows the");
    console.log("     bulk extract differs from the primary). This is a SEC-bulk-side");
    console.log("     bug worth surfacing.");
  } else if (totalDiffer > 0 && totalMatch > 0) {
    console.log("  -> MIXED. Some rows are filer-side errors, some are bulk-extract");
    console.log("     drift. Documentation needs to distinguish per-pattern.");
  } else {
    console.log("  -> INCONCLUSIVE. Need a larger sample or different bucket selection.");
  }
  console.log("");
  console.log("DRY-CHECK COMPLETE. NO PRODUCTION WRITE OCCURRED.");
  console.log("v4 amendment + push remain HELD pending committee decision on this verdict.");
}

async function main(): Promise<void> {
  console.log("############################################################");
  console.log("EDGAR PRIMARY-FILING SPOT-CHECK — bulk_v2 date attribution");
  console.log("READ-ONLY. HTTP GETs to sec.gov + Firestore reads only.");
  console.log("############################################################");
  console.log("");
  console.log(`User-Agent:        ${USER_AGENT}`);
  console.log(`Rate limit:        ${SEC_REQ_DELAY_MS}ms between SEC requests (~${(1000 / SEC_REQ_DELAY_MS).toFixed(1)} req/sec)`);
  console.log(`Filing date floor: ${FILING_DATE_FLOOR} (XML-mandate margin)`);
  console.log(`Bucket targets:`);
  for (const [b, n] of Object.entries(BUCKETS)) {
    console.log(`  ${b.padEnd(26)}: ${n}`);
  }
  console.log("");

  const db = await getLiveDb();
  const pools = await fetchCandidatePools(db);

  const allResults: RowResult[] = [];
  const perBucketSkipCounts: Record<BucketName, number> = {
    "00XX-NONDERIV-trans": 0,
    "00XX-DERIV-exer-exp": 0,
    "203X-NONDERIV-trans": 0,
    "multi-field-DERIV": 0,
  };

  for (const bucket of Object.keys(BUCKETS) as BucketName[]) {
    const target = BUCKETS[bucket];
    const filled = await fillBucketFromPool(bucket, pools[bucket], target);
    allResults.push(...filled.results);
    perBucketSkipCounts[bucket] = filled.noXmlSkipped;
    if (filled.poolExhausted) {
      console.log(
        `  WARNING: bucket ${bucket} pool exhausted with ${filled.results.length}/${target} verified rows (no-primary-xml skipped: ${filled.noXmlSkipped})`,
      );
    }
  }

  console.log("");
  console.log("############################################################");
  console.log("PER-ROW DETAIL");
  console.log("############################################################");
  allResults.forEach((r, i) => printRowDetail(i + 1, allResults.length, r));

  printHeadline(allResults, perBucketSkipCounts);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
