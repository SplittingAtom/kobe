import {
  budgetAlertEmails,
  eq,
  sql,
  teams,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import type { Mailer, MailMessage } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";

/**
 * Budget alert emails (KOBE-42): queued with the alert in its transaction, delivered here **at
 * least once** — rows are claimed with a lease, marked sent once the SMTP server accepted them,
 * retried with backoff, given up (`failed`) after {@link BUDGET_EMAIL_MAX_ATTEMPTS}. A recipient who
 * left (deactivated) is skipped. Plain text, amounts and names only.
 */
export const BUDGET_EMAIL_MAX_ATTEMPTS = 8;
const LEASE = "5 minutes";
const BATCH = 50;
const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type Claimed = {
  id: string;
  attempts: number;
  recipient_id: string;
  team_id: string | null;
  scope: "install" | "team" | "user";
  user_id: string | null;
  period: "month" | "day";
  threshold: number;
  unit: "usd" | "tokens";
  limit_amount: string;
  spent_amount: string;
  superseded: boolean;
  sent_today: number;
};

const money = (v: number) => `$${v.toFixed(2)}`;
const amount = (unit: Claimed["unit"], v: number) =>
  unit === "usd" ? money(v) : `${Math.round(v).toLocaleString("en-US")} tokens`;

export function budgetAlertMessage(input: {
  readonly to: string;
  readonly scope: Claimed["scope"];
  readonly own: boolean;
  readonly teamName: string | null;
  readonly period: Claimed["period"];
  readonly threshold: number;
  readonly unit: Claimed["unit"];
  readonly limit: number;
  readonly spent: number;
  readonly link: string;
}): MailMessage {
  const team = input.teamName ? oneLine(input.teamName) : null;
  const whose =
    input.scope === "install"
      ? "The install's"
      : input.scope === "team"
        ? `The ${team ?? "team"} team's`
        : input.own
          ? `Your (${team ?? "team"})`
          : `A member's (${team ?? "team"})`;
  const period = input.period === "month" ? "monthly" : "daily";
  const reached = input.threshold >= 100;
  const kind = input.unit === "tokens" ? "token" : "model";
  return {
    to: input.to,
    subject: reached
      ? `${whose} ${period} ${kind} budget is used up`
      : `${whose} ${period} ${kind} budget is ${input.threshold}% used`,
    text: [
      `${whose} ${period} ${kind} budget: ${amount(input.unit, input.spent)} of ${amount(input.unit, input.limit)} used.`,
      "",
      reached
        ? "New model calls and runs are refused until the period ends or the budget is raised; runs in progress stop after their current step."
        : "When it is used up, new model calls and runs will be refused.",
      "",
      `Budgets and usage: ${input.link}`,
    ].join("\n"),
  };
}

/** At most this many budget emails per recipient per UTC day (the rest are skipped, logged). */
export const BUDGET_EMAILS_PER_RECIPIENT_PER_DAY = 20;

interface DeliverOptions {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly logger: Logger;
}

/**
 * Delivers due budget emails in every context their alerts are visible in (RLS, KOBE-42 review):
 * the install's (no team), then each team's. Never throws; returns how many were sent.
 */
export async function deliverBudgetEmails(options: DeliverOptions): Promise<number> {
  let sent = await deliverIn(options, null);
  try {
    const all = await options.db.select({ id: teams.id }).from(teams);
    for (const team of all) sent += await deliverIn(options, team.id);
  } catch (err) {
    options.logger.error({ err }, "budget email delivery failed");
  }
  return sent;
}

async function deliverIn(options: DeliverOptions, teamId: string | null): Promise<number> {
  const { db, mailer, logger } = options;
  const inContext = <T>(fn: (tx: KobeTx) => Promise<T>): Promise<T> =>
    teamId ? withTeam(db, teamId, fn) : db.transaction(fn);
  type Settle = Parameters<ReturnType<KobeTx["update"]>["set"]>[0];
  const settle = (id: string, values: Settle) =>
    inContext((tx) => tx.update(budgetAlertEmails).set(values).where(eq(budgetAlertEmails.id, id)));
  let sent = 0;
  try {
    const claimed = await inContext((tx) =>
      tx.execute<Claimed>(sql`
        UPDATE budget_alert_emails e SET attempts = e.attempts + 1,
               next_attempt_at = now() + ${LEASE}::interval
          FROM budget_alerts a
         WHERE a.id = e.alert_id
           AND a.team_id IS NOT DISTINCT FROM ${teamId}::uuid
           AND e.id IN (
               SELECT id FROM budget_alert_emails
                WHERE status = 'pending' AND next_attempt_at <= now()
                ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING e.id, e.attempts, e.recipient_id, a.team_id, a.scope, a.user_id, a.period,
                  a.threshold, a.unit, a.limit_amount, a.spent_amount,
                  (a.threshold < 100 AND EXISTS (
                     SELECT 1 FROM budget_alerts b
                      WHERE b.team_id IS NOT DISTINCT FROM a.team_id
                        AND b.user_id IS NOT DISTINCT FROM a.user_id
                        AND b.scope = a.scope AND b.unit = a.unit AND b.period = a.period
                        AND b.period_start = a.period_start AND b.threshold = 100)) AS superseded,
                  (SELECT count(*) FROM budget_alert_emails x
                    WHERE x.recipient_id = e.recipient_id AND x.status = 'sent'
                      AND x.sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  )::int AS sent_today`),
    );
    for (const row of claimed.rows) {
      const [to] = await db
        .select({ email: users.email, off: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, row.recipient_id));
      if (!to || to.off !== null) {
        await settle(row.id, { status: "skipped", lastError: "recipient_inactive" });
        continue;
      }
      // An 80 % warning whose budget is already used up says less than the 100 % email.
      if (row.superseded) {
        await settle(row.id, { status: "skipped", lastError: "superseded" });
        continue;
      }
      if (row.sent_today >= BUDGET_EMAILS_PER_RECIPIENT_PER_DAY) {
        logger.warn({ recipient: row.recipient_id }, "budget emails per day reached: skipped");
        await settle(row.id, { status: "skipped", lastError: "daily_limit" });
        continue;
      }
      const [team] = row.team_id
        ? await db.select({ name: teams.name }).from(teams).where(eq(teams.id, row.team_id))
        : [];
      const path = row.scope === "install" ? "/admin/install/usage" : "/admin/team/budgets";
      try {
        await mailer.send(
          budgetAlertMessage({
            to: to.email,
            scope: row.scope,
            own: row.user_id === row.recipient_id,
            teamName: team?.name ?? null,
            period: row.period,
            threshold: row.threshold,
            unit: row.unit,
            limit: Number(row.limit_amount),
            spent: Number(row.spent_amount),
            link: `${options.publicUrl}${path}`,
          }),
        );
        await settle(row.id, { status: "sent", sentAt: sql`now()`, lastError: null });
        sent++;
      } catch (err) {
        const giveUp = row.attempts >= BUDGET_EMAIL_MAX_ATTEMPTS;
        logger.warn({ err, emailId: row.id, giveUp }, "budget alert email failed");
        await settle(
          row.id,
          giveUp
            ? { status: "failed", lastError: "smtp_error" }
            : {
                lastError: "smtp_error",
                nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
              },
        );
      }
    }
  } catch (err) {
    logger.error({ err, teamId }, "budget email delivery failed");
  }
  return sent;
}
