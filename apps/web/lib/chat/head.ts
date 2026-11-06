/**
 * The local head (CT3, KOBE-544): which branch of the entry tree this tab shows, apart from the
 * thread's leaf (the branch Pi continues on). Pure rules over the state and the entries; the
 * controller moves the head, the runtime projects from it (`projectThread(entries, head)`).
 */
import { messageContextTokens } from "./context-usage";
import type { ThreadState } from "./thread-state";
import type { ThreadEntry } from "./types";

/** The entry the conversation on screen ends at: the browsed one, else the leaf. */
export function headOf(state: ThreadState): string | null {
  return state.head ?? state.summary?.leafEntryId ?? null;
}

/** This tab shows a branch other than the leaf's (the bar is up). */
export function isBrowsing(state: ThreadState): boolean {
  return state.head !== undefined && state.head !== (state.summary?.leafEntryId ?? null);
}

/** A head the leaf has reached follows the leaf again (a send, Make it current, another tab). */
export function settleHead(state: ThreadState): ThreadState {
  if (state.head === undefined || state.head !== (state.summary?.leafEntryId ?? null)) return state;
  return { ...state, head: undefined };
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
 * The newest leaf at or below `entryId` (the branch a tree click or a search hit opens, CT4/CT15);
 * undefined when the entry is not loaded.
 */
export function branchLeafOf(entries: readonly ThreadEntry[], entryId: string): string | undefined {
  if (!entries.some((e) => e.entryId === entryId)) return undefined;
  const children = new Map<string, ThreadEntry[]>();
  for (const e of entries) {
    if (e.parentId === null) continue;
    children.set(e.parentId, [...(children.get(e.parentId) ?? []), e]);
  }
  let newest: ThreadEntry | undefined;
  const seen = new Set<string>();
  const stack = [...(children.get(entryId) ?? [])];
  while (stack.length > 0) {
    const e = stack.pop() as ThreadEntry;
    if (seen.has(e.entryId)) continue;
    seen.add(e.entryId);
    const below = children.get(e.entryId) ?? [];
    if (below.length === 0 && (newest === undefined || e.seq > newest.seq)) newest = e;
    stack.push(...below);
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
