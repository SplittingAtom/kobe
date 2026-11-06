"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBranches } from "../../lib/chat/use-branches";
import { useLineage } from "../../lib/chat/use-lineage";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import { ConversationTreePanel } from "./conversation-tree";
import { TreeCommands } from "./tree-commands";
import { TreeContext, type TreeData } from "./tree-context";

export { useTreeData, type TreeData } from "./tree-context";

/** The panel at an address (the workspace, `/tree`): open while the address says so. */
export interface TreeRoute {
  readonly open: boolean;
  readonly show: () => void;
  readonly close: () => void;
}

/** In memory (a builder test, Workbench or eval pane: no address of its own). */
function useLocalRoute(): TreeRoute {
  const [open, setOpen] = useState(false);
  return useMemo(() => ({ open, show: () => setOpen(true), close: () => setOpen(false) }), [open]);
}

export function TreeHost({
  route,
  onOpenThread,
  children,
}: {
  readonly route?: TreeRoute | undefined;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
  readonly children: ReactNode;
}) {
  const local = useLocalRoute();
  const at = route ?? local;
  const extras = useKobeExtras();
  const session = useContext(ChatSessionContext);
  const threadId = extras?.state.threadId ?? null;
  const branches = useBranches(threadId, session);
  const lineage = useLineage(threadId, session);
  const focusedMessage = useRef<string | null>(null);
  const nodeOfEntry = extras?.projection.nodeOfEntry;
  const labels = branches.notes.labels;
  const byNode = useMemo(() => {
    const out = new Map<string, string>();
    for (const { entry_id, label } of labels) {
      const node = nodeOfEntry?.get(entry_id);
      // The label on the node's own first entry wins (CT9): it is listed under that id.
      if (node !== undefined && (node === entry_id || !out.has(node))) out.set(node, label);
    }
    return out;
  }, [labels, nodeOfEntry]);
  const labelOf = useCallback((id: string) => byNode.get(id), [byNode]);
  const { show, close, open: isOpen } = at;
  // Another thread (or a new draft) on screen closes it; coming back does not reopen it. Before
  // the first thread shows (a reload at /tree) there is nothing to compare with.
  // A thread opened from the panel (a fork row, the fork dialog): the opener owns the navigation
  // (the workspace replaces the address with the fork's), so this effect must not step back too.
  const shownAt = useRef<string | null>(null);
  const switching = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      shownAt.current = null;
      switching.current = false;
      return;
    }
    if (shownAt.current === null || switching.current) shownAt.current = threadId;
    else if (shownAt.current !== threadId) close();
  }, [isOpen, threadId, close]);
  const openThread = useCallback(
    (id: string) => {
      switching.current = true;
      // In memory the panel closes first; at an address the opener's replace closes it.
      if (route === undefined) local.close();
      onOpenThread?.(id);
    },
    [route, local, onOpenThread],
  );
  const data = useMemo<TreeData>(
    () => ({
      notes: branches.notes,
      replaceNotes: branches.replace,
      lineage,
      labelOf,
      open: threadId === null ? null : show,
      focusedMessage,
    }),
    [branches.notes, branches.replace, lineage, labelOf, threadId, show],
  );
  return (
    <TreeContext.Provider value={data}>
      {children}
      {threadId !== null && extras !== undefined && <TreeCommands extras={extras} />}
      {isOpen && extras !== undefined && extras.state.threadId !== null && (
        <ConversationTreePanel
          extras={extras}
          data={data}
          onClose={close}
          onOpenThread={openThread}
        />
      )}
    </TreeContext.Provider>
  );
}
