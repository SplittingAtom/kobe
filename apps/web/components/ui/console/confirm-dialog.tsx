"use client";

import { AlertDialog } from "radix-ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { consolePortalContainer } from "../chat-portal";
import { Button } from "./button";

export interface ConfirmOptions {
  readonly title: string;
  readonly description?: ReactNode;
  /** Names the action: "Revoke", "Remove Ada" — never "OK". */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** `danger` (the default) for removing, revoking, leaving; `primary` otherwise. */
  readonly tone?: "danger" | "primary";
}

/** Where focus goes when the asking control is gone or disabled: the page (ConsoleMain). */
function consoleMain(): HTMLElement | null {
  return document.getElementById("console-main");
}

/** A control that can take focus back: still on the page and not disabled. */
function focusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && !el.matches(":disabled");
}

/**
 * Asks before a change that can't be undone from here (Radix AlertDialog: modal, focus trapped,
 * Escape and Cancel decline). On close, focus returns to the control that asked, or, when the
 * action removed or disabled it, to `fallbackFocus()` (the page's main, by default), so a
 * keyboard user is never dropped at the top of the document. It mounts in the console root
 * (KOBE-281's portal theming, components/ui/chat-portal.ts), so it takes the console's font and
 * both themes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  returnFocus,
  fallbackFocus = consoleMain,
}: ConfirmOptions & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  /** Focused again when the dialog closes (the control that asked), while it can take focus. */
  readonly returnFocus?: HTMLElement | null;
  readonly fallbackFocus?: () => HTMLElement | null;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal container={consolePortalContainer()}>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-console-overlay" />
        <AlertDialog.Content
          data-slot="console-confirm"
          className="fixed top-1/2 left-1/2 z-50 box-border max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-console-border bg-console-bg p-5 text-console-fg shadow-lg"
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={(event) => {
            const target = focusable(returnFocus) ? returnFocus : fallbackFocus();
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <AlertDialog.Title className="m-0 text-lg font-semibold">{title}</AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="m-0 mt-2 text-console-muted">
              {description}
            </AlertDialog.Description>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={tone} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

interface Pending {
  readonly options: ConfirmOptions;
  readonly resolve: (confirmed: boolean) => void;
  readonly returnFocus: HTMLElement | null;
}

/**
 * `confirm(options)` resolves true once the person confirms, false when they cancel or press
 * Escape, when another question replaces it, or when the component unmounts (a team switch
 * re-keys pages). Render the returned dialog once in the component:
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: "Revoke the invitation?", confirmLabel: "Revoke" }))) return;
 */
export function useConfirm(): readonly [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  // The last question stays (closed) after an answer, so the dialog never empties while closing.
  const [state, setState] = useState<{ readonly ask: Pending; readonly open: boolean } | null>(
    null,
  );
  // The unanswered question's resolver, for a replacement or an unmount.
  const unanswered = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(
    () => () => {
      unanswered.current?.(false);
      unanswered.current = null;
    },
    [],
  );

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        unanswered.current?.(false);
        unanswered.current = resolve;
        const active = document.activeElement;
        const returnFocus = active instanceof HTMLElement ? active : null;
        setState({ ask: { options, resolve, returnFocus }, open: true });
      }),
    [],
  );
  const settle = (confirmed: boolean) => {
    if (!state?.open) return;
    state.ask.resolve(confirmed);
    if (unanswered.current === state.ask.resolve) unanswered.current = null;
    setState({ ask: state.ask, open: false });
  };

  const dialog = (
    <ConfirmDialog
      {...(state?.ask.options ?? { title: "", confirmLabel: "" })}
      returnFocus={state?.ask.returnFocus ?? null}
      open={state?.open ?? false}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      onConfirm={() => settle(true)}
    />
  );
  return [confirm, dialog] as const;
}
