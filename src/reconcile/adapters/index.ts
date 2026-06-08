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

export const ADAPTERS: Record<string, SourceAdapter> = {
  [congressHouseAdapter.name]: congressHouseAdapter,
  [congressSenateAdapter.name]: congressSenateAdapter,
  [secTenderOffersAdapter.name]: secTenderOffersAdapter,
  [secRegistrationStatementsAdapter.name]: secRegistrationStatementsAdapter,
  [secFormDAdapter.name]: secFormDAdapter,
  // Future: sec-form-144, sec-13dg, … (reuse fetchEdgarFilingsByForm)
};

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
