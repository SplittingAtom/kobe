import { formatWorkspaceChange, type WorkspaceFileChange } from "@kobe/protocol";
import type { RunEventHub } from "../event-stream/hub.js";
import type { StreamTimings } from "../event-stream/stream.js";
import { snapshotOf } from "./changes.js";
import { createWorkspaceHintStream, HINT_DEBOUNCE_MS } from "./hint-stream.js";

/**
 * The SSE body of `GET /v1/workspace/changes` (KOBE-496): one `file.state` per requested path
 * (the catch-up by version after any reconnect), then `file.changed` for each newer revision of
 * those paths. Revisions are handed out under the workspace lock (commit order = revision order),
 * so `rev > last` never skips one. Hints, debounce, keep-alives, revalidation and the stall
 * cut-off are the shared pump's (`hint-stream.ts`).
 */
export interface ChangeSource {
  /** Rows of the requested paths with `rev > after`, oldest first (after 0: every path's row). */
  read(after: number): Promise<WorkspaceFileChange[]>;
  /** Whether the caller may still read their workspace in this team. */
  revalidate(): Promise<boolean>;
}

export interface ChangeStreamInput {
  readonly userId: string;
  readonly paths: readonly string[];
  readonly source: ChangeSource;
  readonly hub: RunEventHub;
  readonly timings?: Partial<StreamTimings>;
  /** Wait after a hint before reading, so a burst of commits is read once (ms). */
  readonly debounceMs?: number;
  /** Called exactly once when the stream ends (frees the user's slot). */
  readonly onEnd?: () => void;
  /** Tears down the connection of a client that stopped reading (see run streams). */
  readonly abortConnection?: (() => void) | undefined;
}

export const CHANGE_DEBOUNCE_MS = HINT_DEBOUNCE_MS;

export function createWorkspaceChangeStream(input: ChangeStreamInput): ReadableStream<Uint8Array> {
  let lastRev = 0;
  const { source, paths, ...rest } = input;
  return createWorkspaceHintStream({
    ...rest,
    component: "workspace-change-stream",
    revalidate: () => source.revalidate(),
    async produce(first) {
      const rows = await source.read(first ? 0 : lastRev);
      const type = first ? "file.state" : "file.changed";
      const out = first ? snapshotOf(paths, rows) : rows;
      let text = "";
      for (const change of out) {
        text += formatWorkspaceChange(type, change);
        lastRev = Math.max(lastRev, change.rev);
      }
      return text;
    },
  });
}
