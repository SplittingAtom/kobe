import { inArray, sql, users, withTeam, type TeamRole } from "@kobe/db";
import { readAppName } from "../branding/settings.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { siteAdminChangeMessage, type SiteAdminChange } from "../mail/messages.js";

export type { SiteAdminChange };

const KIND: Readonly<Record<SiteAdminChange, string>> = {
  added: "team.site_admin.member_added",
  role_changed: "team.site_admin.member_role_changed",
  removed: "team.site_admin.member_removed",
  taken_over: "team.site_admin.member_taken_over",
};

type Deps = Pick<ServerDeps, "database" | "mailer" | "background" | "publicUrl">;

export interface SiteAdminChangeNotice {
  readonly team: { readonly id: string; readonly name: string };
  readonly actor: { readonly id: string; readonly name: string };
  readonly change: SiteAdminChange;
  readonly memberIds: readonly string[];
  /** The new role (added, role_changed) or the one they had (removed); none on a Take over. */
  readonly role?: TeamRole;
}

/**
 * Tells a team's active team admins what a Site admin changed in its membership from the Site
 * console (KOBE-638 review M1), so they don't have to watch the audit log: an in-app notice per
 * member changed (naming the Site admin, the member and the team role) and, when this process has
 * a mail relay, one email per admin. The Site admin and the members changed are never recipients
 * (an added member gets their own notice). Runs after the change committed; best effort (the audit
 * log is the record): a failure is logged, never thrown.
 */
export async function notifyTeamAdmins(deps: Deps, input: SiteAdminChangeNotice): Promise<void> {
  const teamId = input.team.id;
  const skip = sql.join(
    [input.actor.id, ...input.memberIds].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  let emails: string[];
  try {
    emails = await withTeam(deps.database.db, teamId, async (tx) => {
      const { rows } = await tx.execute<{ user_id: string; email: string }>(sql`
        SELECT tm.user_id, u.email FROM team_members tm
          JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
         WHERE tm.team_id = ${teamId} AND tm.role = 'team_admin'
           AND tm.user_id NOT IN (${skip})`);
      for (const admin of rows) {
        for (const memberId of input.memberIds) {
          await tx.execute(sql`
            INSERT INTO notifications (team_id, user_id, kind, actor_user_id, subject_user_id, team_role)
            VALUES (${teamId}, ${admin.user_id}, ${KIND[input.change]}, ${input.actor.id},
              ${memberId}, ${input.role ?? null})`);
        }
      }
      return rows.map((r) => r.email);
    });
  } catch (err) {
    logger.error({ err, team_id: teamId }, "site admin change: team admins not notified");
    return;
  }
  mailAdmins(deps, input, emails);
}

function mailAdmins(deps: Deps, input: SiteAdminChangeNotice, emails: readonly string[]): void {
  if (deps.mailer.disabled || emails.length === 0) return;
  deps.background.run(
    "site admin change email failed",
    async () => {
      const db = deps.database.db;
      const members = await db
        .select({ name: users.name })
        .from(users)
        .where(inArray(users.id, [...input.memberIds]));
      const appName = await readAppName(db);
      // One send per admin: a refused address doesn't stop the others.
      for (const to of emails) {
        await deps.mailer
          .send(
            siteAdminChangeMessage({
              to,
              appName,
              adminName: input.actor.name,
              teamName: input.team.name,
              change: input.change,
              memberNames: members.map((m) => m.name),
              ...(input.role ? { role: input.role } : {}),
              signInUrl: `${deps.publicUrl}/`,
            }),
          )
          .catch((err: unknown) => {
            logger.error({ err, team_id: input.team.id }, "site admin change email failed");
          });
      }
    },
    { team_id: input.team.id },
  );
}
