import type { BlobStore } from "../retention/blobs.js";
import { draftSkillForRun } from "../skills/drafts/test-bundle.js";
import type { RunAgentResolver } from "./seams.js";

/**
 * Workbench test chats (KOBE-323, SK13): a thread marked `skill_test` runs the agent as usual
 * (its pinned version, model, connectors, approval mode, the team's policy, egress and budgets)
 * with one change: its only skill is its draft's current revision, scanned before the send
 * (`prepareDraftTest`). A draft that is gone, no longer visible to the thread's owner, or changed
 * since its scan fails the run with its own message; it never falls back to the usual skills.
 */
export function withDraftTests(
  base: RunAgentResolver,
  blobs: BlobStore | undefined,
): RunAgentResolver {
  return {
    ...base,
    async resolve(tx, input) {
      if (!input.skillTest) return base.resolve(tx, input);
      const draft = await draftSkillForRun(tx, blobs, {
        teamId: input.teamId,
        ownerUserId: input.ownerUserId,
        draftId: input.skillTest.draftId,
      });
      if (!draft.ok) return { ok: false, error: { code: draft.code, message: "" } };
      return base.resolve(tx, { ...input, onlySkill: { ref: draft.ref, bundle: draft.bundle } });
    },
  };
}
