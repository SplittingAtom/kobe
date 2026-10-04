import {
  BUDGET_THRESHOLDS,
  MODELS_CHANNEL,
  MODELS_SPEND_PREFIX,
  SYSTEM_ACTOR,
  and,
  eq,
  isNull,
  loadTeamBudgetLines,
  percentUsed,
  sql,
  teamMembers,
  teams,
  users,
  withTeam,
  type BudgetLine,
  type BudgetThreshold,
  type KobeDb,
} from "@kobe/db";
import type { BudgetStopCommand } from "@kobe/protocol";
import pg from "pg";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import { activeInstallAdmins } from "../break-glass/store.js";
import type { Mailer } from "../mail/mailer.js";
import { deliverBudgetEmails } from "./outbox.js";

/**
 * Watches spend against budgets (KOBE-42, D30) and acts on it:
 *
 * - **80 %**: a warning, recorded once per budget and period (`budget_alerts`) and emailed (team
 *   admins; for a member budget the member too; install admins for the install budget). Members
 *   see it in the chat (`GET /v1/team/budget-status`).
 * - **100 %**: the same, audited `models.budget.reached`, and every active run at that level is
 *   budget-stopped (`stopForBudget`): queued runs end now, running ones after their current step,
 *   pending approvals expire. The run gate and the model gateway's call gate refuse new runs and
 *   new model calls from the same numbers.
 *
 * Triggered by the shims' `spend:<team>` hints (right after usage rows land) and by a sweep over
 * every team (`intervalMs`), which also delivers the email outbox. Every replica may evaluate:
 * alerts are unique per period in Postgres and `stopForBudget` is idempotent.
 */
export interface BudgetMonitorOptions {
  readonly db: KobeDb;
  readonly connectionString: string;
  readonly runs: { stopForBudget(command: BudgetStopCommand): Promise<readonly string[]> };
  readonly mailer: Mailer;
  readonly publicUrl: string;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Evaluation {
  /** Alerts recorded by this evaluation (new thresholds crossed). */
  readonly alerts: number;
  /** Budget stops requested: `<scope>` or `user:<id>`. */
  readonly stopped: readonly string[];
}

export class BudgetMonitor {
  private client: pg.Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<Evaluation>>();
  private closed = false;
  private sweeping: Promise<void> | undefined;

