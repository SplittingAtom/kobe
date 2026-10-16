/**
 * assistant-ui `RemoteThreadListAdapter` over the Thread API (D16, KOBE-34). Trash is the list's
 * "archived" state: archive = move to Trash (`DELETE`, restorable for 30 days), unarchive =
 * restore; delete = "Delete forever" from Trash (KOBE-18, the owner only). A new thread is created
 * untitled: the server titles it after its first answer (CE18, KOBE-219, `thread.updated`), and
 * until then the rail shows the first line of its first message (kept in the session only).
 */
import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ApiError, ApiResult } from "../api/client";
import type { ChatSession } from "./session";
import { forkHint, forkOrigin } from "./fork";
import { activityOfSummary } from "./thread-activity";
import { placementCustom } from "./thread-groups";
import type { ThreadSummary } from "./types";

/** An API failure surfaced through assistant-ui (which expects rejected promises). */
export class ChatApiError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = "ChatApiError";
    this.apiError = apiError;
  }
}

type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;

export function metadataOf(thread: ThreadSummary, provisional?: string): RemoteThreadMetadata {
  return {
    status: thread.deletedAt === null ? "regular" : "archived",
    remoteId: thread.threadId,
    title: thread.title ?? provisional ?? undefined,
    lastMessageAt: new Date(thread.lastActivityAt),
    // The rail's groups read this (CE5): project, Scheduled, Shared with me; and the item's fork
    // provenance (CE16), as the server resolved it for the viewer; the rail's dot (KOBE-301).
    custom: {
      ...placementCustom(thread),
      forkHint: forkHint(forkOrigin(thread)) ?? null,
      activity: activityOfSummary(thread),
    },
  };
}

type GenerateTitle = RemoteThreadListAdapter["generateTitle"];

export interface ThreadListAdapterOptions {
  /** Every failed list or change is reported here (the list shows it as an alert). */
  readonly onError: (error: ApiError) => void;
}

export function createThreadListAdapter(
  session: ChatSession,
  { onError }: ThreadListAdapterOptions,
): RemoteThreadListAdapter {
  const api = session.api;
  const unwrap = async <T>(call: Promise<ApiResult<T>>): Promise<T> => {
    const res = await call;
    if (res.ok) return res.data;
    onError(res.error);
    throw new ChatApiError(res.error);
  };

  const meta = (thread: ThreadSummary) =>
    metadataOf(thread, session.provisionalTitle(thread.threadId));

  return {
    async list(params) {
      const cursor = params?.after;
      if (cursor !== undefined) {
        const page = await unwrap(api.listThreads(cursor));
        return { threads: page.threads.map(meta), nextCursor: page.nextCursor ?? undefined };
      }
      // CE19: the activity list leaves pinned and archived threads out; their own lists (first
      // page, newest first) frame it, so no thread is listed twice when more pages load. The
      // activity list is the member's own: others' shared threads come from their list (CE20).
      const [pinned, page, shared, archived, trash] = await Promise.all([
        unwrap(api.listPinned()),
        unwrap(api.listThreads()),
        unwrap(api.listShared()),
        unwrap(api.listArchived()),
        unwrap(api.listTrash()),
      ]);
      return {
        threads: [
          ...pinned.threads,
          ...page.threads,
          ...shared.threads,
          ...archived.threads,
          ...trash.threads,
        ].map(meta),
        nextCursor: page.nextCursor ?? undefined,
      };
    },

    async rename(remoteId, newTitle) {
      const title = newTitle.trim();
      await unwrap(api.renameThread(remoteId, title === "" ? null : title.slice(0, 200)));
    },

    async archive(remoteId) {
      await unwrap(api.trashThread(remoteId));
    },

    async unarchive(remoteId) {
      await unwrap(api.restoreThread(remoteId));
    },

    async delete(remoteId) {
      await unwrap(api.purgeThread(remoteId));
    },

    async initialize() {
      const test = session.testAgentId;
      const model = session.takeNextModel();
      const agent = session.takeNextAgent();
      const projectId = session.takeNextProject();
      const provisional = session.takeNextTitle();
      const created = await unwrap(
        api.createThread(
          // Untitled on purpose: the server titles it after the first answer (KOBE-219).
          undefined,
          // A pinned agent's model wins (2026-10-04): the draft's choice is not sent.
          agent?.model != null ? null : model,
          test !== undefined
            ? { agentId: test, test: true }
            : agent === null
              ? undefined
              : { agentId: agent.id, test: false },
          projectId,
        ),
      );
      session.setProvisionalTitle(created.threadId, provisional);
      session.seed(created);
      return { remoteId: created.threadId, externalId: undefined };
    },

    generateTitle: (async () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      })) as unknown as GenerateTitle,

    async fetch(threadId) {
      return meta(await unwrap(api.threadSummary(threadId)));
    },
  };
}
