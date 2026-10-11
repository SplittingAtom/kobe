/**
 * Tenancy registry (spec D5). Every table in the public schema must appear in exactly one list;
 * the catalog check in CI fails on unclassified tables.
 *
 * Team tables carry `team_id uuid NOT NULL`, a team_id-leading index, ENABLE + FORCE RLS, and a
 * policy on `kobe.team_id`. List a table only once its migration exists; every team table needs a
 * fixture in `testing/probe-fixtures/` (enforced by the type system and the probe suite).
 *
 * Each spec area owns one file in `tenancy/`: add tables to your area's file, not here.
 */
import { agents } from "./tenancy/agents.js";
import { connectors } from "./tenancy/connectors.js";
import { conversations } from "./tenancy/conversations.js";
import { identity } from "./tenancy/identity.js";
import { models } from "./tenancy/models.js";
import { platform } from "./tenancy/platform.js";
import { policy } from "./tenancy/policy.js";
import { sandbox } from "./tenancy/sandbox.js";
import { schedules } from "./tenancy/schedules.js";
import { TEAM_TABLE_PRIVILEGES, type ColumnGrants, type Privilege } from "./tenancy/types.js";
import { workspace } from "./tenancy/workspace.js";

export type { ColumnGrants, Privilege } from "./tenancy/types.js";

/** Every spec area's slice; exported for the registry tests. */
export const TENANCY_DOMAINS = [
  platform,
  identity,
  sandbox,
  conversations,
  policy,
  models,
  agents,
  workspace,
  connectors,
  schedules,
] as const;

type Domain = (typeof TENANCY_DOMAINS)[number];
type TeamOf<D> = D extends { team: readonly (infer T)[] } ? T : never;
type SiteWideOf<D> = D extends { siteWide: readonly (infer T)[] } ? T : never;

export type TeamTable = TeamOf<Domain>;
export type SiteWideTable = SiteWideOf<Domain>;

export const TEAM_TABLES: readonly TeamTable[] = TENANCY_DOMAINS.flatMap<TeamTable>((d) => d.team);

export const SITE_WIDE_TABLES: readonly SiteWideTable[] = TENANCY_DOMAINS.flatMap<SiteWideTable>(
  (d) => d.siteWide,
);

const TEAM_TABLE_SET: ReadonlySet<string> = new Set(TEAM_TABLES);

export function isTeamTable(name: string): name is TeamTable {
  return TEAM_TABLE_SET.has(name);
}

/**
 * App-role privileges on site-wide tables, least privilege. Site-wide tables have no RLS, so
 * every privilege here is reachable from any team context.
 */
export const SITE_WIDE_GRANTS: Readonly<Partial<Record<SiteWideTable, readonly Privilege[]>>> =
  Object.assign({}, ...TENANCY_DOMAINS.map((d) => d.grants)) as Partial<
    Record<SiteWideTable, readonly Privilege[]>
  >;

/**
 * Site-wide tables allowed to carry `team_id` or a foreign key to `teams`, each with a reason.
 * Any other table with either must be a team table (enforced by the catalog check).
 */
export const TEAM_REFERENCING_SITE_WIDE: Readonly<Partial<Record<SiteWideTable, string>>> =
  Object.assign({}, ...TENANCY_DOMAINS.map((d) => d.teamReferencing)) as Partial<
    Record<SiteWideTable, string>
  >;

/** Privileges the migration runner grants the app role on `table` (undefined: none). */
export function appPrivilegesFor(table: string): readonly Privilege[] | undefined {
  if (isTeamTable(table)) return TEAM_TABLE_PRIVILEGES;
  return SITE_WIDE_GRANTS[table as SiteWideTable];
}

/** Column-level privileges on site-wide tables, on top of SITE_WIDE_GRANTS. */
export const SITE_WIDE_COLUMN_GRANTS: Readonly<Partial<Record<SiteWideTable, ColumnGrants>>> =
  Object.assign({}, ...TENANCY_DOMAINS.map((d) => d.columnGrants ?? {})) as Partial<
    Record<SiteWideTable, ColumnGrants>
  >;

/** Column privileges the migration runner grants the app role on `table` (undefined: none). */
export function appColumnPrivilegesFor(table: string): ColumnGrants | undefined {
  if (isTeamTable(table)) return undefined;
  return SITE_WIDE_COLUMN_GRANTS[table as SiteWideTable];
}
