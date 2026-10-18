"use client";

import { useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import { useShellBand } from "../shell/shell-band";
import { CHAT_PORTALLED } from "../ui/chat-portal";
import { AgentChips } from "./agent-chips";
import { AgentPickerMenu } from "./agent-picker";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { ModelSelects, useModelPicker, type ModelPickerData } from "./model-picker";

/**
 * Under this composer width the Agent, Model and Thinking selectors no longer fit on the toolbar's
 * one line beside Attach, Dictate and Send: they fold into one menu. Room for Attach, a 12rem
 * agent chip, a 12rem model and a thinking select, Dictate and Send.
 */
export const FOLD_SELECTORS_BELOW_PX = 640;

/**
 * Whether the composer is too narrow for its selectors (KOBE-418): on a phone (the one-column
 * band) or when its panel is narrower than `FOLD_SELECTORS_BELOW_PX`, as beside the rail and an
 * artifact column. Measured on mount, on resize of the panel and of the window; a panel with no
 * layout yet (width 0) counts as wide.
 */
export function useFoldedSelectors(panel: HTMLElement | null): boolean {
  const single = useShellBand() === "single";
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!panel) return;
    const measure = () => {
      const width = panel.getBoundingClientRect().width;
      setNarrow(width > 0 && width < FOLD_SELECTORS_BELOW_PX);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(panel);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panel]);
  return single || narrow;
}

/** The thread's agent: the picker while the conversation is new, then its name (and state). */
function AgentControl() {
  const session = useChatSession();
  const isNew = useAuiState((s) => s.threadListItem.remoteId) === undefined;
  return isNew && session.canChooseAgent ? <AgentPickerMenu /> : <AgentChips />;
}

/** A press outside the menu closes it; one in portalled content (the agent popover) does not. */
function useDismissOutside(root: HTMLElement | null, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open || !root) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || root.contains(target) || target.closest(CHAT_PORTALLED)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [root, open, close]);
}

/**
 * The folded selectors' menu: one "Agent and model" button and, above the toolbar, the pickers.
 * The pickers stay mounted while it is closed (hidden), so `/model` keeps its binding and nothing
 * remounts when the composer crosses the fold.
 */
function SelectorsMenu({
  folded,
  children,
}: {
  readonly folded: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!folded) setOpen(false);
  }, [folded]);
  useDismissOutside(root, folded && open, close);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape in the agent popover is the popover's own: Radix prevents its default.
    if (e.key !== "Escape" || !open || e.nativeEvent.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    root?.querySelector<HTMLElement>('[data-command="conversation-settings"]')?.focus();
  };
  return (
    <div
      ref={setRoot}
      data-composer-selectors={folded ? "folded" : "inline"}
      className={cn("relative flex min-w-0 items-center", !folded && "flex-1")}
      onKeyDown={folded ? onKeyDown : undefined}
    >
      {folded && (
        <IconAction
          command="conversation-settings"
          side="top"
          className="size-7 rounded-full"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        />
      )}
      <div
        id={id}
        role={folded ? "group" : undefined}
        aria-label={folded ? "Agent and model" : undefined}
        hidden={folded && !open}
        className={
          folded
            ? "bg-background absolute start-0 bottom-full z-30 mb-2 flex w-max max-w-[calc(100vw-2rem)] flex-col items-start gap-2 rounded-lg border p-2 shadow-md"
            : "flex min-w-0 flex-1 items-center gap-1.5"
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The conversation's Agent, Model and Thinking selectors in the composer's toolbar, after Attach
 * (KOBE-418; bar row two before). Inline while they fit; folded into one menu on a narrow
 * composer, so the toolbar stays one line and Send is never pushed off it.
 */
export function ComposerSelectors({
  picker,
  folded,
}: {
  readonly picker: ModelPickerData | null;
  readonly folded: boolean;
}) {
  return (
    <SelectorsMenu folded={folded}>
      <AgentControl />
      {picker && <ModelSelects picker={picker} />}
    </SelectorsMenu>
  );
}

/** The selectors' reading of the thread: one per composer, shared with its model warning. */
export function useComposerPicker(extras: KobeThreadExtras): ModelPickerData | null {
  const isNew = useAuiState((s) => s.threadListItem.remoteId) === undefined;
  const { state, controller } = extras;
  // A shared conversation is read-only and one in Trash can't run: no model to choose.
  const active = state.summary?.readOnly !== true && state.summary?.deletedAt == null;
  return useModelPicker({ controller, state, isNew, active });
}
