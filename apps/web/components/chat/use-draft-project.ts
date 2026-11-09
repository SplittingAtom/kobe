"use client";

import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { DraftProjectIssue } from "../../lib/chat/session";
import { createProjectsApi, type Project } from "../../lib/projects/api";
import { ChatSessionContext, useChatSession } from "./kobe-runtime";

/** The draft's project id and the refusal of its last send (NC5), re-read when either changes. */
export function useDraftProjectState(): {
  readonly projectId: string | null;
  readonly issue: DraftProjectIssue | null;
} {
  const session = useChatSession();
  const projectId = useSyncExternalStore(
    session.subscribeDraftProject,
    () => session.draftProjectId,
    () => null,
  );
  const issue = useSyncExternalStore(
    session.subscribeDraftProject,
    () => session.draftProjectIssue,
    () => null,
  );
  return { projectId, issue };
}

/** The workspace's live projects (every non-archived one the API returns), or null while loading. */
export function useWorkspaceProjects(wanted: boolean): readonly Project[] | null {
  const session = useChatSession();
  const [projects, setProjects] = useState<readonly Project[] | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    session.projects().then(
      (res) => {
        if (current && res.ok) setProjects(res.data);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [session, wanted]);
  return projects;
}

/** The draft's project name (null: none yet, or still loading). */
export function useDraftProjectName(projectId: string | null): string | null {
  const session = useChatSession();
  const projects = useWorkspaceProjects(projectId !== null);
  const [fetched, setFetched] = useState<{ id: string; name: string } | null>(null);
  const listed = projects?.find((p) => p.id === projectId)?.name ?? null;
  useEffect(() => {
    // Not in the live list (archived, or access lost): ask for it by id so the header still names it.
    if (projectId === null || projects === null || listed !== null) return;
    let current = true;
    void createProjectsApi(session.teamId)
      .get(projectId)
      .then((res) => {
        if (current && res.ok) setFetched({ id: projectId, name: res.data.name });
      });
    return () => {
      current = false;
    };
  }, [session, projectId, projects, listed]);
  if (projectId === null) return null;
  return listed ?? (fetched?.id === projectId ? fetched.name : null);
}

/**
 * Ends the draft's project (NC4): what New conversation does before it opens a fresh draft. Needed
 * beyond `onThreadIdChange`, which says nothing when a new draft is already on screen. A no-op
 * without a chat session.
 */
export function useEndDraftProject(): () => void {
  const session = useContext(ChatSessionContext);
  return useCallback(() => session?.setDraftProject(null), [session]);
}
