import type { KobeTx } from "@kobe/db";
import type { Viewer } from "./repository.js";

/**
 * Seam for thread search (`GET /v1/threads?q=`, spec §6.1, D24). KOBE-33 owns search and ships
 * `searchThreads(tx, input)` in `@kobe/db`; wiring it here is the only change the route needs:
 *
 *   const page = await searchThreads(tx, {
 *     viewerUserId: viewer.userId, projectIds: [...viewer.projectIds], query: input.query,
 *     projectId: input.projectId, cursor: input.cursor,
 *     limit: Math.min(input.limit, THREAD_SEARCH_MAX_LIMIT),
 *   });
 *
 * mapping each hit to the thread summary plus `matched_entry_id` and `snippet`, and a rejected
 * cursor to `invalid_cursor`. Set `SET LOCAL statement_timeout` for the search transaction. Until
 * then the route answers 501 `search_unavailable`, and the list without `q` is unaffected.
 */

export interface ThreadSearchInput {
  readonly query: string;
  readonly projectId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export type ThreadSearchResult =
  | { readonly ok: true; readonly body: { threads: unknown[]; next_cursor: string | null } }
  | { readonly ok: false; readonly error: "search_unavailable" | "invalid_cursor" };

export async function searchThreadList(
  _tx: KobeTx,
  _viewer: Viewer,
  _input: ThreadSearchInput,
): Promise<ThreadSearchResult> {
  return { ok: false, error: "search_unavailable" };
}
