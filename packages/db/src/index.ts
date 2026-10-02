export {
  createDb,
  type CreateDbOptions,
  type KobeDatabase,
  type KobeDb,
  type KobeTx,
} from "./client.js";
export { DEFAULT_MIGRATIONS_FOLDER, runMigrations, type MigrateOptions } from "./migrate.js";
export { quoteIdent } from "./roles.js";
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
export { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
export {
  searchThreads,
  THREAD_SEARCH_DEFAULT_LIMIT,
  THREAD_SEARCH_MAX_LIMIT,
  THREAD_SEARCH_MAX_PROJECT_IDS,
  THREAD_SEARCH_MAX_QUERY_LENGTH,
  type SearchThreadsInput,
  type SnippetSegment,
  type ThreadSearchHit,
  type ThreadSearchPage,
} from "./thread-search.js";
