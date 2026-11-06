/**
 * The Conversation tree's nodes (CT1, KOBE-545): a second projection of the entries the web
 * already holds, built on {@link projectThread} so a node is exactly a message on screen (same
 * ids, same turn collapsing, `nodeOfEntry` reused). Every message of every branch is a node, never
 * folded (Q3); a branch marker with nothing under it is a ghost (CT5); the live run's prompt and
 * streaming answer are nodes too (`pending`, drawn dashed). Markers between messages are not
 * nodes: a model or agent change is the next node's `model` / `agentVersion`, a compaction is the
 * `compacted` tick of the node it sits in. Pure; the panel (KOBE-546) draws it.
 */
import type { ThreadBranchesResponse } from "@kobe/protocol";
import {
  isAppCardEntry,
  isSkippedSummary,
  parseEntry,
  recordedModel,
  type ParsedEntry,
} from "./entries";
import type { AgentMarker } from "./markers";
import { failedToolCalls, toolBadges, type TreeBadges } from "./tree-badges";
import {
  messageMeta,
  newestBelow,
  projectThread,
  type LiveOverlay,
  type ProjectedItem,
} from "./tree";
import type { ThreadEntry } from "./types";

/** Excerpt length (§5), the ellipsis included. */
export const TREE_EXCERPT_MAX = 120;
export const TOOLS_ONLY_EXCERPT = "(tools only)";

/** The sandbox agent's branch marker (`pi/session-files.ts` BRANCH_CUSTOM_TYPE). */
const BRANCH_MARKER_TYPE = "kobe.branch";
const PREFIX_EMPTY = "empty:";
const PREFIX_SKIPPED = "skipped:";

/** What the tree reads besides the entries: CT2's `branches` read, and the agent switches. */
export interface TreeNotes extends ThreadBranchesResponse {
  /** The thread's agent switches (KOBE-420 markers), shown at the prompt they precede. */
  readonly agents?: readonly AgentMarker[] | undefined;
  /** The thread's agent's name, for the switch note. */
  readonly agentName?: string | null | undefined;
}

export interface TreeNode {
  /** The message id, as projectThread gives it (`empty:<entry>` for a ghost). */
  readonly id: string;
  readonly parentId: string | null;
  readonly role: "user" | "assistant";
  /** Text, whitespace collapsed, {@link TREE_EXCERPT_MAX} characters; "(tools only)"; "" for a ghost. */
  readonly excerpt: string;
  /** created_at of the first entry (the run's start for a pending node). */
  readonly at: string;
  /** The first entry's seq: the row order (CT4); pending nodes sort last. */
  readonly seq: number;
  /** The model recorded on the branch at this node. */
  readonly model: string | null;
  /** An agent switch recorded at this prompt. */
  readonly agentVersion: { readonly name: string; readonly version: number } | null;
  /** Pi's usage summed over the answer's steps (input = prompt incl. cache); null when none. */
  readonly tokens: { readonly input: number; readonly output: number } | null;
  /** On the path root → head (the conversation on screen, CT3). */
  readonly onScreen: boolean;
  /** The thread's leaf is in this node (where Pi continues). */
  readonly isLeaf: boolean;
  /** A branch marker with no message under it: an interrupted run (CT5). */
  readonly empty?: true;
  /** The live run's message (pulses). */
  readonly live?: true;
  /** Not committed yet (the run's prompt or streaming answer): drawn dashed, never laid out. */
  readonly pending?: true;
  /** A compaction sits in this node: the "compacted above" tick below it. */
  readonly compacted?: true;
  readonly badges: TreeBadges;
  /** A `branch_summary` entry carried into this node (CT11). */
  readonly summary?: { readonly entryId: string };
  readonly label?: string;
}

