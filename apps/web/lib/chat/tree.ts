/**
 * Projects the Pi entry tree (`thread_entries`, D15) and the active run's live stream into the
 * branchable message list assistant-ui renders (D16: `ThreadMessage[]` with `parentId` + `headId`).
 *
 * A Pi turn is several entries (user message → assistant step → tool results → assistant step …);
 * assistant-ui shows one assistant message per turn. So:
 * - a `user` message entry is a user message (its id is the entry id);
 * - a chain of assistant-side entries (assistant steps, tool results, offloaded bodies) is one
 *   assistant message, id = its first entry; the chain ends where the tree branches;
 * - other entry types (`model_change`, `compaction`, …) are not shown and belong to the message
 *   around them.
 * Branches (edit-and-regenerate, Retry) are siblings in the tree, so assistant-ui's branch picker
 * works on them as is. The client keeps both directions of the mapping: `nodeOfEntry` (the leaf's
 * message is the head) and `lastEntryOfNode` (the entry to continue from when a branch is chosen).
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import { parseEntry, type ParsedEntry } from "./entries";
import type { SentFile } from "./attachments";
import { splitAttachedFiles } from "./uploads";
import type { LiveMessage, LiveRun, ToolActivity } from "./live";
import type { ThreadEntry } from "./types";

export type KobeMessageMeta =
  | {
      readonly kind: "user";
      /** The entry id; undefined for a prompt Pi hasn't committed yet. */
      readonly entryId?: string | undefined;
      /** Where an edit of this message branches from (its entry's parent). */
      readonly parentEntryId: string | null;
      readonly text: string;
      readonly pending: boolean;
      /** Files sent with it (chips): from the send while pending, from Pi's text once committed. */
      readonly attachments?: readonly ChipFile[] | undefined;
    }
  | {
      readonly kind: "assistant";
      readonly entryIds: readonly string[];
      readonly live: boolean;
    };

/** A file shown on a sent message; `size` is unknown for files not sent from this tab. */
export interface ChipFile {
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number | undefined;
  /** Sandbox path of an upload, to look its size and thumbnail up after a reload (KOBE-194). */
  readonly path?: string | undefined;
  readonly previewUrl?: string | undefined;
}

export interface ProjectedItem {
  readonly parentId: string | null;
  readonly message: ThreadMessageLike & { readonly id: string };
  /** Everything the message was built from: equal deps (by identity) → reuse the old message. */
  readonly deps: readonly unknown[];
}

export interface Projection {
  readonly items: readonly ProjectedItem[];
  readonly headId: string | null;
  readonly nodeOfEntry: ReadonlyMap<string, string>;
  readonly lastEntryOfNode: ReadonlyMap<string, string>;
}

export interface LiveOverlay {
  readonly run: LiveRun;
  /** The run still holds the thread (streaming or waiting). */
  readonly active: boolean;
  /** The run's message text, shown until Pi commits it (from pending-messages or the send). */
  readonly prompt?:
    | {
        readonly text: string;
        readonly parentEntryId: string | null;
        readonly files?: readonly SentFile[] | undefined;
      }
    | undefined;
}

interface ToolResultInfo {
  readonly text: string;
  readonly isError: boolean;
}

interface Node {
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant";
  readonly entries: ThreadEntry[];
}

type MessagePart = Exclude<ThreadMessageLike["content"], string>[number];

const PREFIX_PROMPT = "prompt:";
const PREFIX_LIVE = "live:";

function isAssistantSide(parsed: ParsedEntry): boolean {
  return parsed.kind === "assistant" || parsed.kind === "toolResult" || parsed.kind === "offloaded";
}

