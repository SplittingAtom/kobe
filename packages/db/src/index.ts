export * from "./audit/index.js";
export * from "./connectors/index.js";
export * from "./egress/index.js";
export * from "./envelope/index.js";
export * from "./models/index.js";
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
export {
  PORTABLE_BREAK_GLASS_ITEMS_MAX,
  SiteBreakGlassDenied,
  readPortableWithSiteBreakGlass,
  type PortableBreakGlassItem,
  type PortableBreakGlassRead,
  type PortableBreakGlassResult,
  type PortableBreakGlassVersion,
  type SiteBreakGlassAccess,
  type SiteBreakGlassDeniedCode,
  type SiteBreakGlassGrantView,
} from "./break-glass/portable-read.js";
export { BREAK_GLASS_READABLE_TABLES, type BreakGlassReadableTable } from "./break-glass/tables.js";
export {
  LEGAL_HOLD_SQLSTATE,
  isLegalHoldViolation,
  isUnderLegalHold,
  legalHoldsForTeam,
  lockLegalHolds,
  type TeamLegalHolds,
} from "./legal-hold/index.js";
export { BLOB_REF_COLUMNS, type BlobRefColumn } from "./blob-refs.js";
export {
  JOB_SETTING_KEYS,
  STARTUP_SEEDED_ROWS,
  startupSeed,
  type StartupSeed,
} from "./startup-seeds.js";
export {
  PG_DEADLOCK_DETECTED,
  PG_FOREIGN_KEY_VIOLATION,
  PG_LOCK_NOT_AVAILABLE,
  PG_UNIQUE_VIOLATION,
  isForeignKeyViolation,
  isLockConflict,
  isLockTimeout,
  isUniqueViolation,
  pgCodeOf,
  pgErrorOf,
} from "./pg-errors.js";
export { CURSOR_MAX_LENGTH, makeCursorCodec, type CursorCodec } from "./cursor-codec.js";
export {
  APP_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  APP_STATEMENT_TIMEOUT_MS,
  JOB_STATEMENT_TIMEOUT,
  DatabaseConnectionLostError,
  IDLE_IN_TRANSACTION_SQLSTATE,
  IdleInTransactionTimeoutError,
  appSessionHook,
  createDb,
  DEFAULT_POOL_MAX,
  type AppSessionOptions,
  type ConnectionErrorLog,
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
export {
  listTeamChoices,
  readLastTeam,
  rememberLastTeam,
  type TeamChoice,
} from "./team-choices.js";
export * from "./schema/index.js";
export {
  BREAK_GLASS_ACTOR_SETTING,
  BREAK_GLASS_GRANT_SETTING,
  TEAM_ID_SETTING,
} from "./settings.js";
export {
  SITE_WIDE_TABLES,
  TEAM_TABLES,
  isTeamTable,
  type SiteWideTable,
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
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
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
