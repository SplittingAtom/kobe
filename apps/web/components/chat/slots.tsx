"use client";

/**
 * Extension points of the message renderer for later tickets. Each slot is one component in one
 * place, so a ticket replaces its own entry without touching the renderer:
 *
 * - `ApprovalSlot` (KOBE-37): `approval.requested` / `approval.resolved` on a tool call. Today it
 *   says what the server is waiting for; KOBE-37 renders the approval card (tool, input, risk,
 *   Allow/Deny, remember) and posts `POST /v1/approvals/{id}`.
 * - `ArtifactSlot` (KOBE-55): `artifact.created` / `artifact.updated`, on a tool call or on its own
 *   (run notice). KOBE-55 opens assistant-ui's artifact panel.
 * - `FileSlot` (KOBE-54): `file.shared`; KOBE-54 renders the download card.
 * - `NoticeSlot`: run-level notices not tied to a tool call (`egress.blocked`, `steer.applied`,
 *   `memory.updated` (KOBE-56 adds Undo), artifacts and files shared outside a tool call).
 */
import type { KobeEventPayload } from "@kobe/protocol";
import type { RunNotice, ToolActivity } from "../../lib/chat/live";
import styles from "./chat.module.css";

export function ApprovalSlot({ tool }: { readonly tool: ToolActivity }) {
  const requested = tool.approvalRequested;
  if (!requested) return null;
  const resolved = tool.approvalResolved;
  if (resolved) {
    const text: Record<typeof resolved.decision, string> = {
      allowed: "Approved.",
      denied: "Denied.",
      expired: "The approval request expired.",
    };
    return <p className={styles.notice}>{text[resolved.decision]}</p>;
  }
  return (
    <p className={styles.notice} role="status">
      Waiting for approval: {requested.reasons.map((r) => r.message).join(" ")}
    </p>
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
    </p>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileSlot({ file }: { readonly file: KobeEventPayload<"file.shared"> }) {
  return (
    <p className={styles.notice}>
      File shared: {file.name} ({formatBytes(file.size)})
    </p>
  );
}

export function NoticeSlot({ notice }: { readonly notice: RunNotice }) {
  switch (notice.type) {
    case "egress.blocked":
      return <EgressBlocked payload={notice.payload} />;
    case "steer.applied":
      return <p className={styles.notice}>Steered: “{notice.payload.content}”</p>;
    case "memory.updated":
      return (
        <p className={styles.notice}>
          Memory updated: {notice.payload.path} ({notice.payload.scope} memory)
        </p>
      );
    case "artifact.created":
    case "artifact.updated":
      return <ArtifactSlot artifact={notice.payload} />;
    case "file.shared":
      return <FileSlot file={notice.payload} />;
  }
}

/** U12: a blocked domain is a clear notice; "Request access" arrives with KOBE-39. */
export function EgressBlocked({
  payload,
}: {
  readonly payload: KobeEventPayload<"egress.blocked">;
}) {
  return (
    <p className={styles.denied} role="note">
      Internet access to <strong>{payload.domain}</strong> was blocked by your team&apos;s egress
      policy.
      {payload.request_access
        ? " A team admin can allow it."
        : " It is outside what this install allows."}
    </p>
  );
}
