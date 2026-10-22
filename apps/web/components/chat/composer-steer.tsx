"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { useDictation, type Dictation } from "../../lib/chat/dictation";
import { textAfterSend } from "../../lib/chat/after-send";
import { isBusy } from "../../lib/chat/thread-state";
import { useDraftFiles } from "./attachment-chips";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";

const DictationContext = createContext<Dictation | null>(null);

/** Text an app put in the composer that the member has not changed or confirmed yet (KOBE-439). */
export interface PendingInsert {
  readonly from: string;
  /** The text the app inserted. */
  readonly insert: string;
  /** The composer's whole text right after the insert. */
  readonly text: string;
  /** When it was inserted (`Date.now()`): edits before {@link INSERT_SETTLE_MS} never lift it. */
  readonly at: number;
}

export interface InsertGate {
  readonly pending: PendingInsert | null;
  set(pending: PendingInsert | null): void;
}

const InsertGateContext = createContext<InsertGate | null>(null);

/** Why the composer cannot send or steer while an app's insert waits for the member. */
export const INSERT_PENDING = "Edit or confirm the text the app inserted first.";

/**
 * One dictation per composer, shared by the composer (mic button, sends) and the steering panel
 * (Steer now), so every way of sending the text stops it (CE10, KOBE-206).
 */
export function ComposerDictationProvider({ children }: { readonly children: ReactNode }) {
  const aui = useAui();
  const dictation = useDictation((t) => aui.composer.setText(t));
  const [pending, setPending] = useState<PendingInsert | null>(null);
  const gate = useMemo<InsertGate>(() => ({ pending, set: setPending }), [pending]);
  return (
    <DictationContext.Provider value={dictation}>
      <InsertGateContext.Provider value={gate}>{children}</InsertGateContext.Provider>
    </DictationContext.Provider>
  );
}

/**
 * The composer's app-insert gate (KOBE-439 review MEDIUM-2, LOW-L): shared by the composer (Enter,
 * Send, Queue) and every way of steering (the chord, the command, the panel's Steer now).
 */
export function useInsertGate(): InsertGate {
  const gate = useContext(InsertGateContext);
  if (!gate) throw new Error("useInsertGate needs a ComposerDictationProvider");
  return gate;
}

export function useComposerDictation(): Dictation {
  const dictation = useContext(DictationContext);
  if (!dictation) throw new Error("useComposerDictation needs a ComposerDictationProvider");
  return dictation;
}

export interface Steer {
  /** Sends the composer's text into the running agent; clears it once the server took it. */
  readonly steer: () => Promise<void>;
  /** Why Steer now can't send right now, or undefined when it can. */
  readonly unavailable: string | undefined;
}

/**
 * Steer now (D17, CE10): the composer's text goes to the running agent at its next safe point.
 * One helper for Ctrl/Cmd+Shift+Enter in the composer and the panel's Steer now button. A steer
 * carries text only, so with files attached the message has to be queued instead.
 */
export function useSteer(extras: KobeThreadExtras): Steer {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const files = useDraftFiles(remoteId ?? NEW_DRAFT);
  const dictation = useComposerDictation();
  const session = useChatSession();
  const gate = useInsertGate();
  const { controller, state } = extras;
  const content = text.trim();
  const unavailable =
    gate.pending !== null
      ? INSERT_PENDING
      : files.length > 0
        ? "Files can't be steered in: queue the message instead."
        : content === ""
          ? "Type in the message box first."
          : isBusy(state, "steer")
            ? "Sending the last steer…"
            : undefined;
  const steer = async () => {
    if (!controller || unavailable !== undefined) return;
    dictation.stop();
    const draft = remoteId ?? NEW_DRAFT;
    const mentions = session.mentions.forText(draft, content);
    if (await controller.steer(content, mentions)) {
      // Only what went: text and mentions added during the send stay (KOBE-415).
      const remaining = textAfterSend(aui.composer.getState().text, text);
      session.mentions.settleSent(draft, mentions, remaining);
      aui.composer.setText(remaining);
    }
  };
  return { steer, unavailable };
}
