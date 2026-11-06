/**
 * The Conversation tree panel's pure half (CT4, CT6, CT8, CT9, CT18; KOBE-546): its fixed texts,
 * the header counts, a row's badges and accessible name, the filter, the node menu, the keyboard
 * moves between rows and siblings, the narrow list grouped by junction and the label rules. The
 * drawing (`components/chat/conversation-tree.tsx`) reads the nodes of `projectTree` and the rows
 * of `tree-layout.ts`.
 */
import { BRANCH_LABEL_MAX_CHARS, branchLabelSchema } from "@kobe/protocol";
import { messageMeta, type KobeMessageMeta, type Projection } from "./tree";
import type { TreeBadges } from "./tree-badges";
import { TOOLS_ONLY_EXCERPT, type TreeNode, type TreeProjection } from "./tree-nodes";

/** CT4 "Empty": a straight thread still opens the view. */
export const EMPTY_TREE_NOTE =
  "No branches yet. Edit a message or choose Continue from here on an answer to start one.";
/** CT6: memories and rules never branch. */
export const TREE_HELP_TEXT = "Memories and approval rules written on a branch stay in force.";
/** CT6: the Make-it-current confirmation when the branch being left changed files. */
export const FILES_LEFT_NOTE =
  "Files changed on the branch you are leaving stay changed; the workspace is shared by every branch.";
/** CT5: a ghost node's text. */
export const GHOST_TEXT = "no answer (run interrupted)";
/** CT11: a folded branch summary's row. */
export const SUMMARY_TEXT = "○ summary carried";
export const COMPACTED_TEXT = "compacted above";
export const LABEL_SAVED = "Label saved";
export const LABEL_REMOVED = "Label removed";

