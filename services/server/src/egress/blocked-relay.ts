import {
  ACTIVE_RUN_STATUSES,
  EGRESS_BLOCKED_CHANNEL,
  EGRESS_BLOCKED_EVENT_KIND,
  events,
  inArray,
  runs,
  sql,
  teams,
  threads,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import pg from "pg";
import { z } from "zod";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { logger as rootLogger } from "../logger.js";

/**
 * Turns the egress proxy's blocked attempts into `egress.blocked` run events (spec D28, §6.2).
 *
 * The proxy records a pending `events` row (kind `egress.blocked`) in the sandbox's team and
 * NOTIFYs `<team_id>:<event_id>`. One sandbox serves one (user, team) (D11), so the attempt belongs
 * to that user's active runs in the team; a thread hint from the proxy credentials narrows it to
 * one run when it names one of them. Every replica listens; `FOR UPDATE SKIP LOCKED` makes each
 * event processed exactly once, and a periodic sweep picks up anything whose hint was missed.
 * Attempts with no active run are marked processed (nothing to show; KOBE-39's request-access flow
 * starts from the thread).
 */
const refSchema = z.object({
  user_id: z.uuid(),
  domain: z.string().min(1).max(253),
  request_access: z.boolean(),
  thread_id: z.uuid().optional(),
});

/** Runs one blocked attempt is shown on, at most. */
const MAX_RUNS_PER_EVENT = 8;
const BATCH = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Processes the team's pending egress.blocked events; returns how many it handled. */
export async function relayBlockedEvents(db: KobeDb, teamId: string): Promise<number> {
  return withAppendTx(db, teamId, async (tx) => {
    const pending = await tx
      .select()
      .from(events)
      .where(
        sql`${events.teamId} = ${teamId} AND ${events.kind} = ${EGRESS_BLOCKED_EVENT_KIND} AND ${events.status} = 'pending'`,
      )
      .orderBy(events.createdAt)
      .limit(BATCH)
      .for("update", { skipLocked: true });
    for (const event of pending) {
      const ref = refSchema.safeParse(event.ref);
      const runIds = ref.success ? await appendToActiveRuns(tx, teamId, ref.data) : [];
      await tx
        .update(events)
        .set({
          status: ref.success ? "processed" : "failed",
          ref: { ...event.ref, run_ids: runIds },
        })
        .where(sql`${events.teamId} = ${teamId} AND ${events.id} = ${event.id}`);
    }
    return pending.length;
  });
}

async function appendToActiveRuns(
  tx: KobeTx,
  teamId: string,
  ref: z.infer<typeof refSchema>,
): Promise<string[]> {
  const active = await tx
    .select({ runId: runs.id, threadId: runs.threadId })
    .from(runs)
    .innerJoin(
      threads,
      sql`${threads.teamId} = ${runs.teamId} AND ${threads.id} = ${runs.threadId}`,
    )
    .where(
      sql`${runs.teamId} = ${teamId} AND ${threads.ownerUserId} = ${ref.user_id} AND ${inArray(runs.status, [...ACTIVE_RUN_STATUSES])}`,
    )
    .orderBy(runs.startedAt)
    .limit(MAX_RUNS_PER_EVENT);
  const hinted = active.filter((r) => r.threadId === ref.thread_id);
  const targets = hinted.length > 0 ? hinted : active;
  for (const { runId } of targets) {
    await appendRunEventsInTx(tx, teamId, runId, [
      {
        type: "egress.blocked",
        payload: { domain: ref.domain, request_access: ref.request_access },
      },
    ]);
  }
  return targets.map((t) => t.runId);
}

export interface BlockedRelayOptions {
  readonly db: KobeDb;
  /** App-role URL for the LISTEN connection (direct or session-mode pooler). */
  readonly connectionString: string;
  readonly sweepMs?: number;
  readonly reconnectMs?: number;
}

export class EgressBlockedRelay {
  private client: pg.Client | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly busy = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly log = rootLogger.child({ component: "egress-blocked-relay" });

  constructor(private readonly options: BlockedRelayOptions) {}

  start(): void {
    void this.listen();
    this.sweepTimer = setInterval(() => void this.sweep(), this.options.sweepMs ?? 30_000);
    this.sweepTimer.unref();
  }

  /** Processes one team now, coalescing concurrent requests for the same team. */
  process(teamId: string): Promise<void> {
    const running = this.busy.get(teamId);
    if (running) {
      this.again.add(teamId);
      return running;
    }
    const work = (async () => {
      try {
        do {
          this.again.delete(teamId);
          while ((await relayBlockedEvents(this.options.db, teamId)) === BATCH) {
            // a full batch: there may be more
          }
        } while (this.again.has(teamId));
      } catch (err) {
        this.log.error({ err, team: teamId }, "egress.blocked relay failed");
      } finally {
        this.busy.delete(teamId);
      }
    })();
    this.busy.set(teamId, work);
    return work;
  }

  async sweep(): Promise<void> {
    try {
      const all = await this.options.db.select({ id: teams.id }).from(teams);
      for (const { id } of all) await this.process(id);
    } catch (err) {
      this.log.error({ err }, "egress.blocked sweep failed");
    }
  }

  private async listen(): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.options.connectionString });
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      client.end().catch(() => undefined);
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => void this.listen(), this.options.reconnectMs ?? 5_000);
      this.reconnectTimer.unref();
    };
    client.on("error", (err) => {
      this.log.warn({ err }, "egress.blocked listener error");
      lost();
    });
    client.on("end", lost);
    client.on("notification", (n) => {
      const team = n.payload?.split(":")[0];
      if (team && UUID.test(team)) void this.process(team.toLowerCase());
    });
    this.client = client;
    try {
      await client.connect();
      await client.query(`LISTEN ${EGRESS_BLOCKED_CHANNEL}`);
      void this.sweep(); // anything recorded while nobody listened
    } catch (err) {
      this.log.warn({ err }, "egress.blocked listener could not connect");
      lost();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
    await Promise.all([...this.busy.values()]);
  }
}
