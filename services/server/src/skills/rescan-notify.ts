import {
  and,
  eq,
  inArray,
  isNull,
  teamMembers,
  teams,
  users,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import { logger } from "../logger.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { Mailer, MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/** One suspended version and who is told about it (KOBE-313). */
export interface SuspendedVersion {
  readonly scope: "team" | "personal";
  /** The team whose approved review row was suspended; absent for a personal version's own scan. */
  readonly teamId?: string;
  readonly skillId: string;
  readonly version: number;
  readonly slug: string;
  /** The uploader (team version) or owner (personal version). */
  readonly authorId: string;
}

const MAX_LINES = 20;

/** Recipients by user id: the author, and the team's admins for a team review row. */
async function recipients(
  db: KobeDb,
  items: readonly SuspendedVersion[],
): Promise<Map<string, SuspendedVersion[]>> {
  const byUser = new Map<string, SuspendedVersion[]>();
  const add = (userId: string, item: SuspendedVersion) =>
    byUser.set(userId, [...(byUser.get(userId) ?? []), item]);
  const teamIds = [...new Set(items.flatMap((i) => (i.teamId ? [i.teamId] : [])))];
  // Memberships are team rows: read each team's admins under its own RLS.
  const admins = (
    await Promise.all(
      teamIds.map((teamId) =>
        withTeam(db, teamId, (tx) =>
          tx
            .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
            .from(teamMembers)
            .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "team_admin"))),
        ),
      ),
    )
  ).flat();
  for (const item of items) {
    const people = new Set([
      item.authorId,
      ...admins.filter((a) => a.teamId === item.teamId).map((a) => a.userId),
    ]);
    for (const userId of people) add(userId, item);
  }
  return byUser;
}

export function suspensionMessage(
  publicUrl: string,
  items: readonly SuspendedVersion[],
  teamNames: ReadonlyMap<string, string>,
  to: string,
): MailMessage {
  const lines = items.slice(0, MAX_LINES).map((i) => {
    const where = i.teamId ? ` in ${oneLine(teamNames.get(i.teamId) ?? "a team")}` : "";
    return `  - ${oneLine(i.slug)} (version ${i.version})${where}`;
  });
  const more = items.length - lines.length;
  return {
    to,
    subject: "Kobe: skills suspended after a scanner update",
    text: [
      "A scanner rule update rescanned these skill versions and now blocks them. They are",
      "suspended: runs leave them out until a reviewer decides them again.",
      ...lines,
      ...(more > 0 ? [`  ... and ${more} more`] : []),
      "",
      `Team admins review them at ${publicUrl}${CONSOLE_PATHS.teamSkillReview}`,
      `Your own skills: ${publicUrl}${CONSOLE_PATHS.mySkills}`,
    ].join("\n"),
  };
}

/**
 * Emails each author and each affected team's admins once per rescan pass about the versions it
 * suspended (ids, slugs and versions; never findings or content). Best effort: a failed send is
 * logged (the audit log and the Site console keep the record). Returns the emails sent.
 */
export async function notifySuspensions(
  deps: { readonly db: KobeDb; readonly mailer: Mailer; readonly publicUrl: string },
  items: readonly SuspendedVersion[],
): Promise<number> {
  if (items.length === 0) return 0;
  try {
    const byUser = await recipients(deps.db, items);
    const people = await deps.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(inArray(users.id, [...byUser.keys()]), isNull(users.deactivatedAt)));
    const teamIds = [...new Set(items.flatMap((i) => (i.teamId ? [i.teamId] : [])))];
    const names =
      teamIds.length === 0
        ? []
        : await deps.db
            .select({ id: teams.id, name: teams.name })
            .from(teams)
            .where(inArray(teams.id, teamIds));
    const teamNames = new Map(names.map((t) => [t.id, t.name]));
    let sent = 0;
    for (const person of people) {
      try {
        const mine = byUser.get(person.id) ?? [];
        await deps.mailer.send(suspensionMessage(deps.publicUrl, mine, teamNames, person.email));
        sent += 1;
      } catch (err) {
        logger.warn({ err, userId: person.id }, "skills: rescan suspension email failed");
      }
    }
    return sent;
  } catch (err) {
    logger.error({ err }, "skills: rescan suspension notices failed");
    return 0;
  }
}
