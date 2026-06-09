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
  // Future: sec-form-144, sec-13dg, lobbying, fec-* …
};

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
