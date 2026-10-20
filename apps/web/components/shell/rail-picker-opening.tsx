"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { callAppTool } from "../../lib/apps/app-api";
import type { RailApp } from "../../lib/apps/app-cards";
import type { ToolCallAnswer } from "../../lib/apps/host-bridge";
import styles from "./rail.module.css";

/**
 * A rail picker's opening tool result (KOBE-460 fix). A card gets its tool input and result from
 * the stored result of the call that opened it; a picker has none, so it calls the app's opening
 * tool (`RailApp.tool`, the one a rail launch calls, MA11) with `{}` through the checked app call
 * route, naming the thread on screen like its other calls. Nothing is stored or written to a
 * thread. Called once per mount (a selection, or the picker shown again after the Files tab or a
 * collapsed rail); StrictMode's second mount shares the call still in flight.
 */
export type PickerOpening =
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly result: unknown }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

const TOOL_ERROR = "its tool returned an error.";
const inflight = new Map<string, Promise<ToolCallAnswer>>();

function openOnce(appId: string, tool: string, teamId: string, threadId: string | null) {
  const key = `${teamId}:${appId}:${tool}:${threadId ?? "new"}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const call = callAppTool(appId, teamId, tool, {}, fetch, threadId)
    .catch((): ToolCallAnswer => ({ ok: false, code: "call_failed", message: "The call failed." }))
    .finally(() => inflight.delete(key));
  inflight.set(key, call);
  return call;
}

export function openingOf(answer: ToolCallAnswer): PickerOpening {
  if (!answer.ok) return { kind: "failed", code: answer.code, message: answer.message };
  if ((answer.result as { isError?: unknown }).isError === true) {
    return { kind: "failed", code: "tool_error", message: TOOL_ERROR };
  }
  return { kind: "open", result: answer.result };
}

/** Opens `app` on mount and on `retry`; `onAnswer` sees the answer with the thread it named. */
function usePickerOpening(
  app: RailApp,
  teamId: string,
  threadId: string | null,
  ready: boolean,
  onAnswer: (answer: ToolCallAnswer, calledFor: string | null) => void,
) {
  const [opening, setOpening] = useState<PickerOpening>({ kind: "opening" });
  const [attempt, setAttempt] = useState(0);
  // Read when the call starts: a thread change later does not reopen the frame.
  const thread = useRef(threadId);
  thread.current = threadId;
  const report = useRef(onAnswer);
  report.current = onAnswer;
  const { appId, tool } = app;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const calledFor = thread.current;
    void openOnce(appId, tool, teamId, calledFor).then((answer) => {
      if (!live) return;
      report.current(answer, calledFor);
      setOpening(openingOf(answer));
    });
    return () => {
      live = false;
    };
  }, [appId, tool, teamId, ready, attempt]);
  const retry = () => {
    setOpening({ kind: "opening" });
    setAttempt((n) => n + 1);
  };
  return { opening, retry };
}

/** Renders `children(result)` once the picker opened; until then a status, or an error and Retry. */
export function OpenedPicker({
  app,
  teamId,
  threadId,
  ready,
  onAnswer,
  children,
}: {
  readonly app: RailApp;
  readonly teamId: string;
  readonly threadId: string | null;
  /** The thread on screen is known (not still loading): the call names the right one. */
  readonly ready: boolean;
  onAnswer(answer: ToolCallAnswer, calledFor: string | null): void;
  children(result: unknown): ReactNode;
}) {
  const { opening, retry } = usePickerOpening(app, teamId, threadId, ready, onAnswer);
  if (opening.kind === "open") return children(opening.result);
  if (opening.kind === "opening") {
    return (
      <p role="status" className={styles.pickerNote}>
        Opening {app.title}…
      </p>
    );
  }
  return (
    <div role="alert" className={styles.pickerNote}>
      {/* A connector off here is said by the caller's note; a gone app re-reads the list. */}
      {opening.code !== "connector_off" && (
        <p>
          {app.title} could not be opened: {opening.message}
        </p>
      )}
      <button type="button" className={styles.pickerRetry} onClick={retry}>
        Retry
      </button>
    </div>
  );
}
