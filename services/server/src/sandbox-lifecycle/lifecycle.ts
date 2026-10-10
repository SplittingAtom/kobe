import {
  SYSTEM_ACTOR,
  eq,
  getMembership,
  sql,
  teams,
  users,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import type { Logger } from "pino";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit, recordAuditAfter } from "../audit/record.js";
import { appendRunEventsInTx, withAppendTx } from "../event-stream/append.js";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { logger as rootLogger } from "../logger.js";
import type { TeamRef } from "../sandbox/manifests.js";
import { workspacePvcName, type SandboxProvider } from "../sandbox/provider.js";
import { notifyHintInTx } from "../sandbox-wire/bus.js";
import { SandboxWakeError, type SandboxTarget, type SandboxWaker } from "../sandbox-wire/types.js";
import { resolveIdleMinutes, TEAM_IDLE_MINUTES } from "./idle.js";
import { ensureReady, type ReadyProvider } from "./ready.js";
import {
  beginWake,
  forgetSandboxIdentity,
  idleCandidates,
  lockIfIdle,
  markHibernated,
  neverRecorded,
  recordSandboxIdentity,
} from "./store.js";

/**
 * Sandbox hibernation and wake (KOBE-25, spec D14).
 *
 * - **Wake** (the KOBE-24 `SandboxWaker` seam; the router calls it when a command finds no live
 *   connection): the `sandboxes` row becomes `running` with fresh activity under its lock, then the
 *   provider creates or resumes the sandbox through the isolation gate. Concurrent wakes of one
 *   sandbox share one call per process; across replicas the Sandbox's resourceVersion makes the
 *   resume happen once.
 * - **Hibernate**: every replica sweeps periodically; a sandbox idle for its team's idle time, with
 *   no queued/active run and no command in flight, is suspended *while its row is locked*, its
 *   connection row closed and its holder told to close the socket `hibernating`, in one
 *   transaction. A wake or command that comes meanwhile waits for that lock, then sees the sandbox
 *   hibernated and wakes it — so wake racing hibernate always ends awake, and a run is never
 *   started on a pod on its way out.
 */

export type LifecycleProvider = Pick<SandboxProvider, "wakeSandbox" | "hibernateSandbox"> &
  Partial<ReadyProvider>;

export interface LifecycleOptions {
  readonly db: KobeDb;
  readonly provider: LifecycleProvider;
  /** Install default idle minutes (Helm `sandbox.hibernation.idleMinutes`, D14: 15). */
  readonly idleMinutes: number;
  /** Most sandboxes one sweep hibernates per team (spreads Kubernetes writes). */
  readonly batchPerTeam?: number;
  /**
   * Called when a wake finds the member's sandbox offboarded (KOBE-28): drops the old retained
   * volume so the wake can start a new sandbox. False refuses the wake (legal hold). Without it
   * an offboarded sandbox is never woken.
   */
  readonly reinstate?: (target: SandboxTarget) => Promise<boolean>;
  readonly log?: Logger;
}

export interface LifecycleMetrics {
  hibernated: number;
  woken: number;
  wakeFailures: number;
  /** Wakes that failed because the pod was not Ready within the wake timeout (KOBE-192). */
  stalledWakes: number;
  /** Latest wake durations (ms), newest last; bounded. */
  readonly wakeMs: number[];
}

export interface HibernateResult {
  readonly hibernated: { readonly teamId: string; readonly userId: string }[];
  readonly failedTeams: number;
}

export interface SandboxLifecycle {
  readonly waker: SandboxWaker;
  /** One hibernation sweep over every team now. */
  sweep(): Promise<HibernateResult>;
  /**
   * Hibernates one sandbox now if it is not busy (operators, the cold-start harness); `force`
   * skips only the idle-time check, never the busy checks. True when it was hibernated.
   */
  hibernate(target: SandboxTarget, options?: { readonly force?: boolean }): Promise<boolean>;
  /** Runs `sweep` every `everyMs` (jittered); returns a stop function. */
  start(everyMs: number): () => void;
  metrics(): LifecycleMetrics;
}

const WAKE_SAMPLES = 64;

type WakingReason = "hibernated" | "first_start";

interface InflightWake {
  readonly runs: Set<string>;
  /** undefined: not known yet; null: nothing to announce. */
  reason: WakingReason | null | undefined;
  promise: Promise<void>;
}

