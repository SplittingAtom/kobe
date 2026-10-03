import {
  SYSTEM_ACTOR,
  and,
  breakGlassNotifications,
  eq,
  isNull,
  sql,
  teamMembers,
  users,
  withTeam,
  type BreakGlassNotificationEvent,
  type BreakGlassRecipientRole,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { grantMessage } from "./notify.js";
import { activeInstallAdmins, getGrant, type GrantDetail, type GrantRow } from "./store.js";

/**
 * Durable break-glass notifications (spec D10: team admins are notified). Recipients are chosen
 * and one outbox row per recipient is written **in the transaction that changes the grant**, so a
 * committed approval always has its notifications queued, even if SMTP is down or the replica
 * restarts right after. Delivery is at least once (a crash after sending resends). Delivery (`deliverBreakGlassNotifications`) runs right after the commit
 * and again from every replica's sweep, with backoff; a notification that gives up is audited.
 *
 * Who is told:
 * - requested → the other active install admins (they can approve), never the subject
 * - approved, and revoked/expired while active → the team's active admins, the active install
 *   admins, and the subject user unless the grant is a legal hold
 * - denied, withdrawn, or lapsed undecided → the requester
 * Under legal hold the subject is in no list (also when they are a team or install admin). The
 * person who acted is not told about their own action.
 */

export interface Recipient {
  readonly id: string;
  readonly role: BreakGlassRecipientRole;
}

export interface QueuedCounts {
  /** Outbox rows written. */
  readonly recipients: number;
  /** Of which the team's admins (only for events that reach the team). */
  readonly teamAdmins?: number;
}

/** Team admins of the grant's team. Sets the team context on `tx`: call at most once per transaction. */
async function activeTeamAdmins(tx: KobeTx, teamId: string): Promise<{ id: string }[]> {
  return withTeam(tx, teamId, (inner) =>
    inner
      .select({ id: users.id })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.role, "team_admin"),
          isNull(users.deactivatedAt),
        ),
      ),
  );
}

async function isActiveUser(tx: KobeTx, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deactivatedAt)));
  return row !== undefined;
}

/** Whether an event reaches the team (its admins and the subject). */
export function reachesTeam(event: BreakGlassNotificationEvent, wasActive: boolean): boolean {
  return event === "approved" || ((event === "revoked" || event === "expired") && wasActive);
}

export async function recipientsFor(
  tx: KobeTx,
  grant: GrantRow,
  event: BreakGlassNotificationEvent,
  options: { actorId: string | null; wasActive: boolean },
): Promise<Recipient[]> {
  const list: Recipient[] = [];
  if (event === "requested") {
    for (const a of await activeInstallAdmins(tx, grant.adminId)) {
      list.push({ id: a.id, role: "install_admin" });
    }
  } else if (reachesTeam(event, options.wasActive)) {
    for (const a of await activeTeamAdmins(tx, grant.teamId)) {
      list.push({ id: a.id, role: "team_admin" });
    }
    for (const a of await activeInstallAdmins(tx)) {
      list.push({ id: a.id, role: a.id === grant.adminId ? "requester" : "install_admin" });
    }
    if (grant.userId && !grant.legalHold && (await isActiveUser(tx, grant.userId))) {
      list.push({ id: grant.userId, role: "subject" });
    }
  } else if (await isActiveUser(tx, grant.adminId)) {
    list.push({ id: grant.adminId, role: "requester" });
  }
  const seen = new Set<string>();
  return list.filter((r) => {
    if (seen.has(r.id) || r.id === options.actorId) return false;
    // The subject never hears of a legal hold, nor is asked to decide a request about them.
    if ((grant.legalHold || event === "requested") && r.id === grant.userId) return false;
    seen.add(r.id);
    return true;
  });
}

/** Queues the event's notifications in `tx` (the grant's own transaction) and counts them. */
export async function enqueueNotifications(
  tx: KobeTx,
  grant: GrantRow,
  event: BreakGlassNotificationEvent,
  options: { actorId: string | null; wasActive?: boolean },
): Promise<QueuedCounts> {
  const wasActive = options.wasActive ?? false;
  const recipients = await recipientsFor(tx, grant, event, { actorId: options.actorId, wasActive });
  if (recipients.length > 0) {
    await tx.insert(breakGlassNotifications).values(
      recipients.map((r) => ({
        grantId: grant.id,
        event,
        wasActive,
        recipientId: r.id,
        recipientRole: r.role,
      })),
    );
  }
  return reachesTeam(event, wasActive)
    ? {
        recipients: recipients.length,
        teamAdmins: recipients.filter((r) => r.role === "team_admin").length,
      }
    : { recipients: recipients.length };
}

