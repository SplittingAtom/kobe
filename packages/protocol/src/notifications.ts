import { z } from "zod";
import { idSchema, riskClassSchema, timestampSchema, uuidSchema } from "./common.js";
import { policyReasonCodeSchema } from "./policy.js";
import { schedulePausedBySchema } from "./schedules.js";
import { MEMORY_NOTIFICATION_KINDS } from "./semantic-memory/governance.js";

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
  /** A Team admin blocked a catalog skill the member had added for themselves (KOBE-338). */
  "skill.member_add.blocked",
  /**
   * A catalog skill or version the team installed (or the member added) was retired (KOBE-340,
   * SK31): deprecated, withdrawn, revoked, or a revoke undone. The version ones name `skill_semver`.
   */
  "skill.deprecated",
  "skill.version.deprecated",
  "skill.version.withdrawn",
  "skill.version.revoked",
  "skill.version.unrevoked",
  /**
   * A Site admin published a new version of a team-published catalog skill (KOBE-495): told to its
   * maintainers in the publishing team; names the version and the admin (`actor_name`).
   */
  "skill.version.site_published",
  /**
   * A Site admin added the user to the team from the Site console (KOBE-638): names the admin
   * (`actor_name`) and nothing else (the team is the notification's own).
   */
  "team.member.added",
  /**
   * A Site admin changed the team's membership from the Site console (KOBE-638 review M1): told
   * to the team's active team admins. Names the admin (`actor_name`), the member (`subject_name`)
   * and the team role (`team_role`: the new one, or the one they had when removed; none on a
   * Take over).
   */
  "team.site_admin.member_added",
  "team.site_admin.member_role_changed",
  "team.site_admin.member_removed",
  "team.site_admin.member_taken_over",
  /**
   * Semantic memory (KOBE-645): every phase's kinds (KOBE-377 `MEMORY_NOTIFICATION_KINDS`). They
   * name no schedule, thread, run or skill; see {@link memoryNotificationFields} for what each names.
   */
  ...MEMORY_NOTIFICATION_KINDS,
] as const;
/** Kinds about a catalog skill: they name it (`skill_id`, `skill_name`), not a schedule. */
export const SKILL_NOTIFICATION_KINDS = NOTIFICATION_KINDS.filter((k) => k.startsWith("skill."));
/** Skill kinds about one version: they also name it (`skill_semver`). */
export const SKILL_VERSION_NOTIFICATION_KINDS = NOTIFICATION_KINDS.filter((k) =>
  k.startsWith("skill.version."),
);
/** Kinds about the team itself (KOBE-638): no schedule, thread, run or skill. */
export const TEAM_NOTIFICATION_KINDS = NOTIFICATION_KINDS.filter((k) => k.startsWith("team."));
/** Kinds about a schedule: they name it (`schedule_id`). */
export const SCHEDULE_NOTIFICATION_KINDS = NOTIFICATION_KINDS.filter((k) =>
  k.startsWith("schedule."),
);
/** Memory kinds about one proposal, suggestion or Site proposal: they name it (`memory_object_id`). */
export const MEMORY_OBJECT_NOTIFICATION_KINDS = MEMORY_NOTIFICATION_KINDS.filter((k) =>
  /^memory\.(proposal|suggestion|site_proposal)\./.test(k),
);
/**
 * The kinds of a pending object someone decides on: what a `memory.review.reminder` is about. A
 * Site proposal waits for its Team admin (received, changes_requested) or the Site (confirmed).
 */
export const MEMORY_PENDING_NOTIFICATION_KINDS = [
  "memory.proposal.received",
  "memory.suggestion.received",
  "memory.site_proposal.received",
  "memory.site_proposal.confirmed",
  "memory.site_proposal.changes_requested",
] as const;
/** Kinds a `memory.review.digest` can roll up: every memory kind but the digest itself. */
export const MEMORY_DIGESTIBLE_NOTIFICATION_KINDS = MEMORY_NOTIFICATION_KINDS.filter(
  (k) => k !== "memory.review.digest",
);
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * One in-app notification of the caller. `thread_id`/`run_id` are null for `schedule.paused` and
 * `skill.member_add.blocked` (which names a catalog skill instead of a schedule).
 * `skipped_count` is set on `schedule.run.skipped_actions` (the full count, even above
 * {@link SKIPPED_ACTIONS_MAX}). `paused_by` is set on `schedule.paused`. Email (opt-in per schedule
 * via `notify_email`) sends the same facts and links, never content.
 */
