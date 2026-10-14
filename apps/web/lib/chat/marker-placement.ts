/**
 * Where entry markers (KOBE-209) go in the tree projection (`tree.ts`). A marker is placed in the
 * message (node) around its entry: inside a turn after the entries before it, or after the
 * message. Below a fork or the root it belongs to one branch only, so it is carried down to the
 * first message under it (`before`); a branch that ends in system entries (a model change, then a
 * run interrupted before Pi wrote anything) leaves its markers "dangling" on the nearest message
 * above, shown only while the leaf is on that branch.
 */
import type { EntryMarker } from "./markers";
import type { ThreadEntry } from "./types";

/** A marker after a node's first `at` listed entries; `entry` is its source (deps). */
export interface PlacedMarker {
  readonly at: number;
  readonly marker: EntryMarker;
  readonly entry: ThreadEntry;
}

/** Markers carried towards the first node below a fork or the root; null elsewhere. */
export type Carry = readonly PlacedMarker[] | null;

interface Dangling {
  readonly markers: readonly PlacedMarker[];
  /** The entries of the branch's tail: the leaf on any of them shows the markers. */
  readonly ends: ReadonlySet<string>;
}

export interface MarkerBook {
  readonly before: ReadonlyMap<string, readonly PlacedMarker[]>;
  readonly inside: ReadonlyMap<string, readonly PlacedMarker[]>;
  readonly dangling: ReadonlyMap<string, readonly Dangling[]>;
}

const append = <T>(map: Map<string, readonly T[]>, key: string, item: T) =>
  map.set(key, [...(map.get(key) ?? []), item]);

/** Collects placements while the nodes are built; `book()` is the result. */
export function markerPlacer() {
  const before = new Map<string, readonly PlacedMarker[]>();
  const inside = new Map<string, readonly PlacedMarker[]>();
  const dangling = new Map<string, readonly Dangling[]>();
  return {
    /** A node was created: the markers carried to it show above it. */
    created(nodeId: string, carry: Carry) {
      if (carry && carry.length > 0) before.set(nodeId, carry);
    },
    /**
     * A system entry in node `ctx` (null: above every node) that holds `listed` entries so far.
     * Returns what its children carry.
     */
    hidden(args: {
      readonly entry: ThreadEntry;
      readonly marker: EntryMarker | undefined;
      readonly ctx: string | null;
      readonly listed: number;
      readonly carry: Carry;
      readonly kids: number;
    }): Carry {
      const { entry, marker, ctx, listed, carry, kids } = args;
      const placed = marker ? { at: listed, marker, entry } : undefined;
      if (carry === null) {
        if (placed && ctx !== null) append(inside, ctx, placed);
        return null;
      }
      const next = placed ? [...carry, placed] : carry;
      if (kids === 0 && next.length > 0 && ctx !== null) {
        const ends = new Set([entry.entryId, ...next.map((m) => m.entry.entryId)]);
        append(dangling, ctx, { markers: next, ends });
      }
      return next;
    },
    book(): MarkerBook {
      return { before, inside, dangling };
    },
  };
}

/** What a child of an entry carries: every branch of a fork starts carrying. */
export function childCarry(carry: Carry, kids: number): Carry {
  return kids > 1 ? (carry ?? []) : carry;
}

const markersOf = (placed: readonly PlacedMarker[]) => placed.map((m) => m.marker);

/**
 * A node's markers by place, and what they were built from (deps). `listed` is how many entries
 * the node lists; a user node shows every marker in it after the message.
 */
export function nodeMarkers(
  book: MarkerBook,
  node: { readonly id: string; readonly role: "user" | "assistant"; readonly listed: number },
  leafEntryId: string | null,
) {
  const carried = book.before.get(node.id) ?? [];
  const inside = book.inside.get(node.id) ?? [];
  const tails = (book.dangling.get(node.id) ?? []).filter(
    (d) => leafEntryId !== null && d.ends.has(leafEntryId),
  );
  const trailing = [
    ...inside.filter((m) => node.role === "user" || m.at >= node.listed),
    ...tails.flatMap((d) => d.markers),
  ];
  const before = markersOf(carried);
  const after = markersOf(trailing);
  return {
    ...(before.length > 0 ? { before } : {}),
    ...(after.length > 0 ? { after } : {}),
    deps: [...carried, ...inside, ...tails.flatMap((d) => d.markers)].flatMap((m) => [
      m.entry,
      m.marker.kind === "compaction" ? m.marker.folded : undefined,
    ]),
  };
}

/** The markers inside an assistant turn right after its `index`-th listed entry. */
export function innerMarkers(
  book: MarkerBook,
  nodeId: string,
  index: number,
  listed: number,
): readonly EntryMarker[] {
  return markersOf(
    (book.inside.get(nodeId) ?? []).filter((m) => m.at === index + 1 && m.at < listed),
  );
}
