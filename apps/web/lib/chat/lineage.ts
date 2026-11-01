/**
 * The pure parts of the lineage strip (TL3, KOBE-535): which rows it shows for a
 * `GET /v1/threads/{id}/lineage` answer, the fold, and the labels. The server already left out
 * every thread the viewer cannot read (TL1), so these only arrange what came back. Titles stay
 * text: they are rendered as React text, never HTML.
 */
import {
  LINEAGE_MAX_SIBLINGS,
  threadLineageResponseSchema,
  type LineageRelative,
  type ThreadLineageResponse,
} from "@kobe/protocol";
import { TEAM_HEADER } from "../teams";
import { UNTITLED_THREAD } from "./fork";

/** More ancestor rows than this fold the middle generations (TL3). */
export const LINEAGE_FOLD_ROWS = 4;

/** The strip's fork point excerpt: shorter than the old note's (TL3). */
export const LINEAGE_EXCERPT_MAX = 48;

/** A window focus reads the lineage again once the last read is this old (TL4). */
export const LINEAGE_REREAD_MS = 60_000;

/** A thread as the strip names it. */
export interface LineageThread {
  readonly threadId: string;
  readonly title: string;
  /** In its owner's Trash (only the owner is told): a muted "In Trash" suffix. */
  readonly inTrash: boolean;
}

/** A row's siblings (its parent has several readable forks): the dropdown's items and label. */
export interface SiblingChoice {
  /** Newest first, as the server sent them, the thread in the path among them. */
  readonly items: readonly LineageThread[];
  /** 1-based place of the thread in the path. */
  readonly position: number;
  /** How many there are: "50+" when the server cut the list. */
  readonly total: string;
}

export type LineageRow =
  | { readonly kind: "hidden"; readonly depth: number }
  | {
      readonly kind: "ancestor";
      readonly depth: number;
      readonly thread: LineageThread;
      readonly siblings: SiblingChoice | null;
    }
  | { readonly kind: "fold"; readonly depth: number; readonly folded: readonly LineageThread[] }
  | {
      readonly kind: "self";
      readonly depth: number;
      readonly thread: LineageThread;
      readonly siblings: SiblingChoice | null;
      readonly forkedAt: string | null;
    }
  | {
      readonly kind: "forks";
      readonly depth: number;
      readonly forks: readonly LineageThread[];
      readonly more: boolean;
    };

/** A stored title as shown: null is "Untitled conversation". */
export function lineageTitle(title: string | null): string {
  return title ?? UNTITLED_THREAD;
}

function named(t: {
  readonly thread_id: string;
  readonly title: string | null;
  readonly deleted_at?: string | null;
}): LineageThread {
  return {
    threadId: t.thread_id,
    title: lineageTitle(t.title),
    inTrash: t.deleted_at !== null && t.deleted_at !== undefined,
  };
}

function countLabel(count: number, more: boolean): string {
  return more ? `${LINEAGE_MAX_SIBLINGS}+` : String(count);
}

/** The siblings dropdown of the thread `pathId`; null unless its parent has several forks. */
export function siblingChoice(
  siblings: readonly LineageRelative[],
  more: boolean,
  pathId: string,
): SiblingChoice | null {
  if (siblings.length < 2) return null;
  const index = siblings.findIndex((s) => s.thread_id === pathId);
  if (index < 0) return null;
  return {
    items: siblings.map(named),
    position: index + 1,
    total: countLabel(siblings.length, more),
  };
}

/** The strip shows only for a fork or a thread with forks (TL3): an ordinary thread shows nothing. */
export function hasLineage(lineage: ThreadLineageResponse): boolean {
  return lineage.ancestors.length > 0 || lineage.forks.length > 0 || lineage.root_hidden;
}

/**
 * The strip's rows (TL3): the hidden root's muted row, one row per generation root first (the
 * middle folded past `LINEAGE_FOLD_ROWS`), the thread on screen, then its forks. Each row after
 * the first is one step deeper. The first row is never a dropdown.
 */
