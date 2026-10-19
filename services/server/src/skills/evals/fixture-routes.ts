import { sql, withTeam, type KobeDb } from "@kobe/db";
import { fixtureWorkspacePath, skillEvalSuiteSchema } from "@kobe/protocol";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { BlobStore } from "../../retention/blobs.js";
import type { SandboxAuthenticator } from "../../workspace-sync/auth.js";
import { readFixtures } from "./storage.js";

/**
 * `GET ?path=<workspace path>` on the sandbox listener (KOBE-325, `SKILL_EVAL_FIXTURES_PATH`): one
 * fixture of the case a skill eval's own sandbox runs. The caller must be that sandbox (its token
 * names the eval thread, live as checked by the authenticator); its thread's execution must be
 * starting; the path must be one of that case's fixtures. Everything else is the same 404.
 */
export function skillEvalFixtureRoutes(deps: {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly authenticate: SandboxAuthenticator;
  readonly log: Pick<Logger, "error" | "warn">;
}): Hono {
  const app = new Hono();
  const notFound = () =>
    new Response(JSON.stringify({ code: "not_found", message: "No such fixture." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  app.get("/", async (c) => {
    const auth = await deps.authenticate(c.req.header("authorization"));
    if (!auth.ok) return c.json({ code: "unauthorized", message: "Not a live sandbox." }, 401);
    const { caller } = auth;
    const wanted = c.req.query("path");
    if (caller.evalThreadId === undefined || !wanted) return notFound();
    const row = await withTeam(deps.db, caller.teamId, async (tx) => {
      const res = await tx.execute<{
        case_id: string;
        suite: unknown;
        fixtures_key: string | null;
      }>(
        sql`
        SELECT x.case_id, r.suite, r.fixtures_key
          FROM skill_eval_results x
          JOIN skill_eval_runs r ON r.team_id = x.team_id AND r.id = x.eval_run_id
         WHERE x.team_id = ${caller.teamId} AND x.thread_id = ${caller.evalThreadId}
           AND x.state = 'starting' AND r.started_by = ${caller.userId}
           AND r.status IN ('queued', 'running')`,
      );
      return res.rows[0];
    });
    if (!row?.fixtures_key) return notFound();
    const suite = skillEvalSuiteSchema.safeParse(row.suite);
    const theCase = suite.success ? suite.data.cases.find((x) => x.id === row.case_id) : undefined;
    const name = theCase?.files.find((f) => fixtureWorkspacePath(f) === wanted);
    if (!name) return notFound();
    try {
      const files = await readFixtures(deps.blobs, row.fixtures_key);
      const bytes = files?.get(name);
      if (!bytes) return notFound();
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    } catch (err) {
      deps.log.error({ err }, "skill evals: stored fixtures are unreadable");
      return c.json({ code: "unavailable", message: "The fixtures are not available." }, 503);
    }
  });
  return app;
}
