import { Readable } from "node:stream";
import { SYSTEM_ACTOR, withTeam, type KobeDb } from "@kobe/db";
import {
  WORKSPACE_ENTRY_HEADER,
  WORKSPACE_MAX_BATCH,
  encodeWorkspaceEntryHeader,
  sha256HexSchema,
  workspaceBlobsMissingRequestSchema,
  workspaceCommitRequestSchema,
  workspacePathSchema,
  workspaceRestoreReportSchema,
} from "@kobe/protocol";
import { Hono, type Context } from "hono";
import type { Logger } from "pino";
import { recordAudit, type ServerAuditEvent } from "../audit/record.js";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";
import type { SandboxAuthenticator, SandboxCaller } from "./auth.js";
import { workspaceBlobKey } from "./keys.js";
import { IntegrityError, verifyingStream, type ObjectStore } from "./object-store.js";
import type { QuotaCheck, WorkspaceLimits } from "./quota.js";
import {
  blobState,
  commitChanges,
  currentEntry,
  heldBlobBytes,
  manifestPage,
  missingBlobs,
  publicEntry,
  recordBlob,
  recordRestore,
} from "./store.js";

/** Requests per sandbox: a burst big enough for a restore's downloads, then a steady rate. */
export const WORKSPACE_RATE = { capacity: 2000, refillPerSecond: 500 } as const;
/** Concurrent uploads/downloads per sandbox per replica. */
export const WORKSPACE_MAX_TRANSFERS = 16;
/** Throttle for audit rows a looping sandbox could otherwise repeat. */
const AUDIT_EVERY_MS = 5 * 60_000;
const MAX_JSON_BYTES = 1024 * 1024;

export interface WorkspaceRoutesDeps {
  readonly db: KobeDb;
  readonly objects: ObjectStore;
  readonly authenticate: SandboxAuthenticator;
  readonly prefix: string;
  readonly limits: WorkspaceLimits;
  readonly quota: QuotaCheck;
  readonly log: Pick<Logger, "error" | "warn" | "info">;
  readonly limiter?: RateLimiter;
}

type Vars = { Variables: { caller: SandboxCaller } };

const error = (c: Context, status: number, code: string, message: string) =>
  c.json({ code, message }, status as 400);

/**
 * The sandbox-facing workspace sync endpoints (contract: packages/protocol
 * sandbox-wire/workspace-sync.ts), mounted on the sandbox listener only. Everything is scoped to
 * the caller's verified (team, user); object keys never come from the request.
 */
