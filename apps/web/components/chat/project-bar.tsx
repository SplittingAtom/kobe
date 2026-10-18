"use client";

import { IconAction } from "../shell/icon-action";
import { useEffect, useState } from "react";
import { createProjectsApi } from "../../lib/projects/api";
import { isBusy } from "../../lib/chat/thread-state";
import { SHARED_HINT, sharedBy, visibilityOf } from "../../lib/chat/share";
import { AgentChips } from "./agent-chips";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

/** True for a thread shared to you by someone else (KOBE-163): read it, fork it, nothing more. */
export function isReadOnlyThread(extras: KobeThreadExtras | null | undefined): boolean {
  return extras?.state.summary?.readOnly === true;
}

/**
 * The sharing side of a thread (D23, CE20): for a reader the read-only banner naming who shared it
 * and the thread's agent (KOBE-418: its composer has no selectors), with Fork; for its owner a share-with-the-project switch on a project thread, or, while it is
 * shared with the team, a note with Make private (the row menu's Share sets every scope). Plain
 * text only. The server decides every call; a refusal shows.
 */
export function ProjectBar({
  extras,
  onOpenThread,
}: {
  readonly extras: KobeThreadExtras;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const session = useChatSession();
  // A refused fork shows here, once (the thread's error banner stays for the thread's own errors).
  const [forkError, setForkError] = useState<string | null>(null);
  const { controller, state } = extras;
  const summary = state.summary;
  if (!summary || !controller || summary.deletedAt != null) return null;

  if (summary.readOnly === true) {
    const fork = async () => {
      setForkError(null);
      const res = await controller.fork();
      if (!res.ok) {
        setForkError(res.error.message);
        return;
      }
      session.threadCreated(); // the list reads again: the fork is yours
      onOpenThread?.(res.data.threadId);
    };
    return (
      <div className={styles.banner} role="note" aria-label="Shared thread">
        <p>
          {sharedBy(summary.ownerName)} This conversation is shared with you read-only. You can read
          it and fork it into your own private copy; only its author can continue it.
        </p>
        {summary.agentName != null && (
          <p className="flex flex-wrap items-center gap-1.5">
            <AgentChips />
          </p>
        )}
        <button type="button" disabled={isBusy(state, "fork")} onClick={() => void fork()}>
          Fork into my conversations
        </button>
        {forkError !== null && <p role="alert">{forkError}</p>}
      </div>
    );
  }

  const visibility = visibilityOf(summary);
  if (visibility === "team") {
    return (
      <div className={styles.banner} role="group" aria-label="Sharing">
        <span className={styles.hint}>{SHARED_HINT.team}</span>{" "}
        <button
          type="button"
          disabled={isBusy(state, "share")}
          onClick={() => void controller.setVisibility("private")}
        >
          Make private
        </button>
      </div>
    );
  }
  if (summary.projectId === null) return null;
  const shared = visibility === "project";
  return (
    <div className={styles.banner} role="group" aria-label="Sharing">
      <label>
        <input
          type="checkbox"
          checked={shared}
          disabled={isBusy(state, "share")}
          onChange={(e) => void controller.setVisibility(e.target.checked ? "project" : "private")}
        />{" "}
        Share with the project
      </label>
      <span className={styles.hint}>
        {shared ? ` ${SHARED_HINT.project}` : " Only you can see this conversation."}
      </span>
      <IconAction command="open-project" href={`/me/projects/${summary.projectId}`} size="sm" />
    </div>
  );
}

/** On a new conversation started from a project: says which project it will belong to. */
export function DraftProjectNote() {
  const session = useChatSession();
  const projectId = session.draftProjectId;
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (projectId === null) return;
    let current = true;
    void createProjectsApi(session.teamId)
      .get(projectId)
      .then((res) => {
        if (current && res.ok) setName(res.data.name);
      });
    return () => {
      current = false;
    };
  }, [projectId, session]);
  if (projectId === null) return null;
  return (
    <p className={styles.banner} role="note">
      This conversation will be in the project {name ?? "…"}. It stays private until you share it.
    </p>
  );
}
