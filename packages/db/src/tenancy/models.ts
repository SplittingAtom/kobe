import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Models & Budgets (KOBE-40–44). */
export const models = defineDomain({
  // Team model enablement and each member's gateway virtual key (KOBE-40).
  // The model usage ledger (KOBE-43), written by the model-gateway shim.
  team: ["team_models", "model_gateway_keys", "run_usage"],
  installWide: ["model_providers", "model_catalog", "model_gateway_state"],
  grants: {
    // Providers and their sealed keys (KOBE-40): no team data; catalog entries RESTRICT deletes.
    model_providers: ALL_PRIVILEGES,
    // The model catalog (KOBE-40): deleting an alias cascades into every team's `team_models` row
    // for it: intended (it left the catalog), audited as `models.catalog.changed`, and the only
    // cascade from this table.
    model_catalog: ALL_PRIVILEGES,
    // Gateway sync progress (one row, seeded by the migration): read and advanced, never added.
    model_gateway_state: ["SELECT", "UPDATE"],
  },
  teamReferencing: {},
});
