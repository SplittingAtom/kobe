import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Identity, Teams & Governance (KOBE-12–20). */
export const identity = defineDomain({
  team: [
    "team_members",
    "team_invitations",
    // Retention and deletion (KOBE-18, D18)
    "team_retention",
    "retention_blob_deletions",
  ],
  siteWide: [
    // Better Auth (KOBE-12)
    "users",
    "sessions",
    "accounts",
    "verifications",
    "passkeys",
    "two_factors",
    "jwks",
    "rate_limits",
    "invitations",
    // Identity and governance
    "teams",
    "site_roles",
    "site_settings",
    // Branding files: logo, dark logo, favicon (KOBE-497, theming TH7)
    "site_branding_assets",
    // Active team per session (KOBE-14)
    "session_active_teams",
    // Last active team per user, a new session's default (KOBE-456)
    "user_last_teams",
    "break_glass_grants",
    "break_glass_notifications",
    "legal_holds",
    "audit_log",
    // Single sign-on and SCIM (KOBE-625, spec sso-oidc-scim §4–§10)
    "sso_providers",
    "sso_identities",
    // Admin-expected links (KOBE-630, §6)
    "sso_link_expectations",
    "sso_access_mappings",
    "session_sso_contexts",
    "scim_tokens",
    "scim_groups",
    "scim_group_members",
  ],
  grants: {
    // No DELETE on `teams`: foreign-key cascades bypass RLS and would wipe another team's rows.
    teams: ["SELECT", "INSERT", "UPDATE"],
    // Better Auth. Users are deactivated, never deleted (FK cascades would bypass team RLS).
    users: ["SELECT", "INSERT", "UPDATE"],
    sessions: ALL_PRIVILEGES,
    accounts: ALL_PRIVILEGES,
    verifications: ALL_PRIVILEGES,
    passkeys: ALL_PRIVILEGES,
    two_factors: ALL_PRIVILEGES,
    // Signing keys are only ever inserted (no rotation configured).
    jwks: ["SELECT", "INSERT"],
    rate_limits: ALL_PRIVILEGES,
    site_roles: ALL_PRIVILEGES,
    // DELETE: a branding reset removes its keys so the defaults apply again (TH12, KOBE-499); the
    // app role could already set any key, so removing one grants nothing new.
    site_settings: ALL_PRIVILEGES,
    // One row per kind, replaced on upload and deleted on removal or reset (TH12).
    site_branding_assets: ALL_PRIVILEGES,
    // A pointer only; rows also go away with their session (cascade from `sessions`).
    session_active_teams: ALL_PRIVILEGES,
    // A pointer only, replaced on every team switch; rows go away with their user.
    user_last_teams: ALL_PRIVILEGES,
    // Kept as the record of who invited whom: revoked or accepted, never deleted (KOBE-13).
    invitations: ["SELECT", "INSERT", "UPDATE"],
    // Append-only (KOBE-15): never DELETE or TRUNCATE; triggers refuse them for the owner too. The
    // only UPDATE is the erasure of ip and user_agent (column grants below, KOBE-17).
    audit_log: ["SELECT", "INSERT"],
    // The record behind break-glass audit events (KOBE-16): requested, decided, revoked, expired;
    // never deleted. Transitions are checked by the break_glass_grants_guard trigger.
    break_glass_grants: ["SELECT", "INSERT", "UPDATE"],
    // Outbox (KOBE-16): queued in the grant's transaction, marked sent/failed by delivery.
    break_glass_notifications: ["SELECT", "INSERT", "UPDATE"],
    // The record behind legal-hold audit events (KOBE-17): requested, decided, released; never
    // deleted. Transitions and the two-person rule are checked by the legal_holds_guard trigger.
    legal_holds: ["SELECT", "INSERT", "UPDATE"],
    // Single sign-on (KOBE-625). Deleting a provider is refused by foreign keys while an identity
    // is linked or an SSO session is live; unlinking deletes the identity row.
    sso_providers: ALL_PRIVILEGES,
    sso_identities: ALL_PRIVILEGES,
    // Single use: deleted when it links, replaced by a new one, or withdrawn (KOBE-630).
    sso_link_expectations: ALL_PRIVILEGES,
    sso_access_mappings: ALL_PRIVILEGES,
    // A pointer only, like session_active_teams; rows also go away with their session.
    session_sso_contexts: ALL_PRIVILEGES,
    // Hash only; revoked, never deleted (UPDATE only on the columns below; the scim_tokens_guard
    // trigger makes revocation final). Rows go with their provider (cascade).
    scim_tokens: ["SELECT", "INSERT"],
    scim_groups: ALL_PRIVILEGES,
    scim_group_members: ALL_PRIVILEGES,
  },
  columnGrants: {
    // Erasure of the client IP and user agent after the retention period (KOBE-17). The
    // audit_log_erase_pii trigger allows only setting all three to NULL, on rows past the period
    // and not under legal hold; the hash chain covers a commitment, not the values.
    audit_log: { UPDATE: ["ip", "user_agent", "pii_salt"] },
    // Use and revocation of a SCIM token (KOBE-625): the hash and provider never change.
    scim_tokens: { UPDATE: ["last_used_at", "revoked_at"] },
  },
  teamReferencing: {
    user_last_teams:
      "The team a user last made active (KOBE-456): a pointer to `teams`, no team content; " +
      "a new session uses it only while the user is still a member (checked under team RLS).",
    session_active_teams:
      "Which team a sign-in session has active (D9): a pointer to `teams`, no team content; " +
      "membership is re-verified under team RLS on every request.",
    audit_log:
      "Site-wide record (D6) whose events may belong to a team: team admins read their team's " +
      "events through listTeamAuditEvents(), which always filters on team_id. No FK to `teams`. " +
      "Only metadata is stored (AUDIT_EVENTS allowlist), never team content.",
    break_glass_grants:
      "Spec §5.4 marks it site-wide (†, D10): a site admin's request for read access to one " +
      "team must exist before any team context and be visible to every site admin who may " +
      "approve it. It holds the team id, an optional subject user and thread id, and the " +
      "requester's reason, never team content. Team content is read only through " +
      "readWithBreakGlass(), which verifies an active grant before setting kobe.team_id.",
    legal_holds:
      "Spec §5.4 marks it site-wide (†, D18): a site admin's hold on one team (or one user " +
      "in it) must exist before any team context and be visible to every site admin who may " +
      "approve or release it. It holds the team id, an optional user id and the requester's " +
      "reason, never team content.",
    sso_access_mappings:
      "Site configuration naming teams, no team content (KOBE-625, spec sso-oidc-scim §7): an " +
      "IdP claim value grants a team role. Edited only with site.users.manage; applied to " +
      "team_members inside withTeam() for each team.",
  },
});
