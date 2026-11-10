"use client";

import { useAui } from "@assistant-ui/react";
import { useContext, useSyncExternalStore } from "react";
import type { ProjectRef } from "../projects/project-work";
import { isThreadRunning, queuedRuns } from "../../lib/chat/thread-state";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import { ThreadOnScreenContext } from "./thread-on-screen";

const noSubscribe = () => () => {};
const NOT_MOVABLE = "Wait for the current run to finish: it uses the current project.";

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

  return { activeProjectId, newConversationIn, moveHere };
}
