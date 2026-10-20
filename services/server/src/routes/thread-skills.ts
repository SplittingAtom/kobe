import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull, threads, withTeam } from "@kobe/db";
import { resolveAgentPin } from "../agents/versions.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { NIL_THREAD, effectiveSkillNames } from "../runs/effective-skills.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

const draftQuerySchema = z.strictObject({ agent_id: uuidSchema.optional() });

const notFound = { code: "thread_not_found", message: "No thread with that id." } as const;

/**
 * The composer's Skills (KOBE-451): the skills a run would load here, from the run-start
 * resolver itself (so the list and the server's check of a picked skill always agree).
 *
 * GET /v1/threads/skills[?agent_id=]  → 200 `{skills: [{name}]}` for a conversation not started
 *                                       yet, with that agent (none: no agent)
 * GET /v1/threads/{id}/skills         → 200 `{skills}` for the caller's own thread; 404 otherwise
 *
 * Mounted before the thread API, so `/skills` isn't taken for a thread id.
 */
export function threadSkillRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  const list = (names: readonly string[]) => ({
    skills: [...names].sort().map((name) => ({ name })),
  });

  app.get("/skills", async (c) => {
    const query = draftQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c);
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    const names = await withTeam(db, viewer.teamId, async (tx) => {
      const pin = await resolveAgentPin(tx, viewer, query.data.agent_id ?? null);
      if (!pin.ok) return null;
      return effectiveSkillNames(tx, deps.runAgents, {
        teamId: viewer.teamId,
        ownerUserId: viewer.userId,
        threadId: NIL_THREAD,
        agentScope: pin.value?.agentScope ?? null,
        agentId: pin.value?.agentId ?? null,
        agentVersion: pin.value?.agentVersion ?? null,
      });
    });
    if (names === null) {
      return c.json({ code: "agent_not_found", message: "That agent isn't available." }, 404);
    }
    return c.json(list(names));
  });

  app.get("/:id/skills", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id };
    const names = await withTeam(db, viewer.teamId, async (tx) => {
      const [thread] = await tx
        .select({
          id: threads.id,
          ownerUserId: threads.ownerUserId,
          agentScope: threads.agentScope,
          agentId: threads.agentId,
          agentVersion: threads.agentVersion,
          skillTest: threads.skillTest,
          skillDraftId: threads.skillDraftId,
          skillEval: threads.skillEval,
        })
        .from(threads)
        .where(
          and(
            eq(threads.teamId, viewer.teamId),
            eq(threads.id, id.data),
            eq(threads.ownerUserId, viewer.userId),
            isNull(threads.deletedAt),
          ),
        );
      if (!thread) return null;
      return effectiveSkillNames(tx, deps.runAgents, {
        teamId: viewer.teamId,
        ...thread,
        threadId: thread.id,
      });
    });
    if (names === null) return c.json(notFound, 404);
    return c.json(list(names));
  });

  return app;
}
