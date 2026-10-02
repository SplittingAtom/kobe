import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Identity, Teams & Governance (KOBE-12–20). */
export const identity = defineDomain({
  team: ["team_members", "team_invitations"],
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
  },
  teamReferencing: {
    session_active_teams:
      "Which team a sign-in session has active (D9): a pointer to `teams`, no team content; " +
      "membership is re-verified under team RLS on every request.",
  },
});
