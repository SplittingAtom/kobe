import type { Context } from "hono";
import type { z } from "zod";
import {
  SCHEDULE_ERROR_HTTP_STATUS,
  MAX_ACTIVE_SCHEDULES_PER_USER,
  type ScheduleError,
  type ScheduleErrorCode,
} from "@kobe/protocol";

/** An answer chosen inside a transaction and sent after it commits (or rolls back). */
export interface Answer {
  readonly status: 200 | 201 | 204 | 400 | 403 | 404 | 409 | 422;
  readonly json?: unknown;
}

export const NOT_FOUND: Answer = {
  status: 404,
  json: { code: "schedule_not_found", message: "No schedule with that id." },
};

export const NOT_ALLOWED: Answer = {
  status: 403,
  json: { code: "forbidden", message: "You don't have permission to do that." },
};

export const PAUSED_BY_ADMIN: Answer = {
  status: 403,
  json: {
    code: "paused_by_team_admin",
    message: "A team admin paused this schedule; only a team admin can resume it.",
  },
};

export const OWNER_INACTIVE: Answer = {
  status: 409,
  json: {
    code: "schedule_owner_inactive",
    message:
      "The schedule's owner is deactivated or no longer in this team; only the owner can resume it.",
  },
};

const MESSAGES: Record<ScheduleErrorCode, string> = {
  schedule_cap_reached: `You can have at most ${MAX_ACTIVE_SCHEDULES_PER_USER} active schedules across all your teams. Pause one first.`,
  invalid_recurrence: "That recurrence is not valid.",
  invalid_timezone: "That timezone is not a known IANA zone name.",
  agent_not_runnable:
    "That agent cannot be scheduled: it is suspended, unpublished or not available to you here.",
  invalid_mention: "A mentioned file is not in your workspace.",
};

/** A contract error (`scheduleErrorSchema`) with its documented HTTP status. */
export function scheduleError(
  code: ScheduleErrorCode,
  extra: Partial<Pick<ScheduleError, "active_count" | "limit">> & { message?: string } = {},
): Answer {
  const { message, ...counts } = extra;
  return {
    status: SCHEDULE_ERROR_HTTP_STATUS[code],
    json: { code, message: message ?? MESSAGES[code], ...counts },
  };
}

export const capReached = (activeCount: number): Answer =>
  scheduleError("schedule_cap_reached", {
    active_count: activeCount,
    limit: MAX_ACTIVE_SCHEDULES_PER_USER,
  });

/**
 * Parses a JSON body; a recurrence or timezone issue becomes the contract's 422 code, anything
 * else the platform's 400 `invalid_request`.
 */
export async function parseScheduleBody<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; answer: Answer }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (parsed.success) return { ok: true, data: parsed.data };
  const paths = parsed.error.issues.map((i) => i.path[0]);
  if (paths.includes("recurrence"))
    return { ok: false, answer: scheduleError("invalid_recurrence") };
  if (paths.includes("tz")) return { ok: false, answer: scheduleError("invalid_timezone") };
  return {
    ok: false,
    answer: {
      status: 400,
      json: { code: "invalid_request", message: "Check the request and try again." },
    },
  };
}

export function send(c: Context, answer: Answer): Response {
  if (answer.status === 204) return c.body(null, 204);
  return c.json(answer.json ?? {}, answer.status);
}
