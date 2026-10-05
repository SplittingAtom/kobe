import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Agents, Skills, Gallery & Orbit (KOBE-45–52). */
export const agents = defineDomain({
  team: [
    "team_agents",
    "team_agent_versions",
    "team_skills",
    "team_skill_versions",
    "team_agent_suspensions",
    "team_skill_reviews",
    "team_skill_settings",
    "team_eval_settings",
    "orbit_evals",
  ],
  installWide: [
    "skill_blocklist",
    "install_agents",
    "install_agent_versions",
    "install_skills",
    "install_skill_versions",
    "install_skill_scans",
    "gallery_agent_scores",
  ],
  grants: {
    // Personal and gallery agents (KOBE-45): the server confines personal rows to their owner and
    // gallery writes to install admins. Nothing references them with a cascade.
    install_agents: ALL_PRIVILEGES,
    // Published versions (KOBE-46) are immutable: append and read only (a trigger backs this up).
    install_agent_versions: ["SELECT", "INSERT"],
    // Personal skills (KOBE-78): the server confines rows to their owner. Versions are immutable.
    install_skills: ALL_PRIVILEGES,
    install_skill_versions: ["SELECT", "INSERT"],
    // Scans of personal versions (KOBE-80): written with the version, read at run start.
    install_skill_scans: ["SELECT", "INSERT"],
    // Published gallery scores (KOBE-94): append and read only.
    gallery_agent_scores: ["SELECT", "INSERT"],
    // The blocklist (KOBE-81): the server lets only install admins add or remove rows (no UPDATE).
    skill_blocklist: ["SELECT", "INSERT", "DELETE"],
  },
  teamReferencing: {},
});
