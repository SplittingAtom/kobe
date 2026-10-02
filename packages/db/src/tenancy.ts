/**
 * Tenancy registry (spec D5). Every table in the public schema must appear in exactly one list;
 * the catalog check in CI fails on unclassified tables.
 *
 * Team tables carry `team_id uuid NOT NULL`, a team_id-leading index, ENABLE + FORCE RLS, and a
 * policy on `kobe.team_id`. List a table here only once its migration exists; every entry needs a
 * fixture in `testing/probe-fixtures.ts` (enforced by the type system and the probe suite).
 */
export const TEAM_TABLES = ["team_members"] as const;

export type TeamTable = (typeof TEAM_TABLES)[number];

/**
 * Install-wide tables (spec §5.4 †): not team-owned, no team RLS. Listed up front from the spec so
 * a later table can't silently skip classification; entries may not exist yet.
 */
export const INSTALL_WIDE_TABLES = [
  // Better Auth (KOBE-12)
  "users",
  "sessions",
  "accounts",
  "verifications",
  "passkeys",
  "two_factors",
  "invitations",
  // Identity and governance
  "teams",
  "install_roles",
  "break_glass_grants",
  "legal_holds",
  "audit_log",
  // Building blocks, connectors, egress
  "skill_blocklist",
  "connectors",
  "connector_grants",
  "egress_domains",
] as const;

export type InstallWideTable = (typeof INSTALL_WIDE_TABLES)[number];

const TEAM_TABLE_SET: ReadonlySet<string> = new Set(TEAM_TABLES);

export function isTeamTable(name: string): name is TeamTable {
  return TEAM_TABLE_SET.has(name);
}