/** The narrow list's breakpoint (CT18): the panels' full-screen sheet under 820 px. */
export const TREE_NARROW_QUERY = "(max-width: 819.98px)";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "N branches · M forks" (branches = junctions, CT12; forks = the lineage's forks). */
export function headerCounts(branches: number, forks: number): string {
  return `${plural(branches, "branch", "branches")} · ${plural(forks, "fork", "forks")}`;
}

export interface BadgeText {
  readonly kind: "files" | "memories" | "rule";
  /** What the row shows ("📄 2 files"). */
  readonly shown: string;
  /** Its words in the accessible name ("2 files changed"). */
  readonly spoken: string;
}

/** A node's badges as shown and spoken (CT6). */
export function badgeTexts(badges: TreeBadges): readonly BadgeText[] {
  const out: BadgeText[] = [];
  if (badges.files !== undefined && badges.files > 0) {
    const files = plural(badges.files, "file", "files");
    out.push({ kind: "files", shown: `📄 ${files}`, spoken: `${files} changed` });
  }
  if (badges.memories !== undefined && badges.memories > 0) {
    const memories = plural(badges.memories, "memory", "memories");
    out.push({ kind: "memories", shown: `🧠 ${memories}`, spoken: `${memories} written` });
  }
  if (badges.rule === true) {
    out.push({ kind: "rule", shown: "🔏 rule", spoken: "approval rule remembered" });
  }
  return out;
}

/** The node's text in the tree: its excerpt, or what a ghost or a tool-only turn says. */
export function nodeText(node: TreeNode): string {
  return node.empty === true ? GHOST_TEXT : node.excerpt;
}

/** "12:04" in the viewer's locale. */
export function nodeTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A row's accessible name (CT4): "<role>, <excerpt>, <time>, <label>, <badges>". */
export function nodeName(node: TreeNode, time = nodeTime(node.at)): string {
  const role = node.role === "user" ? "You" : "Agent";
  const parts = [
    role,
    nodeText(node),
    time,
    node.label ?? "",
    ...badgeTexts(node.badges).map((b) => b.spoken),
  ];
  return parts.filter((p) => p !== "").join(", ");
}

/** The filter (CT4): every word in the node's text or label; an empty filter matches all. */
export function matchesFilter(node: TreeNode, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${nodeText(node)} ${node.label ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Each node's siblings (its parent's children, by seq), itself included. */
export function siblingsOf(nodes: readonly TreeNode[]): ReadonlyMap<string, readonly string[]> {
  const kids = new Map<string | null, string[]>();
  for (const n of nodes) {
    if (n.pending === true) continue;
    const list = kids.get(n.parentId) ?? [];
    list.push(n.id);
    kids.set(n.parentId, list);
  }
  const out = new Map<string, readonly string[]>();
  for (const list of kids.values()) for (const id of list) out.set(id, list);
  return out;
}

/**
 * Continue from here (CT8) is offered on an answer that is committed, not live, and not the
 * leaf's own last answer (there is nothing to branch from there).
 */
export function isContinuable(node: TreeNode, tree: Pick<TreeProjection, "leafId">): boolean {
  return (
    node.role === "assistant" &&
    node.empty !== true &&
    node.live !== true &&
    node.pending !== true &&
    node.id !== tree.leafId
  );
}

export type TreeMenuItem =
  | "show"
  | "make-current"
  | "continue"
  | "edit"
  | "retry"
  | "label"
  | "remove-label"
  | "compare"
  | "carry-summary"
  | "fork"
  | "copy";

export const TREE_MENU_NAMES: Readonly<Record<TreeMenuItem, string>> = {
  show: "Show in conversation",
  "make-current": "Make it current",
  continue: "Continue from here",
  edit: "Edit this message",
  retry: "Retry",
  label: "Label…",
  "remove-label": "Remove label",
  compare: "Compare with…",
  "carry-summary": "Make it current and carry a summary",
  fork: "Fork a new thread here",
  copy: "Copy text",
};

export interface TreeMenuContext {
  /** The viewer owns the thread (a reader browses only). */
  readonly owner: boolean;
  /** Builder test, Workbench, eval (CT19): no labels, no summaries. */
  readonly testThread: boolean;
  /** The thread is in Trash: nothing is written. */
  readonly inTrash: boolean;
  /** The node is off the leaf's branch (Make it current moves the leaf there). */
  readonly offLeafBranch: boolean;
  readonly hasSiblings: boolean;
  /** The message's own Edit is offered (a branch point above it, no run on). */
  readonly canEdit: boolean;
  /** An interrupted run waits for Retry on this ghost. */
  readonly canRetry: boolean;
  /** Fork to a new thread is possible at this node. */
  readonly forkable: boolean;
  /** Compare versions (KOBE-547) has shipped. */
  readonly compare?: boolean;
  /** Make it current and carry a summary (KOBE-548) has shipped. */
  readonly carrySummary?: boolean;
}

/** The node menu (CT4), in the spec's order; only what applies to this node and viewer. */
export function treeMenu(
  node: TreeNode,
  tree: Pick<TreeProjection, "leafId">,
  ctx: TreeMenuContext,
): readonly TreeMenuItem[] {
  const writable = ctx.owner && !ctx.inTrash;
  const committed = node.pending !== true && node.live !== true;
  const items: (TreeMenuItem | false)[] = [
    "show",
    writable && ctx.offLeafBranch && committed && "make-current",
    writable && isContinuable(node, tree) && "continue",
    writable && node.role === "user" && ctx.canEdit && "edit",
    writable && node.empty === true && ctx.canRetry && "retry",
    writable && !ctx.testThread && committed && "label",
    writable && !ctx.testThread && committed && node.label !== undefined && "remove-label",
    ctx.compare === true && ctx.hasSiblings && "compare",
    ctx.carrySummary === true &&
      writable &&
      !ctx.testThread &&
      ctx.offLeafBranch &&
      "carry-summary",
    ctx.forkable && !ctx.testThread && "fork",
    node.empty !== true && node.excerpt !== "" && node.excerpt !== TOOLS_ONLY_EXCERPT && "copy",
  ];
  return items.filter((i): i is TreeMenuItem => i !== false);
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * The row a key moves to (CT4): ↑/↓ the rows in order, ←/→ the previous or next sibling at a
 * branch point, Home the root (the first row), End the leaf's row (else the last row).
 */
export function moveFocus(
  rows: readonly string[],
  current: string | undefined,
  key: TreeKey,
  siblings: ReadonlyMap<string, readonly string[]>,
  leafId: string | null,
): string | undefined {
  if (rows.length === 0) return undefined;
  const at = current === undefined ? -1 : rows.indexOf(current);
  switch (key) {
    case "ArrowUp":
      return rows[Math.max(0, at - 1)];
    case "ArrowDown":
      return rows[Math.min(rows.length - 1, at + 1)];
    case "Home":
      return rows[0];
    case "End":
      return leafId !== null && rows.includes(leafId) ? leafId : rows.at(-1);
    case "ArrowLeft":
    case "ArrowRight": {
      if (current === undefined) return rows[0];
      const list = siblings.get(current) ?? [current];
      const i = list.indexOf(current) + (key === "ArrowLeft" ? -1 : 1);
      return list[Math.min(list.length - 1, Math.max(0, i))];
    }
  }
}

export interface JunctionBranch {
  /** The branch's first node (a row opens the branch from it). */
  readonly node: TreeNode;
  readonly onScreen: boolean;
  readonly isLeaf: boolean;
  /** The branch's badges, summed over its nodes. */
  readonly badges: TreeBadges;
}

export interface JunctionGroup {
  /** The node the branches hang off; null: the conversation's start (two first messages). */
  readonly parent: TreeNode | null;
  readonly branches: readonly JunctionBranch[];
}

function sumBadges(nodes: readonly TreeNode[]): TreeBadges {
  let files = 0;
  let memories = 0;
  let rule = false;
  for (const n of nodes) {
    files += n.badges.files ?? 0;
    memories += n.badges.memories ?? 0;
    rule ||= n.badges.rule === true;
  }
  return {
    ...(files > 0 ? { files } : {}),
    ...(memories > 0 ? { memories } : {}),
    ...(rule ? { rule: true as const } : {}),
  };
}

/**
 * The narrow list (CT18): one section per junction (a node with more than one child), headed by
 * the node above it, in row order; its branches as rows with the chips of everything below them.
 */
export function junctionGroups(tree: Pick<TreeProjection, "nodes">): readonly JunctionGroup[] {
  const nodes = tree.nodes.filter((n) => n.pending !== true);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const kids = new Map<string | null, TreeNode[]>();
  for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const below = (start: TreeNode): TreeNode[] => {
    const out: TreeNode[] = [];
    for (let stack = [start]; stack.length > 0;) {
      const n = stack.pop() as TreeNode;
      out.push(n);
      stack.push(...(kids.get(n.id) ?? []));
    }
    return out;
  };
  const groups: JunctionGroup[] = [];
  const parents = [null, ...nodes.map((n) => n.id)];
  for (const parentId of parents) {
    const children = kids.get(parentId) ?? [];
    if (children.length < 2) continue;
    groups.push({
      parent: parentId === null ? null : (byId.get(parentId) ?? null),
      branches: children.map((child) => {
        const all = below(child);
        return {
          node: child,
          onScreen: child.onScreen,
          isLeaf: all.some((n) => n.isLeaf),
          badges: sumBadges(all),
        };
      }),
    });
  }
  return groups;
}

export type LabelCheck =
  { readonly ok: true; readonly label: string } | { readonly ok: false; readonly message: string };

export const LABEL_EMPTY = "Type a label, or choose Remove label.";
export const LABEL_TOO_LONG = `A label is at most ${BRANCH_LABEL_MAX_CHARS} characters.`;
export const LABEL_BAD_CHARS = "A label is one line of plain text.";

/** The label rules (CT9, Q30): trimmed, 1–60 characters, one line, the folder-name characters. */
export function checkLabel(text: string): LabelCheck {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: LABEL_EMPTY };
  if ([...trimmed].length > BRANCH_LABEL_MAX_CHARS) return { ok: false, message: LABEL_TOO_LONG };
  const parsed = branchLabelSchema.safeParse(trimmed);
  return parsed.success
    ? { ok: true, label: parsed.data }
    : { ok: false, message: LABEL_BAD_CHARS };
}

const LABEL_ERRORS: Readonly<Record<string, string>> = {
  entry_not_found: "That message is not in this conversation any more.",
  label_limit: "This conversation has as many labels as it can hold. Remove one first.",
  thread_in_trash: "This conversation is in Trash. Restore it to label it.",
  test_thread: "Test conversations can't be labelled.",
  forbidden: "Only the conversation's owner can label it.",
  rate_limited: "Too many label changes. Try again in a few minutes.",
  thread_not_found: "This conversation is gone.",
  invalid_request: LABEL_BAD_CHARS,
};

/** The server's label refusals as fixed messages (CT9); anything else is a generic one. */
export function labelErrorMessage(code: string): string {
  return LABEL_ERRORS[code] ?? "The label could not be saved. Try again.";
}

const GHOST_PREFIX = "empty:";

/** A node's first and last entries (label key; head, fork and continue point), from the chat's projection. */
export function nodeEntries(
  projection: Pick<Projection, "items" | "lastEntryOfNode">,
  nodeId: string,
): { readonly first?: string; readonly last?: string; readonly meta?: KobeMessageMeta } {
  if (nodeId.startsWith(GHOST_PREFIX)) {
    const marker = nodeId.slice(GHOST_PREFIX.length);
    return { first: marker, last: marker };
  }
  const item = projection.items.find((i) => i.message.id === nodeId);
  const meta = item ? messageMeta(item.message) : undefined;
  const first =
    meta?.kind === "user"
      ? meta.entryId
      : meta?.kind === "assistant"
        ? meta.entryIds[0]
        : undefined;
  const last = projection.lastEntryOfNode.get(nodeId);
  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    ...(meta === undefined ? {} : { meta }),
  };
}

export function nodePath(nodes: readonly TreeNode[], id: string | null): Set<string> {
  const parent = new Map(nodes.map((n) => [n.id, n.parentId] as const));
  const path = new Set<string>();
  for (let at = id; at !== null && !path.has(at); at = parent.get(at) ?? null) path.add(at);
  return path;
}

/**
 * CT6: the branch being left (the leaf's, below where it meets `target`'s path) changed files, so
 * Make it current says the workspace stays as it is.
 */
export function filesLeftBehind(
  tree: Pick<TreeProjection, "nodes" | "leafId">,
  target: string | null,
): boolean {
  const kept = nodePath(tree.nodes, target);
  const left = nodePath(tree.nodes, tree.leafId);
  return tree.nodes.some((n) => left.has(n.id) && !kept.has(n.id) && (n.badges.files ?? 0) > 0);
}

/**
 * Continue from here (CT8): the messages on screen after the answer holding `entryId`, dimmed in
 * place until the send (or Escape). Empty when the answer is not on screen.
 */
export function laterOnScreen(
  projection: Pick<Projection, "items" | "headId" | "nodeOfEntry">,
  entryId: string | undefined,
): ReadonlySet<string> {
  const from = entryId === undefined ? undefined : projection.nodeOfEntry.get(entryId);
  if (from === undefined) return EMPTY_SET;
  const parent = new Map(projection.items.map((i) => [i.message.id, i.parentId] as const));
  const later: string[] = [];
  for (let at: string | null = projection.headId; at !== null; at = parent.get(at) ?? null) {
    if (at === from) return new Set(later);
    later.push(at);
    if (later.length > parent.size) break;
  }
  return EMPTY_SET;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** The answer's excerpt in the composer's branch chip (CT8). */
export const CHIP_EXCERPT_MAX = 60;

export function chipExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= CHIP_EXCERPT_MAX ? flat : `${flat.slice(0, CHIP_EXCERPT_MAX - 1)}…`;
}
