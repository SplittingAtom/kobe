"use client";

/**
 * Extension points of the message renderer for later tickets. Each slot is one component in one
 * place, so a ticket replaces its own entry without touching the renderer:
 *
 * - `ApprovalSlot` (KOBE-37): `approval.requested` / `approval.resolved` on a tool call: the
 *   approval card (`approval-card.tsx`: tool, input, risk, Allow/Deny, remember), which posts
 *   `POST /v1/approvals/{id}`.
 * - `ArtifactSlot` (KOBE-55): `artifact.created` / `artifact.updated`, on a tool call or on its own
 *   (run notice). The notice has an Open button for the artifact panel (KOBE-130).
 * - `FileCard` (KOBE-152, `file-card.tsx`): `file.shared`, a download card.
 * - `NoticeSlot`: run-level notices not tied to a tool call (`egress.blocked`, `steer.applied`,
 *   `memory.updated` (KOBE-158: the chip with Undo), `context.omitted` (KOBE-77), artifacts and files shared outside a tool call).
 *   Each one can be closed by the viewer (KOBE-468, `closable-notice.tsx`).
 */
import { useContext } from "react";
import type { KobeEventPayload } from "@kobe/protocol";
import type { RunNotice, ToolActivity } from "../../lib/chat/live";
import { ApprovalCard } from "./approval-card";
import { OpenArtifactButton } from "./artifact-panel";
import { ClosableNotice } from "./closable-notice";
import { FileCard } from "./file-card";
import { ConnectedEgressNotice } from "./egress-notice";
import { MemoryNotice } from "./memory-notice";
import { OmissionNotice } from "./omission-notice";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

export function ApprovalSlot({ tool }: { readonly tool: ToolActivity }) {
  const session = useContext(ChatSessionContext);
  const readOnly = useKobeExtras()?.state.summary?.readOnly === true;
  const requested = tool.approvalRequested;
  if (!requested) return null;
  return (
    <ApprovalCard
      key={requested.approval_id}
      requested={requested}
      resolved={tool.approvalResolved}
      api={session?.api}
      readOnly={readOnly}
    />
  );
}

type ArtifactPayload = KobeEventPayload<"artifact.created"> | KobeEventPayload<"artifact.updated">;

export function ArtifactSlot({ artifact }: { readonly artifact: ArtifactPayload }) {
  const title = artifact.title?.trim() || "Untitled artifact";
  return (
    <p className={styles.notice}>
      {artifact.version === 1
        ? "Artifact created"
        : `Artifact updated (version ${artifact.version})`}
      : {title}
      <OpenArtifactButton id={artifact.artifact_id} title={title} />
    </p>
  );
}

/**
 * Identifies a notice's event for closing it (KOBE-468): run id and seq, or for a blocked domain
 * (one notice per domain and run, `live.ts`) the domain.
 */
export function noticeCloseId(notice: RunNotice): string {
  return notice.type === "egress.blocked"
    ? `${notice.run_id}:egress:${notice.payload.domain}`
    : `${notice.run_id}:${notice.seq}`;
}

export function NoticeSlot({ notice }: { readonly notice: RunNotice }) {
  if (notice.type === "egress.blocked") {
    return <EgressBlocked payload={notice.payload} closeId={noticeCloseId(notice)} />;
  }
  return (
    <ClosableNotice id={noticeCloseId(notice)}>
      <NoticeBody notice={notice} />
    </ClosableNotice>
  );
}

function NoticeBody({
  notice,
}: {
  readonly notice: Exclude<RunNotice, { type: "egress.blocked" }>;
}) {
  switch (notice.type) {
    case "context.omitted":
      return <OmissionNotice payload={notice.payload} />;
    case "steer.applied":
      return <p className={styles.notice}>Steered: “{notice.payload.content}”</p>;
    case "memory.updated":
      return <MemoryNotice payload={notice.payload} />;
    case "artifact.created":
    case "artifact.updated":
      return <ArtifactSlot artifact={notice.payload} />;
    case "file.shared":
      return <FileCard file={notice.payload} />;
  }
}

/** U12: a blocked domain is a clear notice with Request access (KOBE-39, egress-notice.tsx). */
export function EgressBlocked({
  payload,
  closeId,
}: {
  readonly payload: KobeEventPayload<"egress.blocked">;
  /** The event's id: the viewer can close the notice (KOBE-468). */
  readonly closeId?: string | undefined;
}) {
  return <ConnectedEgressNotice payload={payload} closeId={closeId} />;
}

export { FileCard as FileSlot };
