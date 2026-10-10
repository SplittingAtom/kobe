"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createProjectsApi } from "../../lib/projects/api";
import { isBusy } from "../../lib/chat/thread-state";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

/** True for a thread shared to you by someone else (KOBE-163): read it, fork it, nothing more. */
export function isReadOnlyThread(extras: KobeThreadExtras | null | undefined): boolean {
  return extras?.state.summary?.readOnly === true;
}

/**
 * The project side of a thread: for its owner a share-with-the-project switch, for a reader the
 * read-only banner with Fork. Plain text only. The server decides every call; a refusal shows.
 */
export function ProjectBar({
  extras,
  onOpenThread,
}: {
  readonly extras: KobeThreadExtras;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const session = useChatSession();
  const { controller, state } = extras;
  const summary = state.summary;
  if (!summary || !controller || summary.deletedAt != null) return null;

  if (summary.readOnly === true) {
    const fork = async () => {
      const id = await controller.fork();
      if (id === null) return;
      session.threadCreated(); // the list reads again: the fork is yours
      onOpenThread?.(id);
    };
    return (
      <div className={styles.banner} role="note" aria-label="Shared thread">
        <p>
          This conversation is shared with you read-only. You can read it and fork it into your own
          private copy; only its author can continue it.
        </p>
        <button type="button" disabled={isBusy(state, "fork")} onClick={() => void fork()}>
          Fork into my conversations
        </button>
      </div>
    );
  }

  if (summary.projectId === null) return null;
  const shared = summary.visibility === "project" || summary.sharedToProject;
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
        {shared
          ? " Members of the project can read and fork this conversation."
          : " Only you can see this conversation."}
      </span>
      <Link href={`/me/projects/${summary.projectId}`}>Project</Link>
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
