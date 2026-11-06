/**
 * The thread's own forks in the Conversation tree (CT4 "Forks", KOBE-545): the lineage read (TL1)
 * lists the readable forks; each is drawn as a dashed leaf row off the node it forked from, found
 * through projectThread's `nodeOfEntry`, so a fork point on an inactive branch is drawn there.
 * Ancestors are not drawn (the lineage strip shows them).
 */

/** A fork as the lineage lists it; `forked_at_entry_id` places it (absent: not placed). */
export interface ForkSource {
  readonly thread_id: string;
  readonly title: string | null;
  readonly forked_at_entry_id?: string | null | undefined;
}

export interface TreeFork {
  /** The row id: `fork:<thread id>`. */
  readonly id: string;
  readonly threadId: string;
  /** Null: untitled (the panel says "Untitled conversation"). */
  readonly title: string | null;
  /** The node it hangs off. */
  readonly nodeId: string;
}

export const FORK_ROW_PREFIX = "fork:";

/** Forks placed on their node, and how many could not be (fork point unknown or not loaded). */
export function treeForks(
  forks: readonly ForkSource[],
  nodeOfEntry: ReadonlyMap<string, string>,
): { readonly placed: readonly TreeFork[]; readonly unplaced: number } {
  const placed: TreeFork[] = [];
  for (const fork of forks) {
    const at = fork.forked_at_entry_id;
    const nodeId = at === undefined || at === null ? undefined : nodeOfEntry.get(at);
    if (nodeId === undefined) continue;
    placed.push({
      id: `${FORK_ROW_PREFIX}${fork.thread_id}`,
      threadId: fork.thread_id,
      title: fork.title,
      nodeId,
    });
  }
  return { placed, unplaced: forks.length - placed.length };
}
