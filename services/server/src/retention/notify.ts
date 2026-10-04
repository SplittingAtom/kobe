import {
  SYSTEM_ACTOR,
  and,
  asc,
  eq,
  isNull,
  sql,
  teamMembers,
  teams,
  users,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import { recordAuditAfter } from "../audit/record.js";
import type { MailMessage, Mailer } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { PERIOD_DAYS, upcomingShortening, type RetentionPeriod } from "./periods.js";
import { readMaximumLayer, readTeamLayer } from "./settings.js";

/**
 * Email to a team's admins when its retention period is about to get shorter (user decision
 * 2026-10-04): the new period, the date, and how many conversations would go — a count only, never
 * titles or owners — with a pointer to the export. Sent after the change commits (best effort,
 * logged on failure; the banner in the app says the same), audited as
 * `retention.shortening_notified` (counts only).
 */

const LABEL: Readonly<Record<RetentionPeriod, string>> = {
  "30d": "30 days",
  "90d": "90 days",
  "1y": "1 year",
  forever: "forever",
};

export function shorteningMessage(input: {
  readonly to: string;
  readonly teamName: string;
  readonly period: RetentionPeriod;
  readonly effectiveAt: Date;
  readonly threads: number;
  readonly appUrl: string;
}): MailMessage {
  const team = oneLine(input.teamName);
  const when = input.effectiveAt.toUTCString();
  const label = LABEL[input.period];
  return {
    to: input.to,
    subject: `${team}: conversations older than ${label} will be deleted on ${when}`,
    text: [
      `The ${team} team on Kobe will keep conversations for ${label} after their last activity,`,
      `starting ${when}. From then on, older conversations are deleted for good every night.`,
      "",
      `Today, ${input.threads} conversation${input.threads === 1 ? "" : "s"} in the team would be deleted on that date`,
      "(not counting conversations in Trash, which are deleted 30 days after being trashed anyway).",
      "",
      "Members can export their own conversations before then (Export my conversations in Kobe):",
      input.appUrl,
      "",
      "Team admins can cancel the change in the team console (Retention) until that date.",
    ].join("\n"),
  };
}

export interface NotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

/** Notifies one team's admins of its next shortening, if any. Returns the emails sent. */
export async function notifyShortening(
  deps: NotifyDeps,
  teamId: string,
  now = new Date(),
): Promise<number> {
  const plan = await withTeam(deps.db, teamId, async (tx) => {
    const upcoming = upcomingShortening(
      await readTeamLayer(tx, teamId),
      await readMaximumLayer(tx),
      now,
    );
    const days = upcoming ? PERIOD_DAYS[upcoming.period] : null;
    if (!upcoming || days === null) return null;
    const counted = await tx.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM threads t
       WHERE t.team_id = ${teamId} AND t.deleted_at IS NULL
         AND t.last_activity_at < ${upcoming.effectiveAt.toISOString()}::timestamptz
                                  - make_interval(days => ${days})`);
    const admins = await tx
      .select({ email: users.email })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.role, "team_admin"),
          isNull(users.deactivatedAt),
        ),
      )
      .orderBy(asc(users.email));
    return { upcoming, threads: Number(counted.rows[0]?.n ?? 0), admins };
  });
  if (!plan) return 0;
  const [team] = await deps.db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  let sent = 0;
  for (const admin of plan.admins) {
    await deps.mailer.send(
      shorteningMessage({
        to: admin.email,
        teamName: team?.name ?? "Your team",
        period: plan.upcoming.period,
        effectiveAt: plan.upcoming.effectiveAt,
        threads: plan.threads,
        appUrl: deps.publicUrl,
      }),
    );
    sent += 1;
  }
  await recordAuditAfter(deps.db, {
    action: "retention.shortening_notified",
    actor: SYSTEM_ACTOR,
    teamId,
    target: {
      period: plan.upcoming.period,
      effectiveAt: plan.upcoming.effectiveAt.toISOString(),
      threads: plan.threads,
      recipients: sent,
    },
  });
  return sent;
}

/** After the install maximum was lowered: every team whose applied period will get shorter. */
export async function notifyAllTeams(deps: NotifyDeps, now = new Date()): Promise<number> {
  const all = await deps.db.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
  let sent = 0;
  for (const { id } of all) sent += await notifyShortening(deps, id, now);
  return sent;
}
