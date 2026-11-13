/**
 * The Me editor's lists of one scope (KOBE-384 review M1): pinned memories first (fetched on their
 * own, at most 10, so the count is exact), then the others page by page ("Show more" with the API's
 * cursor), and the archive once opened. A change the server confirmed is placed in the lists from
 * its answer, so rows keep their place and focus instead of reloading.
 */
import type { MemoryItem, MemoryItemList } from "./items-api";

export interface ItemPage {
  readonly items: readonly MemoryItem[];
  readonly nextCursor: string | null;
}

export interface ScopeLists {
  readonly pinned: readonly MemoryItem[];
  readonly others: ItemPage;
  /** Null until the person opens the archive. */
  readonly archived: ItemPage | null;
  readonly usage: MemoryItemList["usage"];
}

type Bucket = "pinned" | "others" | "archived";

const bucketOf = (item: MemoryItem): Bucket =>
  item.status !== "active" ? "archived" : item.pinned ? "pinned" : "others";

/** Appends a further page, dropping items already listed (a change can shift pages). */
export function appendPage(page: ItemPage, next: MemoryItemList): ItemPage {
  const seen = new Set(page.items.map((i) => i.id));
  return {
    items: [...page.items, ...next.items.filter((i) => !seen.has(i.id))],
    nextCursor: next.nextCursor,
  };
}

function find(lists: ScopeLists, id: string): { bucket: Bucket; index: number } | null {
  const buckets: [Bucket, readonly MemoryItem[]][] = [
    ["pinned", lists.pinned],
    ["others", lists.others.items],
    ["archived", lists.archived?.items ?? []],
  ];
  for (const [bucket, items] of buckets) {
    const index = items.findIndex((i) => i.id === id);
    if (index >= 0) return { bucket, index };
  }
  return null;
}

const without = (items: readonly MemoryItem[], id: string) => items.filter((i) => i.id !== id);

/**
 * Places the server's answer for one item: in place when it stays in its list, first in its new
 * list otherwise. The usage count follows active ↔ archived moves (a new item counts as new).
 */
export function placeItem(lists: ScopeLists, item: MemoryItem): ScopeLists {
  const at = find(lists, item.id);
  const target = bucketOf(item);
  const put = (items: readonly MemoryItem[], bucket: Bucket): readonly MemoryItem[] => {
    if (at?.bucket === bucket && bucket === target)
      return items.map((i) => (i.id === item.id ? item : i));
    const rest = at?.bucket === bucket ? without(items, item.id) : items;
    return bucket === target ? [item, ...rest] : rest;
  };
  const wasActive = at !== null && at.bucket !== "archived";
  const isActive = target !== "archived";
  const delta = (isActive ? 1 : 0) - (wasActive ? 1 : 0);
  return {
    pinned: put(lists.pinned, "pinned"),
    others: { ...lists.others, items: put(lists.others.items, "others") },
    archived:
      lists.archived === null
        ? null
        : { ...lists.archived, items: put(lists.archived.items, "archived") },
    usage: { ...lists.usage, count: Math.max(0, lists.usage.count + delta) },
  };
}

/** Every listed item, for near-duplicate links. */
export function listedItems(lists: ScopeLists): readonly MemoryItem[] {
  return [...lists.pinned, ...lists.others.items, ...(lists.archived?.items ?? [])];
}
