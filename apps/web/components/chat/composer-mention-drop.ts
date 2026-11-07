"use client";

import { useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { ITEM_REFERENCES_MAX } from "@kobe/protocol";
import type { FrameDrag } from "../../lib/apps/frame-drag";
import { appMessageOf } from "../../lib/apps/host-bridge";
import {
  carriesLakehouseItem,
  droppedLakehouseItem,
  LAKEHOUSE_DROP_FROM,
  LAKEHOUSE_DROP_REFUSED,
  lakehouseItemContent,
  lakehouseItemContentOf,
} from "../../lib/apps/lakehouse-drop";
import {
  insertMention,
  MENTION_FOLDER_REFUSED,
  mentionRefusal,
} from "../../lib/chat/mention-insert";
import { carriesWorkspaceFolder, carriesWorkspaceRow, droppedRowPath } from "../../lib/files/drag";
import type { ChatSession } from "../../lib/chat/session";
import { applyAppMessage } from "../apps/use-app-composer";
import { useFrameDrop } from "./composer-frame-drop";
import { useChatSession } from "./kobe-runtime";

/**
 * What a drag hovering over the composer would do: a workspace row is mentioned or refused; a
 * Lakehouse Picker item (KOBE-551) is inserted.
 */
export type RowDrop = "file" | "folder" | "item" | null;

export const LAKEHOUSE_DROP_FULL = `A message can reference at most ${ITEM_REFERENCES_MAX} items.`;

/**
 * A Lakehouse Picker item into the composer of `draft` (KOBE-551, KOBE-553): the click's
 * `ui/message` content through the bridge's `appMessageOf` and the same `applyAppMessage`, so
 * exactly the click's composer state (the chip, `references` on send; no text, the focus stays).
 * The item is the dropped JSON (native drop) or the object a bridge drag carried. The answer is
 * why it was refused.
 */
export function insertLakehouseItem(
  session: ChatSession,
  draft: string,
  item: string | Readonly<Record<string, unknown>>,
  from: string,
): string | undefined {
  const content =
    typeof item === "string" ? lakehouseItemContent(item) : lakehouseItemContentOf(item);
  const message = content === undefined ? undefined : appMessageOf(content);
  if (message === undefined || message.items.length === 0) return LAKEHOUSE_DROP_REFUSED;
  return applyAppMessage(session, draft, message, from) ? undefined : LAKEHOUSE_DROP_FULL;
}

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
 *
 * A Lakehouse Picker item dragged out of its frame (KOBE-551) is taken first: its chip exactly as
 * a click on the picker adds it; an invalid item is refused. So is one an app drags out of its
 * frame with captured pointer events over the bridge (KOBE-553), released over `panel`; its
 * chip says the app's title.
 */
export function useComposerMentionDrop({
  draft,
  text,
  input,
  writable,
  panel = null,
}: {
  readonly draft: string;
  readonly text: string;
  readonly input: RefObject<HTMLTextAreaElement | null>;
  readonly writable: boolean;
  /** The composer panel: the target of a pointer drag out of an app frame (KOBE-553). */
  readonly panel?: HTMLElement | null;
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

  const insertItem = useCallback(
    (
      item: string | Readonly<Record<string, unknown>>,
      from: string = LAKEHOUSE_DROP_FROM,
    ): string | undefined => insertLakehouseItem(session, draft, item, from),
    [session, draft],
  );
  useFrameDrop({
    panel,
    writable,
    over: useCallback((over: boolean) => {
      setRowDrop(over ? "item" : null);
      if (over) setNotice("");
    }, []),
    drop: useCallback(
      (drag: FrameDrag) => setNotice(insertItem(drag.item, drag.from) ?? ""),
      [insertItem],
    ),
  });

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
      if (writable && carriesLakehouseItem(e.dataTransfer)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setRowDrop("item");
        setNotice("");
        return true;
      }
      if (!carriesWorkspaceRow(e.dataTransfer)) return false;
      const folder = carriesWorkspaceFolder(e.dataTransfer);
      e.preventDefault();
      e.dataTransfer.dropEffect = folder ? "none" : "copy";
      setRowDrop(folder ? "folder" : "file");
      setNotice("");
      return true;
    },
    drop(e) {
      // Taken whole, valid or not: the browser never also drops the text/plain copy.
      if (writable && carriesLakehouseItem(e.dataTransfer)) {
        e.preventDefault();
        setRowDrop(null);
        setNotice(insertItem(droppedLakehouseItem(e.dataTransfer)) ?? "");
        return true;
      }
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
