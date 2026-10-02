/** Why a search failed. Messages never include SQL, parameters or row data. */
export type ThreadSearchErrorCode =
  "invalid_input" | "invalid_cursor" | "no_team" | "timeout" | "failed";

export class ThreadSearchError extends Error {
  override readonly name = "ThreadSearchError";

  constructor(
    readonly code: ThreadSearchErrorCode,
    message: string,
    /** Postgres SQLSTATE when the database rejected the query. */
    readonly sqlState?: string,
  ) {
    super(`searchThreads: ${message}`);
  }
}