export interface TreeProjection {
  /** Every node, by first entry seq; pending nodes last. */
  readonly nodes: readonly TreeNode[];
  /** The node on screen at the bottom (the head's), null for an empty thread. */
  readonly headId: string | null;
  /** The node holding the thread's leaf. */
  readonly leafId: string | null;
  readonly nodeOfEntry: ReadonlyMap<string, string>;
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TREE_EXCERPT_MAX ? flat : `${flat.slice(0, TREE_EXCERPT_MAX - 1)}…`;
}

function isMessage(p: ParsedEntry | undefined): boolean {
  const kind = p?.kind;
  return (
    kind === "user" ||
    kind === "assistant" ||
    kind === "toolResult" ||
    kind === "offloaded" ||
    kind === "appCard"
  );
}

/** The model recorded on the branch at each entry (its latest model_change or answer above). */
function modelChain(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
): (entryId: string) => string | null {
  const byId = new Map(entries.map((e) => [e.entryId, e] as const));
  const known = new Map<string, string | null>();
  return (entryId) => {
    const climbed: string[] = [];
    let found: string | null = null;
    for (let at: string | null = entryId; at !== null;) {
      const cached = known.get(at);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      const e = byId.get(at);
      if (!e || climbed.includes(at)) break;
      climbed.push(at);
      const model = recordedModel(e, parsed.get(at) as ParsedEntry);
      if (model !== undefined) {
        found = model;
        break;
      }
      at = e.parentId;
    }
    for (const id of climbed) known.set(id, found);
    return found;
  };
}

function usageOf(entries: readonly ThreadEntry[]): TreeNode["tokens"] {
  let input = 0;
  let output = 0;
  let seen = false;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  for (const e of entries) {
    const message = e.payload.message as { role?: unknown; usage?: unknown } | undefined;
    const usage = message?.role === "assistant" ? message.usage : undefined;
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as Record<string, unknown>;
    seen = true;
    input += n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
    output += n(u.output);
  }
  return seen ? { input, output } : null;
}

/**
 * Branch markers with no message anywhere below them (CT5), topmost only: entry id → parent
 * entry. `skip` leaves out the marker of the run whose prompt is still on screen.
 */
function ghostEntries(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  skip: (e: ThreadEntry) => boolean,
): ThreadEntry[] {
  const byId = new Map(entries.map((e) => [e.entryId, e] as const));
  const aboveMessage = new Set<string>();
  for (const e of entries) {
    if (!isMessage(parsed.get(e.entryId))) continue;
    for (let at = e.parentId; at !== null && !aboveMessage.has(at);) {
      aboveMessage.add(at);
      at = byId.get(at)?.parentId ?? null;
    }
  }
  const isMarker = (e: ThreadEntry) =>
    e.type === "custom" &&
    (e.payload.customType === undefined || e.payload.customType === BRANCH_MARKER_TYPE);
  return entries.filter((e) => {
    if (!isMarker(e) || aboveMessage.has(e.entryId) || skip(e)) return false;
    const parent = e.parentId === null ? undefined : byId.get(e.parentId);
    return parent === undefined || !(isMarker(parent) && !aboveMessage.has(parent.entryId));
  });
}

/** The text of an item's message: the prompt as typed, or the answer's text parts. */
function itemText(item: ProjectedItem): { text: string; tools: boolean } {
  const meta = messageMeta(item.message);
  if (meta?.kind === "user") return { text: meta.text, tools: false };
  const parts = item.message.content;
  if (typeof parts === "string") return { text: parts, tools: false };
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ");
  return { text, tools: parts.some((p) => p.type === "tool-call") };
}

interface Context {
  readonly parsed: ReadonlyMap<string, ParsedEntry>;
  readonly byId: ReadonlyMap<string, ThreadEntry>;
  readonly failed: ReadonlySet<string>;
  readonly modelAt: (entryId: string) => string | null;
  readonly rules: ReadonlySet<string>;
  readonly agents: ReadonlyMap<string, number>;
  readonly agentName: string;
  readonly live: LiveOverlay | undefined;
}

type Draft = Omit<TreeNode, "onScreen" | "isLeaf">;

