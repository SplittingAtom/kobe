import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";

/**
 * Schedules contract (KOBE-171 = 64a of KOBE-64, spec D32; wire shapes in docs/ledger/KOBE-171.md).
 * Contract only: additive, nothing here changes an existing frame or body.
 *
 * REST (team-scoped like every request): `POST/GET /v1/schedules`, `GET/PATCH/DELETE
 * /v1/schedules/{id}`, `POST /v1/schedules/{id}/pause|resume`. A scheduled run executes as the
 * schedule's user (`runTriggerSchema` = `schedule`, policy `Actor.kind` = `schedule`, both existing)
 * and creates a thread whose summary carries `schedule_id` ({@link scheduleThreadMarkerSchema}).
 */

/** D32: max 10 active schedules per user, counted across ALL of the user's teams. */
export const MAX_ACTIVE_SCHEDULES_PER_USER = 10;
/** Smallest allowed gap between two firings of one schedule, in minutes. */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 15;
/** Prompt length in characters (UTF-16 code units). */
export const SCHEDULE_PROMPT_MAX = 10_000;

const MINUTES_PER_DAY = 24 * 60;

// --- Recurrence -----------------------------------------------------------------------------------

/** `HH:MM`, 24-hour, zero-padded, local to the schedule's `tz`. */
export const scheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const SCHEDULE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const scheduleWeekdaySchema = z.enum(SCHEDULE_WEEKDAYS);

interface CronField {
  readonly min: number;
  readonly max: number;
}
const CRON_FIELDS: readonly CronField[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 = Sunday)
];

const CRON_NUMBER = /^(0|[1-9]\d*)$/;

/** Values of one cron list item (`*`, a star-step, `a`, `a-b`, a range-step), or null when malformed. */
function expandCronItem(item: string, field: CronField): number[] | null {
  const [range = "", step, ...rest] = item.split("/");
  if (rest.length > 0) return null;
  if (step !== undefined && (!CRON_NUMBER.test(step) || Number(step) < 1)) return null;
  let lo: number;
  let hi: number;
  if (range === "*") {
    [lo, hi] = [field.min, field.max];
  } else {
    const parts = range.split("-");
    if (parts.length > 2 || !parts.every((p) => CRON_NUMBER.test(p))) return null;
    lo = Number(parts[0]);
    hi = parts.length === 2 ? Number(parts[1]) : step === undefined ? lo : field.max;
  }
  if (lo < field.min || hi > field.max || lo > hi) return null;
  const by = step === undefined ? 1 : Number(step);
  const values: number[] = [];
  for (let v = lo; v <= hi; v += by) values.push(v);
  return values;
}

function expandCronField(text: string, field: CronField): number[] | null {
  const values: number[] = [];
  for (const item of text.split(",")) {
    const expanded = expandCronItem(item, field);
    if (expanded === null) return null;
    values.push(...expanded);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Strict 5-field cron (minute hour day-of-month month day-of-week), single spaces, numeric only:
 * `*`, `a`, `a-b`, a star-step, a range-step and comma lists. No names (MON, JAN), no `?`, `L`, `W`, `#`,
 * no `@daily`, no seconds field. Day of week is 0-7 (0 and 7 = Sunday).
 */
export function parseCron(expr: string): { minutes: number[]; hours: number[] } | null {
  const fields = expr.split(" ");
  if (fields.length !== 5) return null;
  const expanded = fields.map((f, i) => expandCronField(f, CRON_FIELDS[i] as CronField));
  const [minutes, hours] = expanded;
  if (expanded.some((e) => e === null) || !minutes || !hours) return null;
  return { minutes, hours };
}

/**
 * Smallest gap in minutes between two firings in a day (also across midnight). Day-of-month, month
 * and day-of-week only remove firing days, which cannot shrink the gap, so they are ignored.
 */
export function cronMinIntervalMinutes(expr: string): number | null {
  const parsed = parseCron(expr);
  if (parsed === null) return null;
  const times = parsed.hours
    .flatMap((h) => parsed.minutes.map((m) => h * 60 + m))
    .sort((a, b) => a - b);
  let min = MINUTES_PER_DAY;
  times.forEach((t, i) => {
    const next = times[(i + 1) % times.length] as number;
    const gap = (next - t + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    if (gap > 0) min = Math.min(min, gap);
  });
  return min;
}

export const scheduleCronSchema = z
  .string()
  .max(100)
  .refine((s) => parseCron(s) !== null, "invalid cron expression")
  .refine(
    (s) => (cronMinIntervalMinutes(s) ?? 0) >= SCHEDULE_MIN_INTERVAL_MINUTES,
    `cron fires more often than every ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes`,
  );

/**
 * When a schedule fires, evaluated in the schedule's `tz`. `daily`/`weekdays`/`weekly` are the web
 * presets; `weekdays` = Monday to Friday. DST: a local time that does not exist that day fires at
 * the next valid instant; one that occurs twice fires once (server's job, KOBE-174).
 */
export const scheduleRecurrenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cron"), expr: scheduleCronSchema }),
  z.strictObject({ kind: z.literal("daily"), at: scheduleTimeSchema }),
  z.strictObject({ kind: z.literal("weekdays"), at: scheduleTimeSchema }),
  z.strictObject({
    kind: z.literal("weekly"),
    days: z
      .array(scheduleWeekdaySchema)
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, "duplicate weekday"),
    at: scheduleTimeSchema,
  }),
]);
export type ScheduleRecurrence = z.infer<typeof scheduleRecurrenceSchema>;

function isKnownTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone name (`Europe/Berlin`, `UTC`); numeric offsets such as `+01:00` are rejected. */
export const scheduleTimezoneSchema = z
  .string()
  .max(64)
  .refine(isKnownTimeZone, "unknown IANA timezone");

// --- Request bodies -----------------------------------------------------------------------------------

export const schedulePromptSchema = z
  .string()
  .max(SCHEDULE_PROMPT_MAX)
  .refine((s) => s.trim().length > 0, "prompt must not be blank");

/** `POST /v1/schedules`. The server sets `user_id` (the caller) and `team_id` (the request's team). */
export const createScheduleBodySchema = z.strictObject({
  agent_id: uuidSchema,
  prompt: schedulePromptSchema,
  recurrence: scheduleRecurrenceSchema,
  tz: scheduleTimezoneSchema,
  /** Creating an active schedule counts against {@link MAX_ACTIVE_SCHEDULES_PER_USER}. */
  active: z.boolean().default(true),
  notify_email: z.boolean().default(false),
});
export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>;

/** `PATCH /v1/schedules/{id}`: any subset, at least one field. `active: true` is a resume. */
export const patchScheduleBodySchema = z
  .strictObject({
    agent_id: uuidSchema,
    prompt: schedulePromptSchema,
    recurrence: scheduleRecurrenceSchema,
    tz: scheduleTimezoneSchema,
    active: z.boolean(),
    notify_email: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "at least one field is required");
export type PatchScheduleBody = z.infer<typeof patchScheduleBodySchema>;

/** `mine` (default): the caller's schedules in this team. `team`: team inventory, team admins only. */
export const listSchedulesQuerySchema = z.strictObject({
  scope: z.enum(["mine", "team"]).default("mine"),
});
export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>;

// --- Responses ----------------------------------------------------------------------------------------

/** Why a schedule is inactive without the owner asking: a team admin, or the owner's deactivation. */
export const SCHEDULE_PAUSED_BY = ["team_admin", "deactivation"] as const;
export const schedulePausedBySchema = z.enum(SCHEDULE_PAUSED_BY);

export const scheduleResponseSchema = z.strictObject({
  schedule_id: uuidSchema,
  team_id: uuidSchema,
  user_id: uuidSchema,
  agent_id: uuidSchema,
  prompt: schedulePromptSchema,
  recurrence: scheduleRecurrenceSchema,
  tz: scheduleTimezoneSchema,
  active: z.boolean(),
  notify_email: z.boolean(),
  /** Next firing; null while inactive. */
  next_due_at: timestampSchema.nullable(),
  last_run_id: uuidSchema.nullable(),
  /** null = active, or paused by the owner. */
  paused_by: schedulePausedBySchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type ScheduleResponse = z.infer<typeof scheduleResponseSchema>;

export const listSchedulesResponseSchema = z.strictObject({
  schedules: z.array(scheduleResponseSchema),
  /** The caller's active schedules across all teams (what the cap counts). */
  active_count: z.number().int().nonnegative(),
});
export type ListSchedulesResponse = z.infer<typeof listSchedulesResponseSchema>;

// --- Errors -------------------------------------------------------------------------------------------

export const SCHEDULE_ERROR_CODES = [
  "schedule_cap_reached",
  "invalid_recurrence",
  "invalid_timezone",
  "agent_not_runnable",
] as const;
export const scheduleErrorCodeSchema = z.enum(SCHEDULE_ERROR_CODES);
export type ScheduleErrorCode = z.infer<typeof scheduleErrorCodeSchema>;

export const SCHEDULE_ERROR_HTTP_STATUS = {
  schedule_cap_reached: 409,
  invalid_recurrence: 422,
  invalid_timezone: 422,
  agent_not_runnable: 422,
} as const satisfies Record<ScheduleErrorCode, number>;

export const scheduleErrorSchema = z.strictObject({
  code: scheduleErrorCodeSchema,
  message: z.string().max(2000),
  /** `schedule_cap_reached`: how many are active now, and the limit. */
  active_count: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
export type ScheduleError = z.infer<typeof scheduleErrorSchema>;

// --- "Scheduled" folder marker -------------------------------------------------------------------------

/**
 * Fields a thread summary gains: the schedule that created the thread, null for every other thread.
 * The web "Scheduled" folder is the threads with a non-null `schedule_id`. Absent decodes as null,
 * so summaries from servers without schedules still parse. KOBE-173 adds `.shape` to the server's
 * `threadSummarySchema`.
 */
export const scheduleThreadMarkerSchema = z.object({
  schedule_id: uuidSchema.nullable().default(null),
});
export type ScheduleThreadMarker = z.infer<typeof scheduleThreadMarkerSchema>;
