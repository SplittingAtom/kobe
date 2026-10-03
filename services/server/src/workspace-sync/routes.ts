import { Readable } from "node:stream";
import { SYSTEM_ACTOR, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
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
import { resolveLimits, type QuotaCheck, type WorkspaceLimits } from "./quota.js";
import {
  blobState,
  commitChanges,
  currentEntry,
  finishUpload,
  manifestPage,
  missingBlobs,
  publicEntry,
  recordBlob,
  recordRestore,
  reserveUpload,
} from "./store.js";

/** Requests per sandbox: a burst big enough for a restore's downloads, then a steady rate. */
export const WORKSPACE_RATE = { capacity: 2000, refillPerSecond: 500 } as const;
/** Manifest, commit and report calls per sandbox: a much smaller bucket on top. */
export const WORKSPACE_META_RATE = { capacity: 120, refillPerSecond: 20 } as const;
/** Restore reports write a row: at most one per sandbox per minute (audit throttled apart). */
const REPORT_EVERY_MS = 60_000;
/** Concurrent uploads/downloads per sandbox per replica. */
export const WORKSPACE_MAX_TRANSFERS = 16;
/**
 * Database work in flight, per sandbox and per replica. Every workspace endpoint shares the
 * server's connection pool with the user API: one sandbox may hold at most one commit and a few
 * short transactions, and all sandboxes together at most `dbInFlight` connections (beyond: 503,
 * retried), so a compromised sandbox can't starve the API or other tenants.
 */
export interface WorkspaceDbLimits {
  readonly commitsPerSandbox: number;
  readonly othersPerSandbox: number;
  readonly dbInFlight: number;
  /** Separate small pool for ending uploads (they must not be refused, so they wait). */
  readonly finishInFlight: number;
  /** How long a request waits for a replica slot before 503. */
  readonly slotWaitMs: number;
  /** A commit's wait for the workspace row lock (another commit, a collection). */
  readonly lockTimeoutMs: number;
  /**
   * Every other transaction's wait for that lock (upload reservations and finishes, restore
   * reports): short, so a slot is never held long behind a commit — busy answers are retried.
   */
  readonly shortLockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}
export const WORKSPACE_DB_LIMITS: WorkspaceDbLimits = {
  commitsPerSandbox: 1,
  // One sandbox can hold at most 1 + 2 of the replica's 4 slots (downloads' lookups included),
  // and the two short ones only for milliseconds or `shortLockTimeoutMs`: never all of them.
  othersPerSandbox: 2,
  dbInFlight: 4,
  finishInFlight: 2,
  slotWaitMs: 250,
  /** Waiting for the workspace row lock (a long commit, a collection) gives up after this. */
  lockTimeoutMs: 5_000,
  shortLockTimeoutMs: 400,
  statementTimeoutMs: 30_000,
};
/** Throttle for audit rows a looping sandbox could otherwise repeat. */
const AUDIT_EVERY_MS = 5 * 60_000;
const INTEGRITY_AUDIT_EVERY_MS = 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
/** Finish retries on a lock timeout (≈ 30 s of backoff in total, slots released meanwhile). */
const FINISH_RETRIES = 8;

/** Thrown when an in-flight cap is reached: answered 503/429 with Retry-After. */
class Busy extends Error {
  constructor(readonly status: 429 | 503) {
    super("busy");
  }
}

/** Counted slots per key with a ceiling; `take` returns an idempotent release or undefined. */
class Slots {
  /** `take`, retried every 25 ms for up to `waitMs` (a short bounded queue). */
  async wait(key: string, max: number, waitMs: number): Promise<(() => void) | undefined> {
    const until = Date.now() + waitMs;
    for (;;) {
      const release = this.take(key, max);
      if (release || Date.now() >= until) return release;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  readonly #used = new Map<string, number>();
  take(key: string, max: number): (() => void) | undefined {
    const n = this.#used.get(key) ?? 0;
    if (n >= max) return undefined;
    this.#used.set(key, n + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.#used.get(key) ?? 1) - 1;
      if (left <= 0) this.#used.delete(key);
      else this.#used.set(key, left);
    };
  }
}

/** Postgres lock_not_available / query_canceled (our own timeouts), possibly wrapped by Drizzle. */
function isTimeout(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (code === "55P03" || code === "57014") return true;
  }
  return false;
}

export interface WorkspaceRoutesDeps {
  readonly db: KobeDb;
  readonly objects: ObjectStore;
  readonly authenticate: SandboxAuthenticator;
  readonly prefix: string;
  readonly limits: WorkspaceLimits;
  readonly quota: QuotaCheck;
  readonly log: Pick<Logger, "error" | "warn" | "info">;
  readonly limiter?: RateLimiter;
  /** Overrides of {@link WORKSPACE_DB_LIMITS} (tests). */
  readonly dbLimits?: Partial<WorkspaceDbLimits>;
  /** An upload was refused for the workspace's blob budget (collection may free room). */
  readonly onQuotaPressure?: (owner: SandboxCaller) => void;
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
  const { db, objects, prefix, quota, log } = deps;
  const limits = resolveLimits(deps.limits);
  const dbLimits = { ...WORKSPACE_DB_LIMITS, ...deps.dbLimits };
  const limiter = deps.limiter ?? createRateLimiter(WORKSPACE_RATE);
  const metaLimiter = createRateLimiter(WORKSPACE_META_RATE);
  const reported = new Map<string, number>();
  const transfers = new Slots();
  const commits = new Slots();
  const others = new Slots();
  const replica = new Slots();
  const finishing = new Slots();
  const finishOwn = new Slots();
  const audited = new Map<string, number>();
  const integrity = new Map<string, { failures: number; at: number }>();
  const app = new Hono<Vars>();

  const audit = (teamId: string, event: ServerAuditEvent) =>
    void withTeam(db, teamId, (tx) => recordAudit(tx, event)).catch((err: unknown) =>
      log.error({ err, action: event.action }, "could not record a workspace audit event"),
    );
  const throttledAudit = (key: string, teamId: string, event: ServerAuditEvent) => {
    const last = audited.get(key) ?? 0;
    if (Date.now() - last < AUDIT_EVERY_MS) return;
    if (audited.size > 10_000) audited.clear();
    audited.set(key, Date.now());
    audit(teamId, event);
  };
  const auditLimit = (
    caller: SandboxCaller,
    limit: "workspace_bytes" | "workspace_files" | "workspace_file_size",
  ) =>
    throttledAudit(`${caller.sandboxId}:${limit}`, caller.teamId, {
      action: "sandbox.limit_exceeded",
      actor: SYSTEM_ACTOR,
      teamId: caller.teamId,
      target: { sandboxId: caller.sandboxId, userId: caller.userId, limit },
    });
  /** Every mismatch counts; a row at most once a minute carries the count since the last one. */
  const auditIntegrity = (caller: SandboxCaller) => {
    const seen = integrity.get(caller.sandboxId) ?? { failures: 0, at: 0 };
    const failures = seen.failures + 1;
    if (Date.now() - seen.at < INTEGRITY_AUDIT_EVERY_MS) {
      integrity.set(caller.sandboxId, { failures, at: seen.at });
      return;
    }
    if (integrity.size > 10_000) integrity.clear();
    integrity.set(caller.sandboxId, { failures: 0, at: Date.now() });
    audit(caller.teamId, {
      action: "workspace.integrity_failed",
      actor: SYSTEM_ACTOR,
      teamId: caller.teamId,
      target: { sandboxId: caller.sandboxId, userId: caller.userId, failures },
    });
  };

  /**
   * One bounded team transaction for a sandbox: per-sandbox and per-replica in-flight caps
   * (throws {@link Busy}), and lock/statement timeouts so a queue on one workspace's row lock
   * can't pin pool connections.
   */
  const bounded = <T>(teamId: string, lockMs: number, fn: (tx: KobeTx) => Promise<T>): Promise<T> =>
    withTeam(db, teamId, async (t) => {
      await t.execute(sql`
        SELECT set_config('lock_timeout', ${String(lockMs)}, true),
               set_config('statement_timeout', ${String(dbLimits.statementTimeoutMs)}, true)`);
      return fn(t);
    });
  /**
   * `commit` takes the sandbox's one commit slot and may wait `lockTimeoutMs` for the workspace
   * lock; `other` (everything else, downloads' lookups included) takes one of its short slots and
   * waits at most `shortLockTimeoutMs`.
   */
  const tx = async <T>(
    caller: SandboxCaller,
    kind: "commit" | "other",
    fn: (tx: KobeTx) => Promise<T>,
  ): Promise<T> => {
    const mine =
      kind === "commit"
        ? commits.take(caller.sandboxId, dbLimits.commitsPerSandbox)
        : others.take(caller.sandboxId, dbLimits.othersPerSandbox);
    if (!mine) throw new Busy(429);
    const pool = await replica.wait("db", dbLimits.dbInFlight, dbLimits.slotWaitMs);
    if (!pool) {
      mine();
      throw new Busy(503);
    }
    try {
      const lockMs = kind === "commit" ? dbLimits.lockTimeoutMs : dbLimits.shortLockTimeoutMs;
      return await bounded(caller.teamId, lockMs, fn);
    } finally {
      pool();
      mine();
    }
  };
  /**
   * Ending an upload (record the content, release the reservation) waits rather than being
   * refused: one finish per sandbox at a time (its own queue), a few per replica, the short lock
   * timeout, and retries with backoff on a lock timeout — releasing both slots while it backs off,
   * so a sandbox whose own commit holds its workspace lock never holds a shared slot meanwhile.
   */
  const finishTx = async <T>(caller: SandboxCaller, fn: (tx: KobeTx) => Promise<T>) => {
    for (let attempt = 0; ; attempt++) {
      const own = await finishOwn.wait(caller.sandboxId, 1, 60_000);
      if (!own) throw new Busy(503);
      const slot = await finishing.wait("db", dbLimits.finishInFlight, 60_000);
      if (!slot) {
        own();
        throw new Busy(503);
      }
      try {
        return await bounded(caller.teamId, dbLimits.shortLockTimeoutMs, fn);
      } catch (err) {
        if (!isTimeout(err) || attempt >= FINISH_RETRIES) throw err;
      } finally {
        slot();
        own();
      }
      await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** attempt, 5_000)));
    }
  };

  const busy = (c: Context, status: 429 | 503, message: string) => {
    c.header("Retry-After", "1");
    return error(c, status, status === 429 ? "rate_limited" : "busy", message);
  };
  const metaAllowed = (caller: SandboxCaller, c: Context): Response | undefined => {
    const wait = metaLimiter.take(caller.sandboxId);
    if (wait <= 0) return undefined;
    c.header("Retry-After", String(Math.ceil(wait / 1000)));
    return error(c, 429, "rate_limited", "Too many requests.");
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
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const since = Number(c.req.query("since") ?? "0");
    const limit = Number(c.req.query("limit") ?? String(WORKSPACE_MAX_BATCH));
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) {
      return error(c, 400, "invalid_request", "since and limit must be non-negative integers.");
    }
    const page = await tx(caller, "other", (t) =>
      manifestPage(t, caller, since, Math.min(limit, WORKSPACE_MAX_BATCH)),
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
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const body = workspaceBlobsMissingRequestSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Expected {sha256: [...]}.");
    const missing = await tx(caller, "other", (t) => missingBlobs(t, caller, body.data.sha256));
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
      const max = limits.maxFileBytes;
      return error(c, 413, "file_too_large", `Files over ${max} bytes are not synced.`);
    }
    const release = transfers.take(caller.sandboxId, WORKSPACE_MAX_TRANSFERS);
    if (!release) return busy(c, 429, "Too many transfers at once.");
    try {
      // Reserve the bytes (and one blob) before accepting any: concurrent uploads can't overshoot.
      const state = await tx(caller, "other", async (t) => {
        const held = await blobState(t, caller, sha.data);
        if (held !== "absent") return held;
        return (await reserveUpload(t, caller, size, limits)) ? "reserved" : "over_quota";
      });
      if (state === "held") return c.json({ sha256: sha.data, size }, 200);
      if (state === "deleting") {
        c.header("Retry-After", "5");
        return error(c, 409, "retry_later", "This content is being collected; upload it later.");
      }
      if (state === "over_quota") {
        auditLimit(caller, "workspace_bytes");
        deps.onQuotaPressure?.(caller);
        return error(c, 507, "quota_exceeded", "The workspace holds too much unsynced content.");
      }
      // Recording and ending the reservation are short and bounded by the transfer slots: they
      // take no in-flight slot (an upload that finished must never be left unrecorded).
      let outcome: "added" | "exists" | "deleting" | "failed" = "failed";
      let finished = false;
      try {
        const raw = c.req.raw.body;
        const source = raw ? Readable.fromWeb(raw as never) : Readable.from([]);
        const verified = source.pipe(verifyingStream(sha.data, size));
        source.once("error", (err) => verified.destroy(err));
        try {
          await objects.put(workspaceBlobKey(prefix, caller, sha.data), verified, size);
        } catch (err) {
          if (err instanceof IntegrityError || verified.errored instanceof IntegrityError) {
            auditIntegrity(caller);
            return error(
              c,
              422,
              "hash_mismatch",
              "The bytes did not match their SHA-256 and size.",
            );
          }
          log.error({ err, sandbox_id: caller.sandboxId }, "workspace blob upload failed");
          return error(c, 502, "storage_unavailable", "Object storage is unavailable; retry.");
        }
        outcome = await finishTx(caller, async (t) => {
          const recorded = await recordBlob(t, caller, sha.data, size);
          await finishUpload(t, caller, size, recorded === "added");
          return recorded;
        });
        finished = true;
      } finally {
        // A failed upload still ends its reservation (a crash leaves it to collection).
        if (!finished) {
          await finishTx(caller, (t) => finishUpload(t, caller, size, false)).catch(
            (err: unknown) => log.error({ err }, "could not end an upload reservation"),
          );
        }
      }
      if (outcome === "deleting") {
        c.header("Retry-After", "5");
        return error(c, 409, "retry_later", "This content is being collected; upload it again.");
      }
      return c.json({ sha256: sha.data, size }, outcome === "added" ? 201 : 200);
    } finally {
      release();
    }
  });

  app.post("/commit", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const body = workspaceCommitRequestSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Expected {changes: [...]}.");
    const out = await tx(caller, "commit", (t) =>
      commitChanges(t, caller, body.data.changes, { prefix, quota, maxRows: limits.maxRows }),
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
    const release = transfers.take(caller.sandboxId, WORKSPACE_MAX_TRANSFERS);
    if (!release) return busy(c, 429, "Too many transfers at once.");
    let object;
    let entry;
    try {
      entry = await tx(caller, "other", (t) => currentEntry(t, caller, path.data));
      if (!entry || entry.deleted || entry.blobKey === null) {
        release();
        return error(c, 404, "not_found", "No such file in the workspace.");
      }
      object = await objects.get(entry.blobKey);
    } catch (err) {
      release();
      throw err;
    }
    if (!object) {
      release();
      log.error({ sandbox_id: caller.sandboxId, rev: entry.rev }, "workspace object missing");
      return error(c, 502, "storage_unavailable", "The file's content is missing in storage.");
    }
    // The slot is held until the body has been read out of storage (backpressure-bound).
    object.body.once("close", release);
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

  app.post("/restore-report", async (c) => {
    const caller = c.get("caller");
    const limited = metaAllowed(caller, c);
    if (limited) return limited;
    const body = workspaceRestoreReportSchema.safeParse(await readJson(c));
    if (!body.success) return error(c, 400, "invalid_request", "Invalid restore report.");
    const report = body.data;
    const full = report.mode === "full" && report.files > 0;
    const auditIt =
      full && Date.now() - (audited.get(`${caller.sandboxId}:restored`) ?? 0) > AUDIT_EVERY_MS;
    if (auditIt) audited.set(`${caller.sandboxId}:restored`, Date.now());
    const write = auditIt || Date.now() - (reported.get(caller.sandboxId) ?? 0) > REPORT_EVERY_MS;
    if (reported.size > 10_000) reported.clear();
    if (write) reported.set(caller.sandboxId, Date.now());
    if (write) {
      await tx(caller, "other", async (t) => {
        await recordRestore(t, caller, report.duration_ms);
        if (auditIt) {
          await recordAudit(t, {
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
    }
    log.info(
      { sandbox_id: caller.sandboxId, ...report },
      report.mode === "full" ? "workspace restored onto an empty volume" : "workspace restore",
    );
    return c.body(null, 204);
  });

  app.onError((err, c) => {
    if (err instanceof Busy) return busy(c, err.status, "Too much workspace work in flight.");
    if (isTimeout(err)) {
      c.header("Retry-After", "2");
      return error(c, 503, "retry_later", "The workspace is busy; retry.");
    }
    log.error({ err }, "workspace sync request failed");
    return error(c, 500, "internal", "Workspace sync failed; retry.");
  });

  return app;
}