/** Builds the nodes; iterative so a long thread can't overflow the stack. */
function buildNodes(entries: readonly ThreadEntry[], parsed: ReadonlyMap<string, ParsedEntry>) {
  const present = new Set(entries.map((e) => e.entryId));
  const children = new Map<string | null, ThreadEntry[]>();
  for (const entry of entries) {
    const key = entry.parentId !== null && present.has(entry.parentId) ? entry.parentId : null;
    const list = children.get(key);
    if (list) list.push(entry);
    else children.set(key, [entry]);
  }

  const nodes = new Map<string, Node>();
  const order: string[] = [];
  const nodeOfEntry = new Map<string, string>();
  const lastEntryOfNode = new Map<string, string>();
  const create = (id: string, parentId: string | null, role: Node["role"], entry: ThreadEntry) => {
    nodes.set(id, { id, parentId, role, entries: [entry] });
    order.push(id);
    lastEntryOfNode.set(id, entry.entryId);
    return id;
  };
  const attach = (nodeId: string, entry: ThreadEntry, listed: boolean) => {
    if (listed) nodes.get(nodeId)?.entries.push(entry);
    if (lastEntryOfNode.get(nodeId) === entry.parentId) lastEntryOfNode.set(nodeId, entry.entryId);
  };

  type Frame = { entry: ThreadEntry; parentNode: string | null; group: string | null };
  const stack: Frame[] = (children.get(null) ?? [])
    .map((entry) => ({ entry, parentNode: null, group: null }))
    .reverse();
  while (stack.length > 0) {
    const { entry, parentNode, group } = stack.pop() as Frame;
    const p = parsed.get(entry.entryId) as ParsedEntry;
    let ctx: string | null;
    let openGroup: string | null;
    let childParent: string | null = parentNode;
    if (p.kind === "user") {
      ctx = create(entry.entryId, group ?? parentNode, "user", entry);
      openGroup = null;
      childParent = ctx;
    } else if (isAssistantSide(p)) {
      if (group !== null) {
        attach(group, entry, true);
        ctx = group;
      } else {
        ctx = create(entry.entryId, parentNode, "assistant", entry);
      }
      openGroup = ctx;
    } else {
      ctx = group ?? parentNode;
      if (ctx !== null) attach(ctx, entry, false);
      openGroup = group;
    }
    if (ctx !== null) nodeOfEntry.set(entry.entryId, ctx);

    const kids = children.get(entry.entryId) ?? [];
    const branches = kids.length > 1 && openGroup !== null;
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({
        entry: kids[i] as ThreadEntry,
        parentNode: branches ? openGroup : childParent,
        group: branches ? null : openGroup,
      });
    }
  }
  return { nodes, order, nodeOfEntry, lastEntryOfNode };
}

function toolCallPart(
  toolCallId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  result: ToolResultInfo | undefined,
): MessagePart {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args: args as never,
    argsText: JSON.stringify(args),
    ...(result ? { result: result.text, isError: result.isError } : {}),
  };
}

function liveResult(activity: ToolActivity | undefined): ToolResultInfo | undefined {
  const result = activity?.result;
  if (!result) return undefined;
  return {
    text: result.truncated ? `${result.preview}…` : result.preview,
    isError: result.is_error,
  };
}

function entryParts(
  entry: ThreadEntry,
  p: ParsedEntry,
  results: ReadonlyMap<string, ToolResultInfo>,
  tools: Readonly<Record<string, ToolActivity>>,
): MessagePart[] {
  if (p.kind === "offloaded")
    return [{ type: "data-kobe-offloaded", data: { entryId: entry.entryId } }];
  if (p.kind !== "assistant") return [];
  const parts: MessagePart[] = [];
  for (const piece of p.pieces) {
    if (piece.kind === "text") parts.push({ type: "text", text: piece.text });
    else if (piece.kind === "reasoning") parts.push({ type: "reasoning", text: piece.text });
    else {
      const result = results.get(piece.toolCallId) ?? liveResult(tools[piece.toolCallId]);
      parts.push(toolCallPart(piece.toolCallId, piece.toolName, piece.args, result));
    }
  }
  if (p.problem) parts.push({ type: "data-kobe-problem", data: p.problem });
  return parts;
}

