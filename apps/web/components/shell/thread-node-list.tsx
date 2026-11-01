"use client";

import { ThreadListPrimitive } from "@assistant-ui/react";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState, type DragEvent, type ReactNode } from "react";
import type { PanelNode } from "../../lib/chat/folder-tree";
import { carriesSharedThread, carriesThread, THREAD_DRAG_TYPE } from "../../lib/chat/organize";
import type { GroupKind, ThreadGroup } from "../../lib/chat/thread-groups";
import { HitNotes } from "../chat/hit-note";
import { THREAD_ITEM, TRASH_ITEM } from "../chat/thread-item";
import { InlineLink } from "./text-links";
import chat from "../chat/chat.module.css";
import styles from "./rail.module.css";

const HINTS: Partial<Readonly<Record<GroupKind, ReactNode>>> = {
  scheduled: (
    <>
      Threads your <InlineLink href="/me/schedules">schedules</InlineLink> started.
    </>
  ),
};

const TRASH_HINT = "Threads in Trash are deleted for good after 30 days.";

/**
 * A project header takes a dragged thread row (CE19): the thread moves to that project, where the
 * server allows it. The row's menu (Move to project) is the keyboard path to the same move. A row
 * shared with the member drags only to a folder (TF8): the header refuses it.
 */
function useProjectDrop(group: ThreadGroup, onMove: (threadId: string, projectId: string) => void) {
  const [over, setOver] = useState(false);
  const projectId = group.kind === "project" ? group.projectId : undefined;
  if (projectId === undefined) return { over: false, handlers: {} };
  const takes = (e: DragEvent) =>
    carriesThread(e.dataTransfer) && !carriesSharedThread(e.dataTransfer);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!takes(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!takes(e)) return;
        e.preventDefault();
        const threadId = e.dataTransfer.getData(THREAD_DRAG_TYPE);
        if (threadId !== "") onMove(threadId, projectId);
      },
    },
  };
}

function Group({
  group,
  open,
  onToggle,
  onMove,
}: {
  readonly group: ThreadGroup;
  readonly open: boolean;
  onToggle(): void;
  onMove(threadId: string, projectId: string): void;
}) {
  const listId = useId();
  const drop = useProjectDrop(group, onMove);
  return (
    <div className={styles.group} data-group={group.kind}>
      <h4 className={styles.groupHeading}>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
          data-drop-target={drop.over || undefined}
          {...drop.handlers}
        >
          <ChevronRightIcon aria-hidden className={styles.chevron} />
          <span className={styles.groupLabel}>{group.label}</span>
          <span aria-hidden className={styles.groupCount}>
            {group.threads.length}
          </span>
        </button>
      </h4>
      <div id={listId} hidden={!open}>
        {HINTS[group.kind] && <p className={chat.hint}>{HINTS[group.kind]}</p>}
        <ul className={chat.threadList} aria-label={group.label}>
          {open &&
            group.threads.map((t) => (
              <ThreadListPrimitive.ItemByIndex
                key={t.id}
                index={t.index}
                components={THREAD_ITEM}
              />
            ))}
        </ul>
      </div>
    </div>
  );
}

/** A flat list of rows: Archived (newest archived first) or Trash. */
function FlatList({
  label,
  rows,
  trash,
  notes,
}: {
  readonly label: string;
  readonly rows: readonly { readonly id: string; readonly index: number }[];
  readonly trash: boolean;
  readonly notes?: ReadonlyMap<string, ReactNode> | undefined;
}) {
  return (
    <HitNotes.Provider value={notes ?? null}>
      <ul className={chat.threadList} aria-label={label}>
        {rows.map((t) => (
          <ThreadListPrimitive.ItemByIndex
            key={t.id}
            index={t.index}
            archived={trash}
            components={trash ? TRASH_ITEM : THREAD_ITEM}
          />
        ))}
      </ul>
    </HitNotes.Provider>
  );
}

export interface NodeListProps {
  readonly node: PanelNode;
  /** The node's groups (Current or a folder). */
  readonly groups: readonly ThreadGroup[];
  /** Archived rows, newest archived first, with the folder path under filed ones. */
  readonly archived: readonly { readonly id: string; readonly index: number }[];
  readonly archivedNotes: ReadonlyMap<string, ReactNode>;
  readonly trash: readonly { readonly id: string; readonly index: number }[];
  readonly loading: boolean;
  readonly hasMore: boolean;
  /** The chosen folder has subfolders (its empty list points at the tree). */
  readonly hasSubfolders: boolean;
  isOpen(group: ThreadGroup): boolean;
  onToggle(group: ThreadGroup): void;
  onMove(threadId: string, projectId: string): void;
}

/**
 * The chosen node's threads (KOBE-536, TF6/TF7): Current's or a folder's standard groups, the
 * Archived node's flat list, or the Deleted node's Trash with its hint.
 */
export function NodeList(props: NodeListProps) {
  const { node, groups, loading } = props;
  if (node.kind === "archived") {
    if (props.archived.length === 0 && !loading) {
      return <p className={chat.hint}>No archived threads.</p>;
    }
    return (
      <FlatList label="Archived" rows={props.archived} trash={false} notes={props.archivedNotes} />
    );
  }
  if (node.kind === "deleted") {
    return (
      <>
        <p className={chat.hint}>{TRASH_HINT}</p>
        {props.trash.length === 0 && !loading ? (
          <p className={chat.hint}>Trash is empty.</p>
        ) : (
          <FlatList label="Trash" rows={props.trash} trash />
        )}
      </>
    );
  }
  const empty =
    node.kind === "current"
      ? "No threads yet."
      : props.hasSubfolders
        ? "No threads here. Its folders are in the tree."
        : "No threads here yet. Save one here from its ⋯ menu, or drag it onto the folder.";
  return (
    <>
      {!loading && groups.length === 0 && <p className={chat.hint}>{empty}</p>}
      {groups.map((g) => (
        <Group
          key={g.key}
          group={g}
          open={props.isOpen(g)}
          onToggle={() => props.onToggle(g)}
          onMove={props.onMove}
        />
      ))}
      {props.hasMore && (
        <ThreadListPrimitive.LoadMore className={styles.loadMore}>
          Load more
        </ThreadListPrimitive.LoadMore>
      )}
    </>
  );
}
