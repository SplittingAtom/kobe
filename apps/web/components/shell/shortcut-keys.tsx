"use client";

import { useEffect, useRef, useState } from "react";
import { command, type CommandId } from "../../lib/shell/commands";
import type { MenuBindings } from "../../lib/shell/menu";
import {
  isMacPlatform,
  matchedShortcut,
  shortcutAllowed,
  type PressPlace,
} from "../../lib/shell/shortcuts";
import { commandBlocker } from "../../lib/shell/slash";
import { useThreadReadOnly } from "../chat/use-thread-read-only";
import { useBoundCommands } from "./command-bindings";

/** How long a refused shortcut's reason stays on screen. */
export const SHORTCUT_NOTICE_MS = 4_000;

/** Input types that take no typing: a key press there is not text. */
const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type);
  return el.isContentEditable;
}

/** A modal layer is open: the palette, a confirm or form dialog, the rail drawer, a sheet. */
const OPEN_DIALOG =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="dialog"][data-state="open"]';

function placeOf(e: KeyboardEvent): PressPlace {
  const target = e.target instanceof Element ? e.target : null;
  const active = document.activeElement;
  return {
    editing: isTextField(target),
    composer: target?.id === "kobe-composer",
    dialog: document.querySelector(OPEN_DIALOG) !== null,
    // 229: the key an IME reports while it composes (Safari ends composition before keyup).
    composing: e.isComposing || e.keyCode === 229,
    frame: active instanceof HTMLIFrameElement || target instanceof HTMLIFrameElement,
  };
}

interface Notice {
  readonly text: string;
  readonly n: number;
}

/** Runs `id`'s binding, or returns why it can't run (the `/` menu's and palette's rule). */
function runBinding(id: CommandId, bindings: MenuBindings, readOnly: boolean): string | null {
  const cmd = command(id);
  const binding = bindings[id] ?? {};
  const blocker = commandBlocker(cmd, binding, { readOnly });
  if (blocker !== null) return `${binding.label ?? cmd.name}: ${blocker}`;
  binding.onSelect?.();
  return null;
}

/**
 * The CE23 shortcuts (KOBE-225): one keydown listener for the chat that maps a press to its
 * registry command and runs that command's live binding, the very handler its button, the `/`
 * menu and the palette run. Not while typing (only the palette from any field, and Stop and Steer
 * from the message box), during IME composition, over a modal dialog, or from an artifact's
 * iframe (whose keys never reach this page anyway: sandboxed and cross-origin). It listens on the
 * document in the bubbling phase, so a control that handled a key first (Escape in a menu, Enter
 * in the composer) keeps it. A known shortcut that can't run says why and does nothing.
 */
export function ShortcutKeys() {
  const bound = useBoundCommands();
  const readOnly = useThreadReadOnly();
  const latest = useRef({ bound, readOnly });
  useEffect(() => {
    latest.current = { bound, readOnly };
  });
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const match = matchedShortcut(e, mac);
      if (match === null || !shortcutAllowed(match.id, placeOf(e), match.shortcut)) return;
      const { id } = match;
      e.preventDefault();
      const refused = runBinding(id, latest.current.bound, latest.current.readOnly);
      setNotice((prev) => (refused === null ? null : { text: refused, n: (prev?.n ?? 0) + 1 }));
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), SHORTCUT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <p
      role="status"
      data-kobe-shortcut-status=""
      className={
        notice === null
          ? "sr-only"
          : "bg-foreground text-background pointer-events-none fixed bottom-24 left-1/2 z-50 m-0 max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-md px-3 py-1.5 text-sm shadow-lg"
      }
    >
      {notice?.text}
      {/* A repeated reason is still a change screen readers announce. */}
      {notice !== null && notice.n % 2 === 1 ? "\u00a0" : ""}
    </p>
  );
}
