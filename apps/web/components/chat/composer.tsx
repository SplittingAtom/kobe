"use client";

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { MicIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { isThreadRunning } from "../../lib/chat/thread-state";
import { ComposerAttachments } from "./attachment-chips";
import { MentionChips, MentionPicker } from "./mention-picker";
import { useComposerDictation, useSteer } from "./composer-steer";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";
import { ariaKeyShortcuts } from "../../lib/shell/commands";
import { IN_TRASH, READ_ONLY } from "../../lib/chat/thread-commands";
import type { MenuBindings } from "../../lib/shell/menu";
import { shortcutOf } from "../../lib/shell/shortcuts";
import { useBindCommands, useBoundCommands } from "../shell/command-bindings";
import { cn } from "../../lib/utils";
import { ModelPicker } from "./model-picker";
import { SlashMenu } from "./slash-menu";
import styles from "./chat.module.css";
import panelStyles from "./composer.module.css";

const NOTHING_TO_STEER = "Nothing is running to steer.";

/**
 * The composer's own actions for the palette and the shortcuts (CE23, KOBE-225): Go to the message
 * box (Mod+/) and Steer now (Mod+Shift+Enter, which the input itself also handles while a run is
 * on), each with why it can't run.
 */
function composerBindings(
  focus: () => void,
  steer: { readonly run: () => void; readonly unavailable: string | undefined },
  state: { readonly running: boolean; readonly readOnly: boolean; readonly inTrash: boolean },
): MenuBindings {
  const closed = state.readOnly ? READ_ONLY : state.inTrash ? IN_TRASH : null;
  return {
    "focus-composer": { onSelect: focus, blocker: closed },
    steer: {
      onSelect: steer.run,
      blocker: closed ?? (state.running ? (steer.unavailable ?? null) : NOTHING_TO_STEER),
    },
  };
}

/** Up arrow edits the last sent message only from an empty input, the caret at its start. */
function wantsEditLast(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  const el = e.currentTarget;
  return (
    e.key === "ArrowUp" &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    // Safari ends a composition with a keydown that is no longer composing but reports 229.
    !e.nativeEvent.isComposing &&
    e.nativeEvent.keyCode !== 229 &&
    el.value === "" &&
    el.selectionStart === 0 &&
    // An open trigger popover (the @ picker, the / menu) owns the arrows.
    el.getAttribute("aria-expanded") !== "true"
  );
}

/**
 * The composer (D17). Idle: Enter sends. While a run holds the thread the primary button reads
 * **Queue** and Enter queues the message (it runs next, in order); Ctrl/Cmd+Shift+Enter steers it
 * into the running agent at its next safe point. The Steer now and Stop buttons sit in the
 * steering panel above the input (CE10, `steering-panel.tsx`). The text is cleared only
 * once the server accepted it. The mic button dictates into the prompt (`lib/chat/dictation.ts`);
 * sending stops dictation.
 */
export function Composer({
  extras,
  modelPicker = true,
}: {
  readonly extras: KobeThreadExtras;
  /** False in the chat shell, where the model picker sits in bar row two (KOBE-197). */
  readonly modelPicker?: boolean;
}) {
  const aui = useAui();
  const session = useChatSession();
  const text = useAuiState((s) => s.composer.text);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const { controller, state } = extras;
  const running = isThreadRunning(state);
  const inTrash = state.summary?.deletedAt != null;
  const empty = text.trim() === "";
  const dictation = useComposerDictation();
  const { steer, unavailable } = useSteer(extras);
  const draft = remoteId ?? NEW_DRAFT;
  const blocker = session.attachments.blocker(draft);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  // A fork at a prompt opens with that prompt as its draft (KOBE-216), once.
  useEffect(() => {
    if (remoteId === undefined) return;
    const prefill = session.takeComposerDraft(remoteId);
    if (prefill !== undefined) aui.composer.setText(prefill);
  }, [remoteId, session, aui]);

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
    const mentions = session.mentions.forText(draft, text);
    const attach = session.attachments.ready(draft);
    if (await controller.send(text.trim(), undefined, attach, mentions)) {
      session.attachments.sent(draft);
      session.mentions.clear(draft);
      aui.composer.setText("");
    }
  };
  const readOnly = extras.state.summary?.readOnly === true;
  useBindCommands(
    composerBindings(
      () => input.current?.focus(),
      { run: () => void steer(), unavailable },
      { running, readOnly, inTrash },
    ),
  );
  const editLast = useBoundCommands()["edit-last-message"];
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (wantsEditLast(e)) {
      if (editLast?.onSelect && !editLast.blocker) {
        e.preventDefault();
        editLast.onSelect();
      }
      return;
    }
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !running) return;
    // An open trigger popover (the @ picker, the / menu) takes Enter to pick, not to queue.
    if (e.currentTarget.getAttribute("aria-expanded") === "true") return;
    if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void steer();
    } else if (!e.shiftKey) {
      e.preventDefault();
      void queue();
    }
  };

  if (readOnly && !inTrash) {
    return (
      <p className={styles.banner} role="note">
        You are reading a shared conversation. Fork it to ask the agent something of your own.
      </p>
    );
  }

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

  // Trigger popovers (KOBE-223 `@` files, KOBE-224 `/` actions) share the input's keys.
  return (
    <ComposerPrimitive.TriggerPopoverRoot>
      <ComposerPrimitive.Root
        className="relative flex w-full flex-col gap-2"
        onSubmit={() => {
          dictation.stop();
          // A new thread is created by this send: its title is the message's first line.
          if (remoteId === undefined) session.setNextTitle(text);
        }}
      >
        <div
          data-kobe-composer-panel
          data-dragging={dragging || undefined}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            panelStyles.panel,
            "border-foreground/10 data-[dragging]:border-primary data-[dragging]:bg-primary/5 bg-muted/30 flex w-full cursor-text flex-col gap-2 rounded-2xl border p-2",
          )}
        >
          <MentionPicker draft={draft} input={input} />
          <SlashMenu input={input} />
          <ComposerAttachments draft={draft} threadId={remoteId} />
          <MentionChips draft={draft} />
          <label htmlFor="kobe-composer" className="sr-only">
            Message
          </label>
          <ComposerPrimitive.Input
            ref={input}
            id="kobe-composer"
            placeholder={
              running ? "Type to queue a message, or steer the agent" : "Message the agent"
            }
            aria-describedby="kobe-composer-hint"
            aria-keyshortcuts={ariaKeyShortcuts(shortcutOf("focus-composer"))}
            onKeyDown={onKeyDown}
            submitMode="enter"
            rows={1}
            enterKeyHint="send"
            className={cn(
              panelStyles.input,
              "caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none border-0 bg-transparent px-2.5 py-1 text-base leading-6 outline-none focus-visible:shadow-none",
            )}
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
            <IconAction
              command="attach"
              className="size-7 rounded-full"
              onClick={() => picker.current?.click()}
            />
            {modelPicker && (
              <ModelPicker controller={controller} state={state} isNew={remoteId === undefined} />
            )}
            <span className="flex-1" />
            {dictation.supported && (
              <IconAction
                command="dictate"
                label={dictation.listening ? "Stop dictation" : "Dictate"}
                variant={dictation.listening ? "destructive" : "ghost"}
                className="size-7 rounded-full"
                aria-pressed={dictation.listening}
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start(text))}
              >
                <MicIcon
                  aria-hidden
                  className={dictation.listening ? "size-4 animate-pulse" : "size-4"}
                />
              </IconAction>
            )}
            {running ? (
              // CE10: the primary button queues during a run; Steer now and Stop sit in the
              // steering panel above the input.
              <Button
                type="button"
                size="sm"
                className="h-8 rounded-full px-3"
                onClick={() => void queue()}
                disabled={empty || blocker !== undefined}
              >
                Queue
              </Button>
            ) : (
              <ComposerPrimitive.Send asChild>
                <IconAction
                  command="send"
                  type="button"
                  variant="default"
                  className="size-7 rounded-full"
                  disabled={blocker !== undefined}
                />
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
    </ComposerPrimitive.TriggerPopoverRoot>
  );
}
