"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { threadExportUrl } from "../../lib/chat/api";
import { folderPath, placeFolders, treeRows, type PanelNode } from "../../lib/chat/folder-tree";
import { foldersOf } from "../../lib/chat/folders-store";
import { organizedMessage } from "../../lib/chat/organize";
import { placementOf, type ThreadGroup } from "../../lib/chat/thread-groups";
import { ErrorNotice } from "../admin/error-notice";
import { useArtifactPanel } from "../chat/artifact-state";
import { useChatSession } from "../chat/kobe-runtime";
import { filedMessage } from "../chat/save-to-folder-menu";
import { RailAnnounce } from "../chat/use-organize-menu";
import { useFolderReads, useThreadFolders } from "../chat/use-thread-folders";
import { FolderEditor, useFolderActions } from "./folder-node-menu";
import { FolderPicker } from "./folder-picker";
import { FolderTree } from "./folder-tree";
import { IconAction } from "./icon-action";
import { FileMapLayer, pinKey } from "./file-map-layer";
import { useShellBand } from "./shell-band";
import { ThreadFileMap, type ThreadFileMapValue } from "./thread-file-row";
import { useShownThreads, useThreadLinks } from "./use-file-links";
import { NodeList } from "./thread-node-list";
import { useThreadGroups } from "./thread-groups";
import { FolderNote, SearchHits, useThreadsSearch } from "./threads-search";
import chat from "../chat/chat.module.css";
import { RAIL_ACTION, RAIL_ACTION_VARIANT } from "./rail-action";

/** The panel's tree state: the folders placed, the counts, the chosen node and its memory. */
function useTreeModel() {
  const session = useChatSession();
  const memory = session.panelMemory;
  useSyncExternalStore(memory.subscribe, memory.getVersion, memory.getVersion);
  const folders = useThreadFolders();
  const list = foldersOf(folders);
  const { listed, trashIds } = useThreadGroups();
  const placed = useMemo(() => placeFolders(list), [list]);
  const counts = useMemo(() => {
    let current = 0;
    let archived = 0;
    for (const t of listed) {
      const p = placementOf(t.custom);
      if (p.archived) archived += 1;
      else if (p.folderId === null) current += 1;
    }
    return { current, archived, deleted: trashIds.length };
  }, [listed, trashIds]);
  const rows = treeRows(placed, counts, {
    currentOpen: memory.currentOpen,
    open: memory.openFolders,
  });
  // A chosen folder another member deleted: the panel falls back to Current.
  const node = memory.node;
  const gone =
    node.kind === "folder" && folders.status === "ready" && !list.some((f) => f.id === node.id);
  useEffect(() => {
    if (gone) memory.choose({ kind: "current" });
  }, [gone, memory]);
  return { memory, node, list, placed, counts, rows };
}

/**
 * The Threads panel's content (KOBE-453, CE5; two rails since KOBE-536, TF7; three since KOBE-612,
 * spec thread-file-map): the server's search and Export above; on wide windows (1,100 px and
 * wider) the folder tree, the chosen node's threads and a read-only workspace rail, with lines
 * between threads and the files they used; at 820 px and wider the tree beside the threads; below
 * that a dropdown above them. Rows keep the rail's menu, keyboard access and drag onto a project
 * header or a folder, and show "Files (N)". Choosing a thread (its title) calls `onChosen`: the
 * panel closes onto it; a file opens in the artifact column and `onClose` closes the panel.
 */
