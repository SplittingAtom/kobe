import type { BreakGlassNotificationEvent } from "@kobe/db";
import type { ServerDeps } from "../deps.js";
import type { MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { scopeOf, type GrantDetail } from "./store.js";

/** Break-glass emails (spec D10). Who receives them and when: see `outbox.ts`. */
export type GrantEvent = BreakGlassNotificationEvent;

interface Recipient {
  readonly name: string;
  readonly email: string;
}

const MINUTE = 60_000;

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
