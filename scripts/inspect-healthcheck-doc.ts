import { getLiveDb } from "../src/firestore.js";

const db = await getLiveDb();
const s = await db.collection("meta").doc("healthCheck").get();
const d = (s.data() ?? {}) as Record<string, unknown>;
const iso = (v: unknown) =>
  v && typeof (v as { toDate?: unknown }).toDate === "function"
    ? (v as { toDate: () => Date }).toDate().toISOString()
    : v ?? null;
console.log(JSON.stringify({
  status: d.status ?? null,
  lastNotifiedStatus: d.lastNotifiedStatus ?? null,
  lastNotifiedAt: iso(d.lastNotifiedAt),
  lastChecked: iso(d.lastChecked),
  lastNotifyError: d.lastNotifyError ?? "(none)",
}, null, 2));
process.exit(0);
