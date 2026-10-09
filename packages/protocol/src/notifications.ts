import { z } from "zod";
import { idSchema, riskClassSchema, timestampSchema, uuidSchema } from "./common.js";
import { policyReasonCodeSchema } from "./policy.js";
import { schedulePausedBySchema } from "./schedules.js";

/**
 * Scheduled-run contract (KOBE-176 = 65a of KOBE-65, spec D32; wire shapes in docs/ledger/KOBE-176.md).
 * Contract only and additive: nothing here changes an existing frame or body.
 *
 * Content policy: notifications and skipped-action reports carry ids, tool NAMES, risk class and a
 * policy reason code. Never prompt text, message text, tool input or tool output.
 *
 * REST (team-scoped, caller's own notifications): `GET /v1/notifications`,
 * `POST /v1/notifications/read`.
 */

// --- Skipped actions -------------------------------------------------------------------------------

/** Most skipped actions one terminal event reports; the rest are counted, not listed (see run events). */
export const SKIPPED_ACTIONS_MAX = 100;

/**
 * A tool call a scheduled run did not execute because it would have asked (D32: denied, not queued).
 * `reason_code` is the policy engine's denial code (normally `scheduled_run_no_prompt`;
 * `mode_auto_not_allowlisted` and deny-rule codes also occur). No input, output or message text.
 */
export const skippedActionSchema = z.strictObject({
  tool_call_id: idSchema,
  tool: z.string().min(1).max(256),
  risk: riskClassSchema,
  reason_code: policyReasonCodeSchema,
});
export type SkippedAction = z.infer<typeof skippedActionSchema>;

/** Optional field of `run.completed`, `run.failed` and `run.interrupted` (see events.ts). */
export const skippedActionsSchema = z.array(skippedActionSchema).max(SKIPPED_ACTIONS_MAX);

// --- Run marker ------------------------------------------------------------------------------------

/**
 * Fields a run summary gains: the schedule that triggered it, null for user runs. Absent decodes
 * as null. (The thread side is `scheduleThreadMarkerSchema` from KOBE-171.)
 */
export const runScheduleMarkerSchema = z.object({
  schedule_id: uuidSchema.nullable().default(null),
});
export type RunScheduleMarker = z.infer<typeof runScheduleMarkerSchema>;

// --- Notification ----------------------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  "schedule.run.succeeded",
  "schedule.run.failed",
  "schedule.run.interrupted",
  "schedule.run.skipped_actions",
  "schedule.paused",
] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * One in-app notification of the caller. `thread_id`/`run_id` are null for `schedule.paused`.
 * `skipped_count` is set on `schedule.run.skipped_actions` (the full count, even above
 * {@link SKIPPED_ACTIONS_MAX}). `paused_by` is set on `schedule.paused`. Email (opt-in per schedule
 * via `notify_email`) sends the same facts and links, never content.
 */
export const notificationSchema = z.strictObject({
  notification_id: uuidSchema,
  kind: notificationKindSchema,
  schedule_id: uuidSchema,
  thread_id: uuidSchema.nullable(),
  run_id: uuidSchema.nullable(),
  skipped_count: z.number().int().positive().optional(),
  paused_by: schedulePausedBySchema.optional(),
  read_at: timestampSchema.nullable(),
  created_at: timestampSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

export const NOTIFICATIONS_PAGE_MAX = 100;
export const NOTIFICATIONS_PAGE_DEFAULT = 50;
export const MARK_READ_IDS_MAX = 100;

/** Query booleans arrive as strings. */
const queryBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);

/** Newest first; `next_cursor` is opaque. */
export const listNotificationsQuerySchema = z.strictObject({
  unread: queryBoolean.default(false),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATIONS_PAGE_MAX)
    .default(NOTIFICATIONS_PAGE_DEFAULT),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const listNotificationsResponseSchema = z.strictObject({
  notifications: z.array(notificationSchema),
  /** All of the caller's unread notifications, not just this page (badge count). */
  unread_count: z.number().int().nonnegative(),
  next_cursor: z.string().min(1).max(512).nullable(),
});
export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>;

/** Exactly one of `notification_ids` or `all: true`. Already-read ids are a no-op. */
export const markNotificationsReadBodySchema = z
  .strictObject({
    notification_ids: z.array(uuidSchema).min(1).max(MARK_READ_IDS_MAX).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.notification_ids === undefined) !== (b.all === undefined), {
    message: "send either notification_ids or all: true",
  });
export type MarkNotificationsReadBody = z.infer<typeof markNotificationsReadBodySchema>;

export const markNotificationsReadResponseSchema = z.strictObject({
  /** Notifications that changed from unread to read. */
  updated: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
});
export type MarkNotificationsReadResponse = z.infer<typeof markNotificationsReadResponseSchema>;
