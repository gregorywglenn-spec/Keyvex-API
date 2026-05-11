import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
const snap = await db
  .collection("fec_committees")
  .orderBy("scraped_at", "desc")
  .limit(5)
  .get();
console.log(`Latest 5 by scraped_at:`);
for (const doc of snap.docs) {
  const d = doc.data();
  console.log(
    `  ${doc.id} | ${d["scraped_at"]} | cycles=${JSON.stringify(d["cycles"])} | name=${d["name"]}`,
  );
}
const oldest = await db
  .collection("fec_committees")
  .orderBy("scraped_at", "asc")
  .limit(5)
  .get();
console.log(`\nOldest 5 by scraped_at:`);
for (const doc of oldest.docs) {
  const d = doc.data();
  console.log(
    `  ${doc.id} | ${d["scraped_at"]} | cycles=${JSON.stringify(d["cycles"])} | name=${d["name"]}`,
  );
}
process.exit(0);
