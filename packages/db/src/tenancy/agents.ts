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
    // The Site Skills Catalog in teams (KOBE-311).
    "team_skill_installs",
    "team_skill_optouts",
    "team_skill_blocks",
    "member_skill_enablements",
    // Workbench drafts (KOBE-320).
    "skill_drafts",
    "skill_draft_files",
    "skill_draft_history",
    "skill_draft_file_history",
    // Skill eval runs and their executions (KOBE-325).
    "skill_eval_runs",
    "skill_eval_results",
    // Builders' Promote to Site requests (KOBE-333).
    "skill_promotion_requests",
    // Members' Request for team of a catalog skill (KOBE-338).
    "team_skill_requests",
  ],
  siteWide: [
    "skill_blocklist",
    "site_agents",
    "site_agent_versions",
    "personal_skills",
    "personal_skill_versions",
    "personal_skill_scans",
    "gallery_agent_scores",
    "skill_hash_checks",
    // The Site Skills Registry and Catalog (KOBE-311).
    "registry_skills",
    "registry_maintainers",
    "registry_versions",
    "registry_review_events",
    "registry_tags",
    "registry_skill_tags",
    "site_grants",
    "site_skill_settings",
    // Rescans on a scanner rule-set change (KOBE-313).
    "skill_rescan_runs",
    // Default sync jobs (KOBE-314).
    "skill_default_syncs",
    // Catalog usage aggregates per closed window (KOBE-339).
    "skill_usage_snapshots",
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
    // Rescans on a rule-set change (KOBE-313) update them in place.
    personal_skill_scans: ["SELECT", "INSERT", "UPDATE"],
    // Published gallery scores (KOBE-94): append and read only.
    gallery_agent_scores: ["SELECT", "INSERT"],
    // The blocklist (KOBE-81): the server lets only site admins add or remove rows (no UPDATE).
    skill_blocklist: ["SELECT", "INSERT", "DELETE"],
    // What each stored skill hash is under the package contract (KOBE-310): written once, never
    // changed (the recompute is idempotent: ON CONFLICT DO NOTHING).
    skill_hash_checks: ["SELECT", "INSERT"],
    // The Registry (KOBE-311): catalog skills and versions change state but are never deleted
    // (archived, retired); review events are append-only; tags retire rather than go away.
    registry_skills: ["SELECT", "INSERT", "UPDATE"],
    registry_maintainers: ["SELECT", "INSERT", "DELETE"],
    registry_versions: ["SELECT", "INSERT", "UPDATE"],
    registry_review_events: ["SELECT", "INSERT"],
    registry_tags: ["SELECT", "INSERT", "UPDATE"],
    registry_skill_tags: ["SELECT", "INSERT", "DELETE"],
    // Skill reviewer grants (SK22): given and taken by the Owner or a Site admin.
    site_grants: ["SELECT", "INSERT", "DELETE"],
    // One seeded row: read and changed, never added or removed.
    site_skill_settings: ["SELECT", "UPDATE"],
    // One row per rule set, updated as the rescan runs; kept as the record.
    skill_rescan_runs: ["SELECT", "INSERT", "UPDATE"],
    // One row per Default sync job, updated as it runs; kept as the record.
    skill_default_syncs: ["SELECT", "INSERT", "UPDATE"],
    // One row per closed usage window, written once; the job purges windows older than two.
    skill_usage_snapshots: ["SELECT", "INSERT", "DELETE"],
  },
  teamReferencing: {
    site_skill_settings:
      "registry_team_id names the existing team that runs site-side reviews and evals (SK21); ON DELETE SET NULL leaves the Registry not ready",
  },
});
