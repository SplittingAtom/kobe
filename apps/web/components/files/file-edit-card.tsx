"use client";

/**
 * The card under a `propose_file_edit` call (KOBE-463, spec FE8-FE10): the agent's proposed edit
 * to a workspace file, with Review, which opens the file with the inline diff. Built only from the
 * server's record of the proposal (the run's `file.edit_proposed` event while it streams, the
 * thread's proposal list after a reload), never from the tool result the sandbox relays. Only the
 * thread's owner may commit, so a member reading a shared thread sees the card without Review.
 */
import { FilePenIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import { proposalFromEvent, type ProposalView } from "../../lib/files/editor-state";
import { fileName } from "../../lib/files/preview";
import { useArtifactPanel } from "../chat/artifact-state";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import styles from "../chat/chat.module.css";

export const EXPIRED_NOTE =
  "This proposal is no longer available: proposals are kept 7 days after their run.";

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
