"use client";

import { useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import {
  insertMention,
  MENTION_FOLDER_REFUSED,
  mentionRefusal,
} from "../../lib/chat/mention-insert";
import { carriesWorkspaceFolder, carriesWorkspaceRow, droppedRowPath } from "../../lib/files/drag";
import { useChatSession } from "./kobe-runtime";

/** What a workspace row hovering over the composer would do: be mentioned, or be refused. */
export type RowDrop = "file" | "folder" | null;

export interface ComposerMentionDrop {
  readonly rowDrop: RowDrop;
  /** Why the last drop or menu mention was refused (shown under the composer), else "". */
  readonly notice: string;
  clearNotice(): void;
  /** Each answers whether the event was a workspace row's (then it is handled). */
  over(e: DragEvent): boolean;
  drop(e: DragEvent): boolean;
  leave(): void;
}

/**
 * Workspace files into the composer (KOBE-374): a row dragged from the Files tree and dropped
 * here, or "Mention in message" in its menu (through the session's `composerMentions`), becomes
 * the same @file mention as a pick (KOBE-223): the marker at the caret and the path in the draft's
 * picked set, so the send carries it in `mentions[]` and the server validates it. Folders and
 * names the rules refuse are refused here with a reason. Only a writable composer listens.
 */
export function useComposerMentionDrop({
  draft,
  text,
  input,
  writable,
}: {
  readonly draft: string;
  readonly text: string;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly writable: boolean;
}): ComposerMentionDrop {
  const aui = useAui();
  const session = useChatSession();
  const [rowDrop, setRowDrop] = useState<RowDrop>(null);
  const [notice, setNotice] = useState("");
  const caretAfter = useRef<number | null>(null);

  const mention = useCallback(
    (path: string): string | undefined => {
      const refused = mentionRefusal(path, "file", session.mentions.forText(draft, text));
      if (refused !== undefined) return refused;
      const caret = input.current?.selectionEnd ?? text.length;
      const next = insertMention(text, caret, path);
      session.mentions.add(draft, path);
      aui.composer.setText(next.text);
      caretAfter.current = next.caret;
      return undefined;
    },
    [aui, session, draft, text, input],
  );

  // One subscription per writable composer; it calls the latest `mention` (which reads the text).
  const latest = useRef(mention);
  useEffect(() => {
    latest.current = mention;
  }, [mention]);
  useEffect(
    () => (writable ? session.composerMentions.listen((path) => latest.current(path)) : undefined),
    [session, writable],
  );

  // Once the text holds the mention: the input takes the focus with the caret after it. A frame
  // later, so a closing rail drawer has given the focus back first.
  useEffect(() => {
    const caret = caretAfter.current;
    if (caret === null) return;
    caretAfter.current = null;
    const frame = requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
    return () => cancelAnimationFrame(frame);
  }, [text, input]);

  return {
    rowDrop,
    notice,
    clearNotice: () => setNotice(""),
    over(e) {
      if (!carriesWorkspaceRow(e.dataTransfer)) return false;
      const folder = carriesWorkspaceFolder(e.dataTransfer);
      e.preventDefault();
      e.dataTransfer.dropEffect = folder ? "none" : "copy";
      setRowDrop(folder ? "folder" : "file");
      setNotice("");
      return true;
    },
    drop(e) {
      if (!carriesWorkspaceRow(e.dataTransfer)) return false;
      e.preventDefault();
      setRowDrop(null);
      const path = droppedRowPath(e.dataTransfer);
      // Browsers fire no drop after a folder's `dropEffect = "none"` (the hover hint says why);
      // kept for any that do.
      if (carriesWorkspaceFolder(e.dataTransfer)) setNotice(MENTION_FOLDER_REFUSED);
      else if (path !== "") setNotice(mention(path) ?? "");
      return true;
    },
    leave: () => setRowDrop(null),
  };
}