function nodeOfItem(item: ProjectedItem, ctx: Context): Draft {
  const id = item.message.id;
  const meta = messageMeta(item.message);
  const role = item.message.role === "user" ? "user" : "assistant";
  const ids =
    meta?.kind === "user"
      ? meta.entryId === undefined
        ? []
        : [meta.entryId]
      : (meta?.entryIds ?? []);
  const own = ids.flatMap((e) => ctx.byId.get(e) ?? []);
  const first = own[0];
  const last = own.at(-1);
  const pending = own.length === 0;
  const { text, tools } = itemText(item);
  const live = meta?.kind === "assistant" ? meta.live : meta?.pending === true;
  const agent = first === undefined ? undefined : ctx.agents.get(first.entryId);
  const prompt = meta?.kind === "assistant" ? meta.promptEntryId : undefined;
  const files = role === "assistant" ? toolBadges(own, ctx.parsed, ctx.failed) : {};
  return {
    id,
    parentId: item.parentId,
    role,
    excerpt: text.trim() === "" && tools ? TOOLS_ONLY_EXCERPT : excerptOf(text),
    at: first?.createdAt ?? ctx.live?.run.startedAt ?? "",
    seq: first?.seq ?? Number.MAX_SAFE_INTEGER,
    model: last === undefined ? (ctx.live?.run.model ?? null) : ctx.modelAt(last.entryId),
    agentVersion:
      agent === undefined || role !== "user" ? null : { name: ctx.agentName, version: agent },
    tokens: usageOf(own),
    ...(live ? { live: true as const } : {}),
    ...(pending ? { pending: true as const } : {}),
    badges: prompt !== undefined && ctx.rules.has(prompt) ? { ...files, rule: true } : files,
  };
}

function ghostNode(entry: ThreadEntry, parentId: string | null, ctx: Context): Draft {
  return {
    id: `${PREFIX_EMPTY}${entry.entryId}`,
    parentId,
    role: "assistant",
    excerpt: "",
    at: entry.createdAt,
    seq: entry.seq,
    model: ctx.modelAt(entry.entryId),
    agentVersion: null,
    tokens: null,
    empty: true,
    badges: {},
  };
}

/** The ids of `start` and every node above it. */
function pathUp(start: string | null, parentOf: ReadonlyMap<string, string | null>): Set<string> {
  const path = new Set<string>();
  for (
    let at = start;
    at !== null && parentOf.has(at) && !path.has(at);
    at = parentOf.get(at) ?? null
  ) {
    path.add(at);
  }
  return path;
}

/**
 * The tree of the thread: `head` is this tab's local head (CT3), `leaf` the thread's leaf, `notes`
 * the `branches` read (null when absent or failed: no labels, no rule badges), `live` the run on
 * screen, as projectThread takes it.
 */
