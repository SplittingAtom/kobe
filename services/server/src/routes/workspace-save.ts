import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  workspaceSaveQuerySchema,
  type WorkspaceFileError,
  type WorkspaceSaveConflict,
} from "@kobe/protocol";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import { fileEntry } from "../workspace-files/browse.js";
import { isInternalPath, isReadOnlyPath } from "../workspace-files/paths.js";
import { saveWorkspaceFile } from "../workspace-files/save.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const fail = (
  c: Ctx,
  status: 400 | 403 | 404 | 413 | 502 | 503 | 507,
  code: WorkspaceFileError["code"] | "invalid_request",
  message: string,
) => c.json({ code, message }, status);

/**
 * `PUT /v1/workspace/file?path=&base_sha256=` (KOBE-462, contract file-editor.ts, spec FE4): the
 * file editor's save into the caller's own workspace. Whoever may upload may save (`team.chat`,
 * the owner from the session, never the request); the same path rules, size limit, quotas and
 * read-only areas as the browser upload. Agent-internal paths are not found.
 */
export function registerWorkspaceSave(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
  sync: WorkspaceSync,
): void {
  const maxBytes = Math.min(sync.limits.maxFileBytes, UPLOAD_DEFAULT_MAX_FILE_BYTES);
  app.put(
    "/file",
    bodyLimit({
      maxSize: maxBytes,
      onError: (c) =>
        c.json(
          { code: "file_too_large", message: `Files over ${maxBytes} bytes are not accepted.` },
          413,
        ),
    }),
    async (c) => {
      const query = workspaceSaveQuerySchema.safeParse(
        Object.fromEntries(new URL(c.req.url).searchParams),
      );
      if (!query.success) {
        return fail(c, 400, "invalid_request", "Name the file and the version you edited.");
      }
      const { path, base_sha256: baseSha256 } = query.data;
      if (isInternalPath(path)) return fail(c, 404, "not_found", "No such file or folder.");
      if (isReadOnlyPath(path)) {
        return fail(c, 403, "read_only", "Project files and thread uploads are read-only here.");
      }
      const content = Buffer.from(await c.req.arrayBuffer());
      const owner = { teamId: c.get("team").id, userId: c.get("user").id };
      const result = await saveWorkspaceFile(deps.database.db, sync, owner, {
        path,
        baseSha256,
        content,
        limitBytes: maxBytes,
        teamQuotaDefaultBytes: (deps.uploads ?? DEFAULT_UPLOAD_SETTINGS).defaultQuotaBytes,
      }).catch((err: unknown) => {
        logger.error({ err, teamId: owner.teamId }, "workspace save failed");
        return undefined;
      });
      if (result === undefined) {
        return fail(c, 502, "sandbox_unavailable", "The file could not be saved; try again.");
      }
      if (result.ok) return c.json(fileEntry(result.entry), 200);
      if ("current" in result) {
        const body: WorkspaceSaveConflict = {
          code: result.code,
          message: result.message,
          current: result.current,
        };
        return c.json(body, 409);
      }
      return fail(c, result.status as 413 | 502 | 503 | 507, result.code, result.message);
    },
  );
}
