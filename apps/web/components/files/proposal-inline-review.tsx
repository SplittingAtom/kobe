"use client";

/**
 * The review under a proposal card that decides in the card itself (KOBE-592, projects spec PE4,
 * PE5): a proposed edit to a file of the conversation's project (Accept commits it) and a proposed
 * new file in the project or in My files (Accept creates it). The diff is the proposal against the
 * project's head (a new file: all added). The commit message starts as the agent's summary and is
 * editable (max 500). The server commits exactly the recorded content; this only sends the
 * message. Owner only: the card never mounts this for a shared reader.
 */
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { COMMIT_MESSAGE_MAX } from "../../lib/projects/commits-api";
import { lineDiff, type DiffRow } from "../../lib/files/line-diff";
import { fileName } from "../../lib/files/preview";
import type { ProposalView, ReviewOutcome } from "../../lib/files/editor-state";
import type { ApiError } from "../../lib/api/client";
import { useChatSession } from "../chat/kobe-runtime";
import styles from "../chat/chat.module.css";

export const STALE_NOTE =
  "This file changed after the agent proposed the edit. Ask it to propose again.";
export const NOT_ALLOWED_NOTES: Readonly<Record<string, string>> = {
  moved: "This conversation is no longer in that project, so the edit cannot be committed there.",
  no_edit_access: "You no longer have edit access to this project.",
  archived: "This project is archived and read-only.",
  not_a_project_proposal: "This proposal is for your own files, not a project.",
};
const EXISTS_NOTE = "A file with that name now exists. Ask the agent to propose again.";

type Base = { readonly status: "loading" } | { readonly status: "ready"; readonly text: string };
export type Decision =
  | { readonly status: "idle" }
  | { readonly status: "accepting" }
  | { readonly status: "committed"; readonly seq: number | null }
  | { readonly status: "failed"; readonly note: string };

/** The path inside the project: `projects/<slug>/a/b.md` -> `a/b.md`. */
export const projectRelativePath = (path: string): string => path.split("/").slice(2).join("/");

function failure(error: ApiError): string {
  if (error.status === 409 && error.code === "proposal_stale") return STALE_NOTE;
  if (error.status === 409 && error.code === "proposal_not_allowed") {
    return (
      NOT_ALLOWED_NOTES[error.reason ?? ""] ??
      "This proposal can no longer be accepted. Ask the agent to propose again."
    );
  }
  if (error.status === 409 && error.code === "version_conflict") return EXISTS_NOTE;
  return error.message;
}

/** The text of the file at the project's head ("" for a new file or a project without commits). */
function useBase(proposal: ProposalView): Base {
  const session = useChatSession();
  const [base, setBase] = useState<Base>(
    proposal.projectId === undefined || proposal.isNew
      ? { status: "ready", text: "" }
      : { status: "loading" },
  );
  const { projectId, path, isNew } = proposal;
  useEffect(() => {
    if (projectId === undefined || isNew) return;
    let current = true;
    const commits = session.commits();
    void (async () => {
      const history = await commits.history(projectId);
      const seq = history.ok ? history.data.commits[0]?.seq : undefined;
      const file =
        seq === undefined
          ? undefined
          : await commits.downloadAt(projectId, seq, projectRelativePath(path));
      if (current) {
        const text = file?.ok ? new TextDecoder().decode(file.data) : "";
        setBase({ status: "ready", text });
      }
    })();
    return () => {
      current = false;
    };
  }, [session, projectId, path, isNew]);
  return base;
}

const ROW_MARK = { same: "  ", removed: "- ", added: "+ " } as const;
const ROW_STYLE = {
  same: "",
  removed: "bg-[var(--kobe-diff-deleted-bg)] line-through",
  added: "bg-[var(--kobe-diff-added-bg)]",
} as const;

