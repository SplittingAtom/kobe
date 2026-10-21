import { Hono, type Context } from "hono";
import { sql, withTeam } from "@kobe/db";
import {
  THREAD_CONTEXT_ERROR_HTTP_STATUS,
  THREAD_CONTEXT_MAX_BYTES,
  threadContextError,
  threadContextCommandResultSchema,
  threadContextResultSchema,
  type ThreadContext,
  type ThreadContextErrorCode,
  type ThreadContextWaking,
} from "@kobe/protocol";
import { sealedReplyKeyPair } from "@kobe/protocol/node";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { hitRateLimit } from "../rate-limit.js";
import { SandboxWakeError } from "../sandbox-wire/types.js";
import { invalidRequest } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import { findThread } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

const NOT_FOUND = { code: "thread_not_found", message: "No thread with that id." };
/** How soon the web asks again while the sandbox wakes. */
export const CONTEXT_WAKE_RETRY_MS = 2_000;
/** How long a read waits for the wake to be refused at once (isolation, membership checks). */
export const CONTEXT_WAKE_REFUSAL_WAIT_MS = 1_500;
/** A refused wake is reported to the member's next read within this long (a slow refusal). */
export const CONTEXT_WAKE_REFUSAL_MEMORY_MS = 120_000;
const MAX_REMEMBERED_REFUSALS = 10_000;
/** Reads per member per minute: each one is a command to their sandbox. */
export const CONTEXT_RATE_LIMIT = { windowMs: 60_000, max: 30 };

/** The sandbox's (or the wire's) failure code, as the member's error. Its text is never relayed. */
export function contextErrorFor(code: string): ThreadContextErrorCode {
  switch (code) {
    case "pi_rejected":
      return "thread_busy";
    case "context_unsupported":
    case "unknown_type":
      return "context_unsupported";
    case "timeout":
    case "unavailable":
    case "connection_lost":
    case "session_unavailable":
    case "sandbox_unavailable":
    case "workspace_unavailable":
    case "isolation_runtime_missing":
      return "sandbox_unavailable";
    default:
      return "context_unavailable";
  }
}

/** The opened answer, validated; undefined when it is not JSON or not a context. */
function parseContext(text: string) {
  try {
    const parsed = threadContextResultSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const fail = (c: Context, code: ThreadContextErrorCode) =>
  c.json(threadContextError(code), THREAD_CONTEXT_ERROR_HTTP_STATUS[code]);

/**
 * `GET /v1/threads/{id}/context` (KOBE-470, docs/specs/context-viewer.md): the context of the
 * thread's latest model call, read live from the owner's sandbox (`thread.context`). Only the
 * thread's owner: a shared (project) reader gets 403 `not_owner`, anyone else the usual 404. A
 * sandbox that is not connected is woken and the answer is 202 `waking` (ask again); a connected
 * one answers within the command's deadline. Nothing is stored or logged: the answer is validated,
 * returned with `no-store`, and only failure codes reach the log.
 */
export function threadContextRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  /**
   * Wakes this replica saw refused (`SandboxWakeError`: no gVisor/Kata runtime, the member may not
   * have a sandbox, not ready within the wake budget), by team and user: the next read reports it
   * instead of answering 202 for ever. Per replica; a read on another one starts its own wake,
   * which is refused the same way.
   */
  const refusals = new Map<string, number>();
  const refuse = (key: string) => {
    if (refusals.size >= MAX_REMEMBERED_REFUSALS) refusals.clear();
    refusals.set(key, Date.now());
  };
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.get("/:id/context", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    // Read per request: building the app touches no dependency a route may not need (KOBE-14).
    const db = deps.database.db;
    const router = deps.sandboxWire.router;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const access = await withTeam(db, teamId, async (tx) => {
      const viewer = { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) };
      const found = await findThread(tx, viewer, id.data);
      if (found === null) return null;
      const res = await tx.execute<{ skill_eval: boolean }>(sql`
        SELECT skill_eval FROM threads WHERE team_id = ${teamId} AND id = ${id.data}`);
      return { owner: found.access === "owner", skillEval: res.rows[0]?.skill_eval === true };
    });
    if (access === null) return c.json(NOT_FOUND, 404);
    if (!access.owner) return fail(c, "not_owner");
    // A skill eval's thread runs in its own ephemeral sandbox, never the member's: nothing to wake.
    if (access.skillEval) return fail(c, "context_unsupported");
    if (!(await hitRateLimit(db, `thread-context:${userId}`, CONTEXT_RATE_LIMIT))) {
      return fail(c, "rate_limited");
    }
    c.header("cache-control", "private, no-store");
    const target = { teamId, userId };
    if (!(await router.isConnected(target, id.data))) {
      const key = `${teamId}:${userId}`;
      const refusedAt = refusals.get(key);
      refusals.delete(key);
      if (refusedAt !== undefined && Date.now() - refusedAt < CONTEXT_WAKE_REFUSAL_MEMORY_MS) {
        return fail(c, "sandbox_refused");
      }
      // Like sending (D14): the sandbox wakes; the viewer shows progress and asks again.
      const waking = router.wake(target).then(
        () => "woken" as const,
        (err: unknown) => {
          if (err instanceof SandboxWakeError) {
            refuse(key);
            logger.info({ team_id: teamId, code: err.code }, "context viewer wake refused");
            return "refused" as const;
          }
          logger.warn({ err, team_id: teamId, thread_id: id.data }, "context viewer wake failed");
          return "failed" as const;
        },
      );
      const early = await Promise.race([
        waking,
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), CONTEXT_WAKE_REFUSAL_WAIT_MS).unref(),
        ),
      ]);
      if (early === "refused") {
        refusals.delete(key);
        return fail(c, "sandbox_refused");
      }
      const body: ThreadContextWaking = { status: "waking", retry_after_ms: CONTEXT_WAKE_RETRY_MS };
      return c.json(body, 202);
    }
    // A one-use key pair per request (CV8): the sandbox seals its answer to it, so the command row
    // that carries it between replicas never holds plaintext; the private key stays in `pair`.
    const pair = sealedReplyKeyPair();
    const outcome = await router.threadContext(target, {
      threadId: id.data,
      maxBytes: THREAD_CONTEXT_MAX_BYTES,
      replyKey: pair.key,
    });
    if (!outcome.ok) {
      logger.info(
        { team_id: teamId, thread_id: id.data, code: outcome.error.code },
        "thread context not read",
      );
      return fail(c, contextErrorFor(outcome.error.code));
    }
    const envelope = threadContextCommandResultSchema.safeParse(outcome.data);
    const opened = envelope.success ? pair.open(envelope.data.sealed, id.data) : undefined;
    const parsed = opened === undefined ? undefined : parseContext(opened);
    const bytes =
      parsed === undefined
        ? 0
        : parsed.sections.reduce((sum, s) => sum + Buffer.byteLength(s.text), 0);
    if (parsed === undefined || bytes > THREAD_CONTEXT_MAX_BYTES) {
      logger.warn({ team_id: teamId, thread_id: id.data }, "invalid thread context from sandbox");
      return fail(c, "context_unavailable");
    }
    const body: ThreadContext = { ...parsed, thread_id: id.data };
    return c.json(body);
  });

  return app;
}
