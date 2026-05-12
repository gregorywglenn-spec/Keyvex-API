/**
 * Tool registry — single source of truth for what tools the server exposes.
 *
 * Adding a new tool is one line here plus one new file in this directory. The
 * server entry point (src/index.ts) iterates this list to register handlers.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as activistStakes from "./activist-stakes.js";
import * as annualFinancialDisclosures from "./annual-financial-disclosures.js";
import * as bills from "./bills.js";
import * as congressionalTrades from "./congressional-trades.js";
import * as enforcementActions from "./enforcement-actions.js";
import * as fecCandidateProfile from "./fec-candidate-profile.js";
import * as federalRegister from "./federal-register.js";
import * as federalContracts from "./federal-contracts.js";
import * as insiderTransactions from "./insider-transactions.js";
import * as institutionalHoldings from "./institutional-holdings.js";
import * as lobbyingFilings from "./lobbying-filings.js";
import * as materialEvents from "./material-events.js";
import * as memberProfile from "./member-profile.js";
import * as nportFilings from "./nport-filings.js";
import * as ofacSdn from "./ofac-sdn.js";
import * as otcMarketWeekly from "./otc-market-weekly.js";
import * as plannedInsiderSales from "./planned-insider-sales.js";
import * as privatePlacements from "./private-placements.js";
import * as proxyFilings from "./proxy-filings.js";
import * as registrationStatements from "./registration-statements.js";
import * as rollCallVotes from "./roll-call-votes.js";
import * as tenderOffers from "./tender-offers.js";
import * as treasuryAuctions from "./treasury-auctions.js";
import * as unifiedSearch from "./unified-search.js";

export interface ToolModule {
  definition: Tool;
  handler: (args: unknown) => Promise<unknown>;
}

export const TOOLS: ToolModule[] = [
  insiderTransactions,
  institutionalHoldings,
  congressionalTrades,
  plannedInsiderSales,
  activistStakes,
  federalContracts,
  memberProfile,
  materialEvents,
  lobbyingFilings,
  annualFinancialDisclosures,
  fecCandidateProfile,
  tenderOffers,
  bills,
  rollCallVotes,
  otcMarketWeekly,
  privatePlacements,
  enforcementActions,
  nportFilings,
  registrationStatements,
  ofacSdn,
  federalRegister,
  proxyFilings,
  treasuryAuctions,
  unifiedSearch,
];

export function findTool(name: string): ToolModule | undefined {
  return TOOLS.find((t) => t.definition.name === name);
}
