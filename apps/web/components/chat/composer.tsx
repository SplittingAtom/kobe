"use client";

import { AppContextChips } from "../apps/app-context-chips";
import { appContextBody, insertAt } from "../../lib/apps/app-context";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { MicIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { isThreadRunning } from "../../lib/chat/thread-state";
import { ComposerAttachments } from "./attachment-chips";
import { MentionChips, MentionPicker } from "./mention-picker";
import { useComposerMentionDrop } from "./composer-mention-drop";
import { MENTION_FOLDER_REFUSED } from "../../lib/chat/mention-insert";
import {
  useComposerDictation,
  useInsertGate,
  useSteer,
  type PendingInsert,
} from "./composer-steer";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";
import { ariaKeyShortcuts } from "../../lib/shell/commands";
import { IN_TRASH, READ_ONLY } from "../../lib/chat/thread-commands";
import type { MenuBindings } from "../../lib/shell/menu";
import { shortcutOf } from "../../lib/shell/shortcuts";
import { useBindCommands, useBoundCommands } from "../shell/command-bindings";
import { cn } from "../../lib/utils";
import { ComposerSelectors, useComposerPicker, useFoldedSelectors } from "./composer-selectors";
import { ModelWarning } from "./model-picker";
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
 * sending stops dictation. Its toolbar holds Attach, then the conversation's Agent, Model and
 * Thinking selectors (KOBE-418), folded into one menu on a narrow composer.
 */
export function Composer({
  extras,
  footer,
}: {
  readonly extras: KobeThreadExtras;
  /** The end of the row under the box (the context gauge, KOBE-418); shown under a banner too. */
  readonly footer?: ReactNode;
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
  const filePicker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const folded = useFoldedSelectors(panel);
  const picker = useComposerPicker(extras);
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
  const readOnly = extras.state.summary?.readOnly === true;
  // A workspace row from the Files tree is a mention (KOBE-374); files from the computer attach.
  const rowDrop = useComposerMentionDrop({ draft, text, input, writable: !readOnly && !inTrash });
  const appInsert = useAppInserts(input, text, remoteId, !readOnly && !inTrash);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (rowDrop.over(e) || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    if (rowDrop.drop(e) || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    attach(e.dataTransfer.files);
  };
  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; // into a child
    setDragging(false);
    rowDrop.leave();
  };

  const queue = async () => {
    if (!controller || empty || blocker !== undefined) return;
    dictation.stop();
    const mentions = session.mentions.forText(draft, text);
    const attach = session.attachments.ready(draft);
    const contexts = appContextBody(session.appContexts.forDraft(draft));
    if (await controller.send(text.trim(), undefined, attach, mentions, contexts)) {
      session.attachments.sent(draft);
      session.mentions.clear(draft);
      session.appContexts.clear(draft);
      aui.composer.setText("");
    }
  };
  useBindCommands(
    composerBindings(
      () => input.current?.focus(),
      { run: () => void steer(), unavailable },
      { running, readOnly, inTrash },
    ),
  );
  const editLast = useBoundCommands()["edit-last-message"];
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (rowDrop.notice !== "") rowDrop.clearNotice();
    if (wantsEditLast(e)) {
      if (editLast?.onSelect && !editLast.blocker) {
        e.preventDefault();
        editLast.onSelect();
      }
      return;
    }
    // Text an app inserted is not sent, queued or steered until the member changes or confirms it
    // (MEDIUM-2, LOW-L): only a plain Shift+Enter (a new line) gets through.
    const newLine = e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (e.key === "Enter" && !newLine && appInsert.pending !== null) {
      e.preventDefault();
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

  const footerRow = (hint: ReactNode) => (
    <div data-composer-footer className="flex min-h-6 items-center gap-2 px-2">
      {hint}
      <span data-composer-gauge className="ms-auto flex shrink-0 items-center">
        {footer}
      </span>
    </div>
  );

  if (readOnly && !inTrash) {
    return (
      <div className="flex flex-col gap-1">
        <p className={styles.banner} role="note">
          You are reading a shared conversation. Fork it to ask the agent something of your own.
        </p>
        {footerRow(null)}
      </div>
    );
  }

  if (inTrash) {
    return (
      <div className="flex flex-col gap-1">
        <div className={styles.banner} role="note">
          This conversation is in Trash. Restore it to continue.{" "}
          <button type="button" onClick={() => void aui.threadListItem.unarchive()}>
            Restore
          </button>
        </div>
        {footerRow(null)}
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
          ref={setPanel}
          data-kobe-composer-panel
          data-running={running || undefined}
          data-dragging={dragging || undefined}
          data-mention-drop={rowDrop.rowDrop ?? undefined}
          data-app-insert={appInsert.flash || undefined}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
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
          <AppContextChips draft={draft} />
          {appInsert.pending && (
            <p
              role="note"
              data-kobe-app-insert-from={appInsert.pending.from}
              className="text-muted-foreground m-0 flex items-center gap-2 px-2 text-xs"
            >
              <span>
                From {appInsert.pending.from}: edit the text or confirm it before you send.
              </span>
              <button type="button" className="underline" onClick={appInsert.confirm}>
                Confirm
              </button>
            </p>
          )}
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
          <div data-composer-toolbar className="flex min-w-0 items-center gap-1.5">
            <input
              ref={filePicker}
              type="file"
              multiple
              tabIndex={-1}
              aria-label="Choose files to attach"
              className="sr-only"
              onChange={onPick}
            />
            <IconAction
              command="attach"
              className="size-7 shrink-0 rounded-full"
              onClick={() => filePicker.current?.click()}
            />
            <ComposerSelectors picker={picker} folded={folded} />
            {folded && <span className="flex-1" />}
            {dictation.supported && (
              <IconAction
                command="dictate"
                label={dictation.listening ? "Stop dictation" : "Dictate"}
                variant={dictation.listening ? "destructive" : "ghost"}
                className="size-7 shrink-0 rounded-full"
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
                className="h-8 shrink-0 rounded-full px-3"
                onClick={() => void queue()}
                disabled={empty || blocker !== undefined || appInsert.pending !== null}
              >
                Queue
              </Button>
            ) : (
              <ComposerPrimitive.Send asChild>
                <IconAction
                  command="send"
                  type="button"
                  variant="default"
                  className="size-7 shrink-0 rounded-full"
                  disabled={blocker !== undefined || appInsert.pending !== null}
                />
              </ComposerPrimitive.Send>
            )}
          </div>
          {picker && <ModelWarning picker={picker} />}
        </div>
        {footerRow(
          <p id="kobe-composer-hint" className="text-muted-foreground m-0 min-w-0 text-xs">
            {rowDrop.rowDrop === "file" ? (
              "Drop to mention this file"
            ) : rowDrop.rowDrop === "folder" ? (
              <span role="status">{MENTION_FOLDER_REFUSED}</span>
            ) : rowDrop.notice !== "" ? (
              <span role="status">{rowDrop.notice}</span>
            ) : blocker !== undefined ? (
              <span role="status">{blocker}</span>
            ) : dictation.error ? (
              <span role="alert">{dictation.error}</span>
            ) : dictation.listening ? (
              "Listening… speak your prompt, then press the mic again to stop"
            ) : running ? (
              // Key hints stay on one line (ellipsized on a phone), so the row never grows as a run
              // starts; statuses and errors above still wrap.
              <span className="block truncate">
                Enter queues · Ctrl+Shift+Enter steers · Shift+Enter new line
              </span>
            ) : (
              <span className="block truncate">Enter sends · Shift+Enter new line</span>
            )}
          </p>,
        )}
      </ComposerPrimitive.Root>
    </ComposerPrimitive.TriggerPopoverRoot>
  );
}

/** How long the composer flashes after an app put text in it. */
const INSERT_FLASH_MS = 600;

/**
 * Edits within this long after an insert never lift its gate (KOBE-439 re-review LOW-J): a
 * keystroke the member was already making when the text arrived is not a review of it.
 */
export const INSERT_SETTLE_MS = 800;

/**
 * Whether `text` settles the pending insert: the member cleared the composer, or, once the settle
 * time has passed, changed the inserted text itself. Typing around it does not (LOW-J).
 */
export function settlesInsert(pending: PendingInsert, text: string, now: number): boolean {
  if (text === pending.text) return false;
  if (text.trim() === "") return true;
  return now - pending.at >= INSERT_SETTLE_MS && !text.includes(pending.insert);
}

/**
 * An app's `ui/message` (KOBE-439, spec §8; review MEDIUM-2, coordinator decision): the text goes
 * in at the caret of this thread's composer and **never moves the focus**: an Enter the member
 * presses in the app (or anywhere else) cannot send it. Until the member changes the inserted text
 * or confirms it, it carries a visible "From <app>" marker, and Enter, Send, Queue and every way
 * of steering do nothing (LOW-J, LOW-L). It is never sent by itself. Only a writable composer of a
 * thread listens.
 */
function useAppInserts(
  input: RefObject<HTMLTextAreaElement | null>,
  text: string,
  threadId: string | undefined,
  writable: boolean,
): {
  readonly flash: boolean;
  readonly pending: PendingInsert | null;
  confirm(): void;
} {
  const aui = useAui();
  const session = useChatSession();
  const gate = useInsertGate();
  const [flash, setFlash] = useState(false);
  const latest = useRef(text);
  latest.current = text;
  const setPending = gate.set;
  useEffect(() => {
    if (!writable || threadId === undefined) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = session.composerInserts.listen(threadId, (insert, from) => {
      const el = input.current;
      const caret = el !== null && document.activeElement === el ? el.selectionEnd : undefined;
      const next = insertAt(latest.current, caret ?? latest.current.length, insert);
      aui.composer.setText(next.text);
      setPending({ from, insert, text: next.text, at: Date.now() });
      setFlash(true);
      clearTimeout(timer);
      timer = setTimeout(() => setFlash(false), INSERT_FLASH_MS);
      return true;
    });
    return () => {
      stop();
      clearTimeout(timer);
      setPending(null); // another thread's composer never inherits this one's gate
    };
  }, [session, aui, input, threadId, writable, setPending]);
  const pending = gate.pending;
  // The composer's state shows the inserted text a render later: judge only changes after that.
  const seen = useRef<PendingInsert | null>(null);
  useEffect(() => {
    if (pending === null) return;
    if (text === pending.text) seen.current = pending;
    else if (seen.current === pending && settlesInsert(pending, text, Date.now())) setPending(null);
  }, [pending, text, setPending]);
  const confirm = () => {
    setPending(null);
    input.current?.focus();
  };
  return { flash, pending, confirm };
}
