/**
 * What a run's Kobe Event Stream (spec §6.2, KOBE-31) adds on top of the committed entry tree: the
 * text still streaming, tool activity, notices, and how the run ended. Pure and immutable: every
 * function returns a new state. Events with `seq <= lastSeq` are dropped (duplicates across
 * reconnects), so replaying a stream from 0 after a refresh rebuilds exactly the same state.
 *
 * Deltas carry a stream-local `message_id`; `entry.committed` binds it to the durable entry, after
 * which the entry is the record and the live copy is dropped (contracts decision).
 */
import type { KobeEvent, KobeEventPayload } from "@kobe/protocol";

type Payload<T extends KobeEvent["type"]> = KobeEventPayload<T>;

export type LivePart =
  | { readonly kind: "text" | "reasoning"; readonly contentIndex: number; readonly text: string }
  | { readonly kind: "tool"; readonly toolCallId: string };

export interface LiveMessage {
  readonly messageId: string;
  readonly parts: readonly LivePart[];
}

/** Everything the stream said about one tool call (the card renders it; KOBE-37/54/55 add more). */
export interface ToolActivity {
  readonly call?: Payload<"tool.call"> | undefined;
  readonly result?: Payload<"tool.result"> | undefined;
  readonly denied?: Payload<"policy.denied"> | undefined;
  readonly egressBlocked: readonly Payload<"egress.blocked">[];
  readonly approvalRequested?: Payload<"approval.requested"> | undefined;
  readonly approvalResolved?: Payload<"approval.resolved"> | undefined;
  readonly artifacts: readonly (Payload<"artifact.created"> | Payload<"artifact.updated">)[];
  readonly files: readonly Payload<"file.shared">[];
}

/** Run-level happenings shown beside the conversation (not tied to a tool call). */
export type RunNotice = Extract<
  KobeEvent,
  {
    type:
      | "egress.blocked"
      | "steer.applied"
      | "memory.updated"
      | "artifact.created"
      | "artifact.updated"
      | "file.shared";
  }
>;

export type TerminalEvent = Extract<
  KobeEvent,
  { type: "run.completed" | "run.failed" | "run.interrupted" | "run.budget_stopped" }
>;

/** An entry `entry.committed` delivered (the thread store adds it to the tree). */
export interface CommittedEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly type: string;
  /** Absent when the server stored it by `blob_ref` (over 64 KB). */
  readonly payload: Readonly<Record<string, unknown>> | undefined;
}

export interface LiveRun {
  readonly runId: string;
  readonly lastSeq: number;
  readonly started: boolean;
  /** `sandbox.waking` until the first sign of work (D14 "Waking your workspace…"). */
  readonly waking?: Payload<"sandbox.waking">["reason"] | undefined;
  readonly terminal?: TerminalEvent | undefined;
  /** Entries this run committed, in order. */
  readonly committed: readonly string[];
  /** The run's prompt is in the tree (its first committed user message). */
  readonly promptCommitted: boolean;
  /** Message ids already bound to entries (later deltas for them are ignored). */
  readonly bound: readonly string[];
  readonly messages: readonly LiveMessage[];
  readonly tools: Readonly<Record<string, ToolActivity>>;
  readonly notices: readonly RunNotice[];
}

export function newLiveRun(runId: string): LiveRun {
  return {
    runId,
    lastSeq: 0,
    started: false,
    committed: [],
    promptCommitted: false,
    bound: [],
    messages: [],
    tools: {},
    notices: [],
  };
}

const NO_TOOL: ToolActivity = { egressBlocked: [], artifacts: [], files: [] };

function withTool(
  run: LiveRun,
  toolCallId: string,
  change: (tool: ToolActivity) => ToolActivity,
): LiveRun {
  return {
    ...run,
    tools: { ...run.tools, [toolCallId]: change(run.tools[toolCallId] ?? NO_TOOL) },
  };
}

function upsertMessage(
  run: LiveRun,
  messageId: string,
  change: (parts: readonly LivePart[]) => readonly LivePart[],
): LiveRun {
  const index = run.messages.findIndex((m) => m.messageId === messageId);
  if (index === -1)
    return { ...run, messages: [...run.messages, { messageId, parts: change([]) }] };
  const messages = run.messages.map((m, i) => (i === index ? { ...m, parts: change(m.parts) } : m));
  return { ...run, messages };
}

function appendDelta(run: LiveRun, event: KobeEvent<"text.delta" | "reasoning.delta">): LiveRun {
  const { message_id: messageId, content_index: contentIndex, delta } = event.payload;
  if (run.bound.includes(messageId)) return run;
  const kind = event.type === "text.delta" ? "text" : "reasoning";
  return upsertMessage(run, messageId, (parts) => {
    const at = parts.findIndex(
      (p) => p.kind === kind && "contentIndex" in p && p.contentIndex === contentIndex,
    );
    if (at === -1) return [...parts, { kind, contentIndex, text: delta }];
    return parts.map((p, i) => (i === at && p.kind === kind ? { ...p, text: p.text + delta } : p));
  });
}

