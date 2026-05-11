import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
for (const col of ["fec_candidates", "fec_committees"]) {
  const snap = await db.collection(col).count().get();
  console.log(`${col}: ${snap.data().count}`);
}
process.exit(0);
