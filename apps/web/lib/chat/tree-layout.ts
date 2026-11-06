/**
 * The Conversation tree's git-graph layout (CT4 "Lanes", KOBE-545): pure, no library. One row per
 * node, ordered by its first entry's seq (a branch made later sits below one made earlier, as a git
 * log does); a fork of the thread is a leaf row right under its node. Lanes are a depth-first walk
 * with a free-lane list: the path to the head takes lane 1; every other branch takes the lowest
 * lane free over its rows (from its branch point to its last node), newest sibling first, and frees
 * it after its last node. Past {@link TREE_MAX_LANES} a branch is drawn in the last lane, dotted.
 * The panel draws `<svg>` lines from (parentLane, parentRow) to (lane, row).
 *
 * Performance (CT4): {@link createTreeLayout} lays out the committed nodes once per committed node
 * set; the live run's pending nodes are appended to that layout, never relaid.
 */
import type { TreeFork } from "./tree-forks";
import type { TreeNode, TreeProjection } from "./tree-nodes";
import type { ThreadEntry } from "./types";

export const TREE_MAX_LANES = 8;

export type LayoutNode = Pick<TreeNode, "id" | "parentId" | "seq" | "onScreen"> & {
  readonly pending?: true | undefined;
};

export interface TreeRow {
  readonly id: string;
  readonly kind: "node" | "fork";
  /** 0-based, top to bottom. */
  readonly row: number;
  /** 1-based; 1 is the head's path. */
  readonly lane: number;
  /** Where the connector starts; null for a root (it hangs off the hidden root). */
  readonly parentRow: number | null;
  readonly parentLane: number | null;
  /** The branch did not get a lane of its own: drawn in the last lane with a dotted link. */
  readonly dotted: boolean;
}

export interface TreeLayout {
  readonly rows: readonly TreeRow[];
  readonly byId: ReadonlyMap<string, TreeRow>;
  /** Lanes in use (the SVG's width). */
  readonly lanes: number;
}

interface Item {
  readonly id: string;
  readonly kind: TreeRow["kind"];
  readonly parentId: string | null;
  readonly seq: number;
  readonly onScreen: boolean;
}

/** Rows by seq; a fork right under its node. */
function ordered(nodes: readonly LayoutNode[], forks: readonly TreeFork[]): Item[] {
  const seqOf = new Map(nodes.map((n) => [n.id, n.seq] as const));
  const keyed = [
    ...nodes.map((n) => ({
      item: {
        id: n.id,
        kind: "node" as const,
        parentId: n.parentId,
        seq: n.seq,
        onScreen: n.onScreen,
      },
      key: [n.seq, 0, 0] as const,
    })),
    ...forks.flatMap((f, i) => {
      const seq = seqOf.get(f.nodeId);
      if (seq === undefined) return [];
      const item = { id: f.id, kind: "fork" as const, parentId: f.nodeId, seq, onScreen: false };
      return [{ item, key: [seq, 1, i] as const }];
    }),
  ];
  keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return keyed.map((k) => k.item);
}

/** Lane occupancy: closed row intervals per lane (index = lane). */
class FreeLanes {
  readonly #taken: [number, number][][] = Array.from({ length: TREE_MAX_LANES + 1 }, () => []);

  take(lane: number, from: number, to: number): void {
    this.#taken[lane]?.push([from, to]);
  }

  /** The lowest free lane from 2 over [from, to], or null when every lane is taken there. */
  free(from: number, to: number): number | null {
    for (let lane = 2; lane <= TREE_MAX_LANES; lane++) {
      const busy = this.#taken[lane]?.some(([a, b]) => a <= to && from <= b);
      if (!busy) return lane;
    }
    return null;
  }
}

/** The layout of the committed nodes (pending ones are left out) and the forks. */
export function layoutTree(
  nodes: readonly LayoutNode[],
  forks: readonly TreeFork[] = [],
): TreeLayout {
  const items = ordered(
    nodes.filter((n) => n.pending !== true),
    forks,
  );
  const graph = graphOf(items);
  const laneOf = assignLanes(graph);
  const rows = items.map((item, row): TreeRow => {
    const { lane, dotted } = laneOf.get(item.id) ?? { lane: TREE_MAX_LANES, dotted: true };
    const parentRow = item.parentId === null ? undefined : graph.rowOf.get(item.parentId);
    const parent = parentRow === undefined ? undefined : laneOf.get(item.parentId as string);
    return {
      id: item.id,
      kind: item.kind,
      row,
      lane,
      parentRow: parentRow ?? null,
      parentLane: parent?.lane ?? null,
      dotted,
    };
  });
  return withIndex(rows);
}

interface Graph {
  readonly rowOf: ReadonlyMap<string, number>;
  readonly children: ReadonlyMap<string | null, readonly Item[]>;
}

/** Row indices and children lists (a parent not laid out counts as the root). */
function graphOf(items: readonly Item[]): Graph {
  const rowOf = new Map(items.map((item, i) => [item.id, i] as const));
  const children = new Map<string | null, Item[]>();
  for (const item of items) {
    const key = item.parentId !== null && rowOf.has(item.parentId) ? item.parentId : null;
    const list = children.get(key);
    if (list) list.push(item);
    else children.set(key, [item]);
  }
  return { rowOf, children };
}

