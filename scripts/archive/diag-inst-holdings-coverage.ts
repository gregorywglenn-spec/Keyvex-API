import { getLiveDb } from "../src/firestore.js";

const TRACKED = {
  berkshire: "0001067983",
  blackrock: "0001364742",
  vanguard:  "0000102909",
  bridgewater: "0001350694",
  citadel:   "0001423053",
  point72:   "0001603466",
  deshaw:    "0001009207",
  renaissance:"0001037389",
  twosigma:  "0001179392",
  millennium:"0001273087",
};

async function main() {
  const db = await getLiveDb();
  console.log("=== Fund coverage in institutional_holdings ===");
  for (const [alias, cik] of Object.entries(TRACKED)) {
    const snap = await db.collection("institutional_holdings")
      .where("fund_cik", "==", cik).limit(1).get();
    console.log(`  ${alias.padEnd(12)} cik=${cik}: ${snap.size > 0 ? "PRESENT" : "ABSENT"}`);
  }

  console.log("\n=== Distinct fund_cik values across the 903 docs ===");
  const all = await db.collection("institutional_holdings").limit(2000).get();
  const funds = new Map<string, { name: string; rows: number }>();
  for (const doc of all.docs) {
    const d = doc.data() as Record<string, unknown>;
    const cik = (d.fund_cik ?? "?") as string;
    if (!funds.has(cik)) funds.set(cik, { name: (d.fund_name ?? "") as string, rows: 0 });
    funds.get(cik)!.rows++;
  }
  console.log(`  total distinct funds: ${funds.size}`);
  const sorted = Array.from(funds.entries()).sort((a, b) => b[1].rows - a[1].rows);
  for (const [cik, info] of sorted) {
    console.log(`    ${cik}  ${info.rows.toString().padStart(4)}  ${info.name}`);
  }

  console.log("\n=== cusip_map collection size ===");
  let total = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let pages = 0;
  while (pages < 30) {
    let q: FirebaseFirestore.Query = db.collection("cusip_map").limit(1000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    total += snap.size;
    last = snap.docs[snap.docs.length - 1];
    pages++;
    if (snap.size < 1000) break;
  }
  console.log(`  cusip_map entries: ${total}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
