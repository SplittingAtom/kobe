"use client";

/**
 * An agent's proposed edit under review in the file editor (KOBE-463; layout KOBE-615): a
 * "Proposed edit" bubble with a gold glow naming the proposal, then one row to move between the
 * changes ("Change N of M"), accept or reject the current one, and Commit all or Discard all; the
 * inline diff below has an Accept and a Reject icon on each change. Commit all saves what is shown
 * at the proposal's base version (FE10); a file that moved on ends the review with a notice.
 */
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleXIcon,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useState } from "react";
import { editorLanguage } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore, ProposalView } from "../../lib/files/editor-state";
import type { FilesApi } from "../../lib/files/api";
import { fileName, previewOf } from "../../lib/files/preview";
import type { ReviewControls } from "./code-editor";
import { SaveNotices, useSave } from "./editor-save";
import { TOOL_BUTTON } from "./editor-toolbar";
import { BUTTON, CodeEditor, EditorFallback } from "./text-modes";

export interface ProposalReviewProps {
  readonly path: string;
  /** The file as read now. */
  readonly text: string;
  readonly sha256: string | undefined;
  readonly api: FilesApi;
  readonly drafts: EditDraftStore;
  readonly reviews: FileReviewStore;
  onSaved(text: string, sha256: string): void;
  onReload(): void;
  readonly review: ProposalView;
  /** The member has unsaved changes to the file: the review waits for them. */
  readonly dirty: boolean;
}

/** The bubble at the top: what the agent proposes, in its words. */
export function ProposalBubble({ summary }: { readonly summary: string }) {
  return (
    <p
      data-kobe-proposal-bubble=""
      className="kobe-glow-gold bg-card m-0 w-fit max-w-full shrink-0 self-start rounded-full px-3 py-1 text-sm break-words"
    >
      <strong>Proposed edit:</strong> {summary}
    </p>
  );
}

function RowButton({
  label,
  icon: Icon,
  text,
  tone,
  onClick,
  disabled,
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly text?: string | undefined;
  readonly tone?: "accept" | "reject" | undefined;
  onClick(): void;
  readonly disabled?: boolean | undefined;
}) {
  const colour =
    tone === "accept"
      ? "text-[var(--kobe-diff-added)]"
      : tone === "reject"
        ? "text-[var(--kobe-diff-deleted)]"
        : "";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`${TOOL_BUTTON} ${text === undefined ? "px-1" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden className={`size-3.5 ${colour}`} />
      {text}
    </button>
  );
}

function changeText(current: number | null, open: number | null): string {
  if (open === null) return "";
  if (open === 0) return "No changes left";
  return `Change ${current ?? 1} of ${open}`;
}

export function ProposalReview({
  path,
  text,
  sha256,
  api,
  drafts,
  reviews,
  onSaved,
  onReload,
  review,
  dirty,
}: ProposalReviewProps) {
  const [proposed, setProposed] = useState(review.content);
  // The file as the review started: a re-read never rebuilds the diff (and its accept/reject);
  // a file that moved on ends the review with the notice below instead.
  const [original] = useState(text);
  const [open, setOpen] = useState<number | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [controls, setControls] = useState<ReviewControls | null>(null);
  const { state, save } = useSave(api, path, (saved, version) => {
    reviews.finish(path, "committed");
    onSaved(saved, version);
  });
  const discard = () => reviews.finish(path, "discarded");
  const name = fileName(path);
  const stale = sha256 !== review.baseSha256;
  const none = controls === null || open === null || open === 0;
  return (
    <section
      aria-label={`Proposed edit to ${name}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 pt-1"
    >
      <ProposalBubble summary={review.summary} />
      {stale ? (
        <div role="alert" className="rounded-md border p-2 text-sm">
          <p>
            {name} changed since the agent proposed this edit, so it can no longer be applied.
            Discard it and ask the agent to propose again.
          </p>
          <button type="button" className={`${BUTTON} mt-1`} onClick={discard}>
            Discard the proposal
          </button>
        </div>
      ) : dirty ? (
        <div role="alert" className="rounded-md border p-2 text-sm">
          <p>You have unsaved changes to {name}. Save or discard them to review the proposal.</p>
          <button type="button" className={`${BUTTON} mt-1`} onClick={() => drafts.clear(path)}>
            Discard my changes
          </button>
        </div>
      ) : (
        <>
          <div
            role="toolbar"
            aria-label="Review changes"
            className="flex shrink-0 flex-wrap items-center gap-1"
          >
            <RowButton
              label="Previous change"
              icon={ChevronUpIcon}
              disabled={none}
              onClick={() => controls?.previous()}
            />
            <RowButton
              label="Next change"
              icon={ChevronDownIcon}
              disabled={none}
              onClick={() => controls?.next()}
            />
            <span
              className="text-muted-foreground px-1 text-xs tabular-nums"
              data-kobe-change-position=""
            >
              {changeText(current, open)}
            </span>
            <RowButton
              label="Accept current change"
              icon={CircleCheckIcon}
              text="Accept"
              tone="accept"
              disabled={none}
              onClick={() => controls?.accept()}
            />
            <RowButton
              label="Reject current change"
              icon={CircleXIcon}
              text="Reject"
              tone="reject"
              disabled={none}
              onClick={() => controls?.reject()}
            />
            <span className="ms-auto flex gap-1">
              <button
                type="button"
                className={TOOL_BUTTON}
                disabled={state.status === "saving" || proposed === original}
                onClick={() => void save(review.baseSha256, proposed)}
              >
                {state.status === "saving" ? "Committing…" : "Commit all"}
              </button>
              <button type="button" className={TOOL_BUTTON} onClick={discard}>
                Discard all
              </button>
            </span>
          </div>
          <p role="status" className="text-muted-foreground m-0 text-xs empty:hidden">
            {open === null
              ? ""
              : `${open === 1 ? "1 change" : `${open} changes`} to accept or reject. Commit all saves what is shown.`}
          </p>
          <SaveNotices state={state} onReload={onReload} />
          <Suspense fallback={<EditorFallback />}>
            <CodeEditor
              value={review.content}
              original={original}
              language={editorLanguage(previewOf(path))}
              label={`Proposed content of ${name}`}
              onChange={setProposed}
              onChunks={setOpen}
              onReview={setControls}
              onCurrent={setCurrent}
            />
          </Suspense>
        </>
      )}
    </section>
  );
}
