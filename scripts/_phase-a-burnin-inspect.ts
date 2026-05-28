/**
 * Phase A burn-in inspection (READ-ONLY).
 *
 * After the 2026-05-25 scoped deploy of:
 *   scrape13FQuarterHourly, scrapeForm4HalfHourly, scrapeForm5Daily,
 *   scrapeSenateDaily, scrapeHouseDaily
 *
 * This script answers: did the write-side actually stamp the new Phase A
 * fields on rows it ingested? It does so WITHOUT touching anything —
 * pure Firestore reads, no writes, no SEC fetches, heal-worker untouched.
 *
 * Order: per Greg's burn-in spec, verify
 *   (a) cron completed (proxy: /meta/{jobName}.lastSyncedAt > deploy time)
 *   (b) row volume sensible (docsWritten + actual fresh-row count)
 *   (c) new fields present with sensible values
 *
 * Distinguishes three outcomes per scraper:
 *   - HASN'T FIRED YET   (cron tick still pending; no /meta update past deploy)
 *   - FIRED, FIELDS GOOD (cron ran post-deploy AND new rows carry the fields)
 *   - FIRED, FIELDS MISSING/WRONG (cron ran post-deploy BUT fields absent or wrong values)
 */
import { getLiveDb } from "../src/firestore.js";

// Deploy completed approximately 2026-05-25 ~12:45 UTC (within a few minutes).
// Used as the floor for "did the cron fire AFTER deploy?".
const DEPLOY_REFERENCE_ISO = process.env.DEPLOY_REF_ISO ?? "2026-05-25T12:40:00Z";
const DEPLOY_REFERENCE = new Date(DEPLOY_REFERENCE_ISO);

interface MetaDoc {
  lastSyncedAt?: { toDate?: () => Date } | Date;
  durationMs?: number;
  docsWritten?: number;
  errors?: number;
}

function asDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object" && v !== null && typeof (v as { toDate?: unknown }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  if (typeof v === "string") return new Date(v);
  return null;
}

function fmtAge(t: Date | null): string {
  if (!t) return "(no record)";
  const ageMs = Date.now() - t.getTime();
  const ageMin = ageMs / 60000;
  if (ageMin < 60) return `${ageMin.toFixed(1)} min ago`;
  return `${(ageMin / 60).toFixed(1)} hr ago`;
}

async function inspectMeta(jobName: string): Promise<{
  fired: boolean;
  postDeploy: boolean;
  doc: MetaDoc | null;
  lastSyncedAt: Date | null;
}> {
  const db = await getLiveDb();
  const snap = await db.collection("meta").doc(jobName).get();
  if (!snap.exists) return { fired: false, postDeploy: false, doc: null, lastSyncedAt: null };
  const doc = snap.data() as MetaDoc;
  const lastSyncedAt = asDate(doc.lastSyncedAt);
  return {
    fired: lastSyncedAt !== null,
    postDeploy: lastSyncedAt !== null && lastSyncedAt > DEPLOY_REFERENCE,
    doc,
    lastSyncedAt,
  };
}

function header(title: string): void {
  console.log("\n" + "═".repeat(72));
  console.log(title);
  console.log("═".repeat(72));
}

function sub(title: string): void {
  console.log("\n  " + "─".repeat(68));
  console.log("  " + title);
  console.log("  " + "─".repeat(68));
}

// ─── 13F INSPECTION (THE DECISIVE ONE) ──────────────────────────────────────