export function workspaceRoutes(deps: WorkspaceRoutesDeps): Hono<Vars> {
  const { db, objects, prefix, limits, quota, log } = deps;
  const limiter = deps.limiter ?? createRateLimiter(WORKSPACE_RATE);
  const transfers = new Map<string, number>();
  const audited = new Map<string, number>();
  const app = new Hono<Vars>();

  const throttledAudit = (key: string, teamId: string, event: ServerAuditEvent) => {
    const last = audited.get(key) ?? 0;
    if (Date.now() - last < AUDIT_EVERY_MS) return;
    if (audited.size > 10_000) audited.clear();
    audited.set(key, Date.now());
    void withTeam(db, teamId, (tx) => recordAudit(tx, event)).catch((err: unknown) =>
      log.error({ err, action: event.action }, "could not record a workspace audit event"),
    );
  };
  const auditLimit = (
    caller: SandboxCaller,
    limit: "workspace_bytes" | "workspace_files" | "workspace_file_size" | "workspace_integrity",
  ) =>
    throttledAudit(`${caller.sandboxId}:${limit}`, caller.teamId, {
      action: "sandbox.limit_exceeded",
      actor: SYSTEM_ACTOR,
      teamId: caller.teamId,
      target: { sandboxId: caller.sandboxId, userId: caller.userId, limit },
    });

  /** Runs a transfer under the per-sandbox concurrency cap. */
  const transfer = async (caller: SandboxCaller, c: Context, fn: () => Promise<Response>) => {
    const n = transfers.get(caller.sandboxId) ?? 0;
    if (n >= WORKSPACE_MAX_TRANSFERS) {
      c.header("Retry-After", "1");
      return error(c, 429, "rate_limited", "Too many transfers at once.");
    }
    transfers.set(caller.sandboxId, n + 1);
    try {
      return await fn();
    } finally {
      const left = (transfers.get(caller.sandboxId) ?? 1) - 1;
      if (left <= 0) transfers.delete(caller.sandboxId);
      else transfers.set(caller.sandboxId, left);
    }
  };

  const readJson = async (c: Context): Promise<unknown> => {
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isInteger(length) || length > MAX_JSON_BYTES) return undefined;
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  app.use(async (c, next) => {
    c.header("Cache-Control", "no-store");
    const auth = await deps.authenticate(c.req.header("authorization"));
    if (!auth.ok) {
      log.info({ reason: auth.reason }, "workspace sync request refused");
      return error(c, 401, "unauthorized", "Valid sandbox token required.");
    }
    const wait = limiter.take(auth.caller.sandboxId);
    if (wait > 0) {
      c.header("Retry-After", String(Math.ceil(wait / 1000)));
      return error(c, 429, "rate_limited", "Too many requests.");
    }
    c.set("caller", auth.caller);
    await next();
  });

  app.get("/manifest", async (c) => {
    const caller = c.get("caller");
    const since = Number(c.req.query("since") ?? "0");
    const limit = Number(c.req.query("limit") ?? String(WORKSPACE_MAX_BATCH));
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) {
      return error(c, 400, "invalid_request", "since and limit must be non-negative integers.");
    }
    const page = await withTeam(db, caller.teamId, (tx) =>
      manifestPage(tx, caller, since, Math.min(limit, WORKSPACE_MAX_BATCH)),
    );
    if (page.kind === "resync_required") {
      return error(c, 409, "resync_required", "Pull the manifest again from revision 0.");
    }
    return c.json({
      head_rev: page.headRev,
      entries: page.entries.map(publicEntry),
      more: page.more,
    });
  });

  app.post("/blobs/missing", async (c) => {
    const caller = c.get("caller");
    const body = workspaceBlobsMissingRequestSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Expected {sha256: [...]}.");
    const missing = await withTeam(db, caller.teamId, (tx) =>
      missingBlobs(tx, caller, body.data.sha256),
    );
    return c.json({ missing });
  });

  app.put("/blobs/:sha256", async (c) => {
    const caller = c.get("caller");
    const sha = sha256HexSchema.safeParse(c.req.param("sha256"));
    const size = Number(c.req.header("content-length") ?? "NaN");
    if (!sha.success) return error(c, 400, "invalid_request", "The name must be a SHA-256.");
    if (!Number.isSafeInteger(size) || size < 0) {
      return error(c, 411, "length_required", "Content-Length is required.");
    }
    if (size > limits.maxFileBytes) {
      auditLimit(caller, "workspace_file_size");
      return error(
        c,
        413,
        "file_too_large",
        `Files over ${limits.maxFileBytes} bytes are not synced.`,
      );
    }
    const state = await withTeam(db, caller.teamId, async (tx) => {
      const s = await blobState(tx, caller, sha.data);
      if (s !== "absent") return s;
      // Uncommitted uploads are bounded too: held blobs may not exceed twice the workspace limit.
      return (await heldBlobBytes(tx, caller)) + size > 2 * limits.maxWorkspaceBytes
        ? "over_quota"
        : "absent";
    });
    if (state === "held") return c.json({ sha256: sha.data, size }, 200);
    if (state === "deleting") {
      c.header("Retry-After", "5");
      return error(
        c,
        409,
        "retry_later",
        "This content is being collected; upload it again shortly.",
      );
    }
    if (state === "over_quota") {
      auditLimit(caller, "workspace_bytes");
      return error(c, 507, "quota_exceeded", "The workspace holds too much unsynced content.");
    }
    return transfer(caller, c, async () => {
      const raw = c.req.raw.body;
      const source = raw ? Readable.fromWeb(raw as never) : Readable.from([]);
      const verified = source.pipe(verifyingStream(sha.data, size));
      source.once("error", (err) => verified.destroy(err));
      try {
        await objects.put(workspaceBlobKey(prefix, caller, sha.data), verified, size);
      } catch (err) {
        if (err instanceof IntegrityError || verified.errored instanceof IntegrityError) {
          auditLimit(caller, "workspace_integrity");
          return error(c, 422, "hash_mismatch", "The bytes did not match their SHA-256 and size.");
        }
        log.error({ err, sandbox_id: caller.sandboxId }, "workspace blob upload failed");
        return error(c, 502, "storage_unavailable", "Object storage is unavailable; retry.");
      }
      const recorded = await withTeam(db, caller.teamId, (tx) =>
        recordBlob(tx, caller, sha.data, size),
      );
      if (!recorded) {
        c.header("Retry-After", "5");
        return error(c, 409, "retry_later", "This content is being collected; upload it again.");
      }
      return c.json({ sha256: sha.data, size }, 201);
    });
  });

  app.post("/commit", async (c) => {
    const caller = c.get("caller");
    const body = workspaceCommitRequestSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Expected {changes: [...]}.");
    const out = await withTeam(db, caller.teamId, (tx) =>
      commitChanges(tx, caller, body.data.changes, { prefix, quota }),
    );
    for (const limit of new Set(out.refused)) {
      auditLimit(caller, limit as "workspace_bytes" | "workspace_files" | "workspace_file_size");
    }
    return c.json({ head_rev: out.headRev, results: out.results });
  });

  app.get("/file", async (c) => {
    const caller = c.get("caller");
    const path = workspacePathSchema.safeParse(c.req.query("path"));
    if (!path.success) return error(c, 400, "invalid_request", "A workspace path is required.");
    const entry = await withTeam(db, caller.teamId, (tx) => currentEntry(tx, caller, path.data));
    if (!entry || entry.deleted || entry.blobKey === null) {
      return error(c, 404, "not_found", "No such file in the workspace.");
    }
    const key = entry.blobKey;
    return transfer(caller, c, async () => {
      const object = await objects.get(key);
      if (!object) {
        log.error({ sandbox_id: caller.sandboxId, rev: entry.rev }, "workspace object missing");
        return error(c, 502, "storage_unavailable", "The file's content is missing in storage.");
      }
      return new Response(Readable.toWeb(object.body) as ReadableStream, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(entry.size),
          "cache-control": "no-store",
          [WORKSPACE_ENTRY_HEADER]: encodeWorkspaceEntryHeader(publicEntry(entry)),
        },
      });
    });
  });

  app.post("/restore-report", async (c) => {
    const caller = c.get("caller");
    const body = workspaceRestoreReportSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Invalid restore report.");
    const report = body.data;
    const full = report.mode === "full" && report.files > 0;
    const audit =
      full && Date.now() - (audited.get(`${caller.sandboxId}:restored`) ?? 0) > AUDIT_EVERY_MS;
    if (audit) audited.set(`${caller.sandboxId}:restored`, Date.now());
    await withTeam(db, caller.teamId, async (tx) => {
      await recordRestore(tx, caller, report.duration_ms);
      if (audit) {
        await recordAudit(tx, {
          action: "workspace.restored",
          actor: SYSTEM_ACTOR,
          teamId: caller.teamId,
          target: {
            sandboxId: caller.sandboxId,
            userId: caller.userId,
            files: report.files,
            bytes: report.bytes,
            durationMs: report.duration_ms,
          },
        });
      }
    });
    log.info(
      { sandbox_id: caller.sandboxId, ...report },
      report.mode === "full" ? "workspace restored onto an empty volume" : "workspace restore",
    );
    return c.body(null, 204);
  });

  app.onError((err, c) => {
    log.error({ err }, "workspace sync request failed");
    return error(c, 500, "internal", "Workspace sync failed; retry.");
  });

  return app;
}
