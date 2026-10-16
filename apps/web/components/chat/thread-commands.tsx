"use client";

import { useAuiState } from "@assistant-ui/react";
import { useState } from "react";
import { forkPointOf, type ForkPoint } from "../../lib/chat/fork";
import { stopBinding } from "../../lib/chat/thread-commands";
import { placementOf } from "../../lib/chat/thread-groups";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import type { MenuBindings } from "../../lib/shell/menu";
import { useBindCommands, useCommandsWanted } from "../shell/command-bindings";
import { ForkDialog } from "./fork-dialog";
import type { KobeThreadExtras } from "./kobe-runtime";
import { RailAnnounce } from "./use-organize-menu";
import { useThreadMenuBindings, type Notice } from "./use-thread-menu";

const NO_FORK = "There is no answer to fork yet.";
const UNTITLED = "Untitled conversation";

/** The newest answer's meta on the branch on screen: `/fork` forks there. */
function useLastAnswerMeta(): KobeMessageMeta | undefined {
  return useAuiState(
    (s) =>
      s.thread.messages.findLast((m) => m.role === "assistant")?.metadata.custom as
        KobeMessageMeta | undefined,
  );
}

function Bindings({
  extras,
  threadId,
  notify,
}: {
  readonly extras: KobeThreadExtras;
  readonly threadId: string;
  readonly notify: (notice: Notice) => void;
}) {
  const { controller, state } = extras;
  const listed = useAuiState((s) => s.threadListItem.title);
  const custom = useAuiState((s) => s.threadListItem.custom);
  const wanted = useCommandsWanted();
  const point = forkPointOf(useLastAnswerMeta());
  const [forking, setForking] = useState<ForkPoint | null>(null);
  const readOnly = placementOf(custom).shared || state.summary?.readOnly === true;
  const menu = useThreadMenuBindings({
    threadId,
    title: listed || state.summary?.title || UNTITLED,
    custom,
    open: wanted,
    readOnly,
    state,
    notify,
  });
  const bindings: MenuBindings =
    controller === null
      ? {}
      : {
          ...menu,
          stop: stopBinding(controller, state),
          "fork-thread": {
            onSelect: () => {
              if (point) setForking(point);
            },
            blocker: point ? null : NO_FORK,
          },
        };
  useBindCommands(bindings);
  return (
    forking && (
      <ForkDialog
        point={forking}
        defaultTitle={state.summary?.title ?? ""}
        onOpenChange={(open) => {
          if (!open) setForking(null);
        }}
      />
    )
  );
}

/**
 * The open thread's actions for the command listings (KOBE-224): its menu's bindings (the rail
 * row's `useThreadMenuBindings`: Copy, Regenerate (with), Pin, Move, Archive, Share), Stop (the
 * steering panel's), and Fork at the last answer (the answer's own Fork dialog). Results are
 * spoken in a polite status line, as the rail row speaks them. Nothing renders for a draft.
 */
export function ThreadCommands({ extras }: { readonly extras: KobeThreadExtras }) {
  const [said, setSaid] = useState("");
  const threadId = extras.state.threadId;
  if (threadId === null) return null;
  return (
    <RailAnnounce.Provider value={setSaid}>
      <Bindings
        key={threadId}
        extras={extras}
        threadId={threadId}
        notify={(n) => setSaid(n.full)}
      />
      <span role="status" className="sr-only" data-kobe-thread-commands>
        {said}
      </span>
    </RailAnnounce.Provider>
  );
}
