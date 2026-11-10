"use client";

import { useAui } from "@assistant-ui/react";
import { useContext, useSyncExternalStore } from "react";
import type { ProjectRef } from "../projects/project-work";
import { visibilityOf } from "../../lib/chat/share";
import { isThreadRunning, queuedRuns } from "../../lib/chat/thread-state";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import { ThreadOnScreenContext } from "./thread-on-screen";

const noSubscribe = () => () => {};
const NOT_MOVABLE = "Wait for the current run to finish: it uses the current project.";

/**
 * FP3 (amended 2026-11-10): the Files panel shows "editing ●" on project rows only in a
 * conversation that is in a project and shared (project or team). A private one (no project, or
 * shared with no one; a new conversation is private until shared) shows none.
 */
export function showsEditingMarks(
  projectId: string | null,
  summary: Parameters<typeof visibilityOf>[0],
): boolean {
  return projectId !== null && visibilityOf(summary) !== "private";
}

/**
 * What the Files panel needs of the conversation on screen (KOBE-590, FP2, FP4): its project (or
 * the draft's, in a new conversation), whether the member may move it, and the two actions of a
 * project's menu. Needs the chat around it (the rail has it).
 */
export function useConversationProject() {
  const session = useContext(ChatSessionContext);
  const aui = useAui();
  const extras = useKobeExtras();
  const threadId = useContext(ThreadOnScreenContext);
  const draft = useSyncExternalStore(
    session?.subscribeDraftProject ?? noSubscribe,
    () => session?.draftProjectId ?? null,
    () => null,
  );
  const state = extras?.state;
  const summary = state?.summary;
  const onThread = typeof threadId === "string" && summary !== undefined;
  const activeProjectId = typeof threadId === "string" ? (summary?.projectId ?? null) : draft;
  const own = onThread && summary.readOnly !== true;
  const showEditing = onThread && showsEditingMarks(activeProjectId, summary);

  const newConversationIn = session
    ? (project: ProjectRef) => {
        session.setDraftProject(null);
        aui.threads.switchToNewThread();
        session.setDraftProject(project.id);
        // A switch that settles a frame later ends the draft's project again: set it once more.
        setTimeout(() => session.setDraftProject(project.id), 0);
      }
    : undefined;

  const moveHere =
    session && own && summary && typeof threadId === "string"
      ? async (project: ProjectRef): Promise<string | undefined> => {
          const busy =
            summary.status === "running" ||
            (state !== undefined && (isThreadRunning(state) || queuedRuns(state).length > 0));
          if (busy) return NOT_MOVABLE;
          const res = await session.organize(threadId, {
            action: "move",
            projectId: project.id,
          });
          if (res.ok) return undefined;
          return res.error.code === "project_not_found"
            ? "You can't start conversations in that project, so this one can't move there."
            : res.error.message;
        }
      : undefined;

  /**
   * A project was just made from a Files folder (KOBE-586, PF6): the project controls read the
   * list again, and a new conversation with no project yet takes it as its draft project.
   */
  const offerProject = session
    ? (project: ProjectRef) => {
        session.projectsChanged();
        if (typeof threadId !== "string" && session.draftProjectId === null) {
          session.setDraftProject(project.id);
        }
      }
    : undefined;

  return { activeProjectId, showEditing, newConversationIn, moveHere, offerProject };
}