function liveParts(
  messages: readonly LiveMessage[],
  tools: Readonly<Record<string, ToolActivity>>,
) {
  const parts: MessagePart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool") {
        parts.push({ type: part.kind === "text" ? "text" : "reasoning", text: part.text });
      } else {
        const activity = tools[part.toolCallId];
        const call = activity?.call;
        parts.push(
          toolCallPart(
            part.toolCallId,
            call?.tool ?? "tool",
            (call?.input ?? {}) as Readonly<Record<string, unknown>>,
            liveResult(activity),
          ),
        );
      }
    }
  }
  return parts;
}

function toolDeps(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  resultEntries: ReadonlyMap<string, ThreadEntry>,
  tools: Readonly<Record<string, ToolActivity>>,
) {
  const deps: unknown[] = [];
  for (const entry of entries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind !== "assistant") continue;
    for (const piece of p.pieces) {
      if (piece.kind === "toolCall") {
        deps.push(resultEntries.get(piece.toolCallId), tools[piece.toolCallId]);
      }
    }
  }
  return deps;
}

/** The conversation as assistant-ui messages, with the head on the active branch. */
export function projectThread(
  entries: readonly ThreadEntry[],
  leafEntryId: string | null,
  live?: LiveOverlay,
): Projection {
  const parsed = new Map(entries.map((e) => [e.entryId, parseEntry(e)] as const));
  const results = new Map<string, ToolResultInfo>();
  const resultEntries = new Map<string, ThreadEntry>();
  for (const entry of entries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind === "toolResult") {
      results.set(p.toolCallId, { text: p.text, isError: p.isError });
      resultEntries.set(p.toolCallId, entry);
    }
  }
  const { nodes, order, nodeOfEntry, lastEntryOfNode } = buildNodes(entries, parsed);
  const tools = live?.run.tools ?? {};

  const items: ProjectedItem[] = [];
  const indexOf = new Map<string, number>();
  for (const id of order) {
    const node = nodes.get(id) as Node;
    const first = node.entries[0] as ThreadEntry;
    if (node.role === "user") {
      const p = parsed.get(first.entryId);
      const split = splitAttachedFiles(p?.kind === "user" ? p.text : "");
      const text = split.text;
      const meta: KobeMessageMeta = {
        kind: "user",
        entryId: first.entryId,
        parentEntryId: first.parentId,
        text,
        pending: false,
        ...(split.files.length > 0 ? { attachments: split.files } : {}),
      };
      indexOf.set(id, items.length);
      items.push({
        parentId: node.parentId,
        message: {
          id,
          role: "user",
          content: [{ type: "text", text }],
          metadata: { custom: meta },
        },
        deps: [first],
      });
    } else {
      const content = node.entries.flatMap((e) =>
        entryParts(e, parsed.get(e.entryId) as ParsedEntry, results, tools),
      );
      const meta: KobeMessageMeta = {
        kind: "assistant",
        entryIds: node.entries.map((e) => e.entryId),
        live: false,
      };
      indexOf.set(id, items.length);
      items.push({
        parentId: node.parentId,
        message: {
          id,
          role: "assistant",
          content,
          status: { type: "complete", reason: "stop" },
          metadata: { custom: meta },
        },
        deps: [...node.entries, ...toolDeps(node.entries, parsed, resultEntries, tools)],
      });
    }
  }

  let headId: string | null = headOf(entries, leafEntryId, nodeOfEntry) ?? order.at(-1) ?? null;
  if (live) headId = overlayLive(live, items, indexOf, nodeOfEntry, lastEntryOfNode, headId);
  return { items, headId, nodeOfEntry, lastEntryOfNode };
}

/**
 * The message holding the leaf, or, when the leaf isn't shown (a hidden entry at the root) or not
 * loaded, the nearest shown ancestor that is: never a message of another branch.
 */
