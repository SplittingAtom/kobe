import {
  THREAD_SEARCH_MAX_LIMIT,
  ThreadSearchError,
  searchThreads,
  type KobeTx,
  type ThreadSearchHit as SearchHit,
} from "@kobe/db";
import type { Viewer } from "./repository.js";
import type { ThreadSearchHit } from "./schemas.js";

/**
 * Thread search (`GET /v1/threads?q=`, spec §6.1, D24), backed by `searchThreads` in `@kobe/db`
 * (KOBE-33). Runs in the request's `withTeam` transaction as the session user, over the viewer's
 * own threads and threads shared to their projects (`viewer.projectIds`, empty until KOBE-57),
 * never Trash. The search has its own statement timeout inside a savepoint (`@kobe/db` default,
 * 3 s), so a timeout answers 503 without aborting the request's transaction.
 */

export interface ThreadSearchInput {
  readonly query: string;
  readonly projectId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export type ThreadSearchFailure = "invalid_query" | "invalid_cursor" | "search_timeout";

export type ThreadSearchResult =
  | {
      readonly ok: true;
      readonly body: { threads: ThreadSearchHit[]; next_cursor: string | null };
    }
  | { readonly ok: false; readonly error: ThreadSearchFailure };

const FAILURES: Partial<Record<ThreadSearchError["code"], ThreadSearchFailure>> = {
  invalid_input: "invalid_query",
  invalid_cursor: "invalid_cursor",
  timeout: "search_timeout",
};

export async function searchThreadList(
  tx: KobeTx,
  viewer: Viewer,
  input: ThreadSearchInput,
): Promise<ThreadSearchResult> {
  try {
    const page = await searchThreads(tx, {
      viewerUserId: viewer.userId,
      projectIds: [...viewer.projectIds],
      query: input.query,
      projectId: input.projectId,
      cursor: input.cursor,
      limit: Math.min(input.limit, THREAD_SEARCH_MAX_LIMIT),
    });
    return { ok: true, body: { threads: page.hits.map(toWire), next_cursor: page.nextCursor } };
  } catch (err) {
    // `failed`/`no_team` are server faults: rethrown to the 500 handler (messages carry no SQL).
    const failure = err instanceof ThreadSearchError ? FAILURES[err.code] : undefined;
    if (failure) return { ok: false, error: failure };
    throw err;
  }
}

function toWire(hit: SearchHit): ThreadSearchHit {
  return {
    thread_id: hit.threadId,
    title: hit.title,
    status: hit.status,
    owner_user_id: hit.ownerUserId,
    project_id: hit.projectId,
    agent_id: hit.agentId,
    agent_version: hit.agentVersion,
    shared_to_project: hit.sharedToProject,
    // Search never returns test threads (KOBE-85).
    is_test: false,
    model: hit.modelAlias,
    leaf_entry_id: hit.leafEntryId,
    last_activity_at: hit.lastActivityAt.toISOString(),
    created_at: hit.createdAt.toISOString(),
    // Search never returns Trash.
    deleted_at: null,
    purge_after: null,
    matched_entry_id: hit.matchedEntryId,
    snippet: hit.snippet
      ? hit.snippet.map((s) => ({ text: s.text, highlight: s.highlight }))
      : null,
    score: hit.score,
  };
}
