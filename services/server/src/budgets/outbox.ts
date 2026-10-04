import { budgetAlertEmails, eq, sql, teams, users, type KobeDb } from "@kobe/db";
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

export async function deliverBudgetEmails(options: {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly logger: Logger;
}): Promise<number> {
  const { db, mailer, logger } = options;
  let sent = 0;
  try {
    const claimed = await db.execute<Claimed>(sql`
      UPDATE budget_alert_emails e SET attempts = e.attempts + 1,
             next_attempt_at = now() + ${LEASE}::interval
        FROM budget_alerts a
       WHERE a.id = e.alert_id AND e.id IN (
             SELECT id FROM budget_alert_emails
              WHERE status = 'pending' AND next_attempt_at <= now()
              ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING e.id, e.attempts, e.recipient_id, a.team_id, a.scope, a.user_id, a.period,
                a.threshold, a.unit, a.limit_amount, a.spent_amount`);
    for (const row of claimed.rows) {
      const [to] = await db
        .select({ email: users.email, off: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, row.recipient_id));
      if (!to || to.off !== null) {
        await db
          .update(budgetAlertEmails)
          .set({ status: "skipped", lastError: "recipient_inactive" })
          .where(eq(budgetAlertEmails.id, row.id));
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
        await db
          .update(budgetAlertEmails)
          .set({ status: "sent", sentAt: sql`now()`, lastError: null })
          .where(eq(budgetAlertEmails.id, row.id));
        sent++;
      } catch (err) {
        const giveUp = row.attempts >= BUDGET_EMAIL_MAX_ATTEMPTS;
        logger.warn({ err, emailId: row.id, giveUp }, "budget alert email failed");
        await db
          .update(budgetAlertEmails)
          .set(
            giveUp
              ? { status: "failed", lastError: "smtp_error" }
              : {
                  lastError: "smtp_error",
                  nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
                },
          )
          .where(eq(budgetAlertEmails.id, row.id));
      }
    }
  } catch (err) {
    logger.error({ err }, "budget email delivery failed");
  }
  return sent;
}
