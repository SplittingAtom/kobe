"use client";

/**
 * The card under a `propose_file_edit` call (KOBE-463, spec FE8-FE10): the agent's proposed edit
 * to a workspace file, with Review, which opens the file with the inline diff. Built only from the
 * server's record of the proposal (the run's `file.edit_proposed` event while it streams, the
 * thread's proposal list after a reload), never from the tool result the sandbox relays. Only the
 * thread's owner may commit, so a member reading a shared thread sees the card without Review.
 *
 * KOBE-489: the owner's "Open edits automatically" switch (a stored member preference, off by
 * default). On, a live proposal (the controller's `fileEditRequest`, never a replayed backlog or a
 * reload) starts the review as Review does, once per proposal, without taking focus; it holds back
 * over unsaved changes to the file and says so. Accepting or rejecting stays the member's click.
 */
import { FilePenIcon } from "lucide-react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import {
  proposalFromEvent,
  type AutoOpenOutcome,
  type ProposalView,
} from "../../lib/files/editor-state";
import { fileName } from "../../lib/files/preview";
import { useShellPreferences } from "../../lib/shell/preferences";
import { useArtifactPanel } from "../chat/artifact-state";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import styles from "../chat/chat.module.css";

export const EXPIRED_NOTE =
  "This proposal is no longer available: proposals are kept 7 days after their run.";
export const AUTO_OPEN_LABEL = "Open edits automatically";
export const AUTO_OPEN_HELD_NOTE = "Review when you have saved your changes";

type Recorded =
  | { readonly status: "loading" | "missing" }
  | { readonly status: "found"; readonly proposal: ProposalView };

/** The proposal from the live stream, else from the thread's list once the call is done. */
function useProposal(
  toolCallId: string,
  live: KobeEventPayload<"file.edit_proposed"> | undefined,
  done: boolean,
): Recorded {
  const session = useChatSession();
  const threadId = useKobeExtras()?.state.threadId ?? undefined;
  const [listed, setListed] = useState<Recorded>({ status: "loading" });
  useEffect(() => {
    if (live !== undefined || !done || threadId === undefined) return;
    let current = true;
    void session.api.fileEditProposals(threadId).then((res) => {
      if (!current) return;
      const found = res.ok ? res.data.find((p) => p.toolCallId === toolCallId) : undefined;
      setListed(found ? { status: "found", proposal: found } : { status: "missing" });
    });
    return () => {
      current = false;
    };
  }, [session, threadId, toolCallId, live, done]);
  return live === undefined ? listed : { status: "found", proposal: proposalFromEvent(live) };
}

const OUTCOME_LABEL = { committed: "Committed", discarded: "Discarded" } as const;

/** The member's auto-open switch: their choice on this page, else the stored preference. */
function useAutoOpenEdits() {
  const store = useChatSession().autoOpenEdits;
  const shell = useShellPreferences();
  const chosen = useSyncExternalStore(store.subscribe, store.chosen, () => undefined);
  const stored = shell?.preferences;
  const on = chosen ?? stored?.autoOpenEdits ?? false;
  // Known once the member chose, the preferences loaded, or there are none (outside the shell).
  const known = chosen !== undefined || shell === null || stored != null;
  const save = shell?.save;
  const set = (next: boolean) => {
    store.set(next);
    save?.({ autoOpenEdits: next });
  };
  return { on, known, set } as const;
}

/**
 * What auto-open does with a live proposal, decided when it arrives (KOBE-489): skipped while the
 * switch is off, its state unknown (preferences still loading) or there is no artifact column, so
 * neither a late preference nor a later column ever opens an old proposal; held over unsaved
 * changes; else opened. Undefined: not yet (the proposal's record is still on its way).
 */
export function autoOpenDecision(at: {
  readonly known: boolean;
  readonly enabled: boolean;
  readonly panel: boolean;
  readonly proposal: boolean;
  readonly unsaved: boolean;
}): AutoOpenOutcome | undefined {
  if (!at.known || !at.enabled || !at.panel) return "skipped";
  if (!at.proposal) return undefined;
  return at.unsaved ? "held" : "opened";
}

/**
 * Starts the review of a live proposal by itself when the switch is on (KOBE-489): once per
 * proposal, never over unsaved changes (held back instead). True while held back.
 */
