"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import { adjacentThread, groupThreads, threadOrder } from "../../lib/chat/thread-groups";
import type { MenuBinding, MenuBindings } from "../../lib/shell/menu";
import { useArtifactPanel, type ArtifactPanelApi } from "../chat/artifact-state";
import { useDetail } from "../chat/detail";
import { useBindCommands } from "./command-bindings";
import { useRail, type RailApi } from "./rail-state";
import { toggleTheme, useTheme } from "./use-theme";
import { useListedThreads } from "./use-listed-threads";

const NO_ARTIFACTS = "This conversation has no artifacts yet.";
const FIRST = "This is the first conversation.";
const LAST = "This is the last conversation.";
const NO_THREADS = "There are no other conversations.";

/** The rail's own toggle (Mod+B): collapses or expands it, as its button does (saved when docked). */
function railBinding(rail: RailApi): MenuBinding {
  return {
    label: rail.collapsed ? "Expand the rail" : "Collapse the rail",
    onSelect: () => rail.toggle(!rail.collapsed),
  };
}

/** Hiding the column with the focus in it puts the focus back on the conversation. */
function artifactsBinding(panel: ArtifactPanelApi): MenuBinding {
  const showing = panel.openId !== null && !panel.hidden;
  return {
    label: showing ? "Hide the artifact column" : "Show the artifact column",
    onSelect: () => {
      const column = document.getElementById("kobe-artifact-column");
      const inside = column?.contains(document.activeElement) === true;
      if (panel.toggleColumn() && inside) document.getElementById("kobe-chat-main")?.focus();
    },
    blocker: panel.openId === null && !panel.artifacts?.length ? NO_ARTIFACTS : null,
  };
}

/** Previous and next conversation (Mod+[ and Mod+]) in the rail's order, without wrapping. */
function useThreadSteps(): MenuBindings {
  const aui = useAui();
  const listed = useListedThreads();
  const current = useAuiState((s) => s.threads.mainThreadId);
  const order = useMemo(() => threadOrder(groupThreads(listed, [], () => undefined)), [listed]);
  const step = (dir: -1 | 1, end: string): MenuBinding => {
    const target = adjacentThread(order, current, dir);
    const others = order.some((id) => id !== current);
    return {
      onSelect: () => {
        if (target !== null) aui.threads.switchToThread(target);
      },
      blocker: !others ? NO_THREADS : target === null ? end : null,
    };
  };
  return { "previous-thread": step(-1, FIRST), "next-thread": step(1, LAST) };
}

/**
 * The workspace's own actions for the command listings and the shortcuts (KOBE-224, KOBE-225),
 * bound once for the chat whatever the layout shows (collapsed rail, drawer, one column): New
 * conversation (what `ThreadListPrimitive.New` calls), Files (the bar's Files button), the rail's
 * toggle, the artifact column, Detail, the theme, and previous/next conversation.
 */
export function AppCommands() {
  const aui = useAui();
  const rail = useRail();
  const panel = useArtifactPanel();
  const detail = useDetail();
  const theme = useTheme();
  const steps = useThreadSteps();
  useBindCommands({
    "new-thread": { onSelect: () => aui.threads.switchToNewThread() },
    ...(rail
      ? { files: { onSelect: () => rail.reveal("files") }, "toggle-rail": railBinding(rail) }
      : {}),
    ...(panel ? { "toggle-artifacts": artifactsBinding(panel) } : {}),
    detail: {
      label: detail.expanded ? "Hide all details" : "Show all details",
      onSelect: detail.toggle,
    },
    theme: { label: theme === "dark" ? "Light theme" : "Dark theme", onSelect: toggleTheme },
    ...steps,
  });
  return null;
}
