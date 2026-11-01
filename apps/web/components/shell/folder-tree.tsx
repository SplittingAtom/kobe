"use client";

import { ArchiveIcon, ChevronRightIcon, FolderIcon, InboxIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { nodeKey, sameNode, type PanelNode, type TreeRow } from "../../lib/chat/folder-tree";
import { carriesThread, THREAD_DRAG_TYPE } from "../../lib/chat/organize";
import type { MenuBindings } from "../../lib/shell/menu";
import { cn } from "../../lib/utils";
import { ActionMenu, ROW_REVEAL } from "../ui/action-menu";

const INDENT = 12;
const TYPE_AHEAD_MS = 600;

export interface FolderTreeProps {
  readonly rows: readonly TreeRow[];
  readonly chosen: PanelNode;
  choose(node: PanelNode): void;
  /** Opens or folds a node with children (Current, a folder with subfolders). */
  setOpen(node: PanelNode, open: boolean): void;
  /** A folder node's ⋯ menu (TF7); the built-in nodes have none. */
  bindings(row: TreeRow): MenuBindings | null;
  /** A thread row dropped on a node: a folder files it there, Current takes it out (TF8). */
  onDropThread(threadId: string, folderId: string | null): void;
}

/** Current and folders take a dropped thread; Archived and Deleted don't (TF8). */
const takesDrop = (node: PanelNode) => node.kind === "current" || node.kind === "folder";

function NodeIcon({ node }: { readonly node: PanelNode }) {
  const Icon =
    node.kind === "archived"
      ? ArchiveIcon
      : node.kind === "deleted"
        ? Trash2Icon
        : node.kind === "current"
          ? InboxIcon
          : FolderIcon;
  return <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />;
}

function nextByPrefix(rows: readonly TreeRow[], from: number, prefix: string): number {
  for (let step = 1; step <= rows.length; step += 1) {
    const i = (from + step) % rows.length;
    if (rows[i]?.label.toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

/**
 * The Threads panel's folder tree (KOBE-536, TF7), the ARIA tree pattern as the Files tree has
 * it: one tab stop, arrows, Home/End, type-ahead, Enter or a click chooses the node (selected),
 * Right/Left open and fold, Shift+F10 or the Menu key opens a folder's ⋯ menu. Thread rows drop
 * onto Current and the folders.
 */
export function FolderTree({
  rows,
  chosen,
  choose,
  setOpen,
  bindings,
  onDropThread,
}: FolderTreeProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Shift+F10 / the Menu key on a row: that row's ⋯ menu opens (cleared when the focus moves).
  const [menuSignal, setMenuSignal] = useState<{ readonly key: string; readonly n: number } | null>(
    null,
  );
  const [dropKey, setDropKey] = useState<string | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const elements = useRef(new Map<string, HTMLElement>());
  const chosenIndex = rows.findIndex((r) => sameNode(r.node, chosen));
  const found = rows.findIndex((r) => nodeKey(r.node) === activeKey);
  const current = found >= 0 ? found : Math.max(chosenIndex, 0);

  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    const key = nodeKey(row.node);
    setActiveKey(key);
    setMenuSignal(null);
    elements.current.get(key)?.focus();
  };
  const openMenu = () => {
    const row = rows[current];
    if (!row) return;
    const key = nodeKey(row.node);
    setMenuSignal((s) => ({ key, n: (s?.n ?? 0) + 1 }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!(e.target as Element).matches('[role="treeitem"]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) typed.current = { text: "", at: 0 };
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
          if (row?.expanded === false) setOpen(row.node, true);
          else if (row?.expanded && rows[current + 1]?.level === row.level + 1)
            activate(current + 1);
        });
      case "ArrowLeft":
        return handled(() => {
          if (row?.expanded) return setOpen(row.node, false);
          for (let i = current - 1; i >= 0; i -= 1) {
            if ((rows[i]?.level ?? 0) < (row?.level ?? 0)) return activate(i);
          }
        });
      case "Enter":
      case " ":
        return handled(() => row && choose(row.node));
      case "ContextMenu":
        return handled(openMenu);
      case "F10":
        if (e.shiftKey) handled(openMenu);
        return;
    }
    if (e.key.length === 1) {
      handled(() => {
        const now = Date.now();
        const prev = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "";
        const text = `${prev}${e.key.toLowerCase()}`;
        typed.current = { text, at: now };
        const same = [...text].every((c) => c === text[0]);
        const i = nextByPrefix(rows, same ? current : current - 1, same ? (text[0] ?? "") : text);
        if (i >= 0) activate(i);
      });
    }
  };

  const dropHandlers = (row: TreeRow) => {
    if (!takesDrop(row.node)) return {};
    const key = nodeKey(row.node);
    const folderId = row.node.kind === "folder" ? row.node.id : null;
    return {
      onDragOver: (e: DragEvent) => {
        if (!carriesThread(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropKey(key);
      },
      onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
      onDrop: (e: DragEvent) => {
        setDropKey(null);
        if (!carriesThread(e.dataTransfer)) return;
        e.preventDefault();
        const threadId = e.dataTransfer.getData(THREAD_DRAG_TYPE);
        if (threadId !== "") onDropThread(threadId, folderId);
      },
    };
  };

  return (
    <ul
      role="tree"
      aria-label="Thread folders"
      className="m-0 list-none ps-0"
      onKeyDown={onKeyDown}
    >
      {rows.map((row, i) => {
        const key = nodeKey(row.node);
        const selected = sameNode(row.node, chosen);
        const menu = bindings(row);
        const countId = `kobe-node-${i}-n`;
        return (
          <li
            key={key}
            ref={(el) => {
              if (el) elements.current.set(key, el);
              else elements.current.delete(key);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={row.expanded}
            aria-selected={selected}
            aria-label={row.label}
            aria-describedby={countId}
            tabIndex={i === current ? 0 : -1}
            data-kobe-node={key}
            {...(dropKey === key ? { "data-drop-target": "" } : {})}
            className={cn(
              "group/row relative flex h-7 cursor-pointer items-center gap-1 rounded-sm pe-0.5 text-sm outline-none select-none",
              "hover:bg-muted focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
              selected && "bg-muted font-medium",
              dropKey === key && "bg-accent ring-ring ring-1 ring-inset",
            )}
            style={{ paddingInlineStart: `${(row.level - 1) * INDENT + 2}px` }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setActiveKey(key);
            }}
            onClick={(e) => {
              if ((e.target as Element).closest("button")) return;
              if (!e.currentTarget.contains(e.target as Node)) return;
              setActiveKey(key);
              choose(row.node);
            }}
            {...dropHandlers(row)}
          >
            {row.expanded === undefined ? (
              <span aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                className="flex size-3.5 shrink-0 items-center"
                onClick={() => setOpen(row.node, !row.expanded)}
              >
                <ChevronRightIcon
                  className={cn("size-3.5 transition-transform", row.expanded && "rotate-90")}
                />
              </button>
            )}
            <NodeIcon node={row.node} />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <span id={countId} className="text-muted-foreground shrink-0 text-xs tabular-nums">
              <span aria-hidden>{row.count}</span>
              <span className="sr-only">
                {row.count === 1 ? "1 thread" : `${row.count} threads`}
              </span>
            </span>
            {menu && (
              <ActionMenu
                trigger="folder-node-actions"
                label={`Actions for ${row.label}`}
                scope="folder-menu"
                bindings={menu}
                tabIndex={-1}
                openSignal={menuSignal?.key === key ? menuSignal.n : 0}
                className={ROW_REVEAL}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