/** A node and the children that continue its lane: the path's on the path, else the oldest. */
function chainOf(graph: Graph, start: Item): Item[] {
  const continuing = (item: Item): Item | undefined => {
    const kids = (graph.children.get(item.id) ?? []).filter((k) => k.kind === "node");
    return item.onScreen ? kids.find((k) => k.onScreen) : kids[0];
  };
  const chain = [start];
  for (let next = continuing(start); next !== undefined; next = continuing(next)) chain.push(next);
  return chain;
}

/** The branches off a chain, top-down, newest sibling first at each node. */
function branchesOf(graph: Graph, chain: readonly Item[]): Item[] {
  const inChain = new Set(chain.map((c) => c.id));
  return chain.flatMap((c) =>
    (graph.children.get(c.id) ?? []).filter((k) => !inChain.has(k.id)).reverse(),
  );
}

/** The depth-first lane walk: lane 1 for root → head, the lowest free lane for every branch. */
function assignLanes(graph: Graph): ReadonlyMap<string, { lane: number; dotted: boolean }> {
  const lastRow = (chain: readonly Item[]) => graph.rowOf.get(chain.at(-1)?.id ?? "") ?? 0;
  const roots = graph.children.get(null) ?? [];
  const main = roots.find((r) => r.onScreen) ?? roots[0];
  const laneOf = new Map<string, { lane: number; dotted: boolean }>();
  const lanes = new FreeLanes();
  // Chains still to place, top of the stack first: other roots (newest first), then lane 1's
  // branches top-down, each branch's own branches before its next sibling (depth-first).
  const stack: Item[] = [];
  const place = (chain: readonly Item[], lane: number, dotted: boolean) => {
    for (const c of chain) laneOf.set(c.id, { lane, dotted });
    stack.push(...branchesOf(graph, chain).reverse());
  };
  if (main !== undefined) {
    const chain = chainOf(graph, main);
    lanes.take(1, 0, lastRow(chain));
    place(chain, 1, false);
    stack.push(...roots.filter((r) => r !== main));
  }
  for (let start = stack.pop(); start !== undefined; start = stack.pop()) {
    const chain = chainOf(graph, start);
    const parentRow = start.parentId === null ? undefined : graph.rowOf.get(start.parentId);
    const from = parentRow ?? graph.rowOf.get(start.id) ?? 0;
    const to = lastRow(chain);
    const lane = lanes.free(from, to);
    if (lane !== null) lanes.take(lane, from, to);
    place(chain, lane ?? TREE_MAX_LANES, lane === null);
  }
  return laneOf;
}

function withIndex(rows: readonly TreeRow[]): TreeLayout {
  return {
    rows,
    byId: new Map(rows.map((r) => [r.id, r] as const)),
    lanes: rows.reduce((max, r) => Math.max(max, r.lane), 0),
  };
}

/**
 * The live run's nodes below a committed layout, without relaying it: each continues its parent's
 * lane when the parent is that lane's last row, else takes the next lane (dotted past the cap).
 */
export function appendPending(base: TreeLayout, pending: readonly LayoutNode[]): TreeLayout {
  if (pending.length === 0) return base;
  const rows = [...base.rows];
  const byId = new Map(base.byId);
  const lastInLane = new Map<number, number>();
  for (const r of rows) lastInLane.set(r.lane, r.row);
  for (const node of pending) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    const row = rows.length;
    const keeps = parent !== undefined && lastInLane.get(parent.lane) === parent.row;
    // A new lane right of those in use; lane 1 in an empty tree (a new thread's first prompt).
    const next = lastInLane.size === 0 ? 1 : Math.max(...lastInLane.keys()) + 1;
    const lane = keeps ? parent.lane : Math.min(next, TREE_MAX_LANES);
    const r: TreeRow = {
      id: node.id,
      kind: "node",
      row,
      lane,
      parentRow: parent?.row ?? null,
      parentLane: parent?.lane ?? null,
      dotted: !keeps && next > TREE_MAX_LANES,
    };
    rows.push(r);
    byId.set(r.id, r);
    lastInLane.set(lane, row);
  }
  return { rows, byId, lanes: rows.reduce((max, r) => Math.max(max, r.lane), 0) };
}

/**
 * What a base layout depends on: the committed nodes' ids, parents and path (the entries, the
 * head, the leaf's stale answers and a ghost hidden by the live prompt all show up here).
 */
function committedKey(nodes: readonly LayoutNode[]): string {
  return nodes.map((n) => `${n.id}<${n.parentId ?? ""}${n.onScreen ? "*" : ""}`).join("\n");
}

/**
 * A memoised layout for one panel: recomputed only when the committed node set (ids, parents, the
 * path on screen) or the forks change; the live run's pending nodes are appended to the last
 * layout. `entries` and `head` are kept in the signature for callers; the key is the nodes.
 */
export function createTreeLayout(layout: typeof layoutTree = layoutTree) {
  let last: { key: string; forks: readonly TreeFork[]; base: TreeLayout } | undefined;
  const none: readonly TreeFork[] = [];
  return (
    _entries: readonly ThreadEntry[],
    _head: string | null,
    tree: TreeProjection,
    forks: readonly TreeFork[] = none,
  ): TreeLayout => {
    const committed = tree.nodes.filter((n) => n.pending !== true);
    const key = committedKey(committed);
    if (last?.key !== key || last.forks !== forks) {
      last = { key, forks, base: layout(committed, forks) };
    }
    return appendPending(
      last.base,
      tree.nodes.filter((n) => n.pending === true),
    );
  };
}
