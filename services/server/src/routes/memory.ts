import { Hono } from "hono";
import type { Context } from "hono";
import {
  memoryPutRequestSchema,
  memoryRestoreRequestSchema,
  memoryScopeSchema,
  type MemoryDocDetail,
  type MemoryDocSummary,
  type MemoryScope,
} from "@kobe/protocol";
import { withTeam, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { canAccessProject } from "../memory/access.js";
import { scopeEnabled } from "../memory/switches.js";
import {
  MemoryStorageError,
  RESTORE_MARK,
  deleteMemory,
  findDoc,
  listMemory,
  listVersions,
  readCurrent,
  restoreMemory,
  writeMemory,
  type DocRow,
  type DocVersion,
  type ListedDoc,
  type MemoryActor,
  type MemoryTarget,
} from "../memory/store.js";
import type { BlobStore } from "../retention/blobs.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const NOT_FOUND = { code: "memory_not_found", message: "No such memory file." } as const;
const DISABLED = {
  code: "memory_disabled",
  message: "Memory is turned off for this scope.",
} as const;
const STORAGE = { code: "storage_unavailable", message: "Memory storage is unavailable." } as const;

/** A step's outcome inside the team transaction: a body or an error response to send. */
type Out<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 409 | 413 | 422;
      readonly body: object;
    };
const fail = (status: 400 | 403 | 404 | 409 | 413 | 422, body: object) =>
  ({ ok: false, status, body }) as const;

const summary = (d: ListedDoc): MemoryDocSummary => ({
  id: d.id,
  scope: d.scope,
  path: d.path,
  current_version: d.currentVersion,
  size_bytes: d.sizeBytes,
  updated_at: d.updatedAt.toISOString(),
  updated_by: d.updatedBy,
});

const sourceOf = (v: DocVersion) =>
  v.toolCallId?.startsWith(RESTORE_MARK)
    ? ("restore" as const)
    : v.actorKind === "agent"
      ? ("agent" as const)
      : ("panel" as const);

/**
 * Memory panel API (`/v1/memory`, KOBE-155; contract `packages/protocol/src/memory.ts`, spec D24).
 * Personal memory is the caller's own: another member's doc is a 404, also for team admins (only
 * break-glass reads it). Project memory needs project membership (`canAccessProject`, a seam
 * until projects exist). Each scope also needs its switches on (`memory_disabled`, 403). Every
 * query runs under `withTeam`; content comes from the object store; audit events carry ids and
 * versions, never paths or content. Panel edits apply at once (also for `project`).
 */
