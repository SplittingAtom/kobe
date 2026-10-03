import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Agents, Skills, Gallery & Orbit (KOBE-45–52). */
export const agents = defineDomain({
  team: ["team_agents", "team_agent_versions"],
  installWide: ["skill_blocklist", "install_agents", "install_agent_versions"],
  grants: {
    // Personal and gallery agents (KOBE-45): the server confines personal rows to their owner and
    // gallery writes to install admins. Nothing references them with a cascade.
    install_agents: ALL_PRIVILEGES,
    // Published versions (KOBE-46) are immutable: append and read only (a trigger backs this up).
    install_agent_versions: ["SELECT", "INSERT"],
  },
  teamReferencing: {},
});
