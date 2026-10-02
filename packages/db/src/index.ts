export * from "./audit/index.js";
export { BLOB_REF_COLUMNS, type BlobRefColumn } from "./blob-refs.js";
export {
  createDb,
  type CreateDbOptions,
  type KobeDatabase,
  type KobeDb,
  type KobeTx,
} from "./client.js";
export {
  TEAM_ROLES,
  getMembership,
  listMemberships,
  type TeamMembership,
  type TeamRole,
} from "./memberships.js";
export {
  DEFAULT_MIGRATIONS_FOLDER,
  MIGRATION_LOCK_KEY,
  runMigrations,
  type MigrateOptions,
} from "./migrate.js";
export { quoteIdent } from "./roles.js";
export { listTeamInvitationsFor, type PendingTeamInvitation } from "./team-invitations.js";
export { scanTeams, type ScannedTeam } from "./team-scan.js";
export * from "./schema/index.js";
export { TEAM_ID_SETTING } from "./settings.js";
export {
  INSTALL_WIDE_TABLES,
  TEAM_TABLES,
  isTeamTable,
  type InstallWideTable,
  type TeamTable,
} from "./tenancy.js";
export { withTeam } from "./with-team.js";
export { waitForMigrations, type WaitOptions } from "./wait.js";
// Query helpers re-exported so dependents share this package's drizzle-orm instance (one copy, one type identity).
export {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
