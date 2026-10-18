"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { WORKSPACE_DROP_FOLDER } from "@kobe/protocol";
import type { FileEntry } from "../../lib/files/api";
import { carriesFiles, droppedItems, type DroppedItems } from "../../lib/files/drop";
import { carriesWorkspaceRow, startRowDrag } from "../../lib/files/drag";
import { formatBytes, isReadOnlyPath, parentPath } from "../../lib/files/format";
import { FILE_KIND_LABELS, fileKind, fileKindIcon, folderIcon } from "../../lib/files/icons";
import {
  canMoveInto,
  canUploadInto,
  isProjectMount,
  rowKey,
  type TreeRow,
} from "../../lib/files/tree";
import type { MenuBindings } from "../../lib/shell/menu";
import { cn } from "../../lib/utils";
import { ActionMenu, ROW_REVEAL } from "../ui/action-menu";
import type { FileTree } from "./use-file-tree";

/** The drag's own type: a tree row being moved or mentioned (never files from the computer). */
export { TREE_DRAG_TYPE } from "../../lib/files/drag";
/** Marks the folders that take files dropped from the computer (the rail's zone leaves them). */
export const DROP_FOLDER_ATTR = "data-kobe-drop-folder";
/** Indentation per level, px. */
const INDENT = 12;
const TYPE_AHEAD_MS = 600;

export interface Dragging {
  readonly path: string;
  readonly type: "file" | "dir";
}

export interface TreeActions {
  /** A file row was activated (click, Enter): it opens in the artifact column (KOBE-268). */
  readonly onOpenFile: ((entry: FileEntry) => void) | undefined;
  /** The row's ⋯ menu (KOBE-292). */
  bindings(entry: FileEntry): MenuBindings;
  onRename(entry: FileEntry): void;
  onDelete(entry: FileEntry): void;
  /** A drop of a row onto a folder ("" = the top level). */
  onMove(dragging: Dragging, folder: string): void;
  /** Files from the computer dropped onto a folder. */
  onUpload(folder: string, items: DroppedItems): void;
}

/** What the tree reports up: the focused row's folder (uploads go there) and the drag target. */
export interface TreeFocus {
  readonly path: string | null;
  readonly folder: string;
}

const isEntry = (row: TreeRow | undefined): row is Extract<TreeRow, { kind: "entry" }> =>
  row?.kind === "entry";

/** The folder a drop onto `row` lands in: a folder itself, a file's own folder. */
const dropFolderOf = (row: Extract<TreeRow, { kind: "entry" }>) =>
  row.entry.type === "dir" ? row.entry.path : parentPath(row.entry.path);

function describe(entry: FileEntry): string {
  const parts = [
    entry.type === "dir" ? "Folder" : FILE_KIND_LABELS[fileKind(entry.name)],
    ...(entry.sizeBytes === null ? [] : [formatBytes(entry.sizeBytes)]),
    ...(isReadOnlyPath(entry.path) ? ["read-only"] : []),
  ];
  return parts.join(", ");
}

function Guides({ level }: { readonly level: number }) {
  return (
    <>
      {Array.from({ length: level - 1 }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="border-muted-foreground/20 pointer-events-none absolute inset-y-0 border-s"
          style={{ insetInlineStart: `${i * INDENT + 10}px` }}
        />
      ))}
    </>
  );
}

function ReadOnlyBadge() {
  return (
    <span className="text-muted-foreground shrink-0 rounded-full border px-1.5 text-[0.65rem] leading-4">
      Read-only
    </span>
  );
}

interface RowProps {
  readonly row: Extract<TreeRow, { kind: "entry" }>;
  readonly id: string;
  readonly active: boolean;
  readonly dropHere: boolean;
  readonly menuSignal: number;
  readonly actions: TreeActions;
  readonly drag: DragHandlers;
  onFocusRow(): void;
  onToggle(): void;
  register(el: HTMLElement | null): void;
}

interface DragHandlers {
  start(e: DragEvent, row: Extract<TreeRow, { kind: "entry" }>): void;
  over(e: DragEvent, folder: string, takesFiles: boolean): void;
  drop(e: DragEvent, folder: string, takesFiles: boolean): void;
  end(): void;
}

