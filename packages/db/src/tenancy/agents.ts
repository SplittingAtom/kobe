import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Agents, Skills, Gallery & Orbit (KOBE-45–52). */
export const agents = defineDomain({
  team: ["team_agents"],
  installWide: ["skill_blocklist", "install_agents"],
  grants: {
    // Personal and gallery agents (KOBE-45): the server confines personal rows to their owner and
    // gallery writes to install admins. Nothing references them with a cascade.
    install_agents: ALL_PRIVILEGES,
  },
  teamReferencing: {},
});
