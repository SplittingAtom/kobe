import { and, eq, isNull, teamMembers, users, withTeam } from "@kobe/db";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import type { MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { activeInstallAdmins, scopeOf, type GrantDetail } from "./store.js";

/**
 * Who hears about a break-glass grant (spec D10), by email. Kobe has no in-app notification
 * centre yet; in the app, the team console's break-glass page (and the audit view) show the grant.
 *
 * - requested → the other install admins (they can approve)
 * - approved, and revoked/expired while active → the team's admins, the install admins, and the
 *   subject user unless the grant is a legal hold
 * - denied, withdrawn, or lapsed undecided → the requester
 *
 * A legal hold keeps the subject out of every list, including when the subject is a team admin or
 * an install admin. The person who acted is not mailed about their own action. Sending happens
 * after the change committed and never fails it; a failure is logged at error level.
 */
export type GrantEvent = "requested" | "approved" | "denied" | "revoked" | "expired";

interface Recipient {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const MINUTE = 60_000;

async function activeTeamAdmins(deps: ServerDeps, teamId: string): Promise<Recipient[]> {
  return withTeam(deps.database.db, teamId, (tx) =>
    tx
      .select({ id: users.id, name: users.name, email: users.email })
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

async function activeUser(deps: ServerDeps, id: string): Promise<Recipient | undefined> {
  const [row] = await deps.database.db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deactivatedAt)));
  return row;
}

/** Recipients of one event, de-duplicated, without the actor (and the subject under legal hold). */
export async function recipientsFor(
  deps: ServerDeps,
  detail: GrantDetail,
  event: GrantEvent,
  options: { actorId: string | null; wasActive?: boolean },
): Promise<Recipient[]> {
  const { grant } = detail;
  const list: Recipient[] = [];
  const broad =
    event === "approved" || ((event === "revoked" || event === "expired") && options.wasActive);
  if (event === "requested") {
    list.push(...(await activeInstallAdmins(deps.database.db, grant.adminId)));
  } else if (broad) {
    list.push(...(await activeTeamAdmins(deps, grant.teamId)));
    list.push(...(await activeInstallAdmins(deps.database.db)));
    if (grant.userId && !grant.legalHold) {
      const subject = await activeUser(deps, grant.userId);
      if (subject) list.push(subject);
    }
  } else {
    const requester = await activeUser(deps, grant.adminId);
    if (requester) list.push(requester);
  }
  const seen = new Set<string>();
  return list.filter((r) => {
    if (seen.has(r.id) || r.id === options.actorId) return false;
    // The subject never hears of a legal hold, and never gets asked to decide a request about them.
    if ((grant.legalHold || event === "requested") && r.id === grant.userId) return false;
    seen.add(r.id);
    return true;
  });
}

function scopeLine(detail: GrantDetail, forTeamSide: boolean): string {
  const { grant } = detail;
  if (grant.legalHold && forTeamSide) return "Scope: restricted (legal hold).";
  switch (scopeOf(grant)) {
    case "team":
      return "Scope: all of the team's threads.";
    case "user":
      return `Scope: the threads of ${oneLine(detail.subject?.name ?? "one user")}.`;
    case "thread":
      return `Scope: one thread (${grant.threadId}).`;
  }
}

const SUBJECTS: Record<GrantEvent, string> = {
  requested: "Break-glass request for the {team} team needs a second admin",
  approved: "Break-glass access to the {team} team was approved",
  denied: "Your break-glass request for the {team} team was denied",
  revoked: "Break-glass access to the {team} team was revoked",
  expired: "Break-glass access to the {team} team ended",
};

/** The email for one recipient. Install admins see the reason; team-side readers see it unless the grant is a legal hold. */
export function grantMessage(
  deps: Pick<ServerDeps, "publicUrl">,
  detail: GrantDetail,
  event: GrantEvent,
  to: Recipient,
  options: { isInstallAdmin: boolean; wasActive?: boolean },
): MailMessage {
  const { grant } = detail;
  const team = oneLine(detail.team.name);
  const requester = oneLine(detail.requestedBy.name);
  const teamSide = !options.isInstallAdmin;
  const lapsed = event === "expired" && !options.wasActive;
  const withdrawn = event === "revoked" && !options.wasActive;
  const subject = lapsed
    ? `Your break-glass request for the ${team} team lapsed`
    : withdrawn
      ? `A break-glass request for the ${team} team was withdrawn`
      : SUBJECTS[event].replace("{team}", team);
  const lines = [
    `${requester} asked for read-only break-glass access to the ${team} team on Kobe.`,
    scopeLine(detail, teamSide),
  ];
  if (event === "requested") {
    lines.push(`Requested window: ${grant.durationMinutes} minutes, starting when approved.`);
    if (grant.legalHold) lines.push("Marked as legal hold: the subject user is not notified.");
  }
  if (event === "approved" && grant.startsAt && grant.expiresAt) {
    const approver = oneLine(detail.approvedBy?.name ?? "an install admin");
    lines.push(
      grant.selfApproved
        ? `${approver} approved it alone: this install has a single admin (flagged).`
        : `${approver} approved it.`,
      `Access is read-only and ends at ${grant.expiresAt.toUTCString()} ` +
        `(${Math.round((grant.expiresAt.getTime() - grant.startsAt.getTime()) / MINUTE)} minutes). ` +
        "Every read is recorded in the team's audit log.",
    );
  }
  if (event === "denied")
    lines.push(`${oneLine(detail.decidedBy?.name ?? "An install admin")} denied it.`);
  if (event === "revoked") {
    lines.push(
      `${oneLine(detail.decidedBy?.name ?? "An install admin")} ended it before it expired.`,
    );
  }
  if (event === "expired")
    lines.push(lapsed ? "Nobody decided within 24 hours." : "The time box ended.");
  if (!teamSide || !grant.legalHold) lines.push("", "Reason given:", grant.reason);
  lines.push(
    "",
    options.isInstallAdmin
      ? `Review it: ${deps.publicUrl}/admin/install/break-glass`
      : `See it in your team console: ${deps.publicUrl}/admin/team/break-glass`,
  );
  return { to: to.email, subject, text: lines.join("\n") };
}

/** Sends one event's emails off the request path; never throws. */
export function notifyGrant(
  deps: ServerDeps,
  detail: GrantDetail | undefined,
  event: GrantEvent,
  options: { actorId: string | null; wasActive?: boolean },
): Promise<void> {
  if (!detail) return Promise.resolve();
  const send = async () => {
    const recipients = await recipientsFor(deps, detail, event, options);
    const admins = new Set((await activeInstallAdmins(deps.database.db)).map((a) => a.id));
    for (const to of recipients) {
      const message = grantMessage(deps, detail, event, to, {
        isInstallAdmin: admins.has(to.id),
        ...(options.wasActive !== undefined ? { wasActive: options.wasActive } : {}),
      });
      try {
        await deps.mailer.send(message);
      } catch (err) {
        logger.error({ err, grantId: detail.grant.id, event }, "break-glass email failed");
      }
    }
  };
  return send().catch((err: unknown) =>
    logger.error({ err, grantId: detail.grant.id, event }, "break-glass notification failed"),
  );
}
