/**
 * What the steering panel shows (CE10, KOBE-206), derived from the thread state and its event
 * stream only. Pure: the panel component renders it, tests walk it.
 */
import type { LiveRun } from "./live";
import { activeRun, currentRunId, type ThreadState } from "./thread-state";
import type { PendingMessage } from "./types";

/** idle: zero height. The others expand the panel. */
export type SteeringMode = "idle" | "active" | "waiting" | "queued" | "interrupted";

export type RunPhase =
  | { readonly kind: "waking"; readonly reason: NonNullable<LiveRun["waking"]> }
  | { readonly kind: "thinking" }
  | { readonly kind: "tool"; readonly tool: string }
  | { readonly kind: "approval" }
  | { readonly kind: "budget" };

const WAKING: Record<NonNullable<LiveRun["waking"]>, string> = {
  hibernated: "Waking your workspace",
  first_start: "Starting your workspace for the first time",
  rebuild: "Rebuilding your workspace",
};

export function phaseText(phase: RunPhase): string {
  switch (phase.kind) {
    case "waking":
      return WAKING[phase.reason];
    case "thinking":
      return "Thinking";
    case "tool":
      return `Running tool ${phase.tool}`;
    case "approval":
      return "Waiting for your approval";
    case "budget":
      return "Finishing on budget";
  }
}

/** The queued messages in run order (D17); edited, deleted and reordered from the panel. */
export function queuedMessages(state: ThreadState): readonly PendingMessage[] {
  return state.pending
    .filter((m) => m.status === "queued")
    .sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0));
}

/** A message sent behind the run that the queue doesn't list yet ("Queuing…"). */
export function queuingText(state: ThreadState): string | undefined {
  const sending = state.sending;
  if (sending?.queues !== true) return undefined;
  return state.pending.some((m) => m.runId === sending.runId && m.status === "queued")
    ? undefined
    : sending.text;
}

export function isInterrupted(state: ThreadState): boolean {
  return state.interruptedRun !== null || state.summary?.status === "interrupted";
}

/** The live copy of the run that holds the thread, if this tab streams it. */
function currentLive(state: ThreadState): LiveRun | undefined {
  const runId = currentRunId(state);
  return runId !== undefined && state.live?.runId === runId ? state.live : undefined;
}

function awaitsApproval(live: LiveRun | undefined): boolean {
  return Object.values(live?.tools ?? {}).some(
    (t) => t.approvalRequested !== undefined && t.approvalResolved === undefined,
  );
}

/** The latest tool call without a result (calls arrive in order; object keys keep it). */
function runningTool(live: LiveRun | undefined): string | undefined {
  const open = Object.values(live?.tools ?? {}).filter(
    (t) => t.call !== undefined && t.result === undefined && t.denied === undefined,
  );
  return open.at(-1)?.call?.tool;
}

/** What the running agent is doing; undefined when no run holds the thread. */
export function runPhase(state: ThreadState, budgetExhausted: boolean): RunPhase | undefined {
  if (currentRunId(state) === undefined) return undefined;
  const live = currentLive(state);
  if (activeRun(state)?.status === "waiting_approval" || awaitsApproval(live)) {
    return { kind: "approval" };
  }
  if (budgetExhausted) return { kind: "budget" };
  if (live?.waking) return { kind: "waking", reason: live.waking };
  const tool = runningTool(live);
  return tool === undefined ? { kind: "thinking" } : { kind: "tool", tool };
}

export function steeringMode(state: ThreadState, phase: RunPhase | undefined): SteeringMode {
  if (isInterrupted(state)) return "interrupted";
  if (phase?.kind === "approval") return "waiting";
  if (phase !== undefined) return "active";
  if (queuedMessages(state).length > 0 || queuingText(state) !== undefined) return "queued";
  return "idle";
}

/** When the run started: the stream's `run.started`, else the server's snapshot. */
export function runStartedAt(state: ThreadState): string | undefined {
  return currentLive(state)?.startedAt ?? activeRun(state)?.startedAt;
}

/** `0:42`, `12:05`, `1:02:03`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** `ids` with the item at `from` moved to `to` (both clamped); a new array. */
export function moveItem<T>(ids: readonly T[], from: number, to: number): readonly T[] {
  const last = ids.length - 1;
  const src = Math.min(Math.max(from, 0), last);
  const dst = Math.min(Math.max(to, 0), last);
  if (src === dst) return ids;
  const rest = ids.filter((_, i) => i !== src);
  return [...rest.slice(0, dst), ids[src] as T, ...rest.slice(dst)];
}
