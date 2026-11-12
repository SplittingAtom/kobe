"use client";

import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { consolePortalContainer } from "../chat-portal";
import { Button } from "./button";
import { focusable } from "./focus-return";

/**
 * A detail panel that slides in at the side of a console page (KOBE-641: a connector's details),
 * beside `Dialog` for small forms. Radix Dialog like the workspace panel it opens over: named by its
 * title, focus trapped inside, Escape, Close and a press on the dimmed page close it, and focus
 * returns to `returnFocus` (the control that opened it). Mounts in the console root (KOBE-281
 * portal theming); an Escape here never reaches the workspace panel underneath (use-modal-layer
 * leaves portalled layers alone). Full width on a narrow window.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  children,
  returnFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The accessible name and heading ("Connector catalyst"). */
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  /** The control to focus on close (read then, so a ref works: `() => ref.current`). */
  readonly returnFocus?: () => HTMLElement | null;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal container={consolePortalContainer()}>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-console-overlay" />
        <RadixDialog.Content
          data-slot="console-side-panel"
          className="fixed top-0 right-0 z-50 box-border h-dvh w-[min(44rem,100vw)] overflow-y-auto border-l border-console-border bg-console-bg p-5 text-console-fg shadow-lg"
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(event) => {
            const control = returnFocus?.() ?? null;
            if (control && focusable(control)) {
              event.preventDefault();
              control.focus();
            }
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <RadixDialog.Title className="m-0 min-w-0 text-lg font-semibold break-words">
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button size="sm">Close</Button>
            </RadixDialog.Close>
          </div>
          {description && (
            <RadixDialog.Description className="m-0 mt-1 text-sm text-console-muted">
              {description}
            </RadixDialog.Description>
          )}
          <div className="mt-2">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