function EntryRow({
  row,
  id,
  active,
  dropHere,
  menuSignal,
  actions,
  drag,
  onFocusRow,
  onToggle,
  register,
}: RowProps) {
  const { entry, level, expanded } = row;
  const dir = entry.type === "dir";
  const readOnly = isReadOnlyPath(entry.path);
  const Icon = dir
    ? folderIcon(expanded, isProjectMount(entry.path))
    : fileKindIcon(fileKind(entry.name));
  const folder = dropFolderOf(row);
  const takesFiles = dir && canUploadInto(entry.path);
  const badge = isProjectMount(entry.path) || entry.path === WORKSPACE_DROP_FOLDER;
  return (
    <li
      ref={register}
      id={id}
      role="treeitem"
      aria-level={level}
      aria-posinset={row.posinset}
      aria-setsize={row.setsize}
      aria-expanded={dir ? expanded : undefined}
      aria-selected={active}
      aria-busy={row.loading || undefined}
      aria-label={entry.name}
      aria-describedby={`${id}-d`}
      tabIndex={active ? 0 : -1}
      data-file={entry.name}
      data-path={entry.path}
      {...(dropHere ? { "data-drop-target": "" } : {})}
      {...(takesFiles ? { [DROP_FOLDER_ATTR]: "" } : {})}
      // Read-only files still drag, to be mentioned in the composer (KOBE-374); never moved.
      draggable={!readOnly || !dir}
      title={entry.path}
      className={cn(
        "group/row relative flex h-6.5 cursor-default items-center gap-1 rounded-sm pe-0.5 text-sm outline-none select-none",
        "hover:bg-muted focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        active && "bg-muted/60",
        dropHere && "bg-accent ring-ring ring-1 ring-inset",
      )}
      style={{ paddingInlineStart: `${(level - 1) * INDENT + 2}px` }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow();
      }}
      onClick={(e) => {
        // The ⋯ menu's button, and its items (portaled, but React bubbles them through here).
        if (!e.currentTarget.contains(e.target as Node)) return;
        if ((e.target as Element).closest("button")) return;
        onFocusRow();
        e.currentTarget.focus();
        if (dir) onToggle();
        else actions.onOpenFile?.(entry);
      }}
      onDragStart={(e) => drag.start(e, row)}
      onDragOver={(e) => drag.over(e, folder, takesFiles)}
      onDrop={(e) => drag.drop(e, folder, takesFiles)}
      onDragEnd={drag.end}
    >
      <Guides level={level} />
      {dir ? (
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
        />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0" />
      )}
      <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {row.loading && (
        <LoaderCircleIcon aria-hidden className="text-muted-foreground size-3 animate-spin" />
      )}
      {badge && <ReadOnlyBadge />}
      {entry.sizeBytes !== null && (
        <span className="text-muted-foreground hidden shrink-0 text-xs tabular-nums @min-[15rem]:inline">
          {formatBytes(entry.sizeBytes)}
        </span>
      )}
      <ActionMenu
        trigger="file-row-actions"
        label={`Actions for ${entry.name}`}
        scope="file-menu"
        size="sm"
        tabIndex={-1}
        openSignal={active ? menuSignal : 0}
        className={ROW_REVEAL}
        bindings={actions.bindings(entry)}
      />
      <span id={`${id}-d`} className="sr-only">
        {describe(entry)}
      </span>
    </li>
  );
}

function MoreRow({
  row,
  id,
  active,
  onFocusRow,
  onMore,
  register,
}: {
  readonly row: Extract<TreeRow, { kind: "more" }>;
  readonly id: string;
  readonly active: boolean;
  onFocusRow(): void;
  onMore(): void;
  register(el: HTMLElement | null): void;
}) {
  const label = row.hidden > 0 ? `Show ${row.hidden} more` : "Show more";
  return (
    <li
      ref={register}
      id={id}
      role="treeitem"
      aria-level={row.level}
      aria-label={label}
      tabIndex={active ? 0 : -1}
      className={cn(
        "text-muted-foreground flex h-6.5 cursor-pointer items-center rounded-sm text-xs underline outline-none",
        "hover:bg-muted focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
      )}
      style={{ paddingInlineStart: `${(row.level - 1) * INDENT + 22}px` }}
      onFocus={onFocusRow}
      onClick={() => {
        onFocusRow();
        onMore();
      }}
    >
      {label}
    </li>
  );
}

