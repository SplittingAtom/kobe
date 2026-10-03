"use client";

import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { isThreadRunning, type ThreadState } from "../../lib/chat/thread-state";
import { ErrorNotice } from "../admin/error-notice";
import { Composer } from "./composer";
import { useKobeExtras } from "./kobe-runtime";
import { AssistantMessage, EditComposer, UserMessage } from "./messages";
import { RunPanel } from "./run-panel";
import styles from "./chat.module.css";

function statusLabel(state: ThreadState): string | undefined {
  if (state.summary?.deletedAt != null) return "In Trash";
  if (isThreadRunning(state)) return "Running";
  if (state.interruptedRun !== null || state.summary?.status === "interrupted")
    return "Interrupted";
  return undefined;
}

/** The conversation on screen: the active branch of the entry tree, the run panel and composer. */
export function ThreadView() {
  const extras = useKobeExtras();
  const title = useAuiState((s) => s.threadListItem.title);
  if (!extras) return null;
  const { state } = extras;
  const label = statusLabel(state);

  return (
    <ThreadPrimitive.Root className={styles.thread}>
      <header className={styles.threadHeader}>
        <h2 id="kobe-thread-title" className={styles.threadTitle}>
          {state.threadId === null
            ? "New conversation"
            : (state.summary?.title ?? title ?? "Untitled conversation")}
        </h2>
        {label && <span className={styles.badge}>{label}</span>}
      </header>
      {state.phase === "error" && state.loadError && (
        <div className={styles.footerInner}>
          <ErrorNotice error={state.loadError} />
          {extras.controller && (
            <button type="button" onClick={extras.controller.retryLoad}>
              Try again
            </button>
          )}
        </div>
      )}
      {state.phase === "loading" && (
        <p className={styles.empty} role="status">
          Loading the conversation…
        </p>
      )}
      <ThreadPrimitive.Viewport
        className={styles.viewport}
        role="region"
        aria-labelledby="kobe-thread-title"
      >
        <div className={styles.messages}>
          {state.phase === "ready" && (
            <ThreadPrimitive.Empty>
              <p className={styles.empty}>
                Ask the agent anything. It works in your own isolated workspace, and every tool it
                uses follows your team&apos;s policy.
              </p>
            </ThreadPrimitive.Empty>
          )}
          <ThreadPrimitive.Messages>
            {({ message }) =>
              message.role === "user" ? (
                message.composer.isEditing ? (
                  <EditComposer />
                ) : (
                  <UserMessage />
                )
              ) : (
                <AssistantMessage />
              )
            }
          </ThreadPrimitive.Messages>
        </div>
      </ThreadPrimitive.Viewport>
      <div className={styles.footer}>
        <div className={styles.footerInner}>
          <RunPanel extras={extras} />
          <Composer extras={extras} />
        </div>
      </div>
      <p role="status" aria-live="polite" className={styles.visuallyHidden}>
        {state.announcement}
        {/* A changing no-break space makes a repeated message a change screen readers announce. */}
        {state.announcementSeq % 2 === 1 ? "\u00a0" : ""}
      </p>
    </ThreadPrimitive.Root>
  );
}
