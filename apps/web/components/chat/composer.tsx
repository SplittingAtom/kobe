"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUpIcon, MicIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { useDictation } from "../../lib/chat/dictation";
import { isBusy, isThreadRunning } from "../../lib/chat/thread-state";
import { ComposerAttachments, useDraftFiles } from "./attachment-chips";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { Button } from "../ui/button";
import { ModelPicker } from "./model-picker";
import styles from "./chat.module.css";

/**
 * The composer (D17). Idle: Enter sends. While a run holds the thread: Enter **queues** the message
 * (it runs next, in order), "Steer now" (Ctrl/Cmd+Shift+Enter) injects it into the running agent
 * at its next safe point, and Stop cancels the run (queued messages stay). The text is cleared only
 * once the server accepted it. The mic button dictates into the prompt (`lib/chat/dictation.ts`);
 * sending stops dictation.
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
  const dictation = useDictation((t) => aui.composer.setText(t));
  const draft = remoteId ?? NEW_DRAFT;
  const files = useDraftFiles(draft);
  const blocker = session.attachments.blocker(draft);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const attach = (list: FileList | null) => {
    if (list && list.length > 0) session.attachments.add(draft, [...list], remoteId);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    attach(e.target.files);
    e.target.value = ""; // the same file can be picked again after removing it
  };
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    attach(e.dataTransfer.files);
  };

  const queue = async () => {
    if (!controller || empty || blocker !== undefined) return;
    dictation.stop();
    if (await controller.send(text.trim(), undefined, session.attachments.ready(draft))) {
      session.attachments.sent(draft);
      aui.composer.setText("");
    }
  };
  const steer = async () => {
    if (!controller || empty) return;
    dictation.stop();
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
        dictation.stop();
        // A new thread is created by this send: its title is the message's first line.
        if (remoteId === undefined) session.setNextTitle(text);
      }}
    >
      <div
        data-dragging={dragging || undefined}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="border-foreground/10 focus-within:border-foreground/25 data-[dragging]:border-primary data-[dragging]:bg-primary/5 bg-muted/30 flex w-full cursor-text flex-col gap-2 rounded-2xl border p-2 transition-[border-color]"
      >
        <ComposerAttachments draft={draft} threadId={remoteId} />
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
          <input
            ref={picker}
            type="file"
            multiple
            tabIndex={-1}
            aria-label="Choose files to attach"
            className="sr-only"
            onChange={onPick}
          />
          <TooltipIconButton
            tooltip="Attach files"
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 rounded-full"
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon className="size-4" />
          </TooltipIconButton>
          <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
          <span className="flex-1" />
          {dictation.supported && (
            <TooltipIconButton
              tooltip={dictation.listening ? "Stop dictation" : "Dictate"}
              type="button"
              variant={dictation.listening ? "destructive" : "ghost"}
              size="icon"
              className="size-7 rounded-full"
              aria-pressed={dictation.listening}
              onClick={() => (dictation.listening ? dictation.stop() : dictation.start(text))}
            >
              <MicIcon className={dictation.listening ? "size-4 animate-pulse" : "size-4"} />
            </TooltipIconButton>
          )}
          {running ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full px-3"
                onClick={() => void queue()}
                disabled={empty || blocker !== undefined}
              >
                Queue
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-full px-3"
                onClick={() => void steer()}
                disabled={empty || isBusy(state, "steer") || files.length > 0}
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
                disabled={blocker !== undefined}
              >
                <ArrowUpIcon className="size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
      <p id="kobe-composer-hint" className="text-muted-foreground px-2 text-xs">
        {blocker !== undefined ? (
          <span role="status">{blocker}</span>
        ) : dictation.error ? (
          <span role="alert">{dictation.error}</span>
        ) : dictation.listening ? (
          "Listening… speak your prompt, then press the mic again to stop"
        ) : running ? (
          "Enter queues · Ctrl+Shift+Enter steers · Shift+Enter new line"
        ) : (
          "Enter sends · Shift+Enter new line"
        )}
      </p>
    </ComposerPrimitive.Root>
  );
}
