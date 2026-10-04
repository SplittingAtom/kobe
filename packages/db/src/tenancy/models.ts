import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Models & Budgets (KOBE-40–44). */
export const models = defineDomain({
  // Team model enablement and each member's gateway virtual key (KOBE-40).
  // The model usage ledger (KOBE-43), written by the model-gateway shim.
  team: ["team_models", "model_gateway_keys", "run_usage", "team_budgets", "model_spend_daily"],
  installWide: [
    "model_providers",
    "model_catalog",
    "model_gateway_state",
    "install_model_limits",
    "install_model_spend_daily",
    "budget_alerts",
    "budget_alert_emails",
  ],
  grants: {
    // Providers and their sealed keys (KOBE-40): no team data; catalog entries RESTRICT deletes.
    model_providers: ALL_PRIVILEGES,
    // The model catalog (KOBE-40): deleting an alias cascades into every team's `team_models` row
    // for it: intended (it left the catalog), audited as `models.catalog.changed`, and the only
    // cascade from this table.
    model_catalog: ALL_PRIVILEGES,
    // Gateway sync progress (one row, seeded by the migration): read and advanced, never added.
    model_gateway_state: ["SELECT", "UPDATE"],
    // KOBE-42: the install budget and default rate (one row, seeded): read and changed, never added.
    install_model_limits: ["SELECT", "UPDATE"],
    // Spend of all teams per day, kept by the run_usage trigger (invoker's rights: the repo has
    // no SECURITY DEFINER functions, catalog.db.test.ts): no team ids, never deleted.
    install_model_spend_daily: ["SELECT", "INSERT", "UPDATE"],
    // Budget thresholds crossed (once per period) and their email outbox: never deleted.
    budget_alerts: ["SELECT", "INSERT"],
    budget_alert_emails: ["SELECT", "INSERT", "UPDATE"],
  },
  teamReferencing: {
    budget_alerts:
      "A budget threshold crossed (KOBE-42, D30) must be recorded once for the install budget " +
      "(no team) as well as for a team or one member, and be read by the server's budget " +
      "monitor and outbox across teams. It holds the team and user ids, the scope, the period " +
      "and two amounts, never team content; team views filter on team_id. No FK to `teams`.",
  },
});
