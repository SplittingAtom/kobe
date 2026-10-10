import { Hono } from "hono";
import {
  createScheduleBodySchema,
  listSchedulesQuerySchema,
  patchScheduleBodySchema,
  type CreateScheduleBody,
  type PatchScheduleBody,
} from "@kobe/protocol";
import { listMemberships, withTeam } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";
import {
  NOT_ALLOWED,
  NOT_FOUND,
  PAUSED_BY_ADMIN,
  capReached,
  parseScheduleBody,
  scheduleError,
  send,
  type Answer,
} from "../schedules/http.js";
import {
  activeSchedulesOf,
  agentRunnable,
  atCap,
  deleteSchedule,
  findSchedule,
  insertSchedule,
  listSchedules,
  lockUserSchedules,
  nextDueAt,
  toResponse,
  updateSchedule,
  type ScheduleRow,
} from "../schedules/store.js";

/**
 * Schedules API (KOBE-173, spec D32; contract in @kobe/protocol `schedules.ts`): a member's
 * personal scheduled runs in the active team. Everything is scoped to the owner and the team
 * under RLS; someone else's schedule, or another team's, is a 404 like a missing one. Team
 * admins (`team.schedules.pause`) see the team's inventory and pause or resume, nothing else.
 * Nothing here fires a schedule (the runner is KOBE-174).
 */
