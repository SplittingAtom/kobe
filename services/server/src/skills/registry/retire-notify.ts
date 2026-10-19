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
 *   pins the version or runs it (before or after the act; every install for a whole skill; a
 *   version sharing its runtime hash counts too, review L3) tells its Team admins, and each member
 *   whose own add pins or runs it is told too. **Revoke** tells everyone with it (review M3): also
 *   the members whose runs loaded the version in the last 30 days and the owners of the team's
 *   agents that name the skill. **Unrevoke** tells exactly the people the revoke told (their
 *   `skill.version.revoked` notices since that revoke), not a new reckoning;
 * - **email**: Revoke and Unrevoke go to everyone they tell in-app and the skill's maintainers
 *   ("in-app and email"); Withdraw to the maintainers (installers see it in-app). Deprecate stays
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
          undeprecate: "deprecated",
          withdraw: "withdrawn",
          revoke: "revoked",
          unrevoke: "unrevoked",
        }[r.act]
      }` as const);

/** Does this pin name or run the retired version (or one with its hash), before or after? */
function touches(r: Retired, pin: Pin): boolean {
  if (r.versionId === null) return true;
  const hit = new Set([r.versionId, ...r.siblingIds]);
  if (hit.has(pin.version_id)) return true;
  const after: CatalogVersion[] = r.before.map((v) =>
    v.id === r.versionId ? { ...v, state: r.state } : v,
  );
  const p = { pinMode: pin.pin_mode, versionId: pin.version_id };
  for (const list of [r.before, after]) {
    const pick = pickCatalogVersion(list, p);
    if (pick.ok && hit.has(pick.version.id)) return true;
  }
  return false;
}

/** The semvers a revoke stops: the version and those sharing its runtime hash. */
const hitSemvers = (r: Retired) =>
  r.before.filter((v) => v.id === r.versionId || r.siblingIds.includes(v.id)).map((v) => v.semver);

/** Revoke's wider circle in a team: who ran it lately, and whose agents name it (review M3). */
async function everyoneWithIt(tx: KobeTx, teamId: string, r: Retired): Promise<string[]> {
  const semvers = hitSemvers(r);
  if (semvers.length === 0) return [];
  const ran = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT t.owner_user_id AS user_id
      FROM runs r JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
     WHERE r.team_id = ${teamId} AND t.team_id = ${teamId}
       AND r.created_at > now() - interval '30 days'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.skill_refs) ref
                    WHERE ref ->> 'source' = 'catalog' AND ref ->> 'name' = ${r.name}
                      AND ref ->> 'semver' IN (${sql.join(
                        semvers.map((v) => sql`${v}`),
                        sql`, `,
                      )}))`);
  const agents = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT a.owner_user_id AS user_id
      FROM team_agents a JOIN team_agent_versions v
        ON v.team_id = a.team_id AND v.agent_id = a.id AND v.version = a.current_version
     WHERE a.team_id = ${teamId}
       AND (v.frontmatter -> 'skills' ? ${r.name}
         OR v.frontmatter -> 'skills' -> 'exclusive' ? ${r.name})`);
  // Only people still in the team.
  const ids = [...new Set([...ran.rows, ...agents.rows].map((x) => x.user_id))];
  if (ids.length === 0) return [];
  const members = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM team_members WHERE team_id = ${teamId} AND user_id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  return members.rows.map((m) => m.user_id);
}

/** Unrevoke: the people this team's revoke notices reached (not a new reckoning). */
async function revokeRecipients(tx: KobeTx, teamId: string, r: Retired): Promise<string[]> {
  if (!r.revokedAt || !r.semver) return [];
  const rows = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT user_id FROM notifications
     WHERE team_id = ${teamId} AND kind = 'skill.version.revoked'
       AND skill_id = ${r.skillId} AND skill_semver = ${r.semver}
       AND created_at >= ${r.revokedAt}::timestamptz`);
  return rows.rows.map((x) => x.user_id);
}

async function teamPart(tx: KobeTx, teamId: string, r: Retired) {
  // An undone deprecation tells no one: a deprecate–undo loop must not flood installers' bells.
  if (r.act === "undeprecate") return undefined;
  if (r.act === "unrevoke")
    return write(tx, teamId, r, new Set(await revokeRecipients(tx, teamId, r)));
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
  if (r.act === "revoke") for (const u of await everyoneWithIt(tx, teamId, r)) users.add(u);
  return write(tx, teamId, r, users);
}

async function write(tx: KobeTx, teamId: string, r: Retired, users: ReadonlySet<string>) {
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
  if (r.act === "revoke" || r.act === "unrevoke") for (const u of told) emailTo.add(u);
  if (r.act === "revoke" || r.act === "unrevoke" || r.act === "withdraw") {
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
  unrevoke: "was restored: it runs again where it is pinned or tracked",
} as const;
const SUBJECT = { withdraw: "withdrawn", revoke: "revoked", unrevoke: "restored" } as const;

/** The email of a Withdraw or Revoke (best effort; each failure logged). */
export async function emailRetirement(
  deps: NotifyDeps,
  r: Retired,
  emails: readonly string[],
): Promise<void> {
  if (r.act !== "withdraw" && r.act !== "revoke" && r.act !== "unrevoke") return;
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
        subject: `Kobe: ${what} ${SUBJECT[r.act]}`,
        text,
      });
    } catch (err) {
      logger.warn({ err, skillId: r.skillId }, "skills: retirement email failed");
    }
  }
}