  constructor(private readonly options: BudgetMonitorOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  start(): void {
    void this.listen();
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs ?? 30_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    await this.client?.end().catch(() => undefined);
    await Promise.allSettled(this.running.values());
  }

  private async listen(): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: 10_000,
    });
    const retry = () => {
      if (this.client !== client) return;
      this.client = undefined;
      client.end().catch(() => undefined);
      if (!this.closed) setTimeout(() => void this.listen(), 2_000).unref();
    };
    client.on("error", retry);
    client.on("end", retry);
    client.on("notification", (n) => {
      if (n.channel !== MODELS_CHANNEL || !n.payload?.startsWith(MODELS_SPEND_PREFIX)) return;
      const teamId = n.payload.slice(MODELS_SPEND_PREFIX.length);
      if (UUID.test(teamId)) this.soon(teamId.toLowerCase());
    });
    try {
      this.client = client;
      await client.connect();
      await client.query(`LISTEN ${MODELS_CHANNEL}`);
    } catch (err) {
      this.options.logger.warn({ err }, "budget monitor could not listen");
      retry();
    }
  }

  /** Evaluates a team shortly (hints for one team within 100 ms share one evaluation). */
  soon(teamId: string): void {
    if (this.closed || this.pending.has(teamId)) return;
    const t = setTimeout(() => {
      this.pending.delete(teamId);
      void this.evaluate(teamId).catch((err: unknown) =>
        this.options.logger.error({ err, teamId }, "budget evaluation failed"),
      );
    }, 100);
    t.unref();
    this.pending.set(teamId, t);
  }

  /** Every team, then the email outbox. Never throws; a sweep already running is joined. */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    try {
      const all = await this.options.db.select({ id: teams.id }).from(teams);
      for (const team of all) {
        if (this.closed) return;
        await this.evaluate(team.id).catch((err: unknown) =>
          this.options.logger.error({ err, teamId: team.id }, "budget evaluation failed"),
        );
      }
      await this.deliver();
    } catch (err) {
      this.options.logger.error({ err }, "budget sweep failed");
    }
  }

  deliver(): Promise<number> {
    return deliverBudgetEmails(this.options);
  }

  /** One team's budgets now (concurrent calls for a team share one evaluation). */
  evaluate(teamId: string): Promise<Evaluation> {
    const current = this.running.get(teamId);
    if (current) return current;
    const run = this.evaluateOnce(teamId).finally(() => this.running.delete(teamId));
    this.running.set(teamId, run);
    return run;
  }

  private async evaluateOnce(teamId: string): Promise<Evaluation> {
    const { db, logger } = this.options;
    const { lines } = await withTeam(db, teamId, (tx) =>
      loadTeamBudgetLines(tx, teamId, this.now()),
    );
    let alerts = 0;
    let installReached = false;
    for (const line of lines) {
      for (const threshold of BUDGET_THRESHOLDS) {
        if (percentUsed(line) >= threshold && (await this.alert(teamId, line, threshold))) {
          alerts++;
          if (line.scope === "install" && threshold === 100) installReached = true;
        }
      }
    }
    // The install budget just ran out: stop every team's runs now, not at the next sweep.
    if (installReached) void this.sweep();
    // Stop what is used up, widest first; a narrower stop of the same runs is then a no-op.
    const stopped: string[] = [];
    const seen = new Set<string>();
    for (const line of lines.filter((l) => l.spent >= l.limit)) {
      const key = line.scope === "user" ? `user:${line.userId ?? ""}` : line.scope;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const affected = await this.options.runs.stopForBudget({
          team_id: teamId,
          scope: line.scope,
          ...(line.scope === "user" && line.userId ? { user_id: line.userId } : {}),
        });
        if (affected.length > 0) {
          logger.info({ teamId, scope: line.scope, runs: affected.length }, "budget stop");
        }
        stopped.push(key);
      } catch (err) {
        // Some runs could not be stopped: the next evaluation tries again.
        logger.error({ err, teamId, scope: line.scope }, "budget stop failed");
      }
    }
    if (alerts > 0) await this.deliver();
    return { alerts, stopped };
  }

  /** Records a crossed threshold once (per budget and period); true when this call recorded it. */
  private async alert(
    teamId: string,
    line: BudgetLine,
    threshold: BudgetThreshold,
  ): Promise<boolean> {
    const { db } = this.options;
    const alertTeam = line.scope === "install" ? null : teamId;
    const alertUser = line.scope === "user" ? (line.userId ?? null) : null;
    // Already recorded this period (the common case while a budget stays used up): nothing to do.
    const known = await db.execute(sql`
      SELECT 1 FROM budget_alerts
       WHERE team_id IS NOT DISTINCT FROM ${alertTeam}::uuid
         AND user_id IS NOT DISTINCT FROM ${alertUser}::uuid
         AND scope = ${line.scope} AND unit = ${line.unit} AND period = ${line.period}
         AND period_start = ${line.periodStart}::date AND threshold = ${threshold}`);
    if (known.rows.length > 0) return false;
    // Recipients are read first (team admins live behind the team's RLS).
    const recipients = await this.recipients(teamId, line);
    return db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO budget_alerts (team_id, user_id, scope, unit, period, period_start,
                                   threshold, limit_amount, spent_amount)
        VALUES (${alertTeam}, ${alertUser}, ${line.scope}, ${line.unit}, ${line.period},
                ${line.periodStart}::date, ${threshold}, ${line.limit}, ${line.spent})
        ON CONFLICT ON CONSTRAINT budget_alerts_once DO NOTHING
        RETURNING id`);
      const id = inserted.rows[0]?.id;
      if (!id) return false;
      for (const recipient of recipients) {
        await tx.execute(sql`
          INSERT INTO budget_alert_emails (alert_id, recipient_id)
          VALUES (${id}, ${recipient}) ON CONFLICT DO NOTHING`);
      }
      if (threshold === 100) {
        await recordAudit(tx, {
          action: "models.budget.reached",
          actor: SYSTEM_ACTOR,
          ...(alertTeam ? { teamId: alertTeam } : {}),
          target: {
            scope: line.scope,
            ...(alertUser ? { userId: alertUser } : {}),
            period: line.period,
            periodStart: line.periodStart,
            unit: line.unit,
            limit: line.limit,
            spent: Math.round(line.spent * 1e6) / 1e6,
          },
        });
      }
      return true;
    });
  }

  /** Who is told: install admins (install budget); team admins, plus the member for their own. */
  private async recipients(teamId: string, line: BudgetLine): Promise<string[]> {
    const { db } = this.options;
    if (line.scope === "install") return (await activeInstallAdmins(db)).map((a) => a.id);
    const admins = await withTeam(db, teamId, (tx) =>
      tx
        .select({ id: users.id })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.role, "team_admin"),
            isNull(users.deactivatedAt),
          ),
        ),
    );
    const ids = new Set(admins.map((a) => a.id));
    if (line.scope === "user" && line.userId) ids.add(line.userId);
    return [...ids];
  }
}