function headOf(
  entries: readonly ThreadEntry[],
  leafEntryId: string | null,
  nodeOfEntry: ReadonlyMap<string, string>,
): string | undefined {
  if (leafEntryId === null) return undefined;
  const parentOf = new Map(entries.map((e) => [e.entryId, e.parentId] as const));
  const seen = new Set<string>();
  let id: string | null | undefined = leafEntryId;
  while (id !== null && id !== undefined && !seen.has(id)) {
    const node = nodeOfEntry.get(id);
    if (node !== undefined) return node;
    seen.add(id);
    id = parentOf.get(id);
  }
  return undefined;
}

/** Adds the run's uncommitted prompt and streaming content; returns the run's tail as the head. */
function overlayLive(
  live: LiveOverlay,
  items: ProjectedItem[],
  indexOf: Map<string, number>,
  nodeOfEntry: ReadonlyMap<string, string>,
  lastEntryOfNode: ReadonlyMap<string, string>,
  headId: string | null,
): string | null {
  const { run, active } = live;
  const lastCommitted = [...run.committed].reverse().find((id) => nodeOfEntry.has(id));
  let anchor: string | null =
    lastCommitted === undefined ? headId : (nodeOfEntry.get(lastCommitted) ?? headId);

  if (!run.promptCommitted && live.prompt) {
    const parentEntryId = live.prompt.parentEntryId;
    const parentNode = parentEntryId === null ? null : (nodeOfEntry.get(parentEntryId) ?? headId);
    const id = `${PREFIX_PROMPT}${run.runId}`;
    const meta: KobeMessageMeta = {
      kind: "user",
      parentEntryId,
      text: live.prompt.text,
      pending: true,
      ...(live.prompt.files && live.prompt.files.length > 0
        ? { attachments: live.prompt.files }
        : {}),
    };
    indexOf.set(id, items.length);
    items.push({
      parentId: parentNode,
      message: {
        id,
        role: "user",
        content: [{ type: "text", text: live.prompt.text }],
        metadata: { custom: meta },
      },
      deps: [live.prompt.text, parentNode, live.prompt.files],
    });
    anchor = id;
  }

  const parts = liveParts(run.messages, run.tools);
  const status = active
    ? ({ type: "running" } as const)
    : ({ type: "incomplete", reason: "cancelled" } as const);
  const anchorIndex = anchor === null ? undefined : indexOf.get(anchor);
  const anchorItem = anchorIndex === undefined ? undefined : items[anchorIndex];
  const anchorMeta = anchorItem?.message.metadata?.custom as KobeMessageMeta | undefined;
  const atTail =
    anchorMeta?.kind === "assistant" &&
    (lastCommitted === undefined || lastEntryOfNode.get(anchor as string) === lastCommitted);

  if (anchorItem && anchorIndex !== undefined && atTail && (parts.length > 0 || active)) {
    const content = [...(anchorItem.message.content as readonly MessagePart[]), ...parts];
    items[anchorIndex] = {
      parentId: anchorItem.parentId,
      message: {
        ...anchorItem.message,
        content,
        status: parts.length > 0 || active ? status : anchorItem.message.status,
        metadata: { custom: { ...(anchorMeta as object), live: true } as KobeMessageMeta },
      },
      deps: [...anchorItem.deps, ...run.messages, run.tools, active],
    };
    return anchor;
  }
  if (parts.length === 0) return anchor;
  const id = `${PREFIX_LIVE}${run.runId}`;
  const meta: KobeMessageMeta = { kind: "assistant", entryIds: [], live: true };
  items.push({
    parentId: anchor,
    message: { id, role: "assistant", content: parts, status, metadata: { custom: meta } },
    deps: [...run.messages, run.tools, active, anchor],
  });
  return id;
}

export function messageMeta(message: {
  readonly metadata?: { readonly custom?: unknown } | undefined;
}) {
  return message.metadata?.custom as KobeMessageMeta | undefined;
}
