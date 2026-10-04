import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Policy, Approvals & Egress (KOBE-35–39). */
export const policy = defineDomain({
  // Team and user tool rules (KOBE-35); team egress enablement (KOBE-38); approvals (KOBE-37).
  team: ["tool_rules", "team_egress", "approvals"],
  installWide: ["egress_domains", "install_tool_rules"],
  grants: {
    // The install policy floor (KOBE-35): rules only, no team data, no cascades into teams.
    install_tool_rules: ALL_PRIVILEGES,
    // The egress ceiling (KOBE-38): domain patterns only, no team data. Deleting a custom domain
    // cascades into every team's `team_egress` row for it: intended (it left the ceiling), audited
    // as `egress.ceiling.removed`, and the only cascade from this table.
    egress_domains: ALL_PRIVILEGES,
  },
  teamReferencing: {},
});
