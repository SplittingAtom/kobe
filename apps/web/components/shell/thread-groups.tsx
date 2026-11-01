"use client";

import { useAuiState } from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PanelNode } from "../../lib/chat/folder-tree";
import {
  groupThreads,
  placementOf,
  type ListedThread,
  type ThreadGroup,
} from "../../lib/chat/thread-groups";
import { createProjectsApi } from "../../lib/projects/api";
import { useChatSession } from "../chat/kobe-runtime";
import { useListedThreads } from "./use-listed-threads";

export interface ProjectNames {
  readonly names: ReadonlyMap<string, string>;
  /** The last read failed: the groups fall back to "Project". */
  readonly failed: boolean;
}

const NO_NAMES: ProjectNames = { names: new Map(), failed: false };

/**
 * Project names for the groups: read when the projects in the list change, when the window
 * regains focus (a rename or a new project elsewhere) and per team; another team's never show.
 */
function useProjectNames(teamId: string, ids: string, fetchFn: typeof fetch | undefined) {
  const [state, setState] = useState<ProjectNames & { readonly teamId: string }>({
    ...NO_NAMES,
    teamId,
  });
  const [focused, setFocused] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocused((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    if (ids === "") return;
    let current = true;
    void createProjectsApi(teamId, fetchFn)
      .list(true)
      .then((res) => {
        if (!current) return;
        if (res.ok) {
          setState({ teamId, names: new Map(res.data.map((p) => [p.id, p.name])), failed: false });
          return;
        }
        console.warn("rail: could not read the project names", res.error);
        setState((prev) => ({
          teamId,
          names: prev.teamId === teamId ? prev.names : new Map(),
          failed: true,
        }));
      });
    return () => {
      current = false;
    };
  }, [teamId, ids, fetchFn, focused]);
  return state.teamId === teamId && ids !== "" ? state : NO_NAMES;
}

export interface ThreadGroupsApi {
  /**
   * The chosen node's groups in the rail's order (CE5, KOBE-536 TF6): `Current`'s, or the chosen
   * folder's; what the Threads panel shows and Mod+[ / Mod+] step through. Never Archived or
   * Trash (the tree's own nodes).
   */
  readonly groups: readonly ThreadGroup[];
  readonly projects: ProjectNames;
  /** The node chosen in the Threads panel (TF7; in memory per tab). */
  readonly node: PanelNode;
  /** Every listed thread (not Trash) with its placement, and Trash. */
  readonly listed: readonly ListedThread[];
  readonly trashIds: readonly string[];
}

const ThreadGroupsContext = createContext<ThreadGroupsApi | null>(null);

/**
 * The rail's thread groups, read once for the chat (KOBE-198; shared since KOBE-225): the listed
 * threads, Trash, and project names (one read for the rail and the previous/next keys), grouped
 * in the rail's fixed order with projects sorted by name.
 */
export function ThreadGroupsProvider({
  fetchFn,
  children,
}: {
  readonly fetchFn: typeof fetch | undefined;
  readonly children: ReactNode;
}) {
  const session = useChatSession();
  const trashIds = useAuiState((s) => s.threads.archivedThreadIds);
  const listed = useListedThreads();
  const projectIds = [
    ...new Set(listed.map((t) => placementOf(t.custom).projectId).filter((p) => p !== null)),
  ]
    .sort()
    .join(",");
  const projects = useProjectNames(session.teamId, projectIds, fetchFn);
  const memory = session.panelMemory;
  useSyncExternalStore(memory.subscribe, memory.getVersion, memory.getVersion);
  const node = memory.node;
  const folderId = node.kind === "folder" ? node.id : null;
  const value = useMemo(
    () => ({
      groups: groupThreads(listed, trashIds, (id) => projects.names.get(id), { folderId }),
      projects,
      node,
      listed,
      trashIds,
    }),
    [listed, trashIds, projects, node, folderId],
  );
  return <ThreadGroupsContext.Provider value={value}>{children}</ThreadGroupsContext.Provider>;
}

export function useThreadGroups(): ThreadGroupsApi {
  const groups = useContext(ThreadGroupsContext);
  if (!groups) throw new Error("useThreadGroups needs a ThreadGroupsProvider");
  return groups;
}