export function createSandboxLifecycle(options: LifecycleOptions): SandboxLifecycle {
  const { db, provider } = options;
  const log = options.log ?? rootLogger.child({ component: "sandbox-lifecycle" });
  const batch = options.batchPerTeam ?? 20;
  const metrics: LifecycleMetrics = {
    hibernated: 0,
    woken: 0,
    wakeFailures: 0,
    stalledWakes: 0,
    wakeMs: [],
  };
  /** One wake per sandbox per process; runs that joined it get its `sandbox.waking` too. */
  const inflight = new Map<string, InflightWake>();

  const teamRef = async (teamId: string): Promise<TeamRef & { settings: unknown }> => {
    const [team] = await db
      .select({ id: teams.id, slug: teams.slug, settings: teams.settings })
      .from(teams)
      .where(eq(teams.id, teamId));
    if (!team) throw new SandboxWakeError("sandbox_unavailable", "the team no longer exists");
    return team;
  };

  /** Only an active member's sandbox is woken (the wire refuses anyone else's connection too). */
  const assertAllowed = async (target: SandboxTarget): Promise<void> => {
    const [account] = await db
      .select({ deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, target.userId));
    const member =
      account?.deactivatedAt === null && (await getMembership(db, target.teamId, target.userId));
    if (!member) {
      throw new SandboxWakeError(
        "sandbox_unavailable",
        "the user may not use a sandbox in this team",
      );
    }
  };

  /**
   * `sandbox.waking` on a run that waits for this wake (D14: the UI shows "Waking your
   * workspace…" at once). Only while the run is `running`; never fails the wake.
   */
  const announce = async (
    target: SandboxTarget,
    runId: string,
    reason: WakingReason,
  ): Promise<void> => {
    try {
      await withAppendTx(db, target.teamId, async (tx) => {
        const run = await tx.execute<{ status: string }>(sql`
          SELECT status FROM runs WHERE team_id = ${target.teamId} AND id = ${runId}`);
        if (run.rows[0]?.status !== "running") return;
        await appendRunEventsInTx(tx, target.teamId, runId, [
          { type: "sandbox.waking", payload: { reason } },
        ]);
      });
    } catch (err) {
      log.warn({ err, run_id: runId }, "could not append sandbox.waking");
    }
  };

  /**
   * The pod must be Ready within the wake timeout (KOBE-192). Not Ready: the run fails
   * `workspace_unavailable` (no cluster detail) and install admins get the reason in the audit log
   * (`sandbox.wake_stalled`) and the server log. Runs before the sandbox's identity is recorded,
   * so "identity recorded" means "has come up at least once", the proof the volume-retry needs.
   */
  const waitUntilReady = async (team: TeamRef, target: SandboxTarget): Promise<void> => {
    const { awaitReady, retryStalledVolume } = provider;
    if (!awaitReady || !retryStalledVolume) return;
    const base = { teamId: target.teamId, userId: target.userId };
    await ensureReady({
      provider: { awaitReady, retryStalledVolume },
      team,
      userId: target.userId,
      neverStarted: await neverRecorded(db, target),
      log,
      onRetried: ({ sandboxId, stall }) =>
        recordAuditAfter(db, {
          action: "sandbox.volume_retried",
          actor: SYSTEM_ACTOR,
          target: {
            ...base,
            sandboxId,
            cause: stall.cause === "volume_attach" ? "volume_attach" : "volume_unschedulable",
          },
        }),
      onStalled: ({ sandboxId, stall, retried }) => {
        metrics.stalledWakes += 1;
        return recordAuditAfter(db, {
          action: "sandbox.wake_stalled",
          actor: SYSTEM_ACTOR,
          target: { ...base, sandboxId, cause: stall.cause, detail: stall.detail, retried },
        });
      },
    });
  };

  const wakeOnce = async (target: SandboxTarget, entry: InflightWake): Promise<void> => {
    const started = Date.now();
    await assertAllowed(target);
    const team = await teamRef(target.teamId);
    let previous = await beginWake(db, target);
    if (previous === "destroyed" && options.reinstate && (await options.reinstate(target))) {
      previous = await beginWake(db, target);
    }
    if (previous === "destroyed") {
      throw new SandboxWakeError("sandbox_unavailable", "this sandbox was offboarded");
    }
    // No row: never started through Kobe; hibernated: a resume. A `running` row whose sandbox is
    // merely disconnected (pod restarting) is not announced. (`rebuild`, a lost volume, is the
    // wire's: KOBE-24 restores the session.)
    entry.reason =
      previous === undefined ? "first_start" : previous === "hibernated" ? "hibernated" : null;
    if (entry.reason) {
      const reason = entry.reason;
      await Promise.all([...entry.runs].map((runId) => announce(target, runId, reason)));
    }
    let result;
    try {
      result = await provider.wakeSandbox(team, target.userId);
    } catch (err) {
      if (err instanceof IsolationRuntimeMissingError) {
        throw new SandboxWakeError(
          "isolation_runtime_missing",
          "Agent sandboxes are unavailable: no verified isolation runtime",
        );
      }
      throw err;
    }
    const { handle, resumed } = result;
    await waitUntilReady(team, target);
    // sandbox.woken is recorded by the provider when its resume patch is committed.
    await withTeam(db, target.teamId, (tx) =>
      recordSandboxIdentity(tx, target, handle.sandboxId, workspacePvcName(handle.sandboxName)),
    );
    const ms = Date.now() - started;
    if (resumed) {
      metrics.woken += 1;
      metrics.wakeMs.push(ms);
      if (metrics.wakeMs.length > WAKE_SAMPLES) metrics.wakeMs.shift();
    }
    log.info(
      { team_id: target.teamId, sandbox_id: handle.sandboxId, resumed, previous, ms },
      resumed ? "sandbox woken" : "sandbox ensured",
    );
  };

  const waker: SandboxWaker = {
    wake(target, context) {
      const key = `${target.teamId}:${target.userId}`;
      const running = inflight.get(key);
      if (running) {
        // Joined a wake in progress: announce to this run too (now, or once the reason is known).
        if (context?.runId && !running.runs.has(context.runId)) {
          running.runs.add(context.runId);
          if (running.reason) void announce(target, context.runId, running.reason);
        }
        return running.promise;
      }
      const entry: InflightWake = {
        runs: new Set(context?.runId ? [context.runId] : []),
        reason: undefined,
        promise: Promise.resolve(),
      };
      entry.promise = wakeOnce(target, entry)
        .catch((err: unknown) => {
          metrics.wakeFailures += 1;
          throw err;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, entry);
      return entry.promise;
    },
  };

  const hibernateOne = async (
    team: TeamRef,
    target: SandboxTarget,
    idleMinutes: number,
    force: boolean,
  ): Promise<boolean> => {
    const done = await withTeam(db, target.teamId, async (tx) => {
      const locked = await lockIfIdle(tx, target, idleMinutes, force);
      // No claim recorded yet (its wake failed half-way): nothing known to suspend; the next wake
      // records it and a later sweep hibernates it.
      if (!locked?.sandboxId) return false;
      const sandboxId = locked.sandboxId;
      // Kubernetes first, under the lock: a rollback (commit failure) leaves the row `running`
      // and the next command finds no connection and resumes the sandbox.
      const outcome = await provider.hibernateSandbox(team, target.userId, sandboxId);
      if (outcome === "not_found") {
        // The claim is gone or was recreated (offboarding, isolation enforcement): nothing was
        // suspended. Forget the stale id; the next wake records the current sandbox.
        await forgetSandboxIdentity(tx, target, sandboxId);
        log.warn({ team_id: target.teamId, sandbox_id: sandboxId }, "hibernate: no such sandbox");
        return false;
      }
      const connection = await markHibernated(tx, target);
      if (connection) await notifyHintInTx(tx, { kind: "hib", id: connection });
      // `already_suspended`: a previous hibernation whose commit failed; record the state only.
      if (outcome === "suspended") {
        await recordAudit(tx, {
          action: "sandbox.hibernated",
          actor: currentAuditContext()?.actor ?? SYSTEM_ACTOR,
          teamId: target.teamId,
          target: {
            sandboxId,
            userId: target.userId,
            idleMinutes,
            trigger: force ? "operator" : "idle",
          },
        });
      }
      return true;
    });
    if (done) {
      metrics.hibernated += 1;
      log.info({ team_id: target.teamId, idle_minutes: idleMinutes, force }, "sandbox hibernated");
    }
    return done;
  };

  const sweep = async (): Promise<HibernateResult> => {
    const hibernated: HibernateResult["hibernated"] = [];
    let failedTeams = 0;
    const all = await db
      .select({ id: teams.id, slug: teams.slug, settings: teams.settings })
      .from(teams);
    for (const team of all) {
      try {
        const idle = resolveIdleMinutes(team.settings[TEAM_IDLE_MINUTES], options.idleMinutes);
        const candidates = await withTeam(db, team.id, (tx) =>
          idleCandidates(tx, team.id, idle, batch),
        );
        for (const c of candidates) {
          const target = { teamId: team.id, userId: c.userId };
          if (await hibernateOne(team, target, idle, false)) hibernated.push(target);
        }
      } catch (err) {
        failedTeams += 1;
        log.error({ err, team_id: team.id }, "hibernation sweep failed for a team");
      }
    }
    return { hibernated, failedTeams };
  };

  return {
    waker,
    sweep,
    async hibernate(target, opts) {
      const team = await teamRef(target.teamId);
      const idle = resolveIdleMinutes(
        team.settings && (team.settings as Record<string, unknown>)[TEAM_IDLE_MINUTES],
        options.idleMinutes,
      );
      return hibernateOne(team, target, idle, opts?.force === true);
    },
    start(everyMs) {
      let timer: NodeJS.Timeout | undefined;
      let stopped = false;
      const schedule = () => {
        if (stopped) return;
        timer = setTimeout(
          () => {
            sweep()
              .catch((err: unknown) => log.error({ err }, "hibernation sweep failed"))
              .finally(schedule);
          },
          everyMs * (0.5 + Math.random()),
        );
        timer.unref();
      };
      schedule();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
    metrics: () => ({ ...metrics, wakeMs: [...metrics.wakeMs] }),
  };
}

/**
 * A waker that delegates to one set later: the wire is built before the sandbox provider exists
 * (index.ts). Until then (or without sandboxes configured) wakes fail as unavailable.
 */
export function createDeferredWaker(): SandboxWaker & { set(waker: SandboxWaker): void } {
  let target: SandboxWaker | undefined;
  return {
    set(waker) {
      target = waker;
    },
    wake(t, context) {
      if (!target) {
        return Promise.reject(
          new SandboxWakeError(
            "sandbox_unavailable",
            "sandboxes are not configured on this server",
          ),
        );
      }
      return target.wake(t, context);
    },
  };
}
