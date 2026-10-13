/**
 * The rail's thread groups (CE5, KOBE-198) in their fixed order: Pinned → projects → ungrouped →
 * Scheduled → Shared with me → Archived → Trash. A group shows only when it has threads. Pinned and
 * Archived have no data yet (CE19 adds `pinned_at` / `archived_at` in Phase C); "archived" in the
 * thread list adapter is Trash (D18), not CE19's Archive.
 */
import type { ThreadSummary } from "./types";

export type GroupKind =
  "pinned" | "project" | "ungrouped" | "scheduled" | "shared" | "archived" | "trash";

export const GROUP_ORDER: readonly GroupKind[] = [
  "pinned",
  "project",
  "ungrouped",
  "scheduled",
  "shared",
  "archived",
  "trash",
];

const LABELS: Readonly<Record<Exclude<GroupKind, "project">, string>> = {
  pinned: "Pinned",
  ungrouped: "Your threads",
  scheduled: "Scheduled",
  shared: "Shared with me",
  archived: "Archived",
  trash: "Trash",
};

/** Where a thread belongs, carried in assistant-ui's item `custom` from the list answer. */
export interface ThreadPlacement {
  readonly projectId: string | null;
  readonly scheduled: boolean;
  /** Shared to the caller by someone else (KOBE-163): read-only. */
  readonly shared: boolean;
}

export function placementCustom(thread: ThreadSummary): Record<string, unknown> {
  return {
    projectId: thread.projectId,
    scheduled: thread.scheduleId != null,
    shared: thread.readOnly === true,
  };
}

/** Reads `custom` back; anything malformed (or a thread not listed yet) is ungrouped. */
export function placementOf(custom: unknown): ThreadPlacement {
  const c =
    typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>) : {};
  return {
    projectId: typeof c.projectId === "string" ? c.projectId : null,
    scheduled: c.scheduled === true,
    shared: c.shared === true,
  };
}

function kindOf(p: ThreadPlacement): GroupKind {
  if (p.shared) return "shared";
  if (p.scheduled) return "scheduled";
  return p.projectId === null ? "ungrouped" : "project";
}

/** A thread in a group: assistant-ui's item id and its position in the list it came from. */
export interface GroupedThread {
  readonly id: string;
  /** In `threadIds`, or in `archivedThreadIds` for Trash. */
  readonly index: number;
}

export interface ThreadGroup {
  readonly key: string;
  readonly kind: GroupKind;
  readonly label: string;
  readonly threads: readonly GroupedThread[];
}

export interface ListedThread {
  readonly id: string;
  readonly custom: unknown;
}

/**
 * Groups the listed threads. `regular` is in list order (newest first, kept inside a group);
 * projects sort by name. `projectName` may not know a project (yet): it is then "Project".
 */
export function groupThreads(
  regular: readonly ListedThread[],
  trashIds: readonly string[],
  projectName: (id: string) => string | undefined,
): readonly ThreadGroup[] {
  const buckets = new Map<string, ThreadGroup>();
  regular.forEach(({ id, custom }, index) => {
    const placement = placementOf(custom);
    const kind = kindOf(placement);
    const key = kind === "project" ? `project:${placement.projectId}` : kind;
    const label =
      kind === "project"
        ? (projectName(placement.projectId ?? "") ?? "Project")
        : LABELS[kind as Exclude<GroupKind, "project">];
    const group = buckets.get(key) ?? { key, kind, label, threads: [] };
    buckets.set(key, { ...group, threads: [...group.threads, { id, index }] });
  });
  if (trashIds.length > 0) {
    const threads = trashIds.map((id, index) => ({ id, index }));
    buckets.set("trash", { key: "trash", kind: "trash", label: LABELS.trash, threads });
  }
  const rank = (kind: GroupKind) => GROUP_ORDER.indexOf(kind);
  return [...buckets.values()].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label),
  );
}
