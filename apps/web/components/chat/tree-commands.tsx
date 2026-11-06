"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { messageMeta } from "../../lib/chat/tree";
import type { MenuBindings } from "../../lib/shell/menu";
import { useBindCommands } from "../shell/command-bindings";
import type { KobeThreadExtras } from "./kobe-runtime";
import { focusComposerSoon } from "./tree-actions";
import { useTreeData } from "./tree-context";

export const NO_VERSIONS = "This message has no other versions.";
export const NO_CONTINUE = "There is no earlier answer to continue from.";

interface Shown {
  readonly id: string;
  readonly role: string;
  readonly branchCount: number;
  readonly metadata: { readonly custom?: unknown };
}

/**
 * The tree's palette entries (CT4, CT8; Q29: the palette only, no global chord): Conversation
 * tree, Previous / Next version and Continue from here on the focused message (the last one
 * focused or hovered in the conversation; else the newest that applies on screen).
 */
export function TreeCommands({ extras }: { readonly extras: KobeThreadExtras }) {
  const aui = useAui();
  const data = useTreeData();
  const messages = useAuiState((s) => s.thread.messages) as readonly Shown[];
  const { controller, projection, state } = extras;
  const leaf = state.summary?.leafEntryId ?? null;
  const leafNode = leaf === null ? undefined : projection.nodeOfEntry.get(leaf);
  const readOnly = state.summary?.readOnly === true;
  const pick = (ok: (m: Shown) => boolean): Shown | undefined => {
    const focused = messages.find((m) => m.id === data?.focusedMessage.current);
    return focused !== undefined && ok(focused) ? focused : messages.findLast(ok);
  };
  const versioned = pick((m) => m.branchCount > 1);
  const continuable = (m: Shown) => {
    const meta = messageMeta(m);
    return meta?.kind === "assistant" && !meta.live && meta.appCard !== true && m.id !== leafNode;
  };
  const answer = readOnly ? undefined : pick(continuable);
  const switchTo = (position: "previous" | "next") => {
    if (versioned) aui.thread.message({ id: versioned.id }).switchToBranch({ position });
  };
  const bindings: MenuBindings = {
    "conversation-tree": { onSelect: () => data?.open?.() },
    "previous-branch": {
      onSelect: () => switchTo("previous"),
      blocker: versioned ? null : NO_VERSIONS,
    },
    "next-branch": { onSelect: () => switchTo("next"), blocker: versioned ? null : NO_VERSIONS },
    "continue-from-here": {
      onSelect: () => {
        const last = answer && projection.lastEntryOfNode.get(answer.id);
        if (last === undefined || controller === null) return;
        controller.continueFrom(last);
        focusComposerSoon();
      },
      blocker: answer ? null : NO_CONTINUE,
    },
  };
  useBindCommands(bindings);
  return null;
}
