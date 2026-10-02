import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** Identity, Teams & Governance (KOBE-12–20). */
export const identity = defineDomain({
  team: ["team_members"],
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
  },
  teamReferencing: {},
});