function useAutoReview(
  toolCallId: string,
  proposal: ProposalView | undefined,
  enabled: boolean,
  /** False while the switch's state is unknown (the preferences are still loading). */
  known: boolean,
): boolean {
  const session = useChatSession();
  const store = session.autoOpenEdits;
  const panel = useArtifactPanel();
  const request = useKobeExtras()?.state.fileEditRequest;
  const key = request?.toolCallId === toolCallId ? `${request.runId}:${toolCallId}` : undefined;
  const [held, setHeld] = useState(() => key !== undefined && store.outcomeOf(key) === "held");
  useEffect(() => {
    if (key === undefined || store.outcomeOf(key) !== undefined) return;
    const decision = autoOpenDecision({
      known,
      enabled,
      panel: panel !== null,
      proposal: proposal !== undefined,
      unsaved: proposal !== undefined && session.editDrafts.get(proposal.path) !== undefined,
    });
    if (decision === undefined) return;
    store.record(key, decision);
    if (decision === "held") setHeld(true);
    if (decision !== "opened" || proposal === undefined || !panel) return;
    session.fileReviews.start(proposal);
    panel.autoOpenFile(proposal.path);
  }, [key, enabled, known, panel, proposal, session, store]);
  return held;
}

export function FileEditCard({
  toolCallId,
  live,
  done,
  failed,
}: {
  readonly toolCallId: string;
  /** The `file.edit_proposed` event of this call, while the run streams. */
  readonly live: KobeEventPayload<"file.edit_proposed"> | undefined;
  readonly done: boolean;
  /** The call failed or was denied: no proposal was recorded. */
  readonly failed: boolean;
}) {
  const session = useChatSession();
  const panel = useArtifactPanel();
  const readOnly = useKobeExtras()?.state.summary?.readOnly === true;
  const recorded = useProposal(toolCallId, live, done && !failed);
  const autoOpen = useAutoOpenEdits();
  const found = recorded.status === "found" ? recorded.proposal : undefined;
  const held = useAutoReview(toolCallId, found, autoOpen.on && !readOnly, autoOpen.known);
  const reviews = session.fileReviews;
  const outcome = useSyncExternalStore(
    reviews.subscribe,
    () => reviews.outcomeOf(toolCallId),
    () => undefined,
  );
  if (failed) return null;
  if (recorded.status !== "found") {
    return recorded.status === "missing" && !readOnly ? (
      <p className={styles.fileMeta}>{EXPIRED_NOTE}</p>
    ) : null;
  }
  const { proposal } = recorded;
  const review = () => {
    reviews.start(proposal);
    panel?.openFile(proposal.path);
  };
  return (
    <div className={styles.fileCard} data-kobe-file-edit={proposal.path}>
      <FilePenIcon aria-hidden className="size-4" />
      <div className={styles.fileInfo}>
        <span className={styles.fileName} title={proposal.path}>
          Proposed edit: {fileName(proposal.path)}
        </span>
        <span className={styles.fileMeta}>{proposal.summary}</span>
        <span className={styles.fileMeta}>
          {outcome === undefined
            ? "Nothing is changed until you commit it."
            : OUTCOME_LABEL[outcome]}
        </span>
        {held && outcome === undefined && (
          <span className={styles.fileMeta} role="status">
            {AUTO_OPEN_HELD_NOTE}
          </span>
        )}
        {!readOnly && panel && <AutoOpenSwitch checked={autoOpen.on} onChange={autoOpen.set} />}
      </div>
      {!readOnly && panel && outcome !== "committed" && (
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs"
          aria-label={`Review the proposed edit to ${fileName(proposal.path)}`}
          onClick={review}
        >
          Review
        </button>
      )}
    </div>
  );
}

/** The "Open edits automatically" switch (role=switch, named by its label, Space toggles). */
function AutoOpenSwitch({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <span className="mt-1 inline-flex items-center gap-2">
      <SwitchPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="bg-muted data-[state=checked]:bg-primary focus-visible:ring-ring inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <SwitchPrimitive.Thumb className="bg-background pointer-events-none block size-3 rounded-full shadow-sm transition-transform data-[state=checked]:translate-x-3" />
      </SwitchPrimitive.Root>
      <label htmlFor={id} className={`${styles.fileMeta} cursor-pointer`}>
        {AUTO_OPEN_LABEL}
      </label>
    </span>
  );
}