async function inspect13F(): Promise<void> {
  header("[1/5] scrape13FQuarterHourly → institutional_holdings (DECISIVE)");

  const meta = await inspectMeta("institutional13FSync");
  console.log(`  /meta/institutional13FSync:`);
  console.log(`    lastSyncedAt: ${meta.lastSyncedAt?.toISOString() ?? "(none)"}`);
  console.log(`    durationMs:   ${meta.doc?.durationMs ?? "(n/a)"}`);
  console.log(`    docsWritten:  ${meta.doc?.docsWritten ?? "(n/a)"}`);
  console.log(`    age:          ${fmtAge(meta.lastSyncedAt)}`);
  console.log(`    deploy ref:   ${DEPLOY_REFERENCE.toISOString()}`);
  console.log(`    fired post-deploy? ${meta.postDeploy ? "YES" : "NO (or hasn't fired yet)"}`);

  const db = await getLiveDb();

  // Probe: any institutional_holdings rows with verification_status set?
  sub("Rows with verification_status SET (anywhere in collection)");
  const vsAny = await db
    .collection("institutional_holdings")
    .orderBy("verification_status")
    .limit(10)
    .get();
  console.log(`    rows found (probe of 10): ${vsAny.size}`);

  // Distribution of verification_status if any are set
  if (vsAny.size > 0) {
    const vs_verified = await db
      .collection("institutional_holdings")
      .where("verification_status", "==", "VERIFIED")
      .count()
      .get();
    const vs_insufficient = await db
      .collection("institutional_holdings")
      .where("verification_status", "==", "INSUFFICIENT_DATA")
      .count()
      .get();
    console.log(`    VERIFIED:          ${vs_verified.data().count.toLocaleString()}`);
    console.log(`    INSUFFICIENT_DATA: ${vs_insufficient.data().count.toLocaleString()}`);

    // Show 3 real examples — accession + verified count vs declared
    sub("Examples (3 most-recently-stamped rows)");
    const examples = await db
      .collection("institutional_holdings")
      .where("verification_status", "in", ["VERIFIED", "INSUFFICIENT_DATA"])
      .orderBy("filing_date", "desc")
      .limit(3)
      .get();
    for (const d of examples.docs) {
      const r = d.data() as Record<string, unknown>;
      console.log(
        `    ${r.accession_number} ${r.fund_cik} q=${r.quarter} ` +
          `filed=${r.filing_date}`,
      );
      console.log(
        `      verification_status=${r.verification_status} ` +
          `expected=${r.verification_expected} actual=${r.verification_actual} ` +
          `position_change=${r.position_change}`,
      );
    }
  } else {
    console.log(`    (no rows carry verification_status — 13F cron either hasn't fired post-deploy or fired and didn't stamp)`);
  }

  // Probe: position_change INSUFFICIENT_DATA counts
  sub("position_change distribution (post-Phase-A stamps appear here)");
  const pc_insufficient = await db
    .collection("institutional_holdings")
    .where("position_change", "==", "INSUFFICIENT_DATA")
    .count()
    .get();
  console.log(`    INSUFFICIENT_DATA rows: ${pc_insufficient.data().count.toLocaleString()}`);

  // Newest rows by filing_date — regardless of vs status, to see what's recent
  sub("3 most-recent rows in collection (by filing_date desc)");
  const newest = await db
    .collection("institutional_holdings")
    .orderBy("filing_date", "desc")
    .limit(3)
    .get();
  for (const d of newest.docs) {
    const r = d.data() as Record<string, unknown>;
    console.log(
      `    ${d.id}: filed=${r.filing_date} ` +
        `vs=${r.verification_status ?? "(unset)"} ` +
        `pc=${r.position_change ?? "(unset)"}`,
    );
  }
}

// ─── FORM 4 INSPECTION ──────────────────────────────────────────────────────

async function inspectForm4(): Promise<void> {
  header("[2/5] scrapeForm4HalfHourly → insider_trades (LEGACY collection)");

  const meta = await inspectMeta("insiderTradesSync");
  console.log(`  /meta/insiderTradesSync:`);
  console.log(`    lastSyncedAt: ${meta.lastSyncedAt?.toISOString() ?? "(none)"}`);
  console.log(`    durationMs:   ${meta.doc?.durationMs ?? "(n/a)"}`);
  console.log(`    docsWritten:  ${meta.doc?.docsWritten ?? "(n/a)"}`);
  console.log(`    age:          ${fmtAge(meta.lastSyncedAt)}`);
  console.log(`    fired post-deploy? ${meta.postDeploy ? "YES" : "NO (or hasn't fired yet)"}`);

  const db = await getLiveDb();

  // transaction_nature presence on insider_trades
  sub("Rows with transaction_nature SET");
  const tnAny = await db
    .collection("insider_trades")
    .orderBy("transaction_nature")
    .limit(5)
    .get();
  console.log(`    rows found (probe of 5): ${tnAny.size}`);

  if (tnAny.size > 0) {
    sub("transaction_nature distribution");
    for (const nature of ["OPEN_MARKET", "EQUITY_COMP", "NON_OPEN_MARKET_TRANSFER", "INSUFFICIENT_DATA"]) {
      const c = await db
        .collection("insider_trades")
        .where("transaction_nature", "==", nature)
        .count()
        .get();
      console.log(`    ${nature.padEnd(28)} ${c.data().count.toLocaleString()}`);
    }
  } else {
    console.log(`    (no rows carry transaction_nature)`);
  }

  // Newest 5 rows regardless of nature presence, to see freshness
  sub("5 most-recent insider_trades rows (by disclosure_date desc)");
  const newest = await db
    .collection("insider_trades")
    .orderBy("disclosure_date", "desc")
    .limit(5)
    .get();
  for (const d of newest.docs) {
    const r = d.data() as Record<string, unknown>;
    console.log(
      `    ${d.id}: disc=${r.disclosure_date} code=${r.transaction_code} ` +
        `type=${r.transaction_type} nature=${r.transaction_nature ?? "(unset)"}`,
    );
  }
}

// ─── FORM 5 INSPECTION ──────────────────────────────────────────────────────