export function lineageRows(lineage: ThreadLineageResponse): readonly LineageRow[] {
  if (!hasLineage(lineage)) return [];
  const rows: LineageRow[] = [];
  let depth = 0;
  const next = () => depth++;
  if (lineage.root_hidden) rows.push({ kind: "hidden", depth: next() });
  const { ancestors } = lineage;
  const ancestorRow = (a: (typeof ancestors)[number]): LineageRow => {
    const first = rows.length === 0;
    return {
      kind: "ancestor",
      depth: next(),
      thread: named(a),
      siblings: first ? null : siblingChoice(a.siblings, a.siblings_more, a.thread_id),
    };
  };
  if (ancestors.length > LINEAGE_FOLD_ROWS) {
    const root = ancestors[0];
    const parent = ancestors.at(-1);
    if (root) rows.push(ancestorRow(root));
    rows.push({ kind: "fold", depth: next(), folded: ancestors.slice(1, -1).map(named) });
    if (parent) rows.push(ancestorRow(parent));
  } else {
    for (const a of ancestors) rows.push(ancestorRow(a));
  }
  const { self } = lineage;
  rows.push({
    kind: "self",
    depth: next(),
    thread: { threadId: self.thread_id, title: lineageTitle(self.title), inTrash: false },
    siblings:
      rows.length === 0 ? null : siblingChoice(self.siblings, self.siblings_more, self.thread_id),
    forkedAt: self.forked_at_entry_id,
  });
  if (lineage.forks.length > 0) {
    rows.push({
      kind: "forks",
      depth: next(),
      forks: lineage.forks.map(named),
      more: lineage.forks_more,
    });
  }
  return rows;
}

/** A sibling row's dropdown label: "<title> · n of N". */
export function siblingLabel(title: string, choice: SiblingChoice): string {
  return `${title} · ${choice.position} of ${choice.total}`;
}

/** The Forks row's dropdown label: "2 forks", "50+ forks". */
export function forksLabel(count: number, more: boolean): string {
  return `${countLabel(count, more)} ${count === 1 && !more ? "fork" : "forks"}`;
}

/** The fold's dropdown label. */
export function foldLabel(count: number): string {
  return `… ${count} more`;
}

/** One item of the phone line's menu: the whole family, in the strip's order. */
export interface FamilyItem {
  readonly depth: number;
  /** null: the hidden root (shown muted, not a choice). */
  readonly thread: LineageThread | null;
  /** In the path from the root to the thread on screen (checked). */
  readonly inPath: boolean;
  /** The thread on screen. */
  readonly current: boolean;
}

/**
 * The phone line (TL3, under 820 px): every generation unfolded with its siblings in the server's
 * order, the thread on screen, then its forks; and how many other threads that names.
 */
export function familyItems(lineage: ThreadLineageResponse): {
  readonly items: readonly FamilyItem[];
  readonly related: string;
} {
  const items: FamilyItem[] = [];
  let depth = 0;
  let more = false;
  if (lineage.root_hidden)
    items.push({ depth: depth++, thread: null, inPath: false, current: false });
  const generation = (
    pathId: string,
    path: LineageThread,
    siblings: readonly LineageRelative[],
    siblingsMore: boolean,
    current: boolean,
  ) => {
    const d = depth++;
    more ||= siblingsMore;
    if (siblings.length < 2 || !siblings.some((s) => s.thread_id === pathId)) {
      items.push({ depth: d, thread: path, inPath: true, current });
      return;
    }
    for (const s of siblings) {
      const own = s.thread_id === pathId;
      items.push({ depth: d, thread: own ? path : named(s), inPath: own, current: own && current });
    }
  };
  for (const a of lineage.ancestors)
    generation(a.thread_id, named(a), a.siblings, a.siblings_more, false);
  const { self } = lineage;
  generation(
    self.thread_id,
    { threadId: self.thread_id, title: lineageTitle(self.title), inTrash: false },
    self.siblings,
    self.siblings_more,
    true,
  );
  for (const f of lineage.forks)
    items.push({ depth, thread: named(f), inPath: false, current: false });
  more ||= lineage.forks_more;
  const others = items.filter((i) => i.thread !== null && !i.current).length;
  return { items, related: `${others}${more ? "+" : ""}` };
}

/**
 * One read of `GET /v1/threads/{id}/lineage`, validated as sent (wire casing, no camelizing, as
 * the context viewer reads its route). Never throws: null for any failure, which the strip shows
 * as nothing (TL4).
 */
export async function readThreadLineage(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ThreadLineageResponse | null> {
  try {
    const res = await fetchFn(`/v1/threads/${encodeURIComponent(threadId)}/lineage`, {
      method: "GET",
      headers: { accept: "application/json", [TEAM_HEADER]: teamId },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const parsed = threadLineageResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.thread_id === threadId ? parsed.data : null;
  } catch {
    return null;
  }
}
