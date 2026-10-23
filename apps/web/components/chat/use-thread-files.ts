"use client";

/**
 * The files the agent wrote in the thread on screen (KOBE-488, `GET /v1/threads/{id}/files`), for
 * the badge row under the title. Read when the thread opens and again when the live run's `write`
 * or `edit` succeeds. The server lists only files already synced from the sandbox, and the sandbox
 * pushes a run's files shortly after it ends (or when `open_file` asks), so while a written path
 * is not listed yet the list is read again a few times, backing off.
 *
 * A failed read (anyone but the thread's owner gets 404: a shared reader sees no file badges)
 * shows none.
 */
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { THREAD_FILE_WRITE_TOOLS, workspaceToolPath } from "@kobe/protocol";
import type { FileEntry } from "../../lib/files/api";
import { kobeExtrasOf, useChatSession } from "./kobe-runtime";

const WRITE_TOOLS: readonly string[] = THREAD_FILE_WRITE_TOOLS;
/** Waits before reading the list again while a written file is not listed yet (ms). */
export const THREAD_FILES_RETRY_MS: readonly number[] = [1_500, 3_000, 6_000, 12_000];
const NO_FILES: readonly FileEntry[] = [];

/**
 * Paths of the live run's successful `write`/`edit` calls, normalised, sorted and joined by
 * newlines: a stable string, so streamed deltas don't re-render the caller.
 */
function useLiveWrites(threadId: string | undefined): string {
  return useAuiState((s) => {
    const extras = kobeExtrasOf(s);
    const live = extras?.state.live;
    if (!live || threadId === undefined || extras?.state.threadId !== threadId) return "";
    const paths = Object.values(live.tools).flatMap((t) => {
      if (t.result === undefined || t.result.is_error || !WRITE_TOOLS.includes(t.result.tool)) {
        return [];
      }
      const path = (t.call?.input as { path?: unknown } | undefined)?.path;
      const normal = typeof path === "string" ? workspaceToolPath(path) : undefined;
      return normal === undefined ? [] : [normal];
    });
    return [...new Set(paths)].sort().join("\n");
  });
}

interface ThreadFiles {
  readonly threadId: string;
  readonly files: readonly FileEntry[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useThreadFiles(threadId: string | undefined): readonly FileEntry[] {
  const session = useChatSession();
  const writes = useLiveWrites(threadId);
  const [list, setList] = useState<ThreadFiles | null>(null);
  useEffect(() => {
    if (threadId === undefined) return;
    let current = true;
    const expected = writes === "" ? [] : writes.split("\n");
    const read = async () => {
      for (const delay of [0, ...THREAD_FILES_RETRY_MS]) {
        if (delay > 0) await wait(delay);
        if (!current) return;
        const res = await session.api.threadFiles(threadId);
        if (!current) return;
        const files = res.ok ? res.data : NO_FILES;
        setList({ threadId, files });
        const listed = new Set(files.map((f) => f.path));
        if (!res.ok || expected.every((p) => listed.has(p))) return;
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [session, threadId, writes]);
  // Never another thread's files while this one's load.
  return list !== null && list.threadId === threadId ? list.files : NO_FILES;
}
