import { and, eq, inArray, isNull, teamMembers, users, withTeam, type KobeDb } from "@kobe/db";
import { logger } from "../logger.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { Mailer, MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/**
 * Notices to Team admins when the Default tag changes (KOBE-314, SK8): one email per admin of each
 * team the change reached, after that team's step commits. Best effort: a failure is logged, and a
 * crash between a team's step and its email loses that email (the job does not repeat the team).
 * Skill name and what changed only.
 */
export type DefaultNotice =
  { readonly kind: "added"; readonly installed: boolean } | { readonly kind: "removed" };

export interface DefaultNotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

export function defaultNoticeMessage(
  publicUrl: string,
  skill: string,
  teamName: string,
  notice: DefaultNotice,
  to: string,
): MailMessage {
  const name = oneLine(skill);
  const team = oneLine(teamName);
  const body =
    notice.kind === "removed"
      ? [
          `${name} is no longer a Site default skill. Nothing changes in ${team}: an install the`,
          "Site default made stays, as an ordinary team install, and a removed default can be",
          "installed again like any catalog skill.",
        ]
      : notice.installed
        ? [
            `${name} is now a Site default skill and is installed in ${team}: On by default,`,
            "tracking its current major version. You can change its access or pin mode, or",
            "uninstall it (the team then keeps it out).",
          ]
        : [
            `${name} is now a Site default skill. ${team} already installs it, and its settings`,
            "stay as they are.",
          ];
  return {
    to,
    subject:
      notice.kind === "removed"
        ? `Kobe: ${name} is no longer a default skill`
        : `Kobe: ${name} is now a default skill`,
    text: [...body, "", `Team skills: ${publicUrl}${CONSOLE_PATHS.teamSkills}`].join("\n"),
  };
}

/** Emails the team's active admins; returns how many emails went out. */
export async function notifyTeamAdmins(
  deps: DefaultNotifyDeps,
  team: { readonly id: string; readonly name: string },
  skill: string,
  notice: DefaultNotice,
): Promise<number> {
  const admins = await withTeam(deps.db, team.id, (tx) =>
    tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.role, "team_admin"))),
  );
  if (admins.length === 0) return 0;
  const people = await deps.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        inArray(
          users.id,
          admins.map((a) => a.userId),
        ),
        isNull(users.deactivatedAt),
      ),
    );
  let sent = 0;
  for (const person of people) {
    try {
      await deps.mailer.send(
        defaultNoticeMessage(deps.publicUrl, skill, team.name, notice, person.email),
      );
      sent += 1;
    } catch (err) {
      logger.warn({ err, userId: person.id, teamId: team.id }, "skills: Default notice failed");
    }
  }
  return sent;
}
