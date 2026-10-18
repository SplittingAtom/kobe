import {
  and,
  eq,
  isNull,
  siteAgents,
  threads,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import { KOBE_GALLERY_KEY } from "../../gallery/definitions.js";
import { logger } from "../../logger.js";
import type { BlobStore } from "../../retention/blobs.js";
import { visibleDraft } from "./records.js";
import { prepareDraftTest, UNAVAILABLE_MESSAGE } from "./test-bundle.js";

/**
 * A Workbench test chat's start (KOBE-323, SK13): a conversation with the general-purpose Kobe
 * agent about a draft the creator can see (theirs, or one shared with them), in the same team.
 * The thread is ordinary otherwise; its runs load only the draft (`withDraftTests`).
 */
export type TestChatStart =
  | { readonly ok: true; readonly agentId: string }
  | {
      readonly ok: false;
      readonly error: "draft_not_found" | "test_chat_agent" | "agent_not_found";
    };

export async function testChatStart(
  tx: KobeTx,
  who: { readonly teamId: string; readonly userId: string; readonly role: TeamRole },
  draftId: string,
  agentId: string | null | undefined,
): Promise<TestChatStart> {
  if (!(await visibleDraft(tx, who.teamId, draftId, who)))
    return { ok: false, error: "draft_not_found" };
  const [kobe] = await tx
    .select({ id: siteAgents.id })
    .from(siteAgents)
    .where(
      and(
        eq(siteAgents.scope, "gallery"),
        eq(siteAgents.galleryKey, KOBE_GALLERY_KEY),
        isNull(siteAgents.archivedAt),
      ),
    );
  if (!kobe) return { ok: false, error: "agent_not_found" };
  if (agentId != null && agentId !== kobe.id) return { ok: false, error: "test_chat_agent" };
  return { ok: true, agentId: kobe.id };
}

export interface TestChatRefusal {
  readonly status: 403 | 409 | 422 | 503;
  readonly code: string;
  readonly message: string;
}

const REFUSALS: Readonly<Record<string, { status: 403 | 409 | 422 | 503; code: string }>> = {
  draft_unavailable: { status: 409, code: "skill_draft_unavailable" },
  invalid_draft: { status: 422, code: "invalid_draft" },
  blocklisted: { status: 409, code: "skill_blocklisted" },
  scan_blocked: { status: 409, code: "scan_blocked" },
  scan_incomplete: { status: 503, code: "scan_incomplete" },
  scan_busy: { status: 503, code: "scan_busy" },
  personal_skills_disabled: { status: 403, code: "personal_skills_disabled" },
  skill_declined: { status: 409, code: "skill_declined" },
};

/**
 * Before a message is accepted in a thread (KOBE-323): for the owner's Workbench test chat, its
 * draft's current revision is scanned and stored (`prepareDraftTest`), or the message is refused
 * with the reason. Any other thread (or a caller who isn't its owner, whom the run API refuses
 * anyway) is left to the run API: null.
 */
export async function prepareTestChat(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore | undefined },
  who: { readonly teamId: string; readonly userId: string; readonly role: TeamRole },
  threadId: string,
): Promise<TestChatRefusal | null> {
  const [thread] = await withTeam(deps.db, who.teamId, (tx) =>
    tx
      .select({ skillTest: threads.skillTest, draftId: threads.skillDraftId })
      .from(threads)
      .where(
        and(
          eq(threads.teamId, who.teamId),
          eq(threads.id, threadId),
          eq(threads.ownerUserId, who.userId),
        ),
      ),
  );
  if (!thread?.skillTest) return null;
  if (thread.draftId === null)
    return { status: 409, code: "skill_draft_unavailable", message: UNAVAILABLE_MESSAGE };
  if (!deps.blobs)
    return {
      status: 503,
      code: "skills_unavailable",
      message: "Skill storage is not configured, so drafts can't be tested here.",
    };
  let prepared: Awaited<ReturnType<typeof prepareDraftTest>>;
  try {
    prepared = await prepareDraftTest({ db: deps.db, blobs: deps.blobs }, who, thread.draftId);
  } catch (err) {
    // Storage or the scanner failed (review N2): a clear refusal, the details in the server log.
    logger.error({ err, threadId, draftId: thread.draftId }, "skill test chat: draft not prepared");
    return {
      status: 503,
      code: "draft_not_prepared",
      message: "The draft couldn't be prepared for testing right now. Send again in a moment.",
    };
  }
  if (prepared.ok) return null;
  const refusal = REFUSALS[prepared.error] ?? { status: 409 as const, code: prepared.error };
  return { ...refusal, message: prepared.message };
}