export const notificationSchema = z
  .strictObject({
    notification_id: uuidSchema,
    kind: notificationKindSchema,
    /** Set on the schedule kinds; null on the skill and team kinds. */
    schedule_id: uuidSchema.nullable(),
    thread_id: uuidSchema.nullable(),
    run_id: uuidSchema.nullable(),
    skipped_count: z.number().int().positive().optional(),
    paused_by: schedulePausedBySchema.optional(),
    /** The skill kinds: the catalog skill and its name (KOBE-338, KOBE-340). */
    skill_id: uuidSchema.optional(),
    skill_name: z.string().min(1).max(64).optional(),
    /** `skill.version.*`: the version (KOBE-340). */
    skill_semver: z.string().min(5).max(32).optional(),
    /**
     * `skill.version.site_published`: the Site admin's name (KOBE-495); `team.member.added`: the
     * Site admin who added the user (KOBE-638).
     */
    actor_name: z.string().min(1).max(200).optional(),
    /** `team.site_admin.*`: the member the change was about (KOBE-638 review M1). */
    subject_name: z.string().min(1).max(200).optional(),
    team_role: z.enum(["team_admin", "contributor", "member"]).optional(),
    /** `memory.scope.near_full`: the shared scope at 80% of its item cap (`team` = Workspace). */
    memory_scope: z.enum(["team", "site"]).optional(),
    /** Memory proposal, suggestion and Site proposal kinds, and a reminder: the object. */
    memory_object_id: uuidSchema.optional(),
    /**
     * `memory.review.digest`: the kind it rolls up; `memory.review.reminder`: the pending
     * object's kind (absent: candidates waiting in To review).
     */
    related_kind: z.enum(MEMORY_DIGESTIBLE_NOTIFICATION_KINDS).optional(),
    /** `memory.review.digest`: how many it rolled up; `candidates_ready`: how many wait. */
    item_count: z.number().int().positive().optional(),
    /** `memory.suggestion.*` (and a reminder about one): the project whose notes it is for. */
    project_id: uuidSchema.optional(),
    read_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .refine(
    (n) => {
      if ((MEMORY_NOTIFICATION_KINDS as readonly string[]).includes(n.kind)) {
        return memoryNotificationFields(n);
      }
      if (
        n.memory_scope !== undefined ||
        n.memory_object_id !== undefined ||
        n.related_kind !== undefined ||
        n.item_count !== undefined ||
        n.project_id !== undefined
      ) {
        return false;
      }
      const skill = (SKILL_NOTIFICATION_KINDS as readonly string[]).includes(n.kind);
      const version = (SKILL_VERSION_NOTIFICATION_KINDS as readonly string[]).includes(n.kind);
      if ((TEAM_NOTIFICATION_KINDS as readonly string[]).includes(n.kind)) {
        return (
          n.schedule_id === null &&
          n.thread_id === null &&
          n.run_id === null &&
          n.skill_id === undefined &&
          n.skill_semver === undefined
        );
      }
      return (
        (skill
          ? n.schedule_id === null && n.skill_id !== undefined && n.skill_name !== undefined
          : n.schedule_id !== null && n.skill_id === undefined && n.skill_name === undefined) &&
        version === (n.skill_semver !== undefined)
      );
    },
    {
      message:
        "a schedule notification names its schedule; a skill notification its skill (and version)",
    },
  );
export type Notification = z.infer<typeof notificationSchema>;

interface MemoryFields {
  readonly kind: NotificationKind;
  readonly schedule_id: string | null;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly skill_id?: string | undefined;
  readonly skill_semver?: string | undefined;
  readonly memory_scope?: "team" | "site" | undefined;
  readonly memory_object_id?: string | undefined;
  readonly related_kind?: NotificationKind | undefined;
  readonly item_count?: number | undefined;
  readonly project_id?: string | undefined;
}

/**
 * What a memory notification names (KOBE-645; the DB check `notifications_memory` mirrors it):
 * `memory.scope.near_full` its scope; `memory.review.digest` the kind it rolls up and how many;
 * `memory.review.reminder` its pending object and that object's kind (absent: To review
 * candidates); proposal, suggestion and Site proposal kinds their object and, optionally, who
 * acted (`actor_name`); `memory.review.candidates_ready` its thread, how many wait and optionally
 * the pass (`memory_object_id`). Suggestions (and reminders about one) name their project. None
 * names a schedule, run or skill, and only candidates_ready a thread.
 */
export function memoryNotificationFields(n: MemoryFields): boolean {
  const candidates = n.kind === "memory.review.candidates_ready";
  if (
    n.schedule_id !== null ||
    (n.thread_id !== null) !== candidates ||
    n.run_id !== null ||
    n.skill_id !== undefined ||
    n.skill_semver !== undefined
  ) {
    return false;
  }
  const suggestion =
    n.kind.startsWith("memory.suggestion.") ||
    (n.kind === "memory.review.reminder" && n.related_kind === "memory.suggestion.received");
  if ((n.project_id !== undefined) !== suggestion) return false;
  const scope = n.memory_scope !== undefined;
  const object = n.memory_object_id !== undefined;
  const related = n.related_kind;
  const count = n.item_count !== undefined;
  switch (n.kind) {
    case "memory.scope.near_full":
      return scope && !object && related === undefined && !count;
    case "memory.review.digest":
      return !scope && !object && related !== undefined && count;
    case "memory.review.candidates_ready":
      return !scope && related === undefined && count;
    case "memory.review.reminder":
      return (
        !scope &&
        object &&
        !count &&
        (related === undefined ||
          (MEMORY_PENDING_NOTIFICATION_KINDS as readonly string[]).includes(related))
      );
    default:
      return !scope && object && related === undefined && !count;
  }
}

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
