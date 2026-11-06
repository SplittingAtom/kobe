/**
 * The Conversation tree's one read (CT2, KOBE-545): `GET /v1/threads/{id}/branches`, the labels
 * and the remembered-rule runs the web cannot derive from the entries (`use-branches.ts` reads it).
 */
import {
  setLabelBodySchema,
  threadBranchesResponseSchema,
  type ThreadBranchesResponse,
} from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../api/client";
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

/** The `branches` body as `apiRequest` camelizes it (the label write's answer). */
interface CamelBranches {
  readonly labels?: readonly { readonly entryId?: unknown; readonly label?: unknown }[];
  readonly runs?: readonly { readonly userEntryId?: unknown; readonly rememberedRule?: unknown }[];
}

/**
 * `PUT /v1/threads/{id}/labels/{entryId}` (CT9, KOBE-546): `{label}` sets it, `null` removes it;
 * the answer is the `branches` body, given back in wire casing and validated like the read. An
 * answer that does not validate is an error, so the tree never shows a half-read store.
 */
export async function writeThreadLabel(
  threadId: string,
  entryId: string,
  label: string | null,
  teamId: string,
  fetchFn?: typeof fetch,
): Promise<ApiResult<ThreadBranchesResponse>> {
  const body = setLabelBodySchema.parse({ label });
  const res = await apiRequest<CamelBranches>(
    `/v1/threads/${encodeURIComponent(threadId)}/labels/${encodeURIComponent(entryId)}`,
    { method: "PUT", json: body, teamId, fetchFn },
  );
  if (!res.ok) return res;
  const parsed = threadBranchesResponseSchema.safeParse({
    labels: (res.data.labels ?? []).map((l) => ({ entry_id: l.entryId, label: l.label })),
    runs: (res.data.runs ?? []).map((r) => ({
      user_entry_id: r.userEntryId,
      remembered_rule: r.rememberedRule,
    })),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: { status: res.status, code: "invalid_response", message: "Unexpected answer." },
    };
  }
  return { ok: true, status: res.status, data: parsed.data };
}
