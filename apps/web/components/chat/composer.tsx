"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import type { KeyboardEvent } from "react";
import { isBusy, isThreadRunning } from "../../lib/chat/thread-state";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { ModelPicker } from "./model-picker";
import styles from "./chat.module.css";

/**
 * The composer (D17). Idle: Enter sends. While a run holds the thread: Enter **queues** the message
 * (it runs next, in order), "Steer now" (Ctrl/Cmd+Shift+Enter) injects it into the running agent
 * at its next safe point, and Stop cancels the run (queued messages stay). The text is cleared only
 * once the server accepted it.
 */
export function Composer({ extras }: { readonly extras: KobeThreadExtras }) {
  const aui = useAui();
  const session = useChatSession();
  const text = useAuiState((s) => s.composer.text);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const { controller, state } = extras;
  const running = isThreadRunning(state);
  const inTrash = state.summary?.deletedAt != null;
  const empty = text.trim() === "";

  const queue = async () => {
    if (!controller || empty) return;
    if (await controller.send(text.trim())) aui.composer.setText("");
  };
  const steer = async () => {
    if (!controller || empty) return;
    if (await controller.steer(text.trim())) aui.composer.setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !running) return;
    if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void steer();
    } else if (!e.shiftKey) {
      e.preventDefault();
      void queue();
    }
  };

  if (inTrash) {
    return (
      <div className={styles.banner} role="note">
        This conversation is in Trash. Restore it to continue.{" "}
        <button type="button" onClick={() => void aui.threadListItem.unarchive()}>
          Restore
        </button>
      </div>
    );
  }

  return (
    <ComposerPrimitive.Root
      className={styles.composer}
      onSubmit={() => {
        // A new thread is created by this send: its title is the message's first line.
        if (remoteId === undefined) session.setNextTitle(text);
      }}
    >
      <label htmlFor="kobe-composer" className={styles.visuallyHidden}>
        Message
      </label>
      <ComposerPrimitive.Input
        id="kobe-composer"
        placeholder={running ? "Type to queue a message, or steer the agent" : "Message the agent"}
        aria-describedby="kobe-composer-hint"
        onKeyDown={onKeyDown}
        submitMode="enter"
      />
      <div className={styles.composerActions}>
        <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
        <span id="kobe-composer-hint" className={styles.hint}>
          {running
            ? "Enter queues · Ctrl+Shift+Enter steers · Shift+Enter new line"
            : "Enter sends · Shift+Enter new line"}
        </span>
        {running ? (
          <>
            <button type="button" onClick={() => void queue()} disabled={empty}>
              Queue
            </button>
            <button
              type="button"
              onClick={() => void steer()}
              disabled={empty || isBusy(state, "steer")}
            >
              Steer now
            </button>
            <button
              type="button"
              onClick={() => void controller?.stop()}
              disabled={isBusy(state, "stop")}
            >
              Stop
            </button>
          </>
        ) : (
          <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}
