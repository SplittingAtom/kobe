/**
 * The Conversation tree's one read (CT2, KOBE-545): `GET /v1/threads/{id}/branches`, the labels
 * and the remembered-rule runs the web cannot derive from the entries (`use-branches.ts` reads it).
 */
import { threadBranchesResponseSchema, type ThreadBranchesResponse } from "@kobe/protocol";
import { LINEAGE_REREAD_MS } from "./lineage";
import { TEAM_HEADER } from "../teams";

export const BRANCHES_REREAD_MS = LINEAGE_REREAD_MS;

export const EMPTY_BRANCHES: ThreadBranchesResponse = Object.freeze({
  labels: [],
  runs: [],
}) as ThreadBranchesResponse;

/** One read, validated as sent (wire casing, as the lineage read). Never throws: null on failure. */
export async function readThreadBranches(
  threadId: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ThreadBranchesResponse | null> {
  try {
    const res = await fetchFn(`/v1/threads/${encodeURIComponent(threadId)}/branches`, {
      method: "GET",
      headers: { accept: "application/json", [TEAM_HEADER]: teamId },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const parsed = threadBranchesResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
