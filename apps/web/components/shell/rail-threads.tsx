"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ApiError } from "../../lib/api/client";
import { threadExportUrl } from "../../lib/chat/api";
import {
  groupThreads,
  placementOf,
  type GroupKind,
  type ThreadGroup,
} from "../../lib/chat/thread-groups";
import { createProjectsApi } from "../../lib/projects/api";
import { ErrorNotice } from "../admin/error-notice";
import { useChatSession } from "../chat/kobe-runtime";
import { THREAD_ITEM, TRASH_ITEM } from "../chat/thread-item";
import { IconAction } from "./icon-action";
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

/** Project names for the groups; ids the read misses (or a failed read) show as "Project". */
function useProjectNames(teamId: string, ids: string, fetchFn: typeof fetch | undefined) {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (ids === "") return;
    let current = true;
    void createProjectsApi(teamId, fetchFn)
      .list(true)
      .then((res) => {
        if (current && res.ok) setNames(new Map(res.data.map((p) => [p.id, p.name])));
      });
    return () => {
      current = false;
    };
  }, [teamId, ids, fetchFn]);
  return names;
}

function Group({
  group,
  open,
  onToggle,
}: {
  readonly group: ThreadGroup;
  readonly open: boolean;
  onToggle(): void;
}) {
  const listId = useId();
  const trash = group.kind === "trash";
  return (
    <div className={styles.group} data-group={group.kind}>
      <h4 className={styles.groupHeading}>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
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
export function RailThreads({
  listError,
  fetchFn,
}: {
  readonly listError: ApiError | null;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const session = useChatSession();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const trashIds = useAuiState((s) => s.threads.archivedThreadIds);
  const items = useAuiState((s) => s.threads.threadItems);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  const loading = useAuiState((s) => s.threads.isLoading);
  const listed = useMemo(() => {
    const custom = new Map(items.map((i) => [i.id, i.custom]));
    return threadIds.map((id) => ({ id, custom: custom.get(id) }));
  }, [threadIds, items]);
  const projectIds = [
    ...new Set(listed.map((t) => placementOf(t.custom).projectId).filter((p) => p !== null)),
  ]
    .sort()
    .join(",");
  const names = useProjectNames(session.teamId, projectIds, fetchFn);
  const groups = useMemo(
    () => groupThreads(listed, trashIds, (id) => names.get(id)),
    [listed, trashIds, names],
  );
  // Groups the member opened or closed against their default (in memory; A6 slot, KOBE-202).
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const flip = (key: string) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
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
        {!loading && groups.length === 0 && <p className={chat.hint}>No threads yet.</p>}
        {groups.map((g) => (
          <Group
            key={g.key}
            group={g}
            open={START_FOLDED.has(g.kind) === flipped.has(g.key)}
            onToggle={() => flip(g.key)}
          />
        ))}
        {hasMore && (
          <ThreadListPrimitive.LoadMore className={styles.loadMore}>
            Load more
          </ThreadListPrimitive.LoadMore>
        )}
      </div>
    </ThreadListPrimitive.Root>
  );
}
