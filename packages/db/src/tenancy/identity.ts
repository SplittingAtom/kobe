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
  installWide: [
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
    "install_roles",
    "install_settings",
    // Active team per session (KOBE-14)
    "session_active_teams",
    "break_glass_grants",
    "break_glass_notifications",
    "legal_holds",
    "audit_log",
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
    install_roles: ALL_PRIVILEGES,
    install_settings: ["SELECT", "INSERT", "UPDATE"],
    // A pointer only; rows also go away with their session (cascade from `sessions`).
    session_active_teams: ALL_PRIVILEGES,
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
  },
  columnGrants: {
    // Erasure of the client IP and user agent after the retention period (KOBE-17). The
    // audit_log_erase_pii trigger allows only setting all three to NULL, on rows past the period
    // and not under legal hold; the hash chain covers a commitment, not the values.
    audit_log: { UPDATE: ["ip", "user_agent", "pii_salt"] },
  },
  teamReferencing: {
    session_active_teams:
      "Which team a sign-in session has active (D9): a pointer to `teams`, no team content; " +
      "membership is re-verified under team RLS on every request.",
    audit_log:
      "Install-wide record (D6) whose events may belong to a team: team admins read their team's " +
      "events through listTeamAuditEvents(), which always filters on team_id. No FK to `teams`. " +
      "Only metadata is stored (AUDIT_EVENTS allowlist), never team content.",
    break_glass_grants:
      "Spec §5.4 marks it install-wide (†, D10): an install admin's request for read access to one " +
      "team must exist before any team context and be visible to every install admin who may " +
      "approve it. It holds the team id, an optional subject user and thread id, and the " +
      "requester's reason, never team content. Team content is read only through " +
      "readWithBreakGlass(), which verifies an active grant before setting kobe.team_id.",
    legal_holds:
      "Spec §5.4 marks it install-wide (†, D18): an install admin's hold on one team (or one user " +
      "in it) must exist before any team context and be visible to every install admin who may " +
      "approve or release it. It holds the team id, an optional user id and the requester's " +
      "reason, never team content.",
  },
});
