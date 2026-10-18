"use client";

import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { compactBlocker } from "../../lib/chat/thread-state";
import type { MenuBindings } from "../../lib/shell/menu";
import { useBindCommands } from "../shell/command-bindings";
import { IconAction } from "../shell/icon-action";
import { CompactDialog } from "./compact-dialog";
import type { KobeThreadExtras } from "./kobe-runtime";

/**
 * Compact now (CE15, KOBE-213): who may open the dialog, and why not. `open` is absent where
 * compaction isn't offered at all (a reader's thread, Trash, a draft, the builder's test pane).
 */
export interface CompactNowApi {
  /** Why it can't run now (`compactBlocker`), or null. */
  readonly blocker: string | null;
  readonly open: (() => void) | undefined;
}

const CompactNowContext = createContext<CompactNowApi>({ blocker: null, open: undefined });

/** The open thread's Compact now (the gauge's red action, the latest answer's icon). */
export function useCompactNow(): CompactNowApi {
  return useContext(CompactNowContext);
}

/** The latest answer's Compact now, else the gauge, else the message box: focus after closing. */
function fallbackFocus(): HTMLElement | null {
  const buttons = document.querySelectorAll<HTMLElement>(
    '[data-role="assistant"] [data-command="compact-thread"]',
  );
  return (
    buttons[buttons.length - 1] ??
    document.querySelector<HTMLElement>("[data-context-gauge]") ??
    document.getElementById("kobe-composer")
  );
}

/** What had the focus when the dialog opened, while it is still on the page. */
function focusedNow(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * Owns the thread's Compact dialog (KOBE-418: moved from bar row two) and publishes `/compact`
 * (KOBE-224), so the gauge, the answer's icon, the `/` menu and the palette open the same one.
 * Bound whenever a thread is on screen, so `/compact` always says why it can't run. The dialog
 * belongs to its thread: another thread's never opens or closes it (KOBE-213).
 */
export function CompactNowProvider({
  extras,
  enabled,
  children,
}: {
  readonly extras: KobeThreadExtras;
  /** False in the builder's test pane, which offers no compaction. */
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const { state, controller } = extras;
  const [compactFor, setCompactFor] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const canRun = state.summary?.readOnly !== true && state.summary?.deletedAt == null;
  const blocker = compactBlocker(state);
  const threadId = state.threadId;
  const open =
    enabled && canRun && controller !== null && threadId !== null
      ? () => {
          opener.current = focusedNow();
          setCompactFor(threadId);
        }
      : undefined;
  const bindings: MenuBindings = enabled
    ? {
        "compact-thread": {
          onSelect: () => open?.(),
          blocker: open ? blocker : (blocker ?? "Opening the conversation…"),
        },
      }
    : {};
  useBindCommands(bindings);
  const returnFocus = () => {
    const el = opener.current;
    opener.current = null;
    return el?.isConnected ? el : fallbackFocus();
  };
  return (
    <CompactNowContext.Provider value={{ blocker, open }}>
      {children}
      {open && controller !== null && threadId !== null && (
        <CompactDialog
          key={threadId}
          controller={controller}
          open={compactFor === threadId}
          // Closing (or finishing) this thread's dialog never touches another thread's.
          onOpenChange={(next) =>
            setCompactFor((current) => (next ? threadId : current === threadId ? null : current))
          }
          returnFocus={returnFocus}
        />
      )}
    </CompactNowContext.Provider>
  );
}

/**
 * Compact now beside the latest answer's thumbs down (KOBE-418): enabled only while the thread is
 * idle, its tooltip and description saying why otherwise.
 */
export function CompactNowButton() {
  const { blocker, open } = useCompactNow();
  const latest = useAuiState(
    (s) => s.thread.messages.findLast((m) => m.role === "assistant")?.id === s.message.id,
  );
  if (!latest || open === undefined) return null;
  return (
    <IconAction
      command="compact-thread"
      label="Compact now"
      size="sm"
      aria-disabled={blocker !== null}
      description={blocker ?? undefined}
      onClick={blocker === null ? open : undefined}
    />
  );
}
