/**
 * Workspace sync conflicts (KOBE-492, `GET /v1/threads/{id}/sync-conflicts`): the member saved a
 * file the agent had also changed before the agent's change was synced. The member's version kept
 * the path; the agent's is the conflict copy beside it. Names and hashes only.
 */
import type { ProposalView } from "./editor-state";
import { fileName } from "./preview";

/** One conflict in web casing. */
export interface SyncConflictView {
  readonly id: string;
  readonly path: string;
  readonly conflictPath: string;
  readonly memberSha256: string;
  readonly agentSha256: string;
  readonly createdAt: string;
}

/** The notice's text: which file, which version was kept, where the agent's went. */
export function conflictNoticeText(c: SyncConflictView): string {
  return `The agent's change to ${fileName(c.path)} conflicted with your save. Your version was kept; the agent's is in ${fileName(c.conflictPath)}.`;
}

/**
 * Compare: the file editor's inline diff (the proposal review, KOBE-463) with the member's file as
 * the base and the agent's copy as the proposal, so the member can take the agent's changes chunk
 * by chunk and commit them onto their own version.
 */
export function conflictReview(c: SyncConflictView, agentText: string): ProposalView {
  return {
    toolCallId: `sync-conflict:${c.id}`,
    path: c.path,
    baseSha256: c.memberSha256,
    content: agentText,
    summary: `the agent's version from ${fileName(c.conflictPath)}, shown against yours`,
  };
}
