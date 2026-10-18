import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  personalSkillScans,
  personalSkills,
  sql,
  teamMembers,
  teamSkillReviews,
  teamSkillVersions,
  teams,
  users,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import { logger } from "../logger.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";
import type { Mailer, MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/**
 * Emails about versions a rescan suspended (KOBE-313). The rows are the outbox: a suspension sets
 * `suspended_at` with `suspension_notified_at` null, and these senders email every such row and then
 * stamp it, so a crash between the suspension and the email loses neither (at least once). Ids,
 * slugs and versions only; never findings or content.
 */
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

export interface NotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

const MAX_LINES = 20;
const OUTBOX_BATCH = 100;

/**
 * Recipients by user id: the author, and for a team row the team's admins. An author who is no
 * longer a member of that team is not told about it (the email names the team). Teams are read
 * one after another, each under its own RLS.
 */
async function recipients(
  db: KobeDb,
  items: readonly SuspendedVersion[],
): Promise<Map<string, SuspendedVersion[]>> {
  const byUser = new Map<string, SuspendedVersion[]>();
  const add = (userId: string, item: SuspendedVersion) =>
    byUser.set(userId, [...(byUser.get(userId) ?? []), item]);
  const members = new Map<string, { userId: string; role: string }[]>();
  for (const teamId of new Set(items.flatMap((i) => (i.teamId ? [i.teamId] : [])))) {
    const authors = items.filter((i) => i.teamId === teamId).map((i) => i.authorId);
    const rows = await withTeam(db, teamId, (tx) =>
      tx
        .select({ userId: teamMembers.userId, role: teamMembers.role })
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            or(eq(teamMembers.role, "team_admin"), inArray(teamMembers.userId, authors)),
          ),
        ),
    );
    members.set(teamId, rows);
  }
  for (const item of items) {
    if (!item.teamId) {
      add(item.authorId, item);
      continue;
    }
    const team = members.get(item.teamId) ?? [];
    const people = new Set(
      team
        .filter((m) => m.role === "team_admin" || m.userId === item.authorId)
        .map((m) => m.userId),
    );
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

/** Emails each recipient once about their items. Returns the emails sent; failures are logged. */
export async function notifySuspensions(
  deps: NotifyDeps,
  items: readonly SuspendedVersion[],
): Promise<number> {
  if (items.length === 0) return 0;
  const byUser = await recipients(deps.db, items);
  if (byUser.size === 0) return 0;
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
}

/** Sends the pending emails of personal versions' own suspensions, then stamps them. */
export async function sendPendingPersonal(deps: NotifyDeps): Promise<number> {
  const rows = await deps.db
    .select({
      skillId: personalSkillScans.skillId,
      version: personalSkillScans.version,
      slug: personalSkills.slug,
      authorId: personalSkills.ownerUserId,
    })
    .from(personalSkillScans)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillScans.skillId))
    .where(
      and(
        isNotNull(personalSkillScans.suspendedAt),
        isNull(personalSkillScans.suspensionNotifiedAt),
      ),
    )
    .limit(OUTBOX_BATCH);
  if (rows.length === 0) return 0;
  const sent = await notifySuspensions(
    deps,
    rows.map((r) => ({ ...r, scope: "personal" as const })),
  );
  for (const r of rows)
    await deps.db
      .update(personalSkillScans)
      .set({ suspensionNotifiedAt: new Date() })
      .where(
        and(
          eq(personalSkillScans.skillId, r.skillId),
          eq(personalSkillScans.version, r.version),
          isNull(personalSkillScans.suspensionNotifiedAt),
        ),
      );
  return sent;
}

/** Sends the pending emails of a team's suspended review rows, then stamps them. */
export async function sendPendingTeam(deps: NotifyDeps, teamId: string): Promise<number> {
  const rows = await withTeam(deps.db, teamId, (tx) =>
    tx
      .select({
        skillId: teamSkillReviews.skillId,
        version: teamSkillReviews.version,
        scope: teamSkillReviews.scope,
        slug: teamSkillReviews.slug,
        teamAuthor: teamSkillVersions.uploadedBy,
        personalAuthor: personalSkills.ownerUserId,
      })
      .from(teamSkillReviews)
      .leftJoin(
        teamSkillVersions,
        and(
          eq(teamSkillVersions.teamId, teamSkillReviews.teamId),
          eq(teamSkillVersions.skillId, teamSkillReviews.skillId),
          eq(teamSkillVersions.version, teamSkillReviews.version),
        ),
      )
      .leftJoin(personalSkills, eq(personalSkills.id, teamSkillReviews.skillId))
      .where(
        and(
          eq(teamSkillReviews.teamId, teamId),
          isNotNull(teamSkillReviews.suspendedAt),
          isNull(teamSkillReviews.suspensionNotifiedAt),
        ),
      )
      .limit(OUTBOX_BATCH),
  );
  if (rows.length === 0) return 0;
  const items = rows.flatMap((r) => {
    const authorId = r.scope === "team" ? r.teamAuthor : r.personalAuthor;
    return authorId
      ? [{ teamId, skillId: r.skillId, version: r.version, slug: r.slug, scope: r.scope, authorId }]
      : [];
  });
  const sent = await notifySuspensions(deps, items);
  await withTeam(deps.db, teamId, (tx) =>
    tx
      .update(teamSkillReviews)
      .set({ suspensionNotifiedAt: new Date() })
      .where(
        and(
          eq(teamSkillReviews.teamId, teamId),
          isNotNull(teamSkillReviews.suspendedAt),
          isNull(teamSkillReviews.suspensionNotifiedAt),
          sql`(${teamSkillReviews.skillId}, ${teamSkillReviews.version}) IN (${sql.join(
            rows.map((r) => sql`(${r.skillId}::uuid, ${r.version})`),
            sql`, `,
          )})`,
        ),
      ),
  );
  return sent;
}
