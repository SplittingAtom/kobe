import { apiRequest, type ApiResult } from "../api/client";

/**
 * The drafts `save_skill_draft` made or updated in a conversation (KOBE-442), as the server
 * recorded them (`GET /v1/skills/drafts/saves`, review L4): the Open in Workbench card is built
 * from these only, never from the tool result the sandbox relays.
 */
export interface SavedSkillDraft {
  readonly toolCallId: string;
  readonly draftId: string;
  readonly name: string;
  readonly created: boolean;
  /** A new draft although the conversation had one: it was shared, or edited since. */
  readonly newBecause?: "shared" | "edited";
}

export const SAVE_SKILL_DRAFT_TOOL = "save_skill_draft";

export async function recordedSkillDraftSaves(
  teamId: string,
  threadId: string,
): Promise<ApiResult<readonly SavedSkillDraft[]>> {
  const res = await apiRequest<{ saves: SavedSkillDraft[] }>(
    `/v1/skills/drafts/saves?threadId=${encodeURIComponent(threadId)}`,
    { teamId },
  );
  return res.ok ? { ...res, data: res.data.saves } : res;
}