async function inspectForm5(): Promise<void> {
  header("[3/5] scrapeForm5Daily → insider_trades (data_source=SEC_EDGAR_FORM5)");

  const meta = await inspectMeta("form5Sync");
  console.log(`  /meta/form5Sync:`);
  console.log(`    lastSyncedAt: ${meta.lastSyncedAt?.toISOString() ?? "(none)"}`);
  console.log(`    docsWritten:  ${meta.doc?.docsWritten ?? "(n/a)"}`);
  console.log(`    age:          ${fmtAge(meta.lastSyncedAt)}`);
  console.log(`    fired post-deploy? ${meta.postDeploy ? "YES" : "NO (or hasn't fired yet — cron is 8:20 AM ET daily)"}`);

  const db = await getLiveDb();
  // Most-recent Form 5 rows — client-side filter to avoid missing composite index
  sub("3 most-recent Form 5 rows (client-filtered from 200 newest)");
  const recent = await db
    .collection("insider_trades")
    .orderBy("disclosure_date", "desc")
    .limit(200)
    .get();
  const form5Rows = recent.docs
    .map((d) => d.data() as Record<string, unknown>)
    .filter((r) => r.data_source === "SEC_EDGAR_FORM5")
    .slice(0, 3);
  if (form5Rows.length === 0) {
    console.log(`    (no Form 5 rows found in 200 most-recent insider_trades)`);
  } else {
    for (const r of form5Rows) {
      console.log(
        `    disc=${r.disclosure_date} code=${r.transaction_code} ` +
          `nature=${r.transaction_nature ?? "(unset)"}`,
      );
    }
  }
}

// ─── SENATE/HOUSE INSPECTION ────────────────────────────────────────────────

async function inspectCongressional(): Promise<void> {
  header("[4/5] scrapeSenateDaily → congressional_trades (Senate)");

  const senateMeta = await inspectMeta("senatePtrSync");
  console.log(`  /meta/senatePtrSync:`);
  console.log(`    lastSyncedAt: ${senateMeta.lastSyncedAt?.toISOString() ?? "(none)"}`);
  console.log(`    docsWritten:  ${senateMeta.doc?.docsWritten ?? "(n/a)"}`);
  console.log(`    age:          ${fmtAge(senateMeta.lastSyncedAt)}`);
  console.log(`    fired post-deploy? ${senateMeta.postDeploy ? "YES" : "NO (cron is 6:00 AM ET daily)"}`);

  header("[5/5] scrapeHouseDaily → congressional_trades (House)");

  const houseMeta = await inspectMeta("housePtrSync");
  console.log(`  /meta/housePtrSync:`);
  console.log(`    lastSyncedAt: ${houseMeta.lastSyncedAt?.toISOString() ?? "(none)"}`);
  console.log(`    docsWritten:  ${houseMeta.doc?.docsWritten ?? "(n/a)"}`);
  console.log(`    age:          ${fmtAge(houseMeta.lastSyncedAt)}`);
  console.log(`    fired post-deploy? ${houseMeta.postDeploy ? "YES" : "NO (cron is 6:00 AM ET daily)"}`);

  const db = await getLiveDb();
  sub("transaction_nature presence on congressional_trades");
  const tnAny = await db
    .collection("congressional_trades")
    .orderBy("transaction_nature")
    .limit(5)
    .get();
  console.log(`    rows found (probe of 5): ${tnAny.size}`);

  if (tnAny.size > 0) {
    sub("transaction_nature distribution");
    for (const nature of ["OPEN_MARKET", "EQUITY_COMP", "NON_OPEN_MARKET_TRANSFER", "INSUFFICIENT_DATA"]) {
      const c = await db
        .collection("congressional_trades")
        .where("transaction_nature", "==", nature)
        .count()
        .get();
      console.log(`    ${nature.padEnd(28)} ${c.data().count.toLocaleString()}`);
    }
  } else {
    console.log(`    (no congressional_trades rows carry transaction_nature)`);
  }

  sub("3 most-recent congressional_trades rows (by disclosure_date desc)");
  const newest = await db
    .collection("congressional_trades")
    .orderBy("disclosure_date", "desc")
    .limit(3)
    .get();
  for (const d of newest.docs) {
    const r = d.data() as Record<string, unknown>;
    console.log(
      `    ${d.id}: disc=${r.disclosure_date} chamber=${r.chamber} ` +
        `type=${r.transaction_type} nature=${r.transaction_nature ?? "(unset)"}`,
    );
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Burn-in inspection — current time: ${new Date().toISOString()}`);
  console.log(`Deploy reference floor: ${DEPLOY_REFERENCE.toISOString()}`);

  await inspect13F();
  await inspectForm4();
  await inspectForm5();
  await inspectCongressional();

  console.log("\n" + "═".repeat(72));
  console.log("INSPECTION COMPLETE — read-only, no side effects");
  console.log("═".repeat(72));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
