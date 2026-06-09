/**
 * Adapter registry. Add one line per dataset as its adapter lands.
 * The CLI (`scripts/reconcile.ts <name>`) resolves adapters from here.
 */
import type { SourceAdapter } from "../types.js";
import { congressHouseAdapter } from "./congress-house.js";
import { congressSenateAdapter } from "./congress-senate.js";
import { secTenderOffersAdapter } from "./sec-tender-offers.js";
import { secRegistrationStatementsAdapter } from "./sec-registration-statements.js";
import { secFormDAdapter } from "./sec-form-d.js";
import { federalRegisterAdapter } from "./federal-register.js";
import { secNportAdapter } from "./sec-nport.js";
import { ofacSdnAdapter } from "./ofac-sdn.js";
import { oigExclusionsAdapter } from "./oig-exclusions.js";
import { cslAdapter } from "./csl.js";
import { congressBillsAdapter } from "./congress-bills.js";
import { fecCandidatesAdapter } from "./fec-candidates.js";
import { fecCommitteesAdapter } from "./fec-committees.js";
import { makeEdgarRecentWindowAdapter } from "./edgar-recent-window.js";

// Recent-window completeness checks for accumulating SEC-form feeds (does the
// cron leak in its recent window? — the N-PORT/Form D failure mode).
const sec8kRecentAdapter = makeEdgarRecentWindowAdapter({
  name: "sec-8k-recent",
  title: "SEC Form 8-K — recent-window completeness (last 30d, material_events)",
  collection: "material_events",
  keyvexIdField: "id",
  forms: ["8-K", "8-K/A"],
  days: 30,
});

export const ADAPTERS: Record<string, SourceAdapter> = {
  [congressHouseAdapter.name]: congressHouseAdapter,
  [congressSenateAdapter.name]: congressSenateAdapter,
  [secTenderOffersAdapter.name]: secTenderOffersAdapter,
  [secRegistrationStatementsAdapter.name]: secRegistrationStatementsAdapter,
  [secFormDAdapter.name]: secFormDAdapter,
  [federalRegisterAdapter.name]: federalRegisterAdapter,
  [secNportAdapter.name]: secNportAdapter,
  [ofacSdnAdapter.name]: ofacSdnAdapter,
  [oigExclusionsAdapter.name]: oigExclusionsAdapter,
  [cslAdapter.name]: cslAdapter,
  [congressBillsAdapter.name]: congressBillsAdapter,
  [fecCandidatesAdapter.name]: fecCandidatesAdapter,
  [fecCommitteesAdapter.name]: fecCommitteesAdapter,
  [sec8kRecentAdapter.name]: sec8kRecentAdapter,
  // Future: sec-form-144, sec-13dg, lobbying …
};

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
