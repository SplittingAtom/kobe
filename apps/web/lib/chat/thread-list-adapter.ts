/**
 * assistant-ui `RemoteThreadListAdapter` over the Thread API (D16, KOBE-34). Trash is the list's
 * "archived" state: archive = move to Trash (`DELETE`, restorable for 30 days), unarchive =
 * restore. There is no hard delete from the UI (the purge is KOBE-18's). Titles are the first line
 * of the first message, set when the thread is created; there is no model-generated title.
 */
import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ApiError, ApiResult } from "../api/client";
import type { ChatSession } from "./session";
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

export function metadataOf(thread: ThreadSummary): RemoteThreadMetadata {
  return {
    status: thread.deletedAt === null ? "regular" : "archived",
    remoteId: thread.threadId,
    title: thread.title ?? undefined,
    lastMessageAt: new Date(thread.lastActivityAt),
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

  return {
    async list(params) {
      const cursor = params?.after;
      if (cursor !== undefined) {
        const page = await unwrap(api.listThreads(cursor));
        return { threads: page.threads.map(metadataOf), nextCursor: page.nextCursor ?? undefined };
      }
      const [page, trash] = await Promise.all([unwrap(api.listThreads()), unwrap(api.listTrash())]);
      return {
        threads: [...page.threads, ...trash.threads].map(metadataOf),
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

    async delete() {
      const error: ApiError = {
        status: 409,
        code: "trash_only",
        message: "Threads go to Trash and are removed for good after 30 days.",
      };
      onError(error);
      throw new ChatApiError(error);
    },

    async initialize() {
      const created = await unwrap(
        api.createThread(session.takeNextTitle(), session.takeNextModel()),
      );
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
      return metadataOf(await unwrap(api.threadSummary(threadId)));
    },
  };
}