export function projectTree(
  entries: readonly ThreadEntry[],
  head: string | null,
  leaf: string | null = head,
  notes: TreeNotes | null = null,
  live?: LiveOverlay,
): TreeProjection {
  const projection = projectThread(entries, head, leaf, live);
  const { nodeOfEntry, loaded } = projection;
  const tree = entries.filter((e) => loaded.has(e.entryId));
  const parsed = new Map(tree.map((e) => [e.entryId, parseEntry(e)] as const));
  const ctx: Context = {
    parsed,
    byId: new Map(tree.map((e) => [e.entryId, e] as const)),
    failed: failedToolCalls(tree, parsed),
    modelAt: modelChain(tree, parsed),
    rules: new Set(notes?.runs.filter((r) => r.remembered_rule).map((r) => r.user_entry_id)),
    agents: new Map(notes?.agents?.map((a) => [a.userEntryId ?? "", a.toVersion] as const)),
    agentName: notes?.agentName ?? "Agent",
    live,
  };

  const drafts = new Map<string, Draft>();
  for (const item of projection.items) {
    if (item.message.id.startsWith(PREFIX_SKIPPED)) continue;
    const draft = nodeOfItem(item, ctx);
    const empty = item.message.id.startsWith(PREFIX_EMPTY);
    const marker = empty ? ctx.byId.get(item.message.id.slice(PREFIX_EMPTY.length)) : undefined;
    drafts.set(draft.id, marker ? ghostNode(marker, draft.parentId, ctx) : draft);
  }
  const promptShown = live?.prompt !== undefined && !live.run.promptCommitted;
  const skip = (e: ThreadEntry) =>
    promptShown && (e.entryId === head || e.parentId === live?.prompt?.parentEntryId);
  const ghosts = new Map<string, string>();
  for (const marker of ghostEntries(tree, parsed, skip)) {
    const id = `${PREFIX_EMPTY}${marker.entryId}`;
    ghosts.set(marker.entryId, id);
    if (drafts.has(id)) continue;
    const parent = marker.parentId === null ? null : (nodeOfEntry.get(marker.parentId) ?? null);
    drafts.set(id, ghostNode(marker, parent, ctx));
  }

  const nodeOf = (entryId: string) => ghosts.get(entryId) ?? nodeOfEntry.get(entryId);
  const extras = new Map<string, Partial<Pick<TreeNode, "compacted" | "summary" | "label">>>();
  const add = (id: string | undefined, extra: Partial<Pick<TreeNode, "compacted" | "summary">>) => {
    if (id !== undefined) extras.set(id, { ...extras.get(id), ...extra });
  };
  for (const e of tree) {
    if (e.type === "compaction") add(nodeOfEntry.get(e.entryId), { compacted: true });
    if (e.type === "branch_summary")
      add(nodeOfEntry.get(e.entryId), { summary: { entryId: e.entryId } });
  }
  for (const { entry_id, label } of notes?.labels ?? []) {
    const id = nodeOf(entry_id);
    if (id === undefined) continue;
    const exact = id === entry_id || id === `${PREFIX_EMPTY}${entry_id}`;
    if (exact || extras.get(id)?.label === undefined) extras.set(id, { ...extras.get(id), label });
  }

  const committed = projection.items.flatMap((i) =>
    drafts.get(i.message.id)?.pending === true ? [] : [i.message.id],
  );
  const headGhost = head === null ? undefined : ghosts.get(head);
  const headPending = projection.headId !== null && drafts.get(projection.headId)?.pending === true;
  const headId = headGhost !== undefined && !headPending ? headGhost : projection.headId;
  const leafId =
    leaf === null
      ? null
      : (nodeOf(leaf) ?? (loaded.has(leaf) ? (newestBelow(leaf, tree, committed) ?? null) : null));
  const parentOf = new Map([...drafts.values()].map((d) => [d.id, d.parentId] as const));
  const onScreen = pathUp(headId, parentOf);
  const nodes = [...drafts.values()]
    .map((d): TreeNode => ({
      ...d,
      ...extras.get(d.id),
      onScreen: onScreen.has(d.id),
      isLeaf: d.id === leafId,
    }))
    .sort((a, b) => a.seq - b.seq);
  return { nodes, headId, leafId, nodeOfEntry };
}

/**
 * The thread's branches (CT12): entries with more than one child, the root's hidden settings
 * entry counting (two first messages are one junction). Server-written entries that never enter
 * the tree do not count: skipped-actions reports (`ks-`) and app cards (`ka-`); an unsent prompt
 * (`ku-`) is a real branch. The server's hover card counts the same way.
 */
export function junctionCount(entries: readonly ThreadEntry[]): number {
  const kids = new Map<string, number>();
  for (const e of entries) {
    if (e.parentId === null || isSkippedSummary(e) || isAppCardEntry(e)) continue;
    kids.set(e.parentId, (kids.get(e.parentId) ?? 0) + 1);
  }
  let count = 0;
  for (const n of kids.values()) if (n > 1) count += 1;
  return count;
}