function Diff({ rows, name }: { readonly rows: readonly DiffRow[]; readonly name: string }) {
  return (
    <pre
      role="region"
      aria-label={`Proposed changes to ${name}`}
      tabIndex={0}
      className="max-h-80 overflow-auto rounded-md border p-1 font-mono text-xs"
    >
      {rows.map((row, i) => (
        <div key={i} data-diff={row.kind} className={ROW_STYLE[row.kind]}>
          {ROW_MARK[row.kind]}
          {row.text}
        </div>
      ))}
    </pre>
  );
}

export function ProposalInlineReview({
  proposal,
  threadId,
  projectName,
  onDone,
  onClose,
}: {
  readonly proposal: ProposalView;
  readonly threadId: string | undefined;
  readonly projectName: string | undefined;
  /** Accepted or discarded: the card shows the outcome. */
  readonly onDone: (outcome: ReviewOutcome) => void;
  readonly onClose: () => void;
}) {
  const session = useChatSession();
  const base = useBase(proposal);
  const [message, setMessage] = useState(proposal.summary.slice(0, COMMIT_MESSAGE_MAX));
  const [decision, setDecision] = useState<Decision>({ status: "idle" });
  const messageId = useId();
  const name = fileName(proposal.path);
  const project = proposal.projectId !== undefined;
  const busy = decision.status === "accepting";

  const accept = async () => {
    setDecision({ status: "accepting" });
    if (project) {
      if (proposal.proposalId === undefined || threadId === undefined || !proposal.projectId) {
        setDecision({ status: "failed", note: "This proposal is too old to commit. Ask again." });
        return;
      }
      const res = await session.commits().commitFromProposal(proposal.projectId, {
        threadId,
        proposalId: proposal.proposalId,
        message: message.trim() === "" ? proposal.summary : message.trim(),
      });
      if (!res.ok) return setDecision({ status: "failed", note: failure(res.error) });
      setDecision({ status: "committed", seq: res.data.seq });
    } else {
      const res = await session.files.save(proposal.path, "", proposal.content);
      if (!res.ok) return setDecision({ status: "failed", note: failure(res.error) });
      setDecision({ status: "committed", seq: null });
    }
    onDone("committed");
  };

  if (decision.status === "committed") {
    return (
      <p role="status" className={styles.fileMeta}>
        {decision.seq === null ? (
          `Saved ${name} to your files.`
        ) : (
          <>
            Committed as #{decision.seq}.{" "}
            <Link className="underline" href={`/me/projects/${proposal.projectId}#history`}>
              Open History
            </Link>
            {projectName === undefined ? "" : ` of ${projectName}`}
          </>
        )}
      </p>
    );
  }
  const rows = base.status === "ready" ? lineDiff(base.text, proposal.content) : [];
  return (
    <section aria-label={`Review of ${name}`} className="flex flex-col gap-2 px-2 pb-2">
      {base.status === "loading" ? (
        <p className={styles.fileMeta}>Loading the project&apos;s current file…</p>
      ) : (
        <Diff rows={rows} name={name} />
      )}
      {project && (
        <div className="flex flex-col gap-1">
          <label htmlFor={messageId} className={styles.fileMeta}>
            Commit message
          </label>
          <input
            id={messageId}
            value={message}
            maxLength={COMMIT_MESSAGE_MAX}
            onChange={(e) => setMessage(e.target.value)}
            className="bg-background rounded-md border px-2 py-1 text-sm"
          />
        </div>
      )}
      {decision.status === "failed" && (
        <p role="alert" className="text-sm">
          {decision.note}
        </p>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          className="bg-confirm text-confirm-fg hover:bg-confirm-hover rounded-md px-2 py-0.5 text-xs font-medium disabled:opacity-50"
          disabled={busy || base.status !== "ready"}
          onClick={() => void accept()}
        >
          {busy ? (project ? "Committing…" : "Saving…") : "Accept"}
        </button>
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs"
          disabled={busy}
          onClick={() => onDone("discarded")}
        >
          Reject
        </button>
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-2 py-0.5 text-xs"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </section>
  );
}
