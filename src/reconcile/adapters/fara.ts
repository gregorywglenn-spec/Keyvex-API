/**
 * Source Adapter: FARA — Foreign Agents Registration Act (efile.fara.gov).
 *
 * GRANULARITY: registrant-level (registration_number), deliberately NOT the
 * per-principal row level, for two reasons:
 *   1. KeyVex's doc id is `fara-{regNumber}-{fpIndex}` where fpIndex is the
 *      POSITION in the API's principal array — positional ids can't be
 *      reproduced from source without assuming the API returns principals in
 *      a stable order (tracked as an id-scheme follow-up in SWEEP-STATUS).
 *   2. Principal-level enumeration needs 558 per-registrant calls against a
 *      genuinely flaky host at 5 req/10 s (~20+ min, frequent retries); the
 *      registrant list is ONE call to the endpoint that reliably works.
 *
 * SNAPSHOT dataset (like OFAC/CSL): the source is "active registrants right
 * now" — missing = active registrant KeyVex lacks. KeyVex KEEPS terminated
 * registrations as history with status:"terminated" (Greg's 2026-06-10
 * call), so this adapter scopes the KeyVex side to status=="active"; an
 * extra here means a registrant left DOJ's list but wasn't flagged yet
 * (next weekly cron flags it).
 *
 * Per-row verify link = the per-registrant ForeignPrincipals API URL (the
 * form of the endpoint that works) — clickable JSON proof.
 */

import type { ReconContext, SourceAdapter, SourceItem } from "../types.js";

const API = "https://efile.fara.gov/api/v1";
const UA = process.env.SEC_USER_AGENT ?? "KeyVexMCP/0.1 contact@keyvex.com";

interface RegistrantRow {
  Registration_Number?: number | string;
  Registration_Date?: string;
  Name?: string;
}

function regUrl(regNumber: string): string {
  return `${API}/ForeignPrincipals/json/Active/${encodeURIComponent(regNumber)}`;
}

export const faraAdapter: SourceAdapter = {
  name: "fara",
  title: "FARA — active registrants (efile.fara.gov, registrant-level)",
  collection: "foreign_agents",
  keyvexIdField: "registration_number",
  typeField: "foreign_principal_country",
  keyvexFilter: { field: "status", op: "==", value: "active" },

  async sourceIds(ctx: ReconContext): Promise<SourceItem[]> {
    // One call, with the same retry posture the scraper uses (the host serves
    // its CMS HTML in place of JSON intermittently).
    let rows: RegistrantRow[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(`${API}/Registrants/json/Active`, {
          headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).trimStart();
        if (text.startsWith("<") || !text) throw new Error("HTML/empty body (routing glitch)");
        const json = JSON.parse(text) as { REGISTRANTS_ACTIVE?: { ROW?: unknown } };
        const raw = json?.REGISTRANTS_ACTIVE?.ROW;
        rows = Array.isArray(raw) ? (raw as RegistrantRow[]) : raw ? [raw as RegistrantRow] : [];
        break;
      } catch (err) {
        if (attempt === 5) {
          ctx.warn(`registrant list unreachable after 5 tries: ${(err as Error).message}`);
          return [];
        }
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      }
    }

    const items: SourceItem[] = [];
    for (const r of rows) {
      const n = r.Registration_Number === undefined || r.Registration_Number === null
        ? ""
        : String(r.Registration_Number).trim();
      if (!n) continue;
      items.push({
        id: n,
        url: regUrl(n),
        label: String(r.Name ?? "").trim(),
        meta: { year: String(r.Registration_Date ?? "").match(/(\d{4})/)?.[1] ?? "" },
      });
    }
    console.error(`[fara] active registrant list: ${items.length} registrants`);
    return items;
  },

  sourceUrl(item: SourceItem): string {
    return item.url;
  },

  urlForId(id: string): string {
    return regUrl(id);
  },
};
