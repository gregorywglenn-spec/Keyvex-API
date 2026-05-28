import { getLiveDb } from "../src/firestore.js";

async function main() {
  const db = await getLiveDb();
  console.log("=== congressional_trades: bioguide_id population audit ===");
  // House
  const houseSnap = await db.collection("congressional_trades")
    .where("chamber", "==", "house").limit(50).get();
  let hWith = 0, hWithout = 0;
  const hSample: string[] = [];
  for (const doc of houseSnap.docs) {
    const d = doc.data() as Record<string, unknown>;
    const bg = (d.bioguide_id ?? "") as string;
    if (bg) hWith++; else hWithout++;
    if (hSample.length < 5) hSample.push(`${(d.member_name ?? "?") as string}  bioguide_id="${bg}"  party="${(d.party ?? "") as string}"`);
  }
  console.log(`  HOUSE  (sample ${houseSnap.size}): ${hWith} with bioguide_id, ${hWithout} without`);
  for (const s of hSample) console.log(`    ${s}`);

  // Senate
  const senSnap = await db.collection("congressional_trades")
    .where("chamber", "==", "senate").limit(50).get();
  let sWith = 0, sWithout = 0;
  const sSample: string[] = [];
  for (const doc of senSnap.docs) {
    const d = doc.data() as Record<string, unknown>;
    const bg = (d.bioguide_id ?? "") as string;
    if (bg) sWith++; else sWithout++;
    if (sSample.length < 5) sSample.push(`${(d.member_name ?? "?") as string}  bioguide_id="${bg}"  party="${(d.party ?? "") as string}"`);
  }
  console.log(`\n  SENATE (sample ${senSnap.size}): ${sWith} with bioguide_id, ${sWithout} without`);
  for (const s of sSample) console.log(`    ${s}`);

  // Total counts
  console.log("\n=== Full-collection bioguide_id distribution ===");
  // Use Firestore aggregate. Or scan in chunks.
  let total = 0, withBg = 0, withoutBg = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  while (true) {
    let q: FirebaseFirestore.Query = db.collection("congressional_trades").limit(1000);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      total++;
      if (d.bioguide_id) withBg++; else withoutBg++;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }
  console.log(`  total congressional_trades: ${total}`);
  console.log(`  with bioguide_id:    ${withBg}  (${(100*withBg/total).toFixed(1)}%)`);
  console.log(`  without bioguide_id: ${withoutBg}  (${(100*withoutBg/total).toFixed(1)}%)`);

  // legislators catalog: confirm it's populated
  console.log("\n=== legislators catalog sanity ===");
  const legSnap = await db.collection("legislators").limit(3).get();
  console.log(`  legislators (sample ${legSnap.size} of catalog):`);
  for (const doc of legSnap.docs) {
    const d = doc.data() as Record<string, unknown>;
    console.log(`    bioguide_id=${doc.id}  name=${d.full_name ?? "?"}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
