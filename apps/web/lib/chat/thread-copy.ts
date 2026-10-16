/**
 * Copy as Markdown (KOBE-292) reads the thread itself, every page of it, so the copy is the whole
 * branch on screen even where the open view stopped at its page cap. An offloaded entry's body is
 * not in the entry list: the output route serves it when it is a tool output (left out, like every
 * tool output); no route serves an offloaded message body, so that part becomes a placeholder.
 */
import type { ApiResult } from "../api/client";
import type { ChatApi } from "./api";
import { offloadedOnBranch, threadMarkdown, type CopiedThread } from "./thread-menu";
import { projectThread } from "./tree";
import type { ThreadEntry } from "./types";

/** Pages of 500 entries; past this many the rest is reported as not included. */
const MAX_COPY_PAGES = 200;

/** Every entry of the thread, and whether some could not be read. */
async function allEntries(
  api: ChatApi,
  threadId: string,
): Promise<ApiResult<{ entries: readonly ThreadEntry[]; leaf: string | null; unread: boolean }>> {
  const detail = await api.getThread(threadId);
  if (!detail.ok) return detail;
  const entries = [...detail.data.entries];
  let after = detail.data.nextEntriesAfter;
  for (let page = 0; after !== null && page < MAX_COPY_PAGES; page++) {
    const res = await api.listEntries(threadId, after);
    if (!res.ok) break;
    entries.push(...res.data.entries);
    after = res.data.nextEntriesAfter;
  }
  return {
    ok: true,
    status: detail.status,
    data: { entries, leaf: detail.data.leafEntryId, unread: after !== null },
  };
}

/** The branch on screen of `threadId` as Markdown, with placeholders where it is partial. */
export async function conversationMarkdown(
  api: ChatApi,
  threadId: string,
  title: string,
): Promise<ApiResult<CopiedThread>> {
  const read = await allEntries(api, threadId);
  if (!read.ok) return read;
  const projection = projectThread(read.data.entries, read.data.leaf);
  const offloaded = offloadedOnBranch(projection);
  const outputs = await Promise.all(offloaded.map((id) => api.toolOutput(threadId, id)));
  const toolOutputs = new Set(offloaded.filter((_id, i) => outputs[i]?.ok === true));
  return {
    ok: true,
    status: read.status,
    data: threadMarkdown(title, projection, { toolOutputs, unread: read.data.unread }),
  };
}
