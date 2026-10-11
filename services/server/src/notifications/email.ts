import { and, eq, notificationEmails, sql, teams, withTeam, type KobeDb } from "@kobe/db";
import {
  scheduleRecurrenceSchema,
  type NotificationKind,
  type ScheduleRecurrence,
} from "@kobe/protocol";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { scheduledRunMessage, type ScheduledRunOutcome } from "../mail/messages.js";

/**
 * Scheduled-run notification emails (spec D32, KOBE-179). Rows are queued by `record.ts` in the
 * transaction that ends the run; this delivers them **at least once**, per team under its RLS:
 * claimed with a lease (`lease_until`, SKIP LOCKED) so replicas do not double-send, marked sent
 * once the SMTP server accepted the message, retried with backoff, given up (`failed`) after
 * {@link NOTIFICATION_EMAIL_MAX_ATTEMPTS}. The claim's `attempts` is the fencing token: the lease
 * is renewed before each send and every settle names it, so a replica whose lease ran out can
 * neither send again nor overwrite the row (KOBE-179 review). A recipient who is deactivated or no longer a member of
 * the team is skipped. Delivery runs right after a scheduled run ends (index.ts) and from every
 * server replica's sweep. The message carries metadata only (see `scheduledRunMessage`).
 */
export const NOTIFICATION_EMAIL_MAX_ATTEMPTS = 8;
export const NOTIFICATION_EMAIL_SWEEP_MS = 60_000;
const LEASE = "5 minutes";
/** Small enough that a batch of slow sends (≤ 40 s each, mailer timeouts) ends well inside a lease. */
const BATCH = 5;
const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type Claimed = {
  id: string;
  attempts: number;
  user_id: string;
  kind: NotificationKind;
  thread_id: string | null;
  skipped_count: number | null;
  recurrence: unknown;
  tz: string | null;
  /** False once the owner turned email off for the schedule (null: schedule deleted). */
  notify_email: boolean | null;
};

const OUTCOME: Partial<Record<NotificationKind, ScheduledRunOutcome>> = {
  "schedule.run.succeeded": "succeeded",
  "schedule.run.failed": "failed",
  "schedule.run.interrupted": "interrupted",
  "schedule.run.skipped_actions": "skipped_actions",
};

/** When a schedule runs, in words: "daily at 09:00 (Europe/Berlin)". No prompt text. */
export function scheduleWhen(recurrence: ScheduleRecurrence, tz: string): string {
  switch (recurrence.kind) {
    case "cron":
      return `cron ${recurrence.expr} (${tz})`;
    case "daily":
      return `daily at ${recurrence.at} (${tz})`;
    case "weekdays":
      return `weekdays at ${recurrence.at} (${tz})`;
    case "weekly":
      return `weekly on ${recurrence.days.join(", ")} at ${recurrence.at} (${tz})`;
  }
}

function whenOf(row: Claimed): string | null {
  const parsed = scheduleRecurrenceSchema.safeParse(row.recurrence);
  return parsed.success && row.tz ? scheduleWhen(parsed.data, row.tz) : null;
}

async function claim(db: KobeDb, teamId: string): Promise<Claimed[]> {
  return withTeam(db, teamId, async (tx) => {
    // A row whose last attempt never settled (crash, DB error) is given up once its lease ends.
    await tx.execute(sql`
      UPDATE notification_emails SET status = 'failed', last_error = 'max_attempts', lease_until = NULL
       WHERE team_id = ${teamId} AND status = 'pending'
         AND attempts >= ${NOTIFICATION_EMAIL_MAX_ATTEMPTS}
         AND (lease_until IS NULL OR lease_until <= now())`);
    const result = await tx.execute<Claimed>(sql`
      WITH claimed AS (
        UPDATE notification_emails SET attempts = attempts + 1,
               lease_until = now() + ${LEASE}::interval
         WHERE team_id = ${teamId} AND id IN (
               SELECT id FROM notification_emails
                WHERE team_id = ${teamId} AND status = 'pending' AND next_attempt_at <= now()
                  AND (lease_until IS NULL OR lease_until <= now())
                  AND attempts < ${NOTIFICATION_EMAIL_MAX_ATTEMPTS}
                ORDER BY created_at LIMIT ${BATCH}
                FOR UPDATE SKIP LOCKED)
        RETURNING id, attempts, notification_id)
      SELECT c.id, c.attempts, n.user_id, n.kind, n.thread_id, n.skipped_count,
             s.recurrence, s.tz, s.notify_email
        FROM claimed c
        JOIN notifications n ON n.team_id = ${teamId} AND n.id = c.notification_id
        LEFT JOIN schedules s ON s.team_id = ${teamId} AND s.id = n.schedule_id`);
    return result.rows;
  });
}

