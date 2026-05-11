import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
const snap = await db.collection("annual_financial_disclosures").count().get();
console.log("annual_financial_disclosures count:", snap.data().count);
process.exit(0);
