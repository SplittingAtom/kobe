import {
  and,
  eq,
  egressRequestNotifications,
  egressRequests,
  sql,
  teamMembers,
  teams,
  users,
  withTeam,
  type EgressRequestEvent,
  type KobeDb,
} from "@kobe/db";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import type { MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/**
 * Request-access emails (spec D28: "notifies the team admin"; KOBE-39). Rows are queued by
 * request-store.ts in the request's own transaction; this delivers them **at least once**: claimed
 * with a lease (SKIP LOCKED, per team under its RLS), marked sent once the SMTP server accepted the
 * message, retried with backoff, given up after {@link MAX_ATTEMPTS} (logged). Delivery runs right
 * after the committing request (background) and from every replica's sweep.
 *
 * Content is metadata only: the requester's name, the host and the pattern, and the thread id —
 * never a URL path, prompt or message text.
 */
export const MAX_ATTEMPTS = 8;
const LEASE = "5 minutes";
const BATCH = 50;
export const EGRESS_REQUEST_SWEEP_MS = 60_000;

const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type Claimed = {
  id: string;
  request_id: string;
  event: EgressRequestEvent;
  recipient_id: string;
  attempts: number;
};

interface Detail {
  readonly team: string;
  readonly domain: string;
  readonly pattern: string;
  readonly threadId: string | null;
  readonly requester: string;
}

export function requestMessage(
  publicUrl: string,
  event: EgressRequestEvent,
  detail: Detail,
  to: string,
): MailMessage {
  const team = oneLine(detail.team);
  const requester = oneLine(detail.requester);
  if (event === "requested") {
    return {
      to,
      subject: `Access request: ${detail.pattern} for the ${team} team`,
      text: [
        `${requester} asked to enable ${detail.pattern} for the ${team} team's sandboxes on Kobe.`,
        `A request to ${detail.domain} was blocked by the team's egress policy.`,
        ...(detail.threadId ? [`Thread: ${detail.threadId}`] : []),
        "",
        `Approve or deny it in your team console: ${publicUrl}/admin/team/egress`,
      ].join("\n"),
    };
  }
  const approved = event === "approved";
  return {
    to,
    subject: approved
      ? `${detail.pattern} is now enabled for the ${team} team`
      : `Your request for ${detail.pattern} was denied`,
    text: [
      approved
        ? `A team admin enabled ${detail.pattern} for the ${team} team's sandboxes. Retry what was blocked.`
        : `A team admin denied your request to enable ${detail.pattern} for the ${team} team.`,
      ...(detail.threadId ? [`Thread: ${detail.threadId}`] : []),
    ].join("\n"),
  };
}

async function claim(db: KobeDb, teamId: string): Promise<Claimed[]> {
  return withTeam(db, teamId, async (tx) => {
    const result = await tx.execute<Claimed>(sql`
      UPDATE ${egressRequestNotifications} SET attempts = attempts + 1,
        next_attempt_at = now() + ${LEASE}::interval
      WHERE team_id = ${teamId} AND id IN (
        SELECT id FROM ${egressRequestNotifications}
        WHERE team_id = ${teamId} AND status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED)
      RETURNING id, request_id, event, recipient_id, attempts`);
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
  const where = and(
    eq(egressRequestNotifications.teamId, teamId),
    eq(egressRequestNotifications.id, row.id),
  );
  await withTeam(db, teamId, async (tx) => {
    if (outcome === "sent") {
      await tx
        .update(egressRequestNotifications)
        .set({ status: "sent", sentAt: sql`now()`, lastError: null })
        .where(where);
    } else if (outcome === "skipped") {
      await tx
        .update(egressRequestNotifications)
        .set({ status: "skipped", lastError: error ?? null })
        .where(where);
    } else if (row.attempts < MAX_ATTEMPTS) {
      await tx
        .update(egressRequestNotifications)
        .set({
          lastError: error ?? null,
          nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
        })
        .where(where);
    } else {
      logger.error(
        { team: teamId, notificationId: row.id, attempts: row.attempts },
        "egress request notification gave up",
      );
      await tx
        .update(egressRequestNotifications)
        .set({ status: "failed", lastError: error ?? null })
        .where(where);
    }
  });
}

async function detailOf(
  db: KobeDb,
  teamId: string,
  requestId: string,
): Promise<Detail | undefined> {
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .select({
        domain: egressRequests.domain,
        pattern: egressRequests.pattern,
        threadId: egressRequests.threadId,
        requester: users.name,
        team: teams.name,
      })
      .from(egressRequests)
      .innerJoin(users, eq(users.id, egressRequests.requestedBy))
      .innerJoin(teams, eq(teams.id, egressRequests.teamId))
      .where(and(eq(egressRequests.teamId, teamId), eq(egressRequests.id, requestId)));
    return row;
  });
}

async function stillEntitled(db: KobeDb, teamId: string, row: Claimed): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const [member] = await tx
      .select({ role: teamMembers.role })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, row.recipient_id)));
    if (!member) return false;
    return row.event !== "requested" || member.role === "team_admin";
  });
}

/** Sends the team's due notifications. Never throws; returns how many were sent. */
export async function deliverEgressRequestNotifications(
  deps: Pick<ServerDeps, "database" | "mailer" | "publicUrl">,
  teamId: string,
): Promise<number> {
  const db = deps.database.db;
  let sent = 0;
  try {
    for (const row of await claim(db, teamId)) {
      const detail = await detailOf(db, teamId, row.request_id);
      const [to] = await db
        .select({ email: users.email, off: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, row.recipient_id));
      if (!detail || !to || to.off !== null) {
        await settle(db, teamId, row, "skipped", "recipient_inactive");
        continue;
      }
      // Still entitled at delivery: admins for a new request, members for a decision.
      if (!(await stillEntitled(db, teamId, row))) {
        await settle(db, teamId, row, "skipped", "recipient_not_entitled");
        continue;
      }
      try {
        await deps.mailer.send(requestMessage(deps.publicUrl, row.event, detail, to.email));
        await settle(db, teamId, row, "sent");
        sent++;
      } catch (err) {
        logger.warn(
          { err, team: teamId, notificationId: row.id },
          "egress request email failed; will retry",
        );
        await settle(db, teamId, row, "retry", "smtp_error");
      }
    }
  } catch (err) {
    logger.error({ err, team: teamId }, "egress request notification delivery failed");
  }
  return sent;
}

/** Every team's due notifications (the sweep). */
export async function sweepEgressRequestNotifications(
  deps: Pick<ServerDeps, "database" | "mailer" | "publicUrl">,
): Promise<number> {
  let sent = 0;
  try {
    const all = await deps.database.db.select({ id: teams.id }).from(teams);
    for (const { id } of all) sent += await deliverEgressRequestNotifications(deps, id);
  } catch (err) {
    logger.error({ err }, "egress request notification sweep failed");
  }
  return sent;
}

export class EgressRequestSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(private readonly deps: Pick<ServerDeps, "database" | "mailer" | "publicUrl">) {}

  start(intervalMs = EGRESS_REQUEST_SWEEP_MS): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      void sweepEgressRequestNotifications(this.deps).finally(() => {
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