export function ThreadsPanelContent({
  listError,
  onChosen,
  filesApi,
  workspaceName = "",
  onClose,
}: {
  readonly listError: ApiError | null;
  onChosen(threadId: string): void;
  /** The workspace's files: the third rail at wide widths. Absent: two rails at most. */
  readonly filesApi?: FilesApi | undefined;
  readonly workspaceName?: string | undefined;
  /** Closes the panel (after a file opened in the artifact column). */
  readonly onClose?: (() => void) | undefined;
}) {
  const session = useChatSession();
  const artifactPanel = useArtifactPanel();
  const items = useAuiState((s) => s.threads.threadItems);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  const loading = useAuiState((s) => s.threads.isLoading);
  const { groups, projects, listed, trashIds } = useThreadGroups();
  const band = useShellBand();
  const wide = band === "wide" || band === "medium";
  // Three rails only where they fit (TFM4: about 1,100 px): the shell's wide band.
  const threeRails = band === "wide" && filesApi !== undefined;
  useFolderReads();
  const tree = useTreeModel();
  const { memory, node, list, placed } = tree;
  const [query, setQuery] = useState("");
  // One polite region for the rows' changes: a row that moves to another group is remounted.
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((text: string) => setAnnouncement(text), []);
  const actions = useFolderActions(placed, announce);
  const titleOf = (threadId: string) =>
    items.find((i) => i.remoteId === threadId)?.title || "Untitled conversation";
  const search = useThreadsSearch(query);
  const searching = query.trim() !== "";

  // Thread–file links (KOBE-612): read for the rows on screen before any hover.
  const bodyRef = useRef<HTMLDivElement>(null);
  const threadsRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const shownIds = useShownThreads(threadsRef);
  const shownThreads = useMemo(() => new Set(shownIds), [shownIds]);
  const links = useThreadLinks(session.api, shownIds);
  const [pins, setPins] = useState<ReadonlySet<string>>(new Set());
  const openPanelFile = artifactPanel?.openFile;
  const fileMap = useMemo<ThreadFileMapValue>(
    () => ({
      lines: threeRails,
      linksOf: (id) => links.get(id),
      isPinned: (side, key) => pins.has(pinKey(side, key)),
      togglePin: (side, key) =>
        setPins((prev) => {
          const next = new Set(prev);
          const k = pinKey(side, key);
          if (!next.delete(k)) next.add(k);
          return next;
        }),
      openFile: (path) => {
        openPanelFile?.(path);
        onClose?.();
      },
    }),
    [threeRails, links, pins, openPanelFile, onClose],
  );

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
  const fileByDrop = (threadId: string, folderId: string | null) => {
    const title = titleOf(threadId);
    const from = items.find((i) => i.remoteId === threadId);
    const before = from ? placementOf(from.custom).folderId : null;
    if (before === folderId) return;
    void session.file(threadId, folderId).then((res) => {
      const name = folderId === null ? null : (list.find((f) => f.id === folderId)?.name ?? null);
      announce(
        res.ok
          ? filedMessage(title, name, folderPath(list, before) ?? undefined)
          : res.error.message,
      );
    });
  };
  const choose = (next: PanelNode) => {
    memory.choose(next);
    setQuery("");
  };
  const setOpen = (target: PanelNode, open: boolean) => {
    if (target.kind === "current") memory.setCurrentOpen(open);
    else if (target.kind === "folder") memory.setFolderOpen(target.id, open);
  };

  // A thread's title opens it: once assistant-ui has switched, the panel closes onto it.
  const chooseOnClick = (e: MouseEvent) => {
    if (!(e.target instanceof Element) || e.defaultPrevented) return;
    if (e.target.closest(`.${chat.threadTrigger}`) === null) return;
    const threadId = e.target.closest("[data-kobe-thread]")?.getAttribute("data-kobe-thread");
    if (threadId) queueMicrotask(() => onChosen(threadId));
  };

  const archived = listed.flatMap((t, index) =>
    placementOf(t.custom).archived ? [{ id: t.id, index }] : [],
  );
  const archivedNotes = new Map(
    archived.flatMap(({ id }) => {
      const t = listed.find((l) => l.id === id);
      if (!t) return [];
      const remoteId = items.find((i) => i.id === t.id)?.remoteId;
      const path = folderPath(list, placementOf(t.custom).folderId);
      return remoteId && path ? [[remoteId, <FolderNote key={t.id} path={path} />] as const] : [];
    }),
  );
  const chosenPlaced =
    node.kind === "folder" ? placed.find((p) => p.folder.id === node.id) : undefined;
  /** Where a thread without a row is (spec §5: "3 in Archived"). */
  const placeOf = (threadId: string): string | null => {
    const local = items.find((i) => i.remoteId === threadId)?.id;
    const t = local === undefined ? undefined : listed.find((l) => l.id === local);
    if (!t) return trashIds.includes(local ?? "") ? "Deleted" : null;
    const p = placementOf(t.custom);
    if (p.archived) return "Archived";
    return p.folderId === null ? "Current" : (folderPath(list, p.folderId) ?? null);
  };
  // "Used in" (KOBE-612): the panel closes onto the thread, as for a search hit not yet listed.
  const openThread = (threadId: string) => onChosen(threadId);

  const treeColumn = wide ? (
    <nav aria-label="Folders" className="flex min-w-0 flex-col gap-2">
      <FolderTree
        rows={tree.rows}
        chosen={node}
        choose={choose}
        setOpen={setOpen}
        bindings={(row) => (row.placed ? actions.bindings(row.placed) : null)}
        onDropThread={fileByDrop}
      />
      <FolderEditor actions={actions} announce={announce} />
      <button
        type="button"
        className="self-start px-1 text-sm underline"
        onClick={() => actions.startNew(null)}
      >
        + New folder
      </button>
    </nav>
  ) : (
    <div className="flex flex-col gap-2">
      <FolderPicker
        placed={placed}
        counts={tree.counts}
        chosen={node}
        choose={choose}
        onNewFolder={() => actions.startNew(null)}
        chosenBindings={chosenPlaced ? actions.bindings(chosenPlaced) : null}
        chosenName={chosenPlaced?.folder.name ?? ""}
      />
      <FolderEditor actions={actions} announce={announce} />
    </div>
  );

  return (
    <RailAnnounce.Provider value={announce}>
      <ThreadFileMap.Provider value={fileMap}>
        <ThreadListPrimitive.Root className="flex min-h-full flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              type="search"
              aria-label="Search threads"
              placeholder="Search threads"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            />
            <IconAction
              command="export-threads"
              href={threadExportUrl(session.teamId)}
              download
              description="This team's, as Pi sessions and Markdown in a zip"
              size="sm"
              side="left"
              variant={RAIL_ACTION_VARIANT}
              className={RAIL_ACTION}
            />
          </div>
          <div
            ref={bodyRef}
            className={
              threeRails
                ? "relative grid min-w-0 grid-cols-[200px_1px_minmax(0,1fr)_1px_minmax(220px,0.8fr)] gap-3"
                : wide
                  ? "grid min-w-0 grid-cols-[220px_1px_minmax(0,1fr)] gap-3"
                  : "flex flex-col gap-2"
            }
            data-kobe-threads-body={threeRails ? "three-rails" : wide ? "two-rails" : "dropdown"}
          >
            {treeColumn}
            {wide && <div aria-hidden className="bg-border w-px self-stretch" />}
            {/* Sees the clicks of the rows' own title buttons (Enter on a button is one). */}
            <div ref={threadsRef} className="min-w-0" onClick={chooseOnClick}>
              {listError && <ErrorNotice error={listError} />}
              {projects.failed && (
                <p className={chat.hint} role="status">
                  Project names could not be loaded.
                </p>
              )}
              {searching ? (
                <SearchHits state={search.state} more={search.more} folders={list} />
              ) : (
                <NodeList
                  node={node}
                  groups={groups}
                  archived={archived}
                  archivedNotes={archivedNotes}
                  trash={trashIds.map((id, index) => ({ id, index }))}
                  loading={loading}
                  hasMore={hasMore && (node.kind === "current" || node.kind === "folder")}
                  hasSubfolders={(chosenPlaced?.childCount ?? 0) > 0}
                  isOpen={(g: ThreadGroup) => !memory.flipped(g.key)}
                  onToggle={(g: ThreadGroup) => memory.flip(g.key)}
                  onMove={moveByDrop}
                />
              )}
              <p role="status" className="sr-only" data-kobe-rail-status="">
                {announcement}
              </p>
            </div>
            {threeRails && filesApi && (
              <FileMapLayer
                filesApi={filesApi}
                linksApi={session.api}
                workspaceName={workspaceName}
                links={links}
                shownThreads={shownThreads}
                pins={pins}
                map={fileMap}
                bodyRef={bodyRef}
                threadsRef={threadsRef}
                railRef={railRef}
                titleOf={titleOf}
                placeOf={placeOf}
                openThread={openThread}
              />
            )}
          </div>
        </ThreadListPrimitive.Root>
      </ThreadFileMap.Provider>
    </RailAnnounce.Provider>
  );
}