async function settle(
  db: KobeDb,
  teamId: string,
  row: Claimed,
  outcome: "sent" | "skipped" | "retry",
  error?: string,
): Promise<void> {
  const where = fenced(teamId, row);
  const values =
    outcome === "sent"
      ? { status: "sent" as const, sentAt: sql`now()`, lastError: null }
      : outcome === "skipped"
        ? { status: "skipped" as const, lastError: error ?? null }
        : row.attempts < NOTIFICATION_EMAIL_MAX_ATTEMPTS
          ? {
              lastError: error ?? null,
              nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
            }
          : { status: "failed" as const, lastError: error ?? null };
  if (outcome === "retry" && "status" in values) {
    logger.error(
      { team: teamId, emailId: row.id, attempts: row.attempts },
      "notification email gave up",
    );
  }
  await withTeam(db, teamId, (tx) =>
    tx
      .update(notificationEmails)
      .set({ ...values, leaseUntil: null })
      .where(where),
  );
}

/** Our claim on the row: still pending and not re-claimed since (attempts is the token). */
const fenced = (teamId: string, row: Claimed) =>
  and(
    eq(notificationEmails.teamId, teamId),
    eq(notificationEmails.id, row.id),
    eq(notificationEmails.status, "pending"),
    eq(notificationEmails.attempts, row.attempts),
  );

/** Extends our lease right before a send; false when another replica owns the row now. */
async function renew(db: KobeDb, teamId: string, row: Claimed): Promise<boolean> {
  const renewed = await withTeam(db, teamId, (tx) =>
    tx
      .update(notificationEmails)
      .set({ leaseUntil: sql`now() + ${LEASE}::interval` })
      .where(fenced(teamId, row))
      .returning({ id: notificationEmails.id }),
  );
  return renewed.length > 0;
}

/** Mail errors can quote the recipient's address: log the codes only. */
function mailError(err: unknown): { code?: unknown; responseCode?: unknown; name?: unknown } {
  if (typeof err !== "object" || err === null) return {};
  const e = err as { code?: unknown; responseCode?: unknown; name?: unknown };
  return { code: e.code, responseCode: e.responseCode, name: e.name };
}

/** The recipient's address while they are active and still in the team; null otherwise. */
async function recipient(db: KobeDb, teamId: string, userId: string): Promise<string | null> {
  const res = await withTeam(db, teamId, (tx) =>
    tx.execute<{ email: string }>(sql`
      SELECT u.email FROM users u
        JOIN team_members m ON m.team_id = ${teamId} AND m.user_id = u.id
       WHERE u.id = ${userId} AND u.deactivated_at IS NULL`),
  );
  return res.rows[0]?.email ?? null;
}

type DeliverDeps = Pick<ServerDeps, "database" | "mailer" | "publicUrl">;

/** Sends the team's due notification emails. Never throws; returns how many were sent. */
export async function deliverNotificationEmails(
  deps: DeliverDeps,
  teamId: string,
): Promise<number> {
  const db = deps.database.db;
  let sent = 0;
  try {
    const rows = await claim(db, teamId);
    if (rows.length === 0) return 0;
    const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
    for (const row of rows) {
      const to = await recipient(db, teamId, row.user_id);
      const outcome = OUTCOME[row.kind];
      if (to === null || !team || !outcome || row.thread_id === null) {
        await settle(db, teamId, row, "skipped", to === null ? "recipient_inactive" : "no_run");
        continue;
      }
      if (row.notify_email === false) {
        await settle(db, teamId, row, "skipped", "notify_off");
        continue;
      }
      if (!(await renew(db, teamId, row))) continue;
      try {
        await deps.mailer.send(
          scheduledRunMessage({
            to,
            outcome,
            teamName: team.name,
            when: whenOf(row),
            skippedCount: row.skipped_count,
            threadLink: `${deps.publicUrl}/?thread=${row.thread_id}`,
            schedulesLink: `${deps.publicUrl}/me/schedules`,
          }),
        );
        await settle(db, teamId, row, "sent");
        sent++;
      } catch (err) {
        logger.warn(
          { error: mailError(err), team: teamId, emailId: row.id },
          "notification email failed; will retry",
        );
        await settle(db, teamId, row, "retry", "smtp_error");
      }
    }
  } catch (err) {
    logger.error({ err, team: teamId }, "notification email delivery failed");
  }
  return sent;
}

/** Every team's due notification emails (the sweep). Never throws. */
export async function sweepNotificationEmails(deps: DeliverDeps): Promise<number> {
  let sent = 0;
  try {
    const all = await deps.database.db.select({ id: teams.id }).from(teams);
    for (const { id } of all) sent += await deliverNotificationEmails(deps, id);
  } catch (err) {
    logger.error({ err }, "notification email sweep failed");
  }
  return sent;
}

/** Retries and anything a crashed replica left queued, on every server replica. */
export class NotificationEmailSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: DeliverDeps) {}

  start(intervalMs = NOTIFICATION_EMAIL_SWEEP_MS): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      void sweepNotificationEmails(this.deps).finally(() => {
        this.running = false;
      });
    };
    this.timer ??= setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
