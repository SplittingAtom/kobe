import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Agents, Skills, Gallery & Orbit (KOBE-45–52), shared eval cases (KOBE-276). */
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
    "agent_eval_cases",
    "agent_eval_case_history",
  ],
  siteWide: [
    "skill_blocklist",
    "site_agents",
    "site_agent_versions",
    "personal_skills",
    "personal_skill_versions",
    "personal_skill_scans",
    "gallery_agent_scores",
  ],
  grants: {
    // Personal and gallery agents (KOBE-45): the server confines personal rows to their owner and
    // gallery writes to site admins. Nothing references them with a cascade.
    site_agents: ALL_PRIVILEGES,
    // Published versions (KOBE-46) are immutable: append and read only (a trigger backs this up).
    site_agent_versions: ["SELECT", "INSERT"],
    // Personal skills (KOBE-78): the server confines rows to their owner. Versions are immutable.
    personal_skills: ALL_PRIVILEGES,
    personal_skill_versions: ["SELECT", "INSERT"],
    // Scans of personal versions (KOBE-80): written with the version, read at run start.
    personal_skill_scans: ["SELECT", "INSERT"],
    // Published gallery scores (KOBE-94): append and read only.
    gallery_agent_scores: ["SELECT", "INSERT"],
    // The blocklist (KOBE-81): the server lets only site admins add or remove rows (no UPDATE).
    skill_blocklist: ["SELECT", "INSERT", "DELETE"],
  },
  teamReferencing: {},
});
