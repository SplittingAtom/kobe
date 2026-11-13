/**
 * A valid input for every Team console Kobe MCP tool (KOBE-621, KOBE-650), for tests that only need
 * the route a tool calls (`kobe-mcp/session-contract.test.ts`, `tools/memory-items.test.ts`). Ids
 * are placeholders.
 */
const ID = "00000000-0000-4000-8000-000000000001";
/** Every Workspace memory setting at its default (KOBE-381). */
const MEMORY_ON = {
  memory_enabled: true,
  project_memory_enabled: true,
  memories_enabled: true,
  workspace_memories_enabled: true,
  site_memories_enabled: true,
  learn_enabled: true,
  site_proposals_enabled: true,
  learning_model_alias: null,
};
const AMOUNTS = { monthly_usd: 10, daily_usd: null, monthly_tokens: null, daily_tokens: null };
export const KOBE_TEAM_SAMPLES: Readonly<Record<string, unknown>> = {
  team_members_list: {},
  team_members_set_role: { user_id: ID, from_role: "member", to_role: "contributor" },
  team_members_remove: { user_id: ID, from_role: "member" },
  team_invites_list: {},
  team_invites_create: { email: "a@example.com", role: "member", from_role: null },
  team_invites_revoke: { invitation_id: ID, from_role: "member" },
  team_connectors_list: {},
  team_connectors_set_exposure: { connector_id: ID, from_exposure: "off", to_exposure: "all" },
  team_connectors_disable: { connector_id: ID, from_exposure: "all" },
  team_skills_installs_list: {},
  team_skill_reviews_list: {},
  team_skill_reviews_decide: {
    skill_id: ID,
    version: 1,
    from_status: "pending",
    decision: "approve",
  },
  team_models_list: {},
  team_models_set: {
    alias: "m-1",
    from: { enabled: false, is_default: false, thinking_max: null },
    to: { enabled: true },
  },
  team_budgets_get: {},
  team_budgets_set_team: {
    from: { ...AMOUNTS, monthly_usd: null, user_requests_per_minute: null },
    to: { monthly_usd: 10 },
  },
  team_budgets_set_member: { user_id: ID, from: null, to: AMOUNTS },
  team_memory_get: {},
  team_memory_set: {
    from: MEMORY_ON,
    to: { memory_enabled: false },
  },
  team_memory_items_list: {},
  team_memory_item_get: { id: ID },
  team_egress_list: {},
  team_egress_enable: { domain: "*.example.com", from_enabled: false },
  team_egress_disable: { domain: "example.com", from_enabled: true },
  team_egress_requests_list: {},
  team_egress_requests_decide: { request_id: ID, from_status: "pending", decision: "approve" },
  team_agents_list: {},
  team_agents_suspend: { agent_id: ID, from_suspended: false },
  team_agents_resume: { agent_id: ID, from_suspended: true },
  team_schedules_list: {},
  team_schedules_pause: { schedule_id: ID, from_active: true },
  team_schedules_resume: { schedule_id: ID, from_active: false },
  team_usage_get: {},
  team_audit_list: {},
};
