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
import { TEAM_TABLE_PRIVILEGES, type Privilege } from "./tenancy/types.js";
import { workspace } from "./tenancy/workspace.js";

export type { Privilege } from "./tenancy/types.js";

const DOMAINS = [
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

type Domain = (typeof DOMAINS)[number];
type TeamOf<D> = D extends { team: readonly (infer T)[] } ? T : never;
type InstallWideOf<D> = D extends { installWide: readonly (infer T)[] } ? T : never;

export type TeamTable = TeamOf<Domain>;
export type InstallWideTable = InstallWideOf<Domain>;

export const TEAM_TABLES: readonly TeamTable[] = DOMAINS.flatMap<TeamTable>((d) => d.team);

export const INSTALL_WIDE_TABLES: readonly InstallWideTable[] = DOMAINS.flatMap<InstallWideTable>(
  (d) => d.installWide,
);

const TEAM_TABLE_SET: ReadonlySet<string> = new Set(TEAM_TABLES);

export function isTeamTable(name: string): name is TeamTable {
  return TEAM_TABLE_SET.has(name);
}

/**
 * App-role privileges on install-wide tables, least privilege. Install-wide tables have no RLS, so
 * every privilege here is reachable from any team context.
 */
export const INSTALL_WIDE_GRANTS: Readonly<
  Partial<Record<InstallWideTable, readonly Privilege[]>>
> = Object.assign({}, ...DOMAINS.map((d) => d.grants)) as Partial<
  Record<InstallWideTable, readonly Privilege[]>
>;

/**
 * Install-wide tables allowed to carry `team_id` or a foreign key to `teams`, each with a reason.
 * Any other table with either must be a team table (enforced by the catalog check).
 */
export const TEAM_REFERENCING_INSTALL_WIDE: Readonly<Partial<Record<InstallWideTable, string>>> =
  Object.assign({}, ...DOMAINS.map((d) => d.teamReferencing)) as Partial<
    Record<InstallWideTable, string>
  >;

/** Privileges the migration runner grants the app role on `table` (undefined: none). */
export function appPrivilegesFor(table: string): readonly Privilege[] | undefined {
  if (isTeamTable(table)) return TEAM_TABLE_PRIVILEGES;
  return INSTALL_WIDE_GRANTS[table as InstallWideTable];
}
