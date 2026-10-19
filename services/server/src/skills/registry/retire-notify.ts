import { scanTeams, sql, type KobeDb, type KobeTx } from "@kobe/db";
import { logger } from "../../logger.js";
import { CONSOLE_PATHS } from "../../mail/console-paths.js";
import type { Mailer } from "../../mail/mailer.js";
import { oneLine } from "../../mail/messages.js";
import { pickCatalogVersion, type CatalogVersion } from "../../resolver/catalog-pins.js";
import type { Retired } from "./retire.js";

/**
 * Who hears of a retirement (KOBE-340, SK31's Notice column), after it commits:
 * - **in-app** (team notifications, `skill.deprecated` / `skill.version.*`): each team whose install
 *   pins the version or runs it (before or after the act; every install for a whole skill) tells
 *   its Team admins, and each member whose own add pins or runs it is told too;
 * - **email**: Revoke goes to everyone told in-app and the skill's maintainers ("in-app and
 *   email"); Withdraw to the maintainers (installers see it in-app). Deprecate and Unrevoke stay
 *   in-app.
 * Each team is read and written under its own RLS (`scanTeams`). Email is best effort, off the
 * request path: the console's install banners are the durable record.
 */
export interface NotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

export interface Notified {
  readonly teams: number;
  readonly members: number;
  /** Addresses to email (deduplicated), sent by {@link emailRetirement}. */
  readonly emails: readonly string[];
}

type Pin = { version_id: string; pin_mode: "pinned" | "within_major" | "latest" };

const kindOf = (r: Retired) =>
  r.semver === null
    ? "skill.deprecated"
    : (`skill.version.${
        {
          deprecate: "deprecated",
          withdraw: "withdrawn",
          revoke: "revoked",
          unrevoke: "unrevoked",
        }[r.act]
      }` as const);

/** Does this pin name or run the retired version, before or after the act? */
function touches(r: Retired, pin: Pin): boolean {
  if (r.versionId === null) return true;
  if (pin.version_id === r.versionId) return true;
  const after: CatalogVersion[] = r.before.map((v) =>
    v.id === r.versionId ? { ...v, state: r.state } : v,
  );
  const p = { pinMode: pin.pin_mode, versionId: pin.version_id };
  for (const list of [r.before, after]) {
    const pick = pickCatalogVersion(list, p);
    if (pick.ok && pick.version.id === r.versionId) return true;
  }
  return false;
}

async function teamPart(tx: KobeTx, teamId: string, r: Retired) {
  const install = await tx.execute<Pin>(sql`
    SELECT version_id, pin_mode::text AS pin_mode FROM team_skill_installs
     WHERE team_id = ${teamId} AND skill_id = ${r.skillId}`);
  const adds = await tx.execute<Pin & { user_id: string }>(sql`
    SELECT user_id, version_id, pin_mode::text AS pin_mode FROM member_skill_enablements
     WHERE team_id = ${teamId} AND catalog_skill_id = ${r.skillId}
       AND version_id IS NOT NULL AND enabled`);
  const users = new Set<string>();
  const installed = install.rows[0];
  if (installed && touches(r, installed)) {
    const admins = await tx.execute<{ user_id: string }>(sql`
      SELECT user_id FROM team_members WHERE team_id = ${teamId} AND role = 'team_admin'`);
    for (const a of admins.rows) users.add(a.user_id);
  }
  for (const a of adds.rows) if (touches(r, a)) users.add(a.user_id);
  if (users.size === 0) return undefined;
  const kind = kindOf(r);
  for (const userId of users)
    await tx.execute(sql`
      INSERT INTO notifications (team_id, user_id, kind, skill_id, skill_semver)
      VALUES (${teamId}, ${userId}, ${kind}, ${r.skillId}, ${r.semver})`);
  return [...users];
}

/** Writes the in-app notices; returns how many teams and members were told and whom to email. */
export async function notifyRetirement(db: KobeDb, r: Retired): Promise<Notified> {
  const parts = await scanTeams(db, "notifyRetirement", (tx, team) => teamPart(tx, team.id, r));
  const told = new Set(parts.flat());
  const emailTo = new Set<string>();
  if (r.act === "revoke") for (const u of told) emailTo.add(u);
  if (r.act === "revoke" || r.act === "withdraw") {
    const maintainers = await db.execute<{ user_id: string }>(sql`
      SELECT user_id FROM registry_maintainers WHERE skill_id = ${r.skillId}`);
    for (const m of maintainers.rows) emailTo.add(m.user_id);
  }
  const emails =
    emailTo.size === 0
      ? []
      : (
          await db.execute<{ email: string }>(sql`
            SELECT email FROM users WHERE deactivated_at IS NULL AND id IN (${sql.join(
              [...emailTo].map((id) => sql`${id}::uuid`),
              sql`, `,
            )}) ORDER BY email`)
        ).rows.map((u) => u.email);
  return { teams: parts.length, members: told.size, emails };
}

const WORDS = {
  withdraw: "was withdrawn: pinned installs keep it until a Team admin chooses a version",
  revoke: "was revoked: it stops at the next fetch in every team",
} as const;

/** The email of a Withdraw or Revoke (best effort; each failure logged). */
export async function emailRetirement(
  deps: NotifyDeps,
  r: Retired,
  emails: readonly string[],
): Promise<void> {
  if (r.act !== "withdraw" && r.act !== "revoke") return;
  const what = `${oneLine(r.name, 64)} ${r.semver ?? ""}`.trim();
  const text = [
    `The catalog skill ${what} ${WORDS[r.act]}.`,
    "",
    `Choose another version in your team console: ${deps.publicUrl}${CONSOLE_PATHS.teamSkills}`,
  ].join("\n");
  for (const to of emails) {
    try {
      await deps.mailer.send({
        to,
        subject: `Kobe: ${what} ${r.act === "revoke" ? "revoked" : "withdrawn"}`,
        text,
      });
    } catch (err) {
      logger.warn({ err, skillId: r.skillId }, "skills: retirement email failed");
    }
  }
}