function addToolCall(run: LiveRun, payload: Payload<"tool.call">): LiveRun {
  const withCall = withTool(run, payload.tool_call_id, (t) => ({ ...t, call: payload }));
  const messageId = payload.message_id ?? `tool:${payload.tool_call_id}`;
  if (withCall.bound.includes(messageId)) return withCall;
  return upsertMessage(withCall, messageId, (parts) =>
    parts.some((p) => p.kind === "tool" && p.toolCallId === payload.tool_call_id)
      ? parts
      : [...parts, { kind: "tool", toolCallId: payload.tool_call_id }],
  );
}

function toolCallIdsOf(payload: Readonly<Record<string, unknown>> | undefined): Set<string> {
  const ids = new Set<string>();
  const message = payload?.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return ids;
  for (const part of message.content as unknown[]) {
    const p = part as { type?: unknown; id?: unknown } | null;
    if (p?.type === "toolCall" && typeof p.id === "string") ids.add(p.id);
  }
  return ids;
}

function isUserMessage(payload: Readonly<Record<string, unknown>> | undefined): boolean {
  return (payload?.message as { role?: unknown } | undefined)?.role === "user";
}

function commit(run: LiveRun, payload: Payload<"entry.committed">): LiveRun {
  const entryPayload = payload.payload as Readonly<Record<string, unknown>> | undefined;
  const committedTools = toolCallIdsOf(entryPayload);
  const bound = payload.message_id === undefined ? run.bound : [...run.bound, payload.message_id];
  const messages = run.messages
    .filter((m) => m.messageId !== payload.message_id)
    .map((m) => ({
      ...m,
      parts: m.parts.filter((p) => p.kind !== "tool" || !committedTools.has(p.toolCallId)),
    }))
    .filter((m) => m.parts.length > 0);
  return {
    ...run,
    committed: run.committed.includes(payload.entry_id)
      ? run.committed
      : [...run.committed, payload.entry_id],
    promptCommitted:
      run.promptCommitted || (payload.entry_type === "message" && isUserMessage(entryPayload)),
    bound,
    messages,
  };
}

function notice(run: LiveRun, event: RunNotice): LiveRun {
  return { ...run, notices: [...run.notices, event] };
}

/** Events that show work started: the "waking" notice goes away. */
const WORK_EVENTS: ReadonlySet<string> = new Set([
  "text.delta",
  "reasoning.delta",
  "tool.call",
  "entry.committed",
]);

function applyOne(run: LiveRun, event: KobeEvent): LiveRun {
  const next = WORK_EVENTS.has(event.type) ? { ...run, waking: undefined } : run;
  switch (event.type) {
    case "run.queued":
      return next;
    case "run.started":
      return { ...next, started: true };
    case "sandbox.waking":
      return { ...next, waking: event.payload.reason };
    case "text.delta":
    case "reasoning.delta":
      return appendDelta(next, event);
    case "tool.call":
      return addToolCall(next, event.payload);
    case "tool.result":
      return withTool(next, event.payload.tool_call_id, (t) => ({ ...t, result: event.payload }));
    case "policy.denied":
      return withTool(next, event.payload.tool_call_id, (t) => ({ ...t, denied: event.payload }));
    case "approval.requested":
      return withTool(next, event.payload.tool_call_id, (t) => ({
        ...t,
        approvalRequested: event.payload,
      }));
    case "approval.resolved":
      return withTool(next, event.payload.tool_call_id, (t) => ({
        ...t,
        approvalResolved: event.payload,
      }));
    case "egress.blocked": {
      const id = event.payload.tool_call_id;
      if (id === undefined) return notice(next, event);
      return withTool(next, id, (t) => ({
        ...t,
        egressBlocked: [...t.egressBlocked, event.payload],
      }));
    }
    case "artifact.created":
    case "artifact.updated": {
      const id = event.payload.tool_call_id;
      if (id === undefined) return notice(next, event);
      return withTool(next, id, (t) => ({ ...t, artifacts: [...t.artifacts, event.payload] }));
    }
    case "file.shared": {
      const id = event.payload.tool_call_id;
      if (id === undefined) return notice(next, event);
      return withTool(next, id, (t) => ({ ...t, files: [...t.files, event.payload] }));
    }
    case "steer.applied":
    case "memory.updated":
      return notice(next, event);
    case "entry.committed":
      return commit(next, event.payload);
    case "run.completed":
    case "run.failed":
    case "run.interrupted":
    case "run.budget_stopped":
      return { ...next, terminal: event, waking: undefined };
  }
}

export interface AppliedEvents {
  readonly run: LiveRun;
  /** Entries delivered by `entry.committed`, in order (not yet deduplicated against the tree). */
  readonly entries: readonly CommittedEntry[];
}

/** Applies events in order, dropping any with `seq <= lastSeq` and anything after a terminal. */
export function applyRunEvents(run: LiveRun, events: readonly KobeEvent[]): AppliedEvents {
  let current = run;
  const entries: CommittedEntry[] = [];
  for (const event of events) {
    if (event.run_id !== run.runId || event.seq <= current.lastSeq) continue;
    if (current.terminal !== undefined) continue;
    current = { ...applyOne(current, event), lastSeq: event.seq };
    if (event.type === "entry.committed") {
      entries.push({
        entryId: event.payload.entry_id,
        parentId: event.payload.parent_id,
        type: event.payload.entry_type,
        payload: event.payload.payload as Readonly<Record<string, unknown>> | undefined,
      });
    }
  }
  return { run: current, entries };
}

export function isRunEnded(run: LiveRun): boolean {
  return run.terminal !== undefined;
}
