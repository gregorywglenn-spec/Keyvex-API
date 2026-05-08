/**
 * Tool registry — single source of truth for what tools the server exposes.
 *
 * Adding a new tool is one line here plus one new file in this directory. The
 * server entry point (src/index.ts) iterates this list to register handlers.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as activistStakes from "./activist-stakes.js";
import * as annualFinancialDisclosures from "./annual-financial-disclosures.js";
import * as congressionalTrades from "./congressional-trades.js";
import * as federalContracts from "./federal-contracts.js";
import * as insiderTransactions from "./insider-transactions.js";
import * as institutionalHoldings from "./institutional-holdings.js";
import * as lobbyingFilings from "./lobbying-filings.js";
import * as materialEvents from "./material-events.js";
import * as memberProfile from "./member-profile.js";
import * as plannedInsiderSales from "./planned-insider-sales.js";

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
];

export function findTool(name: string): ToolModule | undefined {
  return TOOLS.find((t) => t.definition.name === name);
}
