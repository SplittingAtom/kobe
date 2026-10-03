export type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/** Team tables: full DML for the app role; RLS confines it to the active team. */
export const TEAM_TABLE_PRIVILEGES: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/** Full DML on an install-wide table (only for tables with no team data behind a cascade). */
export const ALL_PRIVILEGES: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/**
 * One domain's slice of the tenancy registry. Each spec area owns one file in this directory so
 * parallel tickets add tables without touching each other's lists; `../tenancy.ts` combines them.
 */
export interface TenancyDomain<Team extends string, InstallWide extends string> {
  /** Team tables (`team_id uuid NOT NULL`, ENABLE + FORCE RLS, team policy). */
  readonly team: readonly Team[];
  /** Install-wide tables (spec §5.4 †): not team-owned, no team RLS. */
  readonly installWide: readonly InstallWide[];
  /** App-role privileges on install-wide tables, least privilege. A table missing here gets none. */
  readonly grants: Readonly<Partial<Record<InstallWide, readonly Privilege[]>>>;
  /** Install-wide tables allowed to carry `team_id` or a foreign key to `teams`, with a reason. */
  readonly teamReferencing: Readonly<Partial<Record<InstallWide, string>>>;
  /**
   * Column-level privileges on install-wide tables, on top of `grants` (e.g. the audit log's
   * erasable columns, KOBE-17). Keep these rare and give the reason next to them.
   */
  readonly columnGrants?: Readonly<Partial<Record<InstallWide, ColumnGrants>>>;
}

/** Privilege → the columns it is granted on. */
export type ColumnGrants = Readonly<Partial<Record<"UPDATE", readonly string[]>>>;

/** Identity helper that keeps each domain's table names as literal types. */
export function defineDomain<const Team extends string, const InstallWide extends string>(
  domain: TenancyDomain<Team, InstallWide>,
): TenancyDomain<Team, InstallWide> {
  return domain;
}
