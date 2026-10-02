import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Policy, Approvals & Egress (KOBE-35–39). */
export const policy = defineDomain({
  // Team and user tool rules (KOBE-35).
  team: ["tool_rules"],
  installWide: ["egress_domains", "install_tool_rules"],
  grants: {
    // The install policy floor (KOBE-35): rules only, no team data, no cascades into teams.
    install_tool_rules: ALL_PRIVILEGES,
  },
  teamReferencing: {},
});
