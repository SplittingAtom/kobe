/**
 * The state of one open thread and the pure rules over it (merging entries, which run is active,
 * what to show). The controller (`thread-controller.ts`) owns the side effects.
 */
import { isActiveRunStatus } from "@kobe/protocol";
import type { ApiError } from "../api/client";
import type { SentFile } from "./attachments";
import { parseEntry } from "./entries";
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
  /** The files sent with it (chips until the entry is committed). */
  readonly files?: readonly SentFile[] | undefined;
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
  /** Queued messages are held after Stop until the user resumes the queue or sends. */
  readonly queuePaused: boolean;
  readonly pending: readonly PendingMessage[];
  /** The run being streamed, or the last one streamed. */
  readonly live?: LiveRun | undefined;
  /** The model the thread's agent pins (KOBE-44): the model picker is locked to it. */
  readonly agentModel?: string | null | undefined;
  /**
   * The agent's current published version (D19, U8): newer than `summary.agentVersion` means the
   * header offers "v<N> available" (KOBE-420). Null: no agent, or none readable.
   */
  readonly agentCurrentVersion?: number | null | undefined;
  /** The live run's message text, until Pi commits it. */
  readonly livePrompt?:
    | {
        readonly text: string;
        readonly parentEntryId: string | null;
        readonly files?: readonly SentFile[] | undefined;
      }
    | undefined;
  readonly sending?: SendingMessage | undefined;
  readonly connection: Connection;
  /** The last action that failed (rendered as an alert with its way out). */
  readonly actionError?:
    { readonly error: ApiError; readonly draft?: string | undefined } | undefined;
  /** Actions in flight, e.g. `stop`, `retry`, `edit:<runId>`. */
  readonly busy: readonly string[];
  /** The run the server accepted Stop for; it may stream on until its end arrives (KOBE-269). */
  readonly stopRequested?: string | undefined;
  /**
   * Follow-ups the server suggested after the last completed run (KOBE-222 `thread.suggestions`):
   * chips above the composer until the next send.
   */
  readonly followups?:
    { readonly runId: string; readonly suggestions: readonly string[] } | undefined;
  /**
   * The newest `open_file` request that arrived live (KOBE-484): the owner's client opens that
   * file's tab once. Never set from a replayed backlog, so a reload does not reopen old files.
   */
  readonly fileOpenRequest?:
    { readonly runId: string; readonly toolCallId: string; readonly path: string } | undefined;
  /**
   * The newest `propose_file_edit` proposal that arrived live (KOBE-489), by the same rule as
   * `fileOpenRequest`: with the member's auto-open switch on, its card starts the review once.
   */
  readonly fileEditRequest?:
    { readonly runId: string; readonly toolCallId: string; readonly path: string } | undefined;
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
    queuePaused: false,
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

/** Stop was accepted for the current run, whose end has not arrived yet (KOBE-269). */
export function isStopping(state: ThreadState): boolean {
  const runId = currentRunId(state);
  return runId !== undefined && state.stopRequested === runId;
}

/** Drops the Stop flag once its run is no longer the current one (it ended, or another took over). */
export function settleStop(state: ThreadState): ThreadState {
  if (state.stopRequested === undefined || currentRunId(state) === state.stopRequested)
    return state;
  return { ...state, stopRequested: undefined };
}

/** The run to stream: the active one, else the next queued one (unless the thread is interrupted). */
export function runToStream(state: ThreadState): string | undefined {
  const active = activeRun(state);
  if (active) return active.runId;
  if (state.summary?.status === "interrupted" || state.interruptedRun !== null) return undefined;
  // A held queue doesn't start: keep the stopped run (and what it streamed) on screen.
  if (state.queuePaused) return undefined;
  return queuedRuns(state)[0]?.runId;
}

/**
 * Why Compact now (CE15, KOBE-213) is not offered right now, or null when it is: only on the
 * owner's saved thread, out of Trash, idle (no run, nothing being sent or compacted), with a
 * conversation to fold. The server decides again (`thread_busy`, `nothing_to_compact`).
 */
export function compactBlocker(state: ThreadState): string | null {
  const summary = state.summary;
  if (state.threadId === null || state.phase !== "ready" || !summary) return "No conversation yet.";
  if (summary.readOnly === true) return "This conversation is shared with you read-only.";
  if (summary.deletedAt != null) return "Restore the conversation first.";
  if (isBusy(state, "compact")) return "Compacting…";
  // Waiting on Retry (D14): the server refuses it as busy; say what unblocks it.
  if (summary.status === "interrupted" || state.interruptedRun !== null) {
    return "Retry the interrupted run, or continue without retry, first.";
  }
  const running =
    summary.status !== "idle" || isThreadRunning(state) || state.sending !== undefined;
  if (running) return "Wait for the current run to finish.";
  if (!state.entries.some((e) => e.type === "message")) return "There is nothing to compact yet.";
  return null;
}

export function isBusy(state: ThreadState, action: string): boolean {
  return state.busy.includes(action);
}

/**
 * "Regenerate with…" (CE17, KOBE-217) may run: when plain Regenerate may (the thread is read, out
 * of Trash, no run going and nothing being sent), with no queued run (the model change would
 * apply to it too) and no model change in flight.
 */
export function canRegenerateWith(state: ThreadState): boolean {
  const summary = state.summary;
  return (
    state.phase === "ready" &&
    summary !== undefined &&
    summary.deletedAt == null &&
    !isThreadRunning(state) &&
    state.sending === undefined &&
    queuedRuns(state).length === 0 &&
    !isBusy(state, "model")
  );
}

/** What the conversation shows on top of the entries: the streaming run or a message being sent. */
export function liveOverlay(state: ThreadState): LiveOverlay | undefined {
  const sending = state.sending;
  if (sending && !sending.queues) {
    return {
      run: { ...emptyRun(`sending:${sending.key}`) },
      active: true,
      prompt: { text: sending.text, parentEntryId: sending.parentEntryId, files: sending.files },
    };
  }
  const live = state.live;
  if (!live) return undefined;
  const running = currentRunId(state) === live.runId;
  if (!live.started && !running) return undefined; // still queued: shown in the queue
  const prompt = promptSaved(live, state.entries) ? undefined : state.livePrompt;
  // An ended run stays on screen only for what the entries don't have (text cut off by Stop).
  if (!running && live.messages.length === 0 && prompt === undefined) return undefined;
  return { run: live, active: running, prompt };
}

/**
 * The run's prompt is in the tree: the stream said so, or the tree holds a user message the run
 * committed. The second covers a prompt over 64 KiB, streamed without its body (KOBE-288): only
 * the thread read shows its role, and the copy shown from the send must give way to it.
 */
export function promptSaved(live: LiveRun, entries: readonly ThreadEntry[]): boolean {
  if (live.promptCommitted) return true;
  if (live.committed.length === 0) return false;
  const committed = new Set(live.committed);
  return entries.some((e) => committed.has(e.entryId) && parseEntry(e).kind === "user");
}

function emptyRun(runId: string): LiveRun {
  return {
    runId,
    lastSeq: 0,
    started: true,
    committed: [],
    promptCommitted: false,
    bound: {},
    messages: [],
    tools: {},
    notices: [],
  };
}