/** Next row whose name starts with `prefix` after `from`, wrapping (type-ahead). */
function typeAheadIndex(rows: readonly TreeRow[], from: number, prefix: string): number {
  for (let step = 1; step <= rows.length; step += 1) {
    const i = (from + step) % rows.length;
    const row = rows[i];
    if (isEntry(row) && row.entry.name.toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

function useDrag(actions: TreeActions) {
  const dragging = useRef<Dragging | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const end = useCallback(() => {
    dragging.current = null;
    setTarget(null);
  }, []);
  const handlers: DragHandlers = {
    start(e, row) {
      const readOnly = isReadOnlyPath(row.entry.path);
      if (readOnly && row.entry.type === "dir") return e.preventDefault();
      dragging.current = { path: row.entry.path, type: row.entry.type };
      // A drop on the composer mentions it (copy); on a folder here it moves (canMoveInto
      // refuses read-only sources).
      startRowDrag(e.dataTransfer, dragging.current, !readOnly);
    },
    over(e, folder, takesFiles) {
      const own = dragging.current;
      if (own && carriesWorkspaceRow(e.dataTransfer)) {
        if (!canMoveInto(own.path, own.type, folder)) {
          e.dataTransfer.dropEffect = "none";
          return setTarget(null);
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        return setTarget(folder);
      }
      if (takesFiles && carriesFiles(e.dataTransfer)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setTarget(folder);
      }
    },
    drop(e, folder, takesFiles) {
      const own = dragging.current;
      if (own && carriesWorkspaceRow(e.dataTransfer)) {
        e.preventDefault();
        end();
        if (canMoveInto(own.path, own.type, folder)) actions.onMove(own, folder);
        return;
      }
      if (takesFiles && carriesFiles(e.dataTransfer)) {
        e.preventDefault();
        const items = droppedItems(e.dataTransfer); // only readable during the event
        end();
        actions.onUpload(folder, items);
      }
    },
    end,
  };
  return { target, handlers };
}

/**
 * The Files tree (KOBE-304): the ARIA tree pattern over the visible rows (one tab stop; arrows,
 * Home/End, Enter, type-ahead; F2 renames, Delete deletes, Shift+F10 or the Menu key opens the
 * row's menu), lazy folders, compact rows with file-type icons, drag and drop to move (and files
 * from the computer onto a folder to upload there). Keys the tree handles are prevented, so the
 * CE23 shortcuts (KOBE-225) never see them; modified keys pass through.
 */
export function FileTreeView({
  tree,
  label,
  actions,
  focusRequest,
  onFocusChange,
  header,
}: {
  readonly tree: FileTree;
  readonly label: string;
  readonly actions: TreeActions;
  /** Focus moves to this path's row once it shows (after a move or rename). */
  readonly focusRequest: { readonly path: string; readonly seq: number } | null;
  onFocusChange(focus: TreeFocus): void;
  /** The top-level row above the tree (a drop target for the top level). */
  readonly header: (drag: { target: string | null; handlers: DragHandlers }) => ReactNode;
}) {
  const { rows } = tree;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [menuSignal, setMenuSignal] = useState(0);
  const elements = useRef(new Map<string, HTMLElement>());
  const typed = useRef({ text: "", at: 0 });
  const drag = useDrag(actions);
  const index = rows.findIndex((r) => rowKey(r) === activeKey);
  const current = index >= 0 ? index : 0;

  const activate = useCallback(
    (i: number, focus = true) => {
      const row = rows[i];
      if (!row) return;
      const key = rowKey(row);
      setActiveKey(key);
      if (focus) elements.current.get(key)?.focus();
    },
    [rows],
  );

  const focused = rows[current];
  const focusedPath = isEntry(focused) ? focused.entry.path : null;
  const focusedFolder = isEntry(focused) ? dropFolderOf(focused) : "";
  useEffect(() => {
    onFocusChange({
      path: activeKey === null ? null : focusedPath,
      folder: activeKey === null ? "" : focusedFolder,
    });
  }, [activeKey, focusedPath, focusedFolder, onFocusChange]);

  // A requested row (moved, renamed, revealed) takes the focus as soon as it is on screen.
  const pending = useRef<{ path: string; seq: number } | null>(null);
  const seen = useRef(0);
  useEffect(() => {
    if (focusRequest && focusRequest.seq !== seen.current) {
      seen.current = focusRequest.seq;
      pending.current = focusRequest;
    }
    const want = pending.current;
    if (!want) return;
    const i = rows.findIndex((r) => isEntry(r) && r.entry.path === want.path);
    if (i < 0) return;
    pending.current = null;
    activate(i);
  }, [focusRequest, rows, activate]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.target !== e.currentTarget && !(e.target as Element).matches('[role="treeitem"]')) {
      return; // keys inside the ⋯ menu button are its own
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) typed.current = { text: "", at: 0 }; // type-ahead starts over
    const row = rows[current];
    const handled = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    switch (e.key) {
      case "ArrowDown":
        return handled(() => activate(Math.min(current + 1, rows.length - 1)));
      case "ArrowUp":
        return handled(() => activate(Math.max(current - 1, 0)));
      case "Home":
        return handled(() => activate(0));
      case "End":
        return handled(() => activate(rows.length - 1));
      case "ArrowRight":
        return handled(() => {
          if (!isEntry(row) || row.entry.type !== "dir") return;
          if (!row.expanded) tree.expand(row.entry.path);
          else if (rows[current + 1]?.level === row.level + 1) activate(current + 1);
        });
      case "ArrowLeft":
        return handled(() => {
          if (isEntry(row) && row.entry.type === "dir" && row.expanded) {
            return tree.collapse(row.entry.path);
          }
          for (let i = current - 1; i >= 0; i -= 1) {
            if ((rows[i]?.level ?? 0) < (row?.level ?? 0)) return activate(i);
          }
        });
      case "Enter":
        return handled(() => {
          if (!row) return;
          if (row.kind === "more") return tree.showMore(row.folder);
          if (row.entry.type === "dir") tree.toggle(row.entry.path);
          else actions.onOpenFile?.(row.entry);
        });
      case "F2":
        if (isEntry(row) && !isReadOnlyPath(row.entry.path))
          handled(() => actions.onRename(row.entry));
        return;
      case "Delete":
        if (isEntry(row) && !isReadOnlyPath(row.entry.path))
          handled(() => actions.onDelete(row.entry));
        return;
      case "ContextMenu":
        return handled(() => setMenuSignal((n) => n + 1));
      case "F10":
        if (e.shiftKey) handled(() => setMenuSignal((n) => n + 1));
        return;
    }
    if (e.key.length === 1 && e.key !== " ") {
      handled(() => {
        const now = Date.now();
        const prev = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "";
        const text = `${prev}${e.key.toLowerCase()}`;
        typed.current = { text, at: now };
        // A first key (or one key pressed again) moves to the next name starting with it; more
        // keys typed together narrow the match, which may be the row already focused.
        const same = [...text].every((c) => c === text[0]);
        const from = same ? current : current - 1;
        const found = typeAheadIndex(rows, from, same ? (text[0] ?? "") : text);
        if (found >= 0) activate(found);
      });
    }
  };

  return (
    <div className="@container flex min-h-0 flex-col">
      {header(drag)}
      <ul
        role="tree"
        aria-label={label}
        className="m-0 list-none ps-0"
        onKeyDown={onKeyDown}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drag.handlers.end();
        }}
      >
        {rows.map((row, i) => {
          const key = rowKey(row);
          const register = (el: HTMLElement | null) => {
            if (el) elements.current.set(key, el);
            else elements.current.delete(key);
          };
          const id = `kobe-files-row-${i}`;
          return row.kind === "entry" ? (
            <EntryRow
              key={key}
              row={row}
              id={id}
              active={i === current}
              dropHere={
                drag.target !== null && row.entry.type === "dir" && drag.target === row.entry.path
              }
              menuSignal={menuSignal}
              actions={actions}
              drag={drag.handlers}
              register={register}
              onFocusRow={() => setActiveKey(key)}
              onToggle={() => tree.toggle(row.entry.path)}
            />
          ) : (
            <MoreRow
              key={key}
              row={row}
              id={id}
              active={i === current}
              register={register}
              onFocusRow={() => setActiveKey(key)}
              onMore={() => tree.showMore(row.folder)}
            />
          );
        })}
      </ul>
    </div>
  );
}
