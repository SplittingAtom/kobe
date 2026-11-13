/**
 * A valid input for every Site console Kobe MCP tool (KOBE-622), for tests that only need the
 * route a tool calls (`kobe-mcp/session-contract.test.ts`). Ids are placeholders.
 */
const ID = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);

export const KOBE_SITE_SAMPLES: Readonly<Record<string, unknown>> = {
  site_users_list: {},
  site_memory_items_list: {},
  site_memory_item_get: { id: ID },
  site_users_deactivate: { user_id: ID, from_state: "active" },
  site_users_reactivate: { user_id: ID, from_state: "deactivated" },
  site_teams_list: {},
  site_teams_create: { slug: "research", name: "Research", admin_user_id: ID },
  site_team_members_list: { team_id: ID },
  site_team_members_add: { team_id: ID, user_ids: [ID], role: "member" },
  site_team_members_set_role: {
    team_id: ID,
    user_id: ID,
    from_role: "member",
    to_role: "contributor",
  },
  site_team_members_remove: { team_id: ID, user_id: ID, from_role: "member" },
  site_invites_list: {},
  site_invites_create: { email: "ana@example.com" },
  site_invites_revoke: { invitation_id: ID, email: "ana@example.com" },
  site_models_list: {},
  site_models_catalog_update: {
    alias: "fast",
    change: { from: { label: null }, to: { label: "Fast" } },
  },
  site_connectors_list: {},
  site_connectors_set_status: {
    connector_id: ID,
    from_status: "active",
    to_status: "disabled",
  },
  site_egress_ceiling_list: {},
  site_egress_ceiling_add: { domain: "example.com" },
  site_egress_ceiling_set: { domain: "example.com", from_in_ceiling: true, to_in_ceiling: false },
  site_egress_requests_list: {},
  site_egress_requests_decide: {
    team_id: ID,
    request_id: ID,
    from_status: "pending",
    decision: "deny",
  },
  site_skill_reviews_list: {},
  site_skill_reviews_claim: { version_id: ID, from_state: "submitted" },
  site_skill_reviews_comment: { version_id: ID, note: "Looks good." },
  site_skill_reviews_decide: { version_id: ID, from_state: "submitted", action: "reject" },
  site_skill_reviews_reject_and_block: {
    version_id: ID,
    from_state: "submitted",
    note: "Exfiltrates data.",
  },
  site_skill_blocklist_list: {},
  site_skill_blocklist_add: { content_hash: HASH, reason: "malware" },
  site_skill_blocklist_remove: { content_hash: HASH },
  site_grants_list: {},
  site_grants_give: { user_id: ID, grant: "skill_reviewer" },
  site_grants_take: { user_id: ID, grant: "skill_reviewer" },
  site_branding_get: {},
  site_branding_set: { change: { from: { show_name: true }, to: { show_name: false } } },
  site_budget_get: {},
  site_budget_set: { change: { from: { daily_usd: null }, to: { daily_usd: 10 } } },
  site_usage_read: {},
  site_audit_list: {},
};