export function memoryRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  const run = async <T>(c: Ctx, fn: (tx: KobeTx, blobs: BlobStore) => Promise<Out<T>>) => {
    const blobs = deps.blobs;
    if (!blobs) return c.json(STORAGE, 503);
    try {
      const out = await withTeam(db, c.get("team").id, (tx) => fn(tx, blobs));
      return out.ok ? c.json(out.value as object) : c.json(out.body, out.status);
    } catch (err) {
      if (!(err instanceof MemoryStorageError)) throw err;
      logger.error({ err, teamId: c.get("team").id }, "memory storage failed");
      return c.json(STORAGE, 503);
    }
  };

  /** Who the target belongs to, after the access and switch checks. */
  const resolveTarget = async (
    tx: KobeTx,
    c: Ctx,
    scope: MemoryScope,
    projectId: string | undefined,
  ): Promise<Out<MemoryTarget>> => {
    const userId = c.get("user").id;
    let target: MemoryTarget;
    if (scope === "user") {
      if (projectId !== undefined)
        return fail(400, { code: "invalid_request", message: "project_id is for scope=project." });
      target = { scope, ownerUserId: userId };
    } else {
      if (projectId === undefined || !uuidSchema.safeParse(projectId).success) {
        return fail(400, { code: "invalid_request", message: "scope=project needs project_id." });
      }
      if (!(await canAccessProject(tx, c.get("team").id, userId, projectId)))
        return fail(404, NOT_FOUND);
      target = { scope, projectId };
    }
    if (!(await scopeEnabled(tx, c.get("team").id, scope))) return fail(403, DISABLED);
    return { ok: true, value: target };
  };

  /** The doc if the caller may use it (own personal doc, project member) and its scope is on. */
  const resolveDoc = async (tx: KobeTx, c: Ctx, id: string): Promise<Out<DocRow>> => {
    const doc = await findDoc(tx, c.get("team").id, id);
    const userId = c.get("user").id;
    const allowed =
      doc !== undefined &&
      (doc.scope === "user"
        ? doc.ownerUserId === userId
        : doc.projectId !== null &&
          (await canAccessProject(tx, c.get("team").id, userId, doc.projectId)));
    if (!doc || !allowed) return fail(404, NOT_FOUND);
    if (!(await scopeEnabled(tx, c.get("team").id, doc.scope))) return fail(403, DISABLED);
    return { ok: true, value: doc };
  };

  const detail = async (tx: KobeTx, blobs: BlobStore, teamId: string, id: string) => {
    const doc = await findDoc(tx, teamId, id);
    const versions = await listVersions(tx, teamId, id);
    const current = versions.find((v) => v.version === doc?.currentVersion);
    const content = doc ? await readCurrent(tx, blobs, teamId, doc) : null;
    if (!doc || !current || content === null)
      throw new MemoryStorageError("memory content missing");
    const body: MemoryDocDetail = {
      id: doc.id,
      scope: doc.scope,
      path: doc.path,
      current_version: doc.currentVersion,
      size_bytes: current.sizeBytes,
      updated_at: doc.updatedAt.toISOString(),
      updated_by: current.actorUserId,
      content,
      versions: versions.map((v) => ({
        version: v.version,
        size_bytes: v.sizeBytes,
        created_at: v.createdAt.toISOString(),
        source: sourceOf(v),
      })),
    };
    return body;
  };

  const panelActor = (c: Ctx): MemoryActor => ({ kind: "user", userId: c.get("user").id });

  app.get("/", (c) => {
    const scope = memoryScopeSchema.safeParse(c.req.query("scope"));
    if (!scope.success) return invalidRequest(c, "Send scope=user or scope=project.");
    return run(c, async (tx) => {
      const target = await resolveTarget(tx, c, scope.data, c.req.query("project_id"));
      if (!target.ok) return target;
      const docs = await listMemory(tx, c.get("team").id, target.value);
      return { ok: true, value: { docs: docs.map(summary) } };
    });
  });

  app.put("/", async (c) => {
    const parsed = memoryPutRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalidRequest(c);
    const body = parsed.data;
    return run(c, async (tx, blobs) => {
      const teamId = c.get("team").id;
      const target = await resolveTarget(tx, c, body.scope, c.req.query("project_id"));
      if (!target.ok) return target;
      const written = await writeMemory(
        tx,
        blobs,
        teamId,
        target.value,
        {
          path: body.path,
          content: body.content,
          ...(body.expected_version !== undefined
            ? { expectedVersion: body.expected_version }
            : {}),
        },
        panelActor(c),
      );
      if (!written.ok) {
        const status =
          written.code === "version_conflict" ? 409 : written.code === "too_large" ? 413 : 422;
        return fail(status, {
          code: written.code,
          message: written.message,
          ...("currentVersion" in written ? { current_version: written.currentVersion } : {}),
        });
      }
      await recordAudit(tx, {
        action: "memory.written",
        teamId,
        target: {
          scope: body.scope,
          memoryDocId: written.docId,
          version: written.version,
          ...(written.previousVersion !== undefined
            ? { previousVersion: written.previousVersion }
            : {}),
          actorKind: "user",
          sizeBytes: written.sizeBytes,
        },
      });
      return { ok: true, value: await detail(tx, blobs, teamId, written.docId) };
    });
  });

  app.get("/:id", (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    return run(c, async (tx, blobs) => {
      const doc = await resolveDoc(tx, c, id.data);
      if (!doc.ok) return doc;
      if (doc.value.deletedAt !== null) return fail(404, NOT_FOUND);
      return { ok: true, value: await detail(tx, blobs, c.get("team").id, id.data) };
    });
  });

  app.delete("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const res = await run(c, async (tx) => {
      const doc = await resolveDoc(tx, c, id.data);
      if (!doc.ok) return doc;
      const teamId = c.get("team").id;
      const deleted = await deleteMemory(tx, teamId, id.data);
      if (!deleted) return fail(404, NOT_FOUND);
      await recordAudit(tx, {
        action: "memory.deleted",
        teamId,
        target: { scope: doc.value.scope, memoryDocId: id.data, version: deleted.version },
      });
      return { ok: true, value: {} };
    });
    return res.status === 200 ? c.body(null, 204) : res;
  });

  app.post("/:id/restore", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const body = memoryRestoreRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return invalidRequest(c);
    return run(c, async (tx, blobs) => {
      const doc = await resolveDoc(tx, c, id.data);
      if (!doc.ok) return doc;
      const teamId = c.get("team").id;
      const restored = await restoreMemory(
        tx,
        blobs,
        teamId,
        id.data,
        body.data.version,
        panelActor(c),
      );
      if (!restored.ok)
        return fail(404, { code: "version_not_found", message: "No such version." });
      await recordAudit(tx, {
        action: "memory.restored",
        teamId,
        target: {
          scope: doc.value.scope,
          memoryDocId: id.data,
          fromVersion: restored.fromVersion,
          version: restored.version,
        },
      });
      return { ok: true, value: await detail(tx, blobs, teamId, id.data) };
    });
  });

  return app;
}
