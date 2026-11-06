/**
 * The local head (CT3, KOBE-544): which branch of the entry tree this tab shows, apart from the
 * thread's leaf (the branch Pi continues on). Pure rules over the state and the entries; the
 * controller moves the head, the runtime projects from it (`projectThread(entries, head)`).
 */
import { messageContextTokens } from "./context-usage";
import { currentRunId, type ThreadState } from "./thread-state";
import { descendantsOf } from "./tree";
import type { ThreadEntry } from "./types";

/** The entry the conversation on screen ends at: the browsed one, else the leaf. */
export function headOf(state: ThreadState): string | null {
  return state.head ?? state.summary?.leafEntryId ?? null;
}

/** This tab shows a branch other than the leaf's (the bar is up). */
export function isBrowsing(state: ThreadState): boolean {
  return state.head !== undefined && state.head !== (state.summary?.leafEntryId ?? null);
}

/**
 * The parent the run on screen continues from (the sending overlay, or the active run's prompt);
 * undefined when nothing runs or the message only waits in the queue.
 */
function runParent(state: ThreadState): string | null | undefined {
  const sending = state.sending;
  if (sending && !sending.queues) return sending.parentEntryId;
  const live = state.live;
  if (live?.started === true && currentRunId(state) === live.runId) {
    return state.livePrompt?.parentEntryId;
  }
  return undefined;
}

/**
 * The head follows the leaf again once the leaf is at or below it (Make it current, a send's
 * commit, another tab's move), or once a run continues from the head (a send from the browsed
 * branch starts: the leaf is moving down it). A queued send leaves the head where it is.
 */
export function settleHead(state: ThreadState): ThreadState {
  const head = state.head;
  if (head === undefined) return state;
  const leaf = state.summary?.leafEntryId ?? null;
  const reached =
    head === leaf ||
    runParent(state) === head ||
    (leaf !== null && pathOf(state.entries, leaf).has(head));
  return reached ? { ...state, head: undefined } : state;
}

function parents(entries: readonly ThreadEntry[]): ReadonlyMap<string, string | null> {
  return new Map(entries.map((e) => [e.entryId, e.parentId] as const));
}

/** The entries from `entryId` up to the root (empty when it is not loaded). */
export function pathOf(entries: readonly ThreadEntry[], entryId: string | null): Set<string> {
  const up = parents(entries);
  const path = new Set<string>();
  for (let at = entryId; at !== null && up.has(at) && !path.has(at); at = up.get(at) ?? null) {
    path.add(at);
  }
  return path;
}

/** `entryId` is on the leaf's branch (the leaf or above it). */
export function onBranchOf(
  entries: readonly ThreadEntry[],
  leafEntryId: string | null,
  entryId: string,
): boolean {
  return pathOf(entries, leafEntryId).has(entryId);
}

/**
 * Make it current and carry a summary applies (KOBE-548, CT11): the head is on another branch than
 * the leaf's, not on the leaf's own path (an ancestor has no other branch to summarize).
 */
export function carryOffered(
  entries: readonly ThreadEntry[],
  leafEntryId: string | null,
  head: string | null,
): boolean {
  return head !== null && leafEntryId !== null && !onBranchOf(entries, leafEntryId, head);
}

/**
 * The newest leaf at or below `entryId` (the branch a tree click or a search hit opens, CT4/CT15);
 * undefined when the entry is not loaded.
 */
export function branchLeafOf(entries: readonly ThreadEntry[], entryId: string): string | undefined {
  if (!entries.some((e) => e.entryId === entryId)) return undefined;
  const below = descendantsOf(entryId, entries);
  const parentsBelow = new Set(entries.flatMap((e) => (e.parentId === null ? [] : [e.parentId])));
  let newest: ThreadEntry | undefined;
  for (const e of entries) {
    if (!below.has(e.entryId) || parentsBelow.has(e.entryId)) continue;
    if (newest === undefined || e.seq > newest.seq) newest = e;
  }
  return newest?.entryId ?? entryId;
}

/** "N messages differ": messages on the head's branch that the leaf's branch does not have. */
export function messagesDiffer(
  entries: readonly ThreadEntry[],
  nodeOfEntry: ReadonlyMap<string, string>,
  head: string | null,
  leaf: string | null,
): number {
  const onLeaf = pathOf(entries, leaf);
  const shared = new Set([...onLeaf].flatMap((id) => nodeOfEntry.get(id) ?? []));
  const differ = new Set<string>();
  for (const id of pathOf(entries, head)) {
    const node = nodeOfEntry.get(id);
    if (!onLeaf.has(id) && node !== undefined && !shared.has(node)) differ.add(node);
  }
  return differ.size;
}

/**
 * The prompt size of the newest model call on the head's branch (the gauge's estimate, CT16):
 * null after a compaction on that branch (unknown until the next call), undefined before any call.
 */
export function branchContextTokens(
  entries: readonly ThreadEntry[],
  head: string | null,
): number | null | undefined {
  const byId = new Map(entries.map((e) => [e.entryId, e] as const));
  const seen = new Set<string>();
  for (let at = head; at !== null && !seen.has(at);) {
    seen.add(at);
    const e = byId.get(at);
    if (!e) return undefined;
    if (e.type === "compaction") return null;
    const tokens = e.type === "message" ? messageContextTokens(e.payload) : undefined;
    if (tokens !== undefined) return tokens;
    at = e.parentId;
  }
  return undefined;
}
