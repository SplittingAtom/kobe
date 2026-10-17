import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isLockConflict, sql, withTeam } from "@kobe/db";
import {
  isMemberDropPath,
  WORKSPACE_MOVE_MAX_FILES,
  workspaceMoveRequestSchema,
  type WorkspaceFileError,
  type WorkspaceMoveResponse,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { retargetScheduleMentions } from "../schedules/mention-moves.js";
import { baseName, moveRefusal } from "../workspace-files/paths.js";
import { moveFiles, type MoveOutcome } from "../workspace-sync/move.js";
import { resolveLimits } from "../workspace-sync/quota.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

type Ctx = Context<{ Variables: TeamVariables }>;
type Status = 400 | 403 | 404 | 409 | 422 | 429 | 503 | 507;

/** Moves and renames per member per minute (a drag is one; a folder is one however big). */
export const MOVE_RATE_LIMIT = { windowMs: 60_000, max: 60 };
/** Two paths of at most 1024 bytes each, JSON-escaped, with room to spare. */
const MOVE_MAX_BODY = 16 * 1024;
/** How long a move waits for the workspace's lock (a sandbox's commit, a collection). */
const LOCK_TIMEOUT = "5s";

const fail = (
  c: Ctx,
  status: Status,
  code: WorkspaceFileError["code"] | "invalid_request" | "rate_limited" | "busy",
  message: string,
) => c.json({ code, message }, status);

function refused(c: Ctx, outcome: Exclude<MoveOutcome, { kind: "moved" }>, to: string) {
  switch (outcome.kind) {
    case "missing":
      return fail(c, 404, "not_found", "No such file or folder.");
    case "taken":
      return fail(
        c,
        409,
        "already_exists",
        `Something named ${baseName(to)} is already there. Rename one of them first.`,
      );
    case "folder":
      return fail(c, 403, "read_only", "Only files can be moved into uploads.");
    case "too_many":
      return fail(
        c,
        422,
        "invalid_path",
        "That folder holds too many files to move at once; move its subfolders first.",
      );
    case "too_long":
      return fail(c, 422, "invalid_path", "A path in that folder would be too long there.");
    case "no_room":
      return fail(
        c,
        507,
        "quota_exceeded",
        "Your workspace holds too many files to move this now.",
      );
  }
}

/**
 * `POST /v1/workspace/files/move` (KOBE-304; contract `workspaceMoveRequestSchema`): moves or
 * renames a file or folder of the caller's own workspace. The owner comes from the session, never
 * the request; the rules are the server's (`moveRefusal`, then `moveFiles` under the workspace and
 * legal-hold locks inside `withTeam()`). A name clash is refused, never overwritten. Audited as
 * `workspace.file_moved` with counts only; the owner's schedules that mention a moved file follow
 * it. Under a legal hold it answers exactly the same (the old paths are kept aside in SQL).
 */
export function registerWorkspaceMove(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
  sync: WorkspaceSync,
): void {
  const db = deps.database.db;
  const maxRows = resolveLimits(sync.limits).maxRows;
  app.post(
    "/files/move",
    bodyLimit({
      maxSize: MOVE_MAX_BODY,
      onError: (c) => c.json({ code: "invalid_request", message: "That move is too large." }, 413),
    }),
    async (c) => {
      const body = workspaceMoveRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return fail(c, 400, "invalid_path", "That is not a valid workspace path.");
      const { from, to } = body.data;
      const rule = moveRefusal(from, to);
      if (rule) return fail(c, rule.status, rule.code, rule.message);
      const owner = { teamId: c.get("team").id, userId: c.get("user").id };
      if (!(await hitRateLimit(db, `workspace-move:${owner.userId}`, MOVE_RATE_LIMIT))) {
        return fail(c, 429, "rate_limited", "Too many moves. Wait a moment and try again.");
      }
      let outcome: MoveOutcome;
      try {
        outcome = await withTeam(db, owner.teamId, async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`));
          const moved = await moveFiles(tx, owner, {
            from,
            to,
            fileOnly: isMemberDropPath(to),
            maxFiles: WORKSPACE_MOVE_MAX_FILES,
            maxRows,
          });
          if (moved.kind !== "moved") return moved;
          await retargetScheduleMentions(tx, owner, from, to);
          await recordAudit(tx, {
            action: "workspace.file_moved",
            teamId: owner.teamId,
            target: { userId: owner.userId, files: moved.files, bytes: moved.bytes },
          });
          return moved;
        });
      } catch (err) {
        if (!isLockConflict(err)) throw err;
        c.header("Retry-After", "2");
        return fail(c, 503, "busy", "Your workspace is busy syncing. Try again in a moment.");
      }
      if (outcome.kind !== "moved") return refused(c, outcome, to);
      const res: WorkspaceMoveResponse = { from, to, type: outcome.type, files: outcome.files };
      return c.json(res);
    },
  );
}
