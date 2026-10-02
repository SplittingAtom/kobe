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
  "jwks",
  "invitations",
  // Identity and governance
  "teams",
  "install_roles",
  "install_settings",
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

export type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/** Team tables: full DML for the app role; RLS confines it to the active team. */
const TEAM_TABLE_PRIVILEGES: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/**
 * App-role privileges on install-wide tables, least privilege. Install-wide tables have no RLS, so
 * every privilege here is reachable from any team context. No DELETE on `teams`: foreign-key
 * cascades bypass RLS and would wipe another team's rows. A table missing here gets no grants.
 */
const AUTH_TABLE: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

export const INSTALL_WIDE_GRANTS: Readonly<
  Partial<Record<InstallWideTable, readonly Privilege[]>>
> = {
  teams: ["SELECT", "INSERT", "UPDATE"],
  // Better Auth. Users are deactivated, never deleted (FK cascades would bypass team RLS).
  users: ["SELECT", "INSERT", "UPDATE"],
  sessions: AUTH_TABLE,
  accounts: AUTH_TABLE,
  verifications: AUTH_TABLE,
  passkeys: AUTH_TABLE,
  two_factors: AUTH_TABLE,
  jwks: ["SELECT", "INSERT", "UPDATE"],
  install_roles: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  install_settings: ["SELECT", "INSERT", "UPDATE"],
};

/**
 * Install-wide tables allowed to carry `team_id` or a foreign key to `teams`, each with a reason.
 * Any other table with either must be a team table (enforced by the catalog check).
 */
export const TEAM_REFERENCING_INSTALL_WIDE: Readonly<Partial<Record<InstallWideTable, string>>> =
  {};

/** Privileges the migration runner grants the app role on `table` (undefined: none). */
export function appPrivilegesFor(table: string): readonly Privilege[] | undefined {
  if (isTeamTable(table)) return TEAM_TABLE_PRIVILEGES;
  return INSTALL_WIDE_GRANTS[table as InstallWideTable];
}
