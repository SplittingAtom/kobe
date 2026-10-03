/**
 * The state of one open thread and the pure rules over it (merging entries, which run is active,
 * what to show). The controller (`thread-controller.ts`) owns the side effects.
 */
import { isActiveRunStatus } from "@kobe/protocol";
import type { ApiError } from "../api/client";
import type { CommittedEntry, LiveRun } from "./live";
import type { LiveOverlay } from "./tree";
import type { PendingMessage, RunSnapshot, ThreadEntry, ThreadSummary } from "./types";

export type Connection = "idle" | "connecting" | "open" | "reconnecting" | "lost";

/** A message whose POST hasn't answered yet (shown at once, D17 "shown as queued"). */
export interface SendingMessage {
  readonly key: string;
  readonly text: string;
  readonly parentEntryId: string | null;
  /** Another run held the thread when it was sent: it will queue. */
  readonly queues: boolean;
  /** Set once the server answered (queued): hidden as soon as the queue lists this run. */
  readonly runId?: string | undefined;
}

export interface ThreadState {
  readonly threadId: string | null;
  readonly phase: "loading" | "ready" | "error";
  readonly loadError?: ApiError | undefined;
  readonly summary?: ThreadSummary | undefined;
  /** Seq order. Entries from `entry.committed` carry a provisional seq until the next read. */
  readonly entries: readonly ThreadEntry[];
  /** Highest seq read from the server (the next incremental read starts after it). */
  readonly serverSeq: number;
  /** The active run (if any) followed by queued runs, as the server last said. */
  readonly runs: readonly RunSnapshot[];
  readonly interruptedRun: RunSnapshot | null;
  readonly pending: readonly PendingMessage[];
  /** The run being streamed, or the last one streamed. */
  readonly live?: LiveRun | undefined;
  /** The live run's message text, until Pi commits it. */
  readonly livePrompt?:
    { readonly text: string; readonly parentEntryId: string | null } | undefined;
  readonly sending?: SendingMessage | undefined;
  readonly connection: Connection;
  /** The last action that failed (rendered as an alert with its way out). */
  readonly actionError?:
    { readonly error: ApiError; readonly draft?: string | undefined } | undefined;
  /** Actions in flight, e.g. `stop`, `retry`, `edit:<runId>`. */
  readonly busy: readonly string[];
  /** Polite status for screen readers ("Message queued", "Run stopped", …). */
  readonly announcement: string;
  /** Bumped per announcement, so the same text twice is announced twice. */
  readonly announcementSeq: number;
}

export function initialThreadState(threadId: string | null): ThreadState {
  return {
    threadId,
    phase: threadId === null ? "ready" : "loading",
    entries: [],
    serverSeq: 0,
    runs: [],
    interruptedRun: null,
    pending: [],
    connection: "idle",
    busy: [],
    announcement: "",
    announcementSeq: 0,
  };
}

const PROVISIONAL_SEQ_BASE = 1e12;

/** Server entries replace provisional ones with the same id; order is by seq. */
export function mergeServerEntries(
  current: readonly ThreadEntry[],
  incoming: readonly ThreadEntry[],
): readonly ThreadEntry[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((e) => [e.entryId, e] as const));
  for (const entry of incoming) byId.set(entry.entryId, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Entries delivered by the stream that the tree doesn't have yet (provisional seq, appended). */
export function mergeCommittedEntries(
  current: readonly ThreadEntry[],
  committed: readonly CommittedEntry[],
  now: string,
): readonly ThreadEntry[] {
  const known = new Set(current.map((e) => e.entryId));
  const added: ThreadEntry[] = [];
  let seq = current.reduce((max, e) => Math.max(max, e.seq), PROVISIONAL_SEQ_BASE);
  for (const entry of committed) {
    if (known.has(entry.entryId)) continue;
    known.add(entry.entryId);
    seq += 1;
    added.push({
      entryId: entry.entryId,
      parentId: entry.parentId,
      seq,
      type: entry.type,
      payload: entry.payload ?? {},
      payloadOffloaded: entry.payload === undefined,
      createdAt: now,
    });
  }
  return added.length === 0 ? current : [...current, ...added];
}

export function activeRun(state: ThreadState): RunSnapshot | undefined {
  return state.runs.find((r) => isActiveRunStatus(r.status));
}

export function queuedRuns(state: ThreadState): readonly RunSnapshot[] {
  return state.runs.filter((r) => r.status === "queued");
}

/** The run Stop and Steer act on: the streaming run once it started, else the server's active run. */
export function currentRunId(state: ThreadState): string | undefined {
  const live = state.live;
  if (live && live.started && live.terminal === undefined) return live.runId;
  const active = activeRun(state);
  if (!active) return undefined;
  return live?.runId === active.runId && live.terminal !== undefined ? undefined : active.runId;
}

export function isThreadRunning(state: ThreadState): boolean {
  return currentRunId(state) !== undefined;
}

/** The run to stream: the active one, else the next queued one (unless the thread is interrupted). */
export function runToStream(state: ThreadState): string | undefined {
  const active = activeRun(state);
  if (active) return active.runId;
  if (state.summary?.status === "interrupted" || state.interruptedRun !== null) return undefined;
  return queuedRuns(state)[0]?.runId;
}

export function isBusy(state: ThreadState, action: string): boolean {
  return state.busy.includes(action);
}

/** What the conversation shows on top of the entries: the streaming run or a message being sent. */
export function liveOverlay(state: ThreadState): LiveOverlay | undefined {
  const sending = state.sending;
  if (sending && !sending.queues) {
    return {
      run: { ...emptyRun(`sending:${sending.key}`) },
      active: true,
      prompt: { text: sending.text, parentEntryId: sending.parentEntryId },
    };
  }
  const live = state.live;
  if (!live) return undefined;
  const running = currentRunId(state) === live.runId;
  if (!live.started && !running) return undefined; // still queued: shown in the queue
  const unsavedPrompt = !live.promptCommitted && state.livePrompt !== undefined;
  // An ended run stays on screen only for what the entries don't have (text cut off by Stop).
  if (!running && live.messages.length === 0 && !unsavedPrompt) return undefined;
  return { run: live, active: running, prompt: state.livePrompt };
}

function emptyRun(runId: string): LiveRun {
  return {
    runId,
    lastSeq: 0,
    started: true,
    committed: [],
    promptCommitted: false,
    bound: [],
    messages: [],
    tools: {},
    notices: [],
  };
}
