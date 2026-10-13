"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { createContext, useContext, type ReactNode } from "react";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { useDictation, type Dictation } from "../../lib/chat/dictation";
import { isBusy } from "../../lib/chat/thread-state";
import { useDraftFiles } from "./attachment-chips";
import type { KobeThreadExtras } from "./kobe-runtime";

const DictationContext = createContext<Dictation | null>(null);

/**
 * One dictation per composer, shared by the composer (mic button, sends) and the steering panel
 * (Steer now), so every way of sending the text stops it (CE10, KOBE-206).
 */
export function ComposerDictationProvider({ children }: { readonly children: ReactNode }) {
  const aui = useAui();
  const dictation = useDictation((t) => aui.composer.setText(t));
  return <DictationContext.Provider value={dictation}>{children}</DictationContext.Provider>;
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
  const { controller, state } = extras;
  const content = text.trim();
  const unavailable =
    files.length > 0
      ? "Files can't be steered in: queue the message instead."
      : content === ""
        ? "Type in the message box first."
        : isBusy(state, "steer")
          ? "Sending the last steer…"
          : undefined;
  const steer = async () => {
    if (!controller || unavailable !== undefined) return;
    dictation.stop();
    if (await controller.steer(content)) aui.composer.setText("");
  };
  return { steer, unavailable };
}
