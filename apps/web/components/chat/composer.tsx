"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { isBusy, isThreadRunning } from "../../lib/chat/thread-state";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { Button } from "../ui/button";
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
      className="relative flex w-full flex-col gap-2"
      onSubmit={() => {
        // A new thread is created by this send: its title is the message's first line.
        if (remoteId === undefined) session.setNextTitle(text);
      }}
    >
      <div className="border-foreground/10 focus-within:border-foreground/25 bg-muted/30 flex w-full cursor-text flex-col gap-2 rounded-2xl border p-2 transition-[border-color]">
        <label htmlFor="kobe-composer" className="sr-only">
          Message
        </label>
        <ComposerPrimitive.Input
          id="kobe-composer"
          placeholder={
            running ? "Type to queue a message, or steer the agent" : "Message the agent"
          }
          aria-describedby="kobe-composer-hint"
          onKeyDown={onKeyDown}
          submitMode="enter"
          rows={1}
          enterKeyHint="send"
          className="caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none border-0 bg-transparent px-2.5 py-1 text-base leading-6 outline-none focus-visible:shadow-none"
        />
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
          <span className="flex-1" />
          {running ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full px-3"
                onClick={() => void queue()}
                disabled={empty}
              >
                Queue
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full px-3"
                onClick={() => void steer()}
                disabled={empty || isBusy(state, "steer")}
              >
                Steer now
              </Button>
              <TooltipIconButton
                tooltip="Stop"
                type="button"
                variant="default"
                size="icon"
                className="size-7 rounded-full"
                onClick={() => void controller?.stop()}
                disabled={isBusy(state, "stop")}
              >
                <SquareIcon className="size-3.5 fill-current" />
              </TooltipIconButton>
            </>
          ) : (
            <ComposerPrimitive.Send asChild>
              <TooltipIconButton
                tooltip="Send"
                type="button"
                variant="default"
                size="icon"
                className="size-7 rounded-full"
              >
                <ArrowUpIcon className="size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
      <p id="kobe-composer-hint" className="text-muted-foreground px-2 text-xs">
        {running
          ? "Enter queues · Ctrl+Shift+Enter steers · Shift+Enter new line"
          : "Enter sends · Shift+Enter new line"}
      </p>
    </ComposerPrimitive.Root>
  );
}
