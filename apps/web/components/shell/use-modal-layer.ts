"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { CHAT_PORTALLED as PORTALLED } from "../ui/chat-portal";

/**
 * Makes everything in the chat outside `el` inert (no focus, no pointer, hidden from assistive
 * tech), as a modal dialog does; returns the undo. Only attributes this call set are removed.
 */
export function inertOutside(el: HTMLElement): () => void {
  const root = el.closest("[data-kobe-chat]") ?? el.ownerDocument.body;
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement = el; node !== root && node.parentElement;) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      changed.push(sibling);
    }
    node = parent;
  }
  return () => {
    for (const sibling of changed) sibling.removeAttribute("inert");
  };
}

export interface ModalLayerOptions {
  /** Modal: the rest of the chat is inert and a press outside closes the layer. */
  readonly modal: boolean;
  /** Escape anywhere closes it (else the layer handles its own keys). */
  readonly escape: boolean;
}

/**
 * A drawer or sheet over the shell (CE7, CE8, KOBE-201) while `active`: focus moves into it (unless
 * it is already there), Escape and, when modal, a press outside call `onClose`, the background is
 * inert, and focus returns to what had it before (if it is still on the page) once it closes.
 * An Escape that a control inside handled first (`preventDefault`, or a stop at the React root)
 * and an Escape from a popover portalled out of the layer are left alone.
 */
export function useModalLayer(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
  { modal, escape }: ModalLayerOptions,
): void {
  const close = useRef(onClose);
  const before = useRef<Element | null>(null);
  useEffect(() => {
    close.current = onClose;
  });
  // Where focus was when the layer opened: a layout effect runs before the content's own effects
  // move focus into it.
  useLayoutEffect(() => {
    if (active) before.current = document.activeElement;
  }, [active]);
  // The modal parts follow `modal` and `escape` (a sheet crossing 768 px stays open).
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const undoInert = modal ? inertOutside(el) : () => {};
    if (!el.contains(document.activeElement)) el.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!escape || e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(PORTALLED)) return;
      e.preventDefault();
      close.current();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!modal || !target || el.contains(target) || target.closest(PORTALLED)) return;
      close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      undoInert();
    };
  }, [ref, active, modal, escape]);
  // Focus goes back only when the layer closes, after the effect above has lifted `inert`. A
  // passive effect: React restores the focus it saw before a commit once the DOM is updated, so
  // moving focus from a layout effect's cleanup would be undone.
  useEffect(() => {
    if (!active) return;
    return () => {
      const back = before.current;
      before.current = null;
      if (back instanceof HTMLElement && back.isConnected && !back.closest("[inert], [hidden]")) {
        back.focus();
      }
    };
  }, [active]);
}
