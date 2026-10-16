"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon } from "lucide-react";
import { useCallback, useId, useState, type DragEvent, type ReactNode } from "react";
import type { ApiError } from "../../lib/api/client";
import { threadExportUrl } from "../../lib/chat/api";
import type { GroupKind, ThreadGroup } from "../../lib/chat/thread-groups";
import { carriesThread, organizedMessage, THREAD_DRAG_TYPE } from "../../lib/chat/organize";
import { ErrorNotice } from "../admin/error-notice";
import { useChatSession } from "../chat/kobe-runtime";
import { THREAD_ITEM, TRASH_ITEM } from "../chat/thread-item";
import { RailAnnounce } from "../chat/use-organize-menu";
import { IconAction } from "./icon-action";
import { useThreadGroups } from "./thread-groups";
import { InlineLink } from "./text-links";
import chat from "../chat/chat.module.css";
import styles from "./rail.module.css";

const HINTS: Partial<Readonly<Record<GroupKind, ReactNode>>> = {
  scheduled: (
    <>
      Threads your <InlineLink href="/me/schedules">schedules</InlineLink> started.
    </>
  ),
  trash: "Threads in Trash are deleted for good after 30 days.",
};

/** CE5: Archived starts collapsed; so does Trash, which only holds what the member threw away. */
const START_FOLDED: ReadonlySet<GroupKind> = new Set<GroupKind>(["archived", "trash"]);

/**
 * A project header takes a dragged thread row (CE19): the thread moves to that project, where the
 * server allows it. The row's menu (Move to project) is the keyboard path to the same move.
 */
function useProjectDrop(group: ThreadGroup, onMove: (threadId: string, projectId: string) => void) {
  const [over, setOver] = useState(false);
  const projectId = group.kind === "project" ? group.projectId : undefined;
  if (projectId === undefined) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!carriesThread(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        if (!carriesThread(e.dataTransfer)) return;
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
  const trash = group.kind === "trash";
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
                archived={trash}
                components={trash ? TRASH_ITEM : THREAD_ITEM}
              />
            ))}
        </ul>
      </div>
    </div>
  );
}

/** The rail's Threads section (CE5): assistant-ui's thread list in the fixed group order. */
export function RailThreads({ listError }: { readonly listError: ApiError | null }) {
  const session = useChatSession();
  const items = useAuiState((s) => s.threads.threadItems);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  const loading = useAuiState((s) => s.threads.isLoading);
  const { groups, projects } = useThreadGroups();
  // Groups the member opened or closed against their default (in memory: CE8 keeps per user
  // only the rail state, the divider and the artifact width, KOBE-202).
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  // One polite region for the rows' changes: a row that moves to another group is remounted.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((text: string) => setAnnouncement(text), []);
  const titleOf = (threadId: string) =>
    items.find((i) => i.remoteId === threadId)?.title || "Untitled conversation";
  const moveByDrop = (threadId: string, projectId: string) => {
    const change = { action: "move", projectId } as const;
    const title = titleOf(threadId);
    void session.organize(threadId, change).then((res) => {
      if (res.ok) announce(organizedMessage(change, title, projects.names.get(projectId)));
      else
        announce(
          res.error.code === "project_not_found"
            ? "You can't start conversations in that project, so this one can't move there."
            : res.error.message,
        );
    });
  };
  const flip = (key: string) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <RailAnnounce.Provider value={announce}>
      <ThreadListPrimitive.Root className={styles.sectionBody}>
        <div className={styles.sectionHeader}>
          <h3 id="kobe-rail-threads-title" className={styles.sectionTitle}>
            Threads
          </h3>
          <ThreadListPrimitive.New asChild>
            <IconAction command="new-thread" size="sm" side="right" />
          </ThreadListPrimitive.New>
          <IconAction
            command="export-threads"
            href={threadExportUrl(session.teamId)}
            download
            description="This team's, as Pi sessions and Markdown in a zip"
            size="sm"
            side="right"
          />
        </div>
        <div className={styles.scroll}>
          {listError && <ErrorNotice error={listError} />}
          {projects.failed && (
            <p className={chat.hint} role="status">
              Project names could not be loaded.
            </p>
          )}
          {!loading && groups.length === 0 && <p className={chat.hint}>No threads yet.</p>}
          {groups.map((g) => (
            <Group
              key={g.key}
              group={g}
              open={START_FOLDED.has(g.kind) === flipped.has(g.key)}
              onToggle={() => flip(g.key)}
              onMove={moveByDrop}
            />
          ))}
          {hasMore && (
            <ThreadListPrimitive.LoadMore className={styles.loadMore}>
              Load more
            </ThreadListPrimitive.LoadMore>
          )}
          <p role="status" className="sr-only" data-kobe-rail-status="">
            {announcement}
          </p>
        </div>
      </ThreadListPrimitive.Root>
    </RailAnnounce.Provider>
  );
}
