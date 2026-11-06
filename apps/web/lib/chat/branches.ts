/**
 * The Conversation tree's one read (CT2, KOBE-545): `GET /v1/threads/{id}/branches`, the labels
 * and the remembered-rule runs the web cannot derive from the entries (`use-branches.ts` reads it).
 */
import { threadBranchesResponseSchema, type ThreadBranchesResponse } from "@kobe/protocol";
import { LINEAGE_REREAD_MS } from "./lineage";
import { readWire } from "./wire-read";

export const BRANCHES_REREAD_MS = LINEAGE_REREAD_MS;

export const EMPTY_BRANCHES: ThreadBranchesResponse = Object.freeze({
  labels: [],
  runs: [],
}) as ThreadBranchesResponse;

/** One read, validated as sent (wire casing, as the lineage read). Never throws: null on failure. */
export function readThreadBranches(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ThreadBranchesResponse | null> {
  const route = `/v1/threads/${encodeURIComponent(threadId)}/branches`;
  return readWire(route, threadBranchesResponseSchema, teamId, fetchFn);
}
