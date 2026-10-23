import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import {
  ARTIFACT_FILE_FOLDER,
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  isArtifactTextKind,
  type ArtifactSummary,
} from "@kobe/protocol";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { artifactExtension, fileStem } from "../artifacts/serve.js";
import type { ThreadAccess } from "../threads/repository.js";
import { DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import { fileEntry } from "../workspace-files/browse.js";
import { uploadToWorkspace } from "../workspace-files/upload.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";

type Ctx = Context<{ Variables: TeamVariables }>;

interface Found {
  readonly artifact: ArtifactSummary;
  readonly access: ThreadAccess;
}

/** `artifactRoutes`' version loader: the bytes once `check` passed, else the response to send. */
export type LoadVersion = (
  c: Ctx,
  check?: (found: Found) => Response | undefined,
) => Promise<
  | { readonly response: Response }
  | { readonly found: Found; readonly bytes: Buffer; readonly n: number }
>;

/** The workspace path an artifact copies to before any clash: `artifacts/<slug>.<ext>`. */
export function artifactFilePath(artifact: Pick<ArtifactSummary, "title" | "kind" | "language">) {
  const ext = artifactExtension(artifact.kind, artifact.language);
  return `${ARTIFACT_FILE_FOLDER}/${fileStem(artifact.title)}.${ext}`;
}

/** Owner and kind checks, before the content is read. */
function refusal(c: Ctx, found: Found): Response | undefined {
  if (found.access !== "owner") {
    return c.json(
      { code: "read_only", message: "Only the conversation's owner can edit its artifacts." },
      403,
    );
  }
  if (!isArtifactTextKind(found.artifact.kind)) {
    return c.json(
      { code: "not_editable", message: "Only text artifacts can be edited as files." },
      400,
    );
  }
  return undefined;
}

/**
 * `POST /v1/artifacts/:id/versions/:n/edit-as-file` (KOBE-485): copies one version of a text
 * artifact into the caller's own workspace as `artifacts/<slug>.<ext>`, so the member and the agent
 * can edit it together in the file editor. The thread's owner only (a shared reader gets 403, anyone
 * else 404, as reading); the server copies the bytes it stored, the browser sends none. The copy
 * goes through the browser upload's path (`uploadToWorkspace`: size, workspace and team quotas,
 * the `workspace.file_uploaded` audit event with ids only); a clash takes `-2`, `-3` … under the
 * workspace lock, never overwriting. The artifact itself never changes.
 */
export function registerEditAsFile(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
  sync: WorkspaceSync,
  loadVersion: LoadVersion,
): void {
  const maxBytes = Math.min(sync.limits.maxFileBytes, UPLOAD_DEFAULT_MAX_FILE_BYTES);
  app.post("/:id/versions/:n/edit-as-file", async (c) => {
    const loaded = await loadVersion(c, (found) => refusal(c, found));
    if ("response" in loaded) return loaded.response;
    const { found, bytes, n } = loaded;
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    const result = await uploadToWorkspace(
      deps.database.db,
      sync,
      owner,
      artifactFilePath(found.artifact),
      {
        body: Readable.from([bytes]),
        limitBytes: maxBytes,
        teamQuotaDefaultBytes: (deps.uploads ?? DEFAULT_UPLOAD_SETTINGS).defaultQuotaBytes,
        artifact: { artifactId: found.artifact.id, version: n },
      },
    ).catch((err: unknown) => {
      logger.error({ err, teamId: owner.teamId }, "edit as file failed");
      return undefined;
    });
    if (result === undefined) {
      return c.json(
        { code: "sandbox_unavailable", message: "The file could not be created; try again." },
        502,
      );
    }
    if (!result.ok) return c.json({ code: result.code, message: result.message }, result.status);
    return c.json(fileEntry(result.entry), 201);
  });
}
