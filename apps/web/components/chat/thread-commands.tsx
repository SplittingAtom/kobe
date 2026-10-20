"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useState } from "react";
import { forkPointOf, type ForkPoint } from "../../lib/chat/fork";
import {
  IN_TRASH,
  NO_THREAD,
  READ_ONLY,
  stopBinding,
  threadReadOnly,
} from "../../lib/chat/thread-commands";
import { branchPointOfMeta, type KobeMessageMeta } from "../../lib/chat/tree";
import type { MenuBinding, MenuBindings } from "../../lib/shell/menu";
import { useBindCommands, useCommandsWanted } from "../shell/command-bindings";
import { ForkDialog } from "./fork-dialog";
import { SessionCommands } from "./session-info";
import type { KobeThreadExtras } from "./kobe-runtime";
import { RailAnnounce } from "./use-organize-menu";
import { useThreadMenuBindings, type Notice } from "./use-thread-menu";

const NO_FORK = "There is no answer to fork yet.";
const NO_MESSAGE = "You haven't sent a message here yet.";
const WAIT_FOR_ANSWER = "Wait for the answer, or stop it, before editing.";
const NOT_EDITABLE = "That message can't be edited.";
const UNTITLED = "Untitled conversation";

/** The newest answer's meta on the branch on screen: `/fork` forks there. */
function useLastAnswerMeta(): KobeMessageMeta | undefined {
  return useAuiState(
    (s) =>
      s.thread.messages.findLast((m) => m.role === "assistant")?.metadata.custom as
        KobeMessageMeta | undefined,
  );
}

const noop = () => {};

/**
 * Edit your last message (CE23, KOBE-225: Mod+Shift+E, Up arrow in an empty composer): the
 * newest user message on the branch on screen opens in its edit box, as its Edit button does
 * (assistant-ui's `beginEdit`), under the button's rules: hidden while a run is on, and only where
 * the message has a branch point.
 */
function useEditLastBinding(extras: KobeThreadExtras, readOnly: boolean): MenuBinding {
  const aui = useAui();
  const lastId = useAuiState((s) => s.thread.messages.findLast((m) => m.role === "user")?.id);
  const lastMeta = useAuiState(
    (s) =>
      s.thread.messages.findLast((m) => m.role === "user")?.metadata.custom as
        KobeMessageMeta | undefined,
  );
  const running = useAuiState((s) => s.thread.isRunning);
  const blocker = readOnly
    ? READ_ONLY
    : extras.state.summary?.deletedAt != null
      ? IN_TRASH
      : lastId === undefined
        ? NO_MESSAGE
        : running
          ? WAIT_FOR_ANSWER
          : branchPointOfMeta(extras.projection, lastMeta) === undefined
            ? NOT_EDITABLE
            : null;
  return {
    onSelect: () => {
      if (lastId !== undefined) aui.thread.message({ id: lastId }).composer().beginEdit();
    },
    blocker,
  };
}

/**
 * The row menu binds Pin or Unpin, Archive or Unarchive (whichever applies); the listings know
 * both words, so the other one says why it doesn't apply.
 */
function withCounterparts(menu: MenuBindings): MenuBindings {
  const missing = (reason: string) => ({ onSelect: noop, blocker: reason });
  return {
    ...(menu["pin-thread"]
      ? {}
      : {
          "pin-thread": missing(
            menu["unpin-thread"] ? "It is pinned already." : "Unarchive it first.",
          ),
        }),
    ...(menu["unpin-thread"] ? {} : { "unpin-thread": missing("It isn't pinned.") }),
    ...(menu["archive-thread"] ? {} : { "archive-thread": missing("It is archived already.") }),
    ...(menu["unarchive-thread"] ? {} : { "unarchive-thread": missing("It isn't archived.") }),
    ...menu,
  };
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
  const readOnly = threadReadOnly(custom, state);
  const editLast = useEditLastBinding(extras, readOnly);
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
          ...withCounterparts(menu),
          stop: stopBinding(controller, state),
          "edit-last-message": editLast,
          "fork-thread": {
            onSelect: () => {
              if (point) setForking(point);
            },
            blocker: point ? null : NO_FORK,
          },
        };
  useBindCommands(bindings);
  return (
    <>
      <SessionCommands extras={extras} threadId={threadId} />
      {forking && (
        <ForkDialog
          point={forking}
          defaultTitle={state.summary?.title ?? ""}
          onOpenChange={(open) => {
            if (!open) setForking(null);
          }}
        />
      )}
    </>
  );
}

/**
 * The open thread's actions for the command listings (KOBE-224): its menu's bindings (the rail
 * row's `useThreadMenuBindings`: Copy, Regenerate (with), Pin, Move, Archive, Share), Stop (the
 * steering panel's), and Fork at the last answer (the answer's own Fork dialog). Results are
 * spoken in a polite status line, as the rail row speaks them. A draft binds them blocked.
 */
/** A draft: the thread's actions are known, and say why they wait. */
const DRAFT_IDS = [
  "copy-thread",
  "regenerate-thread",
  "regenerate-thread-with",
  "pin-thread",
  "move-thread",
  "archive-thread",
  "share-thread",
  "stop",
  "fork-thread",
  "edit-last-message",
  "thread-info",
  "export-thread",
] as const;
const DRAFT: MenuBindings = Object.fromEntries(
  DRAFT_IDS.map((id) => [id, { onSelect: () => {}, blocker: NO_THREAD }]),
);

function DraftBindings() {
  useBindCommands(DRAFT);
  return null;
}

export function ThreadCommands({ extras }: { readonly extras: KobeThreadExtras }) {
  const [said, setSaid] = useState("");
  const threadId = extras.state.threadId;
  if (threadId === null) return <DraftBindings />;
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
