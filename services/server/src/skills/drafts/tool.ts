import type { SkillDraftSaveFrame, SKILL_DRAFT_SAVE_ERROR_CODES } from "@kobe/protocol";
import { getMembership, sql, withTeam, type KobeDb, type SKILL_DRAFT_REFUSALS } from "@kobe/db";
import { runWithAuditContext } from "../../audit/context.js";
import { teamRoleAllows } from "../../authz/permissions.js";
import { hitRateLimit } from "../../rate-limit.js";
import type { WorkspaceSync } from "../../workspace-sync/index.js";
import { SKILL_UPLOAD_RATE } from "../limits.js";
import { saveWorkspaceSkill, type WorkspaceSaveResult } from "./from-workspace.js";

/**
 * `save_skill_draft` on the server (KOBE-442): what the connection hands over once it checked the
 * capability, the lease and the allowed call (sandbox-wire/connection.ts). From here it is Save to
 * Workbench (KOBE-322) for the run's own thread, with one difference: the files are exactly the
 * ones the sandbox pushed, each live row unchanged since (`pinned`). Nothing the sandbox says
 * about the bytes is trusted; they are read from the workspace store and checked against the
 * manifest's hash. The result is a private draft (created, or this conversation's draft of the
 * same name updated); never a version, a review submission or an eval.
 */

export type SkillDraftRefusal = (typeof SKILL_DRAFT_REFUSALS)[number];
type ErrorCode = (typeof SKILL_DRAFT_SAVE_ERROR_CODES)[number];

export type SkillDraftToolResult =
  | {
      readonly ok: true;
      readonly draftId: string;
      readonly name: string;
      readonly created: boolean;
      readonly rev: number;
      readonly fileCount: number;
    }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
      /** Set when the caller audits the refusal. */
      readonly refusal?: SkillDraftRefusal;
    };

export interface SkillDraftTool {
  /** Binds the workspace store (index.ts, once it exists); without it every save is refused. */
  use(sync: WorkspaceSync): void;
  save(
    target: { readonly teamId: string; readonly userId: string },
    frame: SkillDraftSaveFrame,
  ): Promise<SkillDraftToolResult>;
}

const fail = (code: ErrorCode, message: string, refusal?: SkillDraftRefusal) =>
  ({ ok: false, code, message, ...(refusal ? { refusal } : {}) }) as const;

const RUN_ENDED = fail(
  "not_allowed",
  "The run has ended, so the skill was not saved.",
  "run_not_active",
);

/** The run is this user's message run on this thread and still active (as `share_file`). */
async function runActive(
  db: KobeDb,
  target: { readonly teamId: string; readonly userId: string },
  frame: SkillDraftSaveFrame,
): Promise<boolean> {
  const res = await withTeam(db, target.teamId, (tx) =>
    tx.execute<{ status: string; kind: string }>(sql`
      SELECT r.status, r.kind FROM runs r
        JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
       WHERE r.team_id = ${target.teamId} AND r.id = ${frame.run_id}
         AND r.thread_id = ${frame.thread_id} AND t.owner_user_id = ${target.userId}`),
  );
  const row = res.rows[0];
  return row?.kind === "message" && (row.status === "running" || row.status === "waiting_approval");
}

/** A failed save as the tool's answer; the folder's own words where the member can fix it. */
function refusalOf(result: Extract<WorkspaceSaveResult, { ok: false }>, folder: string) {
  switch (result.error) {
    case "outside_folder":
      return fail(
        "not_allowed",
        `Only files under /workspace/skills/${folder}/ can be saved.`,
        "path_mismatch",
      );
    case "folder_changed":
      return fail(
        "not_synced",
        "The folder changed while saving, or a file was not saved to the workspace copy. Try again.",
        "not_synced",
      );
    case "folder_empty":
    case "thread_not_found":
    case "not_found":
      return fail("not_found", `/workspace/skills/${folder}/ has no saved files.`, "not_found");
    case "invalid_bundle":
      return fail("invalid_skill", result.bundle.message, "invalid_skill");
    case "invalid_path":
      return fail("invalid_skill", result.message, "invalid_skill");
    case "too_many_files":
      return fail("too_many_files", "A skill may hold at most 200 files.", "too_large");
    case "draft_too_large":
    case "file_too_large":
      return fail("too_large", result.message, "too_large");
    case "draft_limit":
      return fail(
        "draft_limit",
        "You have as many drafts as allowed. Delete one in the Workbench first.",
        "draft_limit",
      );
    case "forbidden":
    case "stale_revision":
      return fail("not_allowed", "That draft can't be updated from this conversation.");
  }
}

export function createSkillDraftTool(db: KobeDb): SkillDraftTool {
  let sync: WorkspaceSync | undefined;
  return {
    use(store) {
      sync = store;
    },
    async save(target, frame) {
      const store = sync;
      if (!store) return fail("storage_failed", "Workspace files are not available here.");
      if (!(await runActive(db, target, frame))) return RUN_ENDED;
      const role = await getMembership(db, target.teamId, target.userId);
      if (role === null || !teamRoleAllows(role, "team.personal.create"))
        return fail("forbidden", "Your team role doesn't allow drafts.");
      if (!(await hitRateLimit(db, `skill-upload:${target.userId}`, SKILL_UPLOAD_RATE)))
        return fail(
          "rate_limited",
          "Too many saves. Wait a few minutes and try again.",
          "rate_limited",
        );
      const ctx = { db, teamId: target.teamId, viewer: { userId: target.userId, role } };
      const result = await runWithAuditContext(
        { actor: { kind: "user", id: target.userId }, ip: null, userAgent: null },
        () =>
          saveWorkspaceSkill(ctx, store, {
            threadId: frame.thread_id,
            folder: frame.input.folder,
            pinned: frame.files,
            via: "tool",
          }),
      );
      if (!result.ok) return refusalOf(result, frame.input.folder);
      const { draft } = result;
      return {
        ok: true,
        draftId: draft.id,
        name: draft.name,
        created: result.created !== false,
        rev: draft.rev,
        fileCount: draft.fileCount,
      };
    },
  };
}
