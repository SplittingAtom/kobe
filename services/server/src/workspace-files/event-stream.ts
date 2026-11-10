import { formatWorkspaceEvent, type WorkspaceEvent } from "@kobe/protocol";
import type { RunEventHub } from "../event-stream/hub.js";
import type { StreamTimings } from "../event-stream/stream.js";
import { versionsDiffer } from "./events.js";
import { createWorkspaceHintStream } from "./hint-stream.js";

/** Panels list again after a burst of commits settles, not once per commit (ms). */
export const EVENTS_DEBOUNCE_MS = 500;

export interface WorkspaceEventsInput {
  readonly userId: string;
  readonly hub: RunEventHub;
  /** The caller's current versions (`readWorkspaceVersions`), from Postgres. */
  readonly read: () => Promise<WorkspaceEvent>;
  /** Whether the caller may still read their workspace in this team. */
  readonly revalidate: () => Promise<boolean>;
  readonly timings?: Partial<StreamTimings>;
  readonly debounceMs?: number;
  readonly onEnd?: () => void;
  readonly abortConnection?: (() => void) | undefined;
}

/**
 * The SSE body of `GET /v1/workspace/events` (KOBE-599): `workspace.state` with the caller's
 * versions right after connecting, then `workspace.changed` whenever they move. Woken by the same
 * per-user workspace hint as the change stream (every manifest commit, and project changes of the
 * team, `notifyTeamWorkspaces`); a hint that changed nothing for this (team, user) sends nothing.
 */
export function createWorkspaceEventStream(
  input: WorkspaceEventsInput,
): ReadableStream<Uint8Array> {
  let last: WorkspaceEvent | undefined;
  const { read, debounceMs, ...rest } = input;
  return createWorkspaceHintStream({
    ...rest,
    debounceMs: debounceMs ?? EVENTS_DEBOUNCE_MS,
    component: "workspace-event-stream",
    async produce(first) {
      const now = await read();
      const previous = last;
      last = now;
      if (first || previous === undefined) return formatWorkspaceEvent("workspace.state", now);
      return versionsDiffer(previous, now) ? formatWorkspaceEvent("workspace.changed", now) : "";
    },
  });
}