export function scheduleRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.schedules.personal"));

  const isAdmin = (c: { get: (k: "team") => { role: Parameters<typeof teamRoleAllows>[0] } }) =>
    teamRoleAllows(c.get("team").role, "team.schedules.pause");

  /** The teams a user belongs to besides `teamId` (read before the transaction: no pool deadlock). */
  const otherTeams = async (userId: string, teamId: string): Promise<string[]> =>
    (await listMemberships(db, userId)).map((m) => m.teamId).filter((t) => t !== teamId);

  /** Cap check for `userId` taking one more active schedule; call with the user lock held. */
  const capAnswer = async (
    tx: Parameters<typeof lockUserSchedules>[0],
    userId: string,
    teamId: string,
    others: readonly string[],
  ): Promise<Answer | null> => {
    await lockUserSchedules(tx, userId);
    const active = await activeSchedulesOf(tx, userId, teamId, others);
    return atCap(active) ? capReached(active) : null;
  };

  app.get("/", async (c) => {
    const query = listSchedulesQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    if (query.data.scope === "team" && !isAdmin(c)) return send(c, NOT_ALLOWED);
    const others = await otherTeams(userId, teamId);
    return withTeam(db, teamId, async (tx) => {
      const rows = await listSchedules(tx, teamId, query.data.scope === "team" ? null : userId);
      const activeCount = await activeSchedulesOf(tx, userId, teamId, others);
      return c.json({ schedules: rows.map(toResponse), active_count: activeCount });
    });
  });

  app.post("/", async (c) => {
    const parsed = await parseScheduleBody<CreateScheduleBody>(c, createScheduleBodySchema);
    if (!parsed.ok) return send(c, parsed.answer);
    const body = parsed.data;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const due = body.active ? nextDueAt(body.recurrence, body.tz) : null;
    if (body.active && due === null) return send(c, scheduleError("invalid_recurrence"));
    const others = body.active ? await otherTeams(userId, teamId) : [];
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      if (!(await agentRunnable(tx, { teamId, userId }, body.agent_id))) {
        return scheduleError("agent_not_runnable");
      }
      const blocked = body.active ? await capAnswer(tx, userId, teamId, others) : null;
      if (blocked) return blocked;
      const row = await insertSchedule(tx, {
        teamId,
        userId,
        agentId: body.agent_id,
        prompt: body.prompt,
        recurrence: body.recurrence,
        tz: body.tz,
        active: body.active,
        notifyEmail: body.notify_email,
        nextDueAt: due,
      });
      return { status: 201, json: toResponse(row) };
    });
    return send(c, answer);
  });

  /** The caller's own schedule, locked for update; null (404) for anyone else's. */
  const loadOwn = async (
    tx: Parameters<typeof lockUserSchedules>[0],
    teamId: string,
    userId: string,
    id: string,
  ): Promise<ScheduleRow | null> => {
    const row = await findSchedule(tx, teamId, id);
    return row && row.userId === userId ? row : null;
  };

  app.get("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await loadOwn(tx, teamId, userId, id.data);
      return row ? { status: 200, json: toResponse(row) } : NOT_FOUND;
    });
    return send(c, answer);
  });

  app.patch("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const parsed = await parseScheduleBody<PatchScheduleBody>(c, patchScheduleBodySchema);
    if (!parsed.ok) return send(c, parsed.answer);
    const patch = parsed.data;
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const others = patch.active === true ? await otherTeams(userId, teamId) : [];
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await loadOwn(tx, teamId, userId, id.data);
      if (!row) return NOT_FOUND;
      if (patch.active === true && row.pausedBy === "team_admin") return PAUSED_BY_ADMIN;
      if (patch.agent_id !== undefined && patch.agent_id !== row.agentId) {
        if (!(await agentRunnable(tx, { teamId, userId }, patch.agent_id))) {
          return scheduleError("agent_not_runnable");
        }
      }
      const active = patch.active ?? row.active;
      const activating = active && !row.active;
      if (activating) {
        const blocked = await capAnswer(tx, userId, teamId, others);
        if (blocked) return blocked;
      }
      const recurrence = patch.recurrence ?? (row.recurrence as typeof patch.recurrence & object);
      const tz = patch.tz ?? row.tz;
      const reschedule =
        activating || (active && (patch.recurrence !== undefined || patch.tz !== undefined));
      const due = reschedule ? nextDueAt(recurrence, tz) : undefined;
      if (reschedule && due === null) return scheduleError("invalid_recurrence");
      const updated = await updateSchedule(
        tx,
        row,
        {
          ...(patch.agent_id !== undefined ? { agentId: patch.agent_id } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
          ...(patch.tz !== undefined ? { tz: patch.tz } : {}),
          ...(patch.notify_email !== undefined ? { notifyEmail: patch.notify_email } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(active ? {} : { nextDueAt: null }),
          ...(activating ? { pausedBy: null } : {}),
          ...(due !== undefined ? { nextDueAt: due } : {}),
          ...(patch.active === false ? { pausedBy: null } : {}),
        },
        {
          fieldsChanged: Object.keys(patch).some((k) => k !== "active"),
          activation: active === row.active ? null : active ? "activated" : "deactivated",
          by: "owner",
        },
      );
      return { status: 200, json: toResponse(updated) };
    });
    return send(c, answer);
  });

  app.delete("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await loadOwn(tx, teamId, userId, id.data);
      if (!row) return NOT_FOUND;
      await deleteSchedule(tx, row);
      return { status: 204 };
    });
    return send(c, answer);
  });

  app.post("/:id/pause", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const admin = isAdmin(c);
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await findSchedule(tx, teamId, id.data);
      const own = row?.userId === userId;
      if (!row || (!own && !admin)) return NOT_FOUND;
      if (!row.active) return { status: 200, json: toResponse(row) };
      const by = own ? "owner" : "team_admin";
      const updated = await updateSchedule(
        tx,
        row,
        { active: false, nextDueAt: null, pausedBy: by === "owner" ? null : "team_admin" },
        { fieldsChanged: false, activation: "deactivated", by },
      );
      return { status: 200, json: toResponse(updated) };
    });
    return send(c, answer);
  });

  app.post("/:id/resume", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const admin = isAdmin(c);
    // The owner's other teams: for a resume by an admin the owner is not the caller.
    const peek = await withTeam(db, teamId, (tx) =>
      findSchedule(tx, teamId, id.data).then((r) => r?.userId ?? null),
    );
    const others = peek === null ? [] : await otherTeams(peek, teamId);
    const answer = await withTeam(db, teamId, async (tx): Promise<Answer> => {
      const row = await findSchedule(tx, teamId, id.data);
      const own = row?.userId === userId;
      if (!row || (!own && !(admin && row.pausedBy === "team_admin"))) return NOT_FOUND;
      if (row.active) return { status: 200, json: toResponse(row) };
      if (own && row.pausedBy === "team_admin") return PAUSED_BY_ADMIN;
      const blocked = await capAnswer(tx, row.userId, teamId, others);
      if (blocked) return blocked;
      const due = nextDueAt(row.recurrence as Parameters<typeof nextDueAt>[0], row.tz);
      if (due === null) return scheduleError("invalid_recurrence");
      const updated = await updateSchedule(
        tx,
        row,
        { active: true, nextDueAt: due, pausedBy: null },
        { fieldsChanged: false, activation: "activated", by: own ? "owner" : "team_admin" },
      );
      return { status: 200, json: toResponse(updated) };
    });
    return send(c, answer);
  });

  return app;
}
