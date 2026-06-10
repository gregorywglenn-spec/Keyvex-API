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
import { legislatorsAdapter } from "./legislators.js";
import { rollCallVotesAdapter } from "./roll-call-votes.js";
import { form278Adapter } from "./form278.js";
import { cftcCotAdapter } from "./cftc-cot.js";
import { treasuryAuctionsAdapter } from "./treasury-auctions.js";
import { faraAdapter } from "./fara.js";
import { govinfoRecentAdapter } from "./govinfo-recent.js";
import { productRecallsAdapter } from "./product-recalls.js";
import { enforcementRecentAdapter } from "./enforcement-recent.js";
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
const sec144RecentAdapter = makeEdgarRecentWindowAdapter({
  name: "sec-144-recent",
  title: "SEC Form 144 — recent-window completeness (last 30d, planned_insider_sales)",
  collection: "planned_insider_sales",
  keyvexIdField: "accession_number", // doc id is composite; match on bare accession
  forms: ["144", "144/A"],
  days: 30,
});
const secForm3RecentAdapter = makeEdgarRecentWindowAdapter({
  name: "sec-form3-recent",
  title: "SEC Form 3 — recent-window completeness (last 30d, initial_ownership_baselines)",
  collection: "initial_ownership_baselines",
  keyvexIdField: "accession_number",
  forms: ["3", "3/A"],
  days: 30,
});
const sec13dgRecentAdapter = makeEdgarRecentWindowAdapter({
  name: "sec-13dg-recent",
  title: "SEC 13D/13G — recent-window completeness (last 30d, activist_ownership)",
  collection: "activist_ownership",
  keyvexIdField: "accession_number",
  // EDGAR's daily index uses a MIX of "SCHEDULE 13D/G" and legacy "SC 13D"
  // strings for these forms (verified 2026-06-10), so cover both styles.
  forms: [
    "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A",
    "SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A",
  ],
  days: 30,
});
const secProxyRecentAdapter = makeEdgarRecentWindowAdapter({
  name: "sec-proxy-recent",
  title: "SEC DEF 14A — recent-window completeness (last 30d, proxy_filings)",
  collection: "proxy_filings",
  keyvexIdField: "accession_number",
  forms: ["DEF 14A", "DEFA14A", "DEFM14A", "DEFR14A"],
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
  [legislatorsAdapter.name]: legislatorsAdapter,
  [rollCallVotesAdapter.name]: rollCallVotesAdapter,
  [form278Adapter.name]: form278Adapter,
  [cftcCotAdapter.name]: cftcCotAdapter,
  [treasuryAuctionsAdapter.name]: treasuryAuctionsAdapter,
  [faraAdapter.name]: faraAdapter,
  [govinfoRecentAdapter.name]: govinfoRecentAdapter,
  [productRecallsAdapter.name]: productRecallsAdapter,
  [enforcementRecentAdapter.name]: enforcementRecentAdapter,
  [sec8kRecentAdapter.name]: sec8kRecentAdapter,
  [sec144RecentAdapter.name]: sec144RecentAdapter,
  [secForm3RecentAdapter.name]: secForm3RecentAdapter,
  [sec13dgRecentAdapter.name]: sec13dgRecentAdapter,
  [secProxyRecentAdapter.name]: secProxyRecentAdapter,
  // Future: lobbying …
};

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
