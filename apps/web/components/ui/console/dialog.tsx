"use client";

import { Dialog as RadixDialog } from "radix-ui";
import type { ReactNode } from "react";
import { consolePortalContainer } from "../chat-portal";
import { focusable } from "./focus-return";

/**
 * A modal dialog that holds a small form (KOBE-321: Save version), beside `ConfirmDialog` for
 * yes/no questions. Radix Dialog: named by its title, focus trapped inside and, on close, returned
 * to `returnFocus` (the control that opened it: Safari doesn't focus a clicked button, so it is
 * passed, not guessed), Escape and Cancel close it. Mounts in the console root (KOBE-281
 * portal theming), so it takes the console's font and both themes. The caller renders the form
 * with its buttons in `children`, Cancel as `<DialogClose asChild><Button>Cancel</Button></DialogClose>`.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  returnFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
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
          data-slot="console-dialog"
          className="fixed top-1/2 left-1/2 z-50 box-border max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-console-border bg-console-bg p-5 text-console-fg shadow-lg"
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(event) => {
            const control = returnFocus?.() ?? null;
            if (control && focusable(control)) {
              event.preventDefault();
              control.focus();
            }
          }}
        >
          <RadixDialog.Title className="m-0 text-lg font-semibold">{title}</RadixDialog.Title>
          {description && (
            <RadixDialog.Description className="m-0 mt-2 text-console-muted">
              {description}
            </RadixDialog.Description>
          )}
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Closes the dialog it is in (wrap the Cancel button, `asChild`). */
export const DialogClose = RadixDialog.Close;
