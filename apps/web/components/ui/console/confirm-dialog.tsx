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
function focusable(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && !el.matches(":disabled");
}

/** How long a confirmed action may keep its control disabled before focus stops waiting. */
const REENABLE_WAIT_MS = 15_000;

/**
 * After a confirmed action the asking control is usually disabled while the action runs (the
 * page's pending state) and enabled again once it ends. Focus waits on `interim` (the page's
 * main) meanwhile and returns to the control when it is enabled, unless the person has moved
 * focus elsewhere or the control left the page.
 */
function focusWhenEnabled(target: HTMLElement, interim: HTMLElement | null): void {
  if (typeof MutationObserver === "undefined") return;
  const waiting = () => {
    const active = document.activeElement;
    return active === null || active === document.body || active === interim || active === target;
  };
  const observer = new MutationObserver(() => {
    if (!target.isConnected || !waiting()) return stop();
    if (!target.matches(":disabled")) {
      target.focus();
      stop();
    }
  });
  const timer = setTimeout(() => stop(), REENABLE_WAIT_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(target, { attributes: true, attributeFilter: ["disabled", "aria-busy"] });
}

/**
 * Asks before a change that can't be undone from here (Radix AlertDialog: modal, focus trapped,
 * Escape and Cancel decline). On close, focus returns to the control that asked, or, when the
 * action removed or disabled it, to `fallbackFocus()` (the page's main, by default), so a
 * keyboard user is never dropped at the top of the document; a control that was only disabled
 * while the action ran gets focus back once it is enabled again. It mounts in the console root
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
            const control = returnFocus ?? null;
            if (control && focusable(control)) {
              event.preventDefault();
              control.focus();
              // The action may still disable it (which drops focus): back to it afterwards.
              focusWhenEnabled(control, fallbackFocus());
              return;
            }
            const fallback = fallbackFocus();
            if (fallback) {
              event.preventDefault();
              fallback.focus();
            }
            // Disabled while the confirmed action runs: back to it once it is enabled again.
            if (control?.isConnected) {
              focusWhenEnabled(control, fallback);
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
 * The control an event came from, for `confirm(options, trigger)`: the submit button of a form's
 * submit event, otherwise the element the handler sits on. Safari and macOS Firefox don't focus a
 * button on a mouse click, so `document.activeElement` can't say which control asked.
 */
export function eventTrigger(event: {
  readonly currentTarget: EventTarget | null;
  readonly nativeEvent?: Event;
}): HTMLElement | null {
  if (event.currentTarget instanceof HTMLFormElement) {
    // A form can't take focus: its submit button, when the browser says which one it was.
    const submitter =
      typeof SubmitEvent !== "undefined" && event.nativeEvent instanceof SubmitEvent
        ? event.nativeEvent.submitter
        : null;
    return submitter instanceof HTMLElement ? submitter : null;
  }
  return event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
}

/** Where focus returns: the given trigger, else the focused element, never the bare body. */
function returnTarget(trigger: EventTarget | null | undefined): HTMLElement | null {
  const from = trigger ?? document.activeElement;
  return from instanceof HTMLElement && from !== document.body ? from : null;
}

export type Confirm = (
  options: ConfirmOptions,
  /** The control that asks (`eventTrigger(e)`): focus returns to it when the dialog closes. */
  trigger?: EventTarget | null,
) => Promise<boolean>;

/**
 * `confirm(options, trigger)` resolves true once the person confirms, false when they cancel or
 * press Escape, when another question replaces it, or when the component unmounts (a team switch
 * re-keys pages). Pass the asking control (`eventTrigger(event)`) so focus returns to it even after
 * a mouse click that didn't focus it; without one, the focused element is used. Render the
 * returned dialog once in the component:
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: "Revoke the invitation?", confirmLabel: "Revoke" }, eventTrigger(e)))) return;
 */
export function useConfirm(): readonly [Confirm, ReactNode] {
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

  const confirm = useCallback<Confirm>(
    (options, trigger) =>
      new Promise<boolean>((resolve) => {
        unanswered.current?.(false);
        unanswered.current = resolve;
        setState({ ask: { options, resolve, returnFocus: returnTarget(trigger) }, open: true });
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
