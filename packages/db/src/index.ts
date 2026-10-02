export * from "./audit/index.js";
export {
  BREAK_GLASS_ENTRIES_MAX,
  BREAK_GLASS_THREADS_MAX,
  BreakGlassDenied,
  readWithBreakGlass,
  type BreakGlassAccess,
  type BreakGlassDeniedCode,
  type BreakGlassEntry,
  type BreakGlassGrantView,
  type BreakGlassRead,
  type BreakGlassReadResult,
  type BreakGlassScope,
  type BreakGlassThread,
  type BreakGlassThreadCursor,
} from "./break-glass/read.js";
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
export {
  searchThreads,
  ThreadSearchError,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_DEFAULT_TIMEOUT_MS,
  THREAD_SEARCH_MAX_LIMIT,
  THREAD_SEARCH_MAX_PROJECT_IDS,
  THREAD_SEARCH_MAX_QUERY_LENGTH,
  type SearchThreadsInput,
  type SnippetSegment,
  type ThreadSearchErrorCode,
  type ThreadSearchHit,
  type ThreadSearchPage,
} from "./thread-search.js";