/** Attempts before a notification gives up (about 2 h of backoff in total). */
export const NOTIFY_MAX_ATTEMPTS = 8;
/** A claimed row is invisible to other deliverers for this long (a crash mid-send retries later). */
const LEASE = "5 minutes";
const BATCH = 50;

const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type Claimed = {
  id: string;
  grant_id: string;
  event: BreakGlassNotificationEvent;
  was_active: boolean;
  recipient_id: string;
  recipient_role: BreakGlassRecipientRole;
  attempts: number;
};

async function claim(db: KobeDb, grantId?: string): Promise<Claimed[]> {
  const result = await db.execute<Claimed>(sql`
    UPDATE ${breakGlassNotifications} SET attempts = attempts + 1,
      next_attempt_at = now() + ${LEASE}::interval
    WHERE id IN (
      SELECT id FROM ${breakGlassNotifications}
      WHERE status = 'pending' AND next_attempt_at <= now()
        ${grantId ? sql`AND grant_id = ${grantId}` : sql``}
      ORDER BY created_at LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, grant_id, event, was_active, recipient_id, recipient_role, attempts`);
  return result.rows;
}

async function settle(
  db: KobeDb,
  row: Claimed,
  outcome: { sent: true } | { sent: false; status: "skipped" | "retry"; error: string },
  teamId: string | undefined,
): Promise<void> {
  if (outcome.sent) {
    await db
      .update(breakGlassNotifications)
      .set({ status: "sent", sentAt: sql`now()`, lastError: null })
      .where(eq(breakGlassNotifications.id, row.id));
    return;
  }
  if (outcome.status === "skipped") {
    await db
      .update(breakGlassNotifications)
      .set({ status: "skipped", lastError: outcome.error })
      .where(eq(breakGlassNotifications.id, row.id));
    return;
  }
  if (row.attempts < NOTIFY_MAX_ATTEMPTS) {
    await db
      .update(breakGlassNotifications)
      .set({
        lastError: outcome.error,
        nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
      })
      .where(eq(breakGlassNotifications.id, row.id));
    return;
  }
  logger.error(
    { grantId: row.grant_id, notificationId: row.id, event: row.event, attempts: row.attempts },
    "break-glass notification gave up",
  );
  await db.transaction(async (tx) => {
    await tx
      .update(breakGlassNotifications)
      .set({ status: "failed", lastError: outcome.error })
      .where(eq(breakGlassNotifications.id, row.id));
    if (teamId) {
      await recordAudit(tx, {
        action: "governance.break_glass.notification_failed",
        actor: SYSTEM_ACTOR,
        teamId,
        target: {
          grantId: row.grant_id,
          recipientUserId: row.recipient_id,
          event: row.event,
          attempts: row.attempts,
        },
      });
    }
  });
}

/**
 * Sends due notifications (all, or one grant's) **at least once**: rows are claimed with a lease,
 * marked sent after the SMTP server accepted the message, retried with backoff on failure. A crash
 * (or a failed status update) between the send and the mark resends after the lease, so a
 * recipient may get a duplicate; never none. Never throws; returns how many were sent.
 */
export async function deliverBreakGlassNotifications(
  deps: ServerDeps,
  options: { grantId?: string } = {},
): Promise<number> {
  const db = deps.database.db;
  let sent = 0;
  try {
    const rows = await claim(db, options.grantId);
    const details = new Map<string, GrantDetail | undefined>();
    for (const row of rows) {
      if (!details.has(row.grant_id)) details.set(row.grant_id, await getGrant(db, row.grant_id));
      const detail = details.get(row.grant_id);
      const [to] = await db
        .select({ id: users.id, name: users.name, email: users.email, off: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, row.recipient_id));
      if (!detail || !to || to.off !== null) {
        await settle(
          db,
          row,
          { sent: false, status: "skipped", error: "recipient_inactive" },
          undefined,
        );
        continue;
      }
      const message = grantMessage(deps, detail, row.event, to, {
        isInstallAdmin:
          row.recipient_role === "install_admin" || row.recipient_role === "requester",
        wasActive: row.was_active,
      });
      try {
        await deps.mailer.send(message);
        await settle(db, row, { sent: true }, detail.grant.teamId);
        sent++;
      } catch (err) {
        logger.warn(
          { err, grantId: row.grant_id, notificationId: row.id },
          "break-glass email failed; will retry",
        );
        await settle(
          db,
          row,
          { sent: false, status: "retry", error: "smtp_error" },
          detail.grant.teamId,
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "break-glass notification delivery failed");
  }
  return sent;
}
