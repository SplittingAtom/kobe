"use client";

import { Dialog } from "radix-ui";
import { useRef, useState } from "react";
import { command, formatShortcut } from "../../lib/shell/commands";
import {
  CE23_SHORTCUTS,
  COMPOSER_KEYS,
  isMacPlatform,
  SHEET_NAMES,
  shortcutOf,
} from "../../lib/shell/shortcuts";
import { Button } from "../ui/button";
import { chatPortalContainer } from "../ui/chat-portal";
import { useBindCommands } from "./command-bindings";

function Keys({ keys, mac }: { readonly keys: string; readonly mac: boolean }) {
  return (
    <kbd className="bg-muted text-foreground rounded border px-1.5 py-0.5 font-mono text-xs">
      {formatShortcut(keys, mac)}
    </kbd>
  );
}

const ROW = "flex items-baseline justify-between gap-4 py-1 text-sm";

/**
 * The `?` sheet (CE23, KOBE-225): the twelve fixed shortcuts in the spec's order, then the message
 * box's own keys. Opened with `?` (outside a text field) or from the palette; a modal dialog that
 * gives the focus back on close.
 */
export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  const before = useRef<Element | null>(null);
  useBindCommands({
    "keyboard-shortcuts": {
      onSelect: () => {
        before.current = document.activeElement;
        setOpen(true);
      },
    },
  });
  const mac = isMacPlatform();
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          data-kobe-portal
          data-kobe-shortcut-sheet
          onCloseAutoFocus={(e) => {
            // Back to what had the focus when `?` (or the palette) opened it.
            const back = before.current;
            before.current = null;
            if (back instanceof HTMLElement && back.isConnected) {
              e.preventDefault();
              back.focus();
            }
          }}
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid max-h-[85vh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border p-5 shadow-lg"
        >
          <Dialog.Title className="m-0 text-base font-semibold">Keyboard shortcuts</Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            Press ? to see them again. They don&apos;t work while you type in a field (except{" "}
            {formatShortcut("Mod+K", mac)}) or while an artifact preview has the focus.
          </Dialog.Description>
          <ul className="m-0 list-none p-0" aria-label="Shortcuts">
            {CE23_SHORTCUTS.map((id) => (
              <li key={id} className={ROW} data-kobe-shortcut={id}>
                <span>{SHEET_NAMES[id] ?? command(id).name}</span>
                <Keys keys={shortcutOf(id)} mac={mac} />
              </li>
            ))}
          </ul>
          <h3 className="m-0 text-sm font-semibold">In the message box</h3>
          <ul className="m-0 list-none p-0" aria-label="Message box keys">
            {COMPOSER_KEYS.map((k) => (
              <li key={k.keys} className={ROW}>
                <span>{k.name}</span>
                <Keys keys={k.keys} mac={mac} />
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
