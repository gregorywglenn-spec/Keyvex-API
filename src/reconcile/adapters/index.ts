/**
 * Adapter registry. Add one line per dataset as its adapter lands.
 * The CLI (`scripts/reconcile.ts <name>`) resolves adapters from here.
 */
import type { SourceAdapter } from "../types.js";
import { congressHouseAdapter } from "./congress-house.js";

export const ADAPTERS: Record<string, SourceAdapter> = {
  [congressHouseAdapter.name]: congressHouseAdapter,
  // Future: congress-senate, sec-form4, fec-schedule-a, … (each a 5-field drop-in)
};

export function getAdapter(name: string): SourceAdapter | undefined {
  return ADAPTERS[name];
}
