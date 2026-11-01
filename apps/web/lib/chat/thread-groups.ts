/**
 * The rail's thread groups (CE5, KOBE-198) in their fixed order: Pinned → projects → ungrouped →
 * Scheduled → Workbench (skill drafts' test chats, KOBE-323) → Shared with me → Archived → Trash.
 * A group shows only when it has threads. Pinned and Archived are the owner's organization (CE19,
 * KOBE-220: `pinned_at`, `archived_at`); "archived" in the thread list adapter's own status is
 * Trash (D18), not CE19's Archive. Shared with me holds others' threads shared with the member
 * (CE20, KOBE-221); one shared to a project is also listed in that project's group.
 */
import { visibilityOf } from "./share";
import type { ThreadSummary, ThreadVisibility } from "./types";

export type GroupKind =
  "pinned" | "project" | "ungrouped" | "scheduled" | "workbench" | "shared" | "archived" | "trash";

export const GROUP_ORDER: readonly GroupKind[] = [
  "pinned",
  "project",
  "ungrouped",
  "scheduled",
  "workbench",
  "shared",
  "archived",
  "trash",
];

const LABELS: Readonly<Record<Exclude<GroupKind, "project">, string>> = {
  pinned: "Pinned",
  ungrouped: "Your threads",
  scheduled: "Scheduled",
  workbench: "Workbench",
  shared: "Shared with me",
  archived: "Archived",
  trash: "Trash",
};

/** Where a thread belongs, carried in assistant-ui's item `custom` from the list answer. */
export interface ThreadPlacement {
  readonly projectId: string | null;
  readonly scheduled: boolean;
  /** A Workbench test chat (KOBE-323): the Workbench group. */
  readonly workbench: boolean;
  /** Shared to the caller by someone else (KOBE-163): read-only. */
  readonly shared: boolean;
  /** The share scope (CE20): a project-scoped shared thread is also in its project's group. */
  readonly visibility: ThreadVisibility;
  /** CE19: in the Pinned group (by pin time, the list's order), or in Archived. */
  readonly pinned: boolean;
  readonly archived: boolean;
  /** The team folder it is filed in (KOBE-536, TF2); null = `Current`. */
  readonly folderId: string | null;
}

export function placementCustom(thread: ThreadSummary): Record<string, unknown> {
  return {
    projectId: thread.projectId,
    scheduled: thread.scheduleId != null,
    workbench: thread.skillTest === true,
    shared: thread.readOnly === true,
    visibility: visibilityOf(thread),
    pinned: thread.pinnedAt != null,
    archived: thread.archivedAt != null,
    folderId: thread.folderId ?? null,
  };
}

/** Reads `custom` back; anything malformed (or a thread not listed yet) is ungrouped. */
export function placementOf(custom: unknown): ThreadPlacement {
  const c =
    typeof custom === "object" && custom !== null ? (custom as Record<string, unknown>) : {};
  return {
    projectId: typeof c.projectId === "string" ? c.projectId : null,
    scheduled: c.scheduled === true,
    workbench: c.workbench === true,
    shared: c.shared === true,
    visibility: c.visibility === "project" || c.visibility === "team" ? c.visibility : "private",
    pinned: c.pinned === true,
    archived: c.archived === true,
    folderId: typeof c.folderId === "string" ? c.folderId : null,
  };
}

/** A project wins over Scheduled: a scheduled thread the member moved belongs to the project. */
function kindOf(p: ThreadPlacement): GroupKind {
  if (p.shared) return "shared";
  if (p.archived) return "archived";
  if (p.pinned) return "pinned";
  if (p.projectId !== null) return "project";
  if (p.workbench) return "workbench";
  return p.scheduled ? "scheduled" : "ungrouped";
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
  /** A project group's project: a thread dropped on its header moves there (CE19). */
  readonly projectId?: string | undefined;
  readonly threads: readonly GroupedThread[];
}

export interface ListedThread {
  readonly id: string;
  readonly custom: unknown;
}

/**
 * One node of the Threads panel's tree (KOBE-536, TF6): `Current` (folder null) or a folder. Its
 * list is the standard groups of that node's unarchived threads; never Archived or Trash.
 */
export interface GroupScope {
  readonly folderId: string | null;
}

/**
 * Groups the listed threads. `regular` is in list order (newest first, kept inside a group);
 * projects sort by name. `projectName` may not know a project (yet): it is then "Project". With
 * a `scope`, only that node's unarchived threads are grouped and Trash is left out (TF6).
 */
export function groupThreads(
  regular: readonly ListedThread[],
  trashIds: readonly string[],
  projectName: (id: string) => string | undefined,
  scope?: GroupScope,
): readonly ThreadGroup[] {
  const buckets = new Map<string, ThreadGroup>();
  const add = (kind: GroupKind, projectId: string | null, thread: GroupedThread) => {
    const key = kind === "project" ? `project:${projectId}` : kind;
    const label =
      kind === "project"
        ? (projectName(projectId ?? "") ?? "Project")
        : LABELS[kind as Exclude<GroupKind, "project">];
    const group = buckets.get(key) ?? {
      key,
      kind,
      label,
      projectId: kind === "project" ? (projectId ?? undefined) : undefined,
      threads: [],
    };
    buckets.set(key, { ...group, threads: [...group.threads, thread] });
  };
  regular.forEach(({ id, custom }, index) => {
    const placement = placementOf(custom);
    if (scope && (placement.archived || placement.folderId !== scope.folderId)) return;
    const kind = kindOf(placement);
    add(kind, placement.projectId, { id, index });
    // CE20: shared to a project, it is also one of that project's threads.
    if (kind === "shared" && placement.visibility === "project" && placement.projectId !== null) {
      add("project", placement.projectId, { id, index });
    }
  });
  if (trashIds.length > 0 && !scope) {
    const threads = trashIds.map((id, index) => ({ id, index }));
    buckets.set("trash", { key: "trash", kind: "trash", label: LABELS.trash, threads });
  }
  const rank = (kind: GroupKind) => GROUP_ORDER.indexOf(kind);
  return [...buckets.values()].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label),
  );
}

/** Groups that previous/next conversation (CE23, KOBE-225) step through: not Archived or Trash. */
const STEPPED: ReadonlySet<GroupKind> = new Set(["archived", "trash"]);

/** The rail's conversations in order, each once (a project-shared thread is listed twice). */
export function threadOrder(groups: readonly ThreadGroup[]): readonly string[] {
  const ids = groups.filter((g) => !STEPPED.has(g.kind)).flatMap((g) => g.threads.map((t) => t.id));
  return [...new Set(ids)];
}

/**
 * The conversation `step` (-1 previous, +1 next) from `current` in `order`, without wrapping;
 * from a thread not in the order (a new draft) both go to the first. Null at either end.
 */
export function adjacentThread(
  order: readonly string[],
  current: string,
  step: -1 | 1,
): string | null {
  const at = order.indexOf(current);
  if (at < 0) return order[0] ?? null;
  return order[at + step] ?? null;
}
