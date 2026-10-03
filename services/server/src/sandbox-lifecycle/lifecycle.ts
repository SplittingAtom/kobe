import { SYSTEM_ACTOR, eq, getMembership, teams, users, withTeam, type KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import { IsolationRuntimeMissingError } from "../isolation/gate.js";
import { logger as rootLogger } from "../logger.js";
import type { TeamRef } from "../sandbox/manifests.js";
import { workspacePvcName, type SandboxProvider } from "../sandbox/provider.js";
import { notifyHintInTx } from "../sandbox-wire/bus.js";
import { SandboxWakeError, type SandboxTarget, type SandboxWaker } from "../sandbox-wire/types.js";
import { resolveIdleMinutes, TEAM_IDLE_MINUTES } from "./idle.js";
import {
  beginWake,
  idleCandidates,
  lockIfIdle,
  markHibernated,
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

export type LifecycleProvider = Pick<SandboxProvider, "wakeSandbox" | "hibernateSandbox">;

export interface LifecycleOptions {
  readonly db: KobeDb;
  readonly provider: LifecycleProvider;
  /** Install default idle minutes (Helm `sandbox.hibernation.idleMinutes`, D14: 15). */
  readonly idleMinutes: number;
  /** Most sandboxes one sweep hibernates per team (spreads Kubernetes writes). */
  readonly batchPerTeam?: number;
  readonly log?: Logger;
}

export interface LifecycleMetrics {
  hibernated: number;
  woken: number;
  wakeFailures: number;
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

export function createSandboxLifecycle(options: LifecycleOptions): SandboxLifecycle {
  const { db, provider } = options;
  const log = options.log ?? rootLogger.child({ component: "sandbox-lifecycle" });
  const batch = options.batchPerTeam ?? 20;
  const metrics: LifecycleMetrics = { hibernated: 0, woken: 0, wakeFailures: 0, wakeMs: [] };
  const inflight = new Map<string, Promise<void>>();

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

  const wakeOnce = async (target: SandboxTarget): Promise<void> => {
    const started = Date.now();
    await assertAllowed(target);
    const team = await teamRef(target.teamId);
    const previous = await beginWake(db, target);
    if (previous === "destroyed") {
      throw new SandboxWakeError("sandbox_unavailable", "this sandbox was offboarded");
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
    await withTeam(db, target.teamId, async (tx) => {
      await recordSandboxIdentity(
        tx,
        target,
        handle.sandboxId,
        workspacePvcName(handle.sandboxName),
      );
      if (resumed) {
        await recordAudit(tx, {
          action: "sandbox.woken",
          actor: currentAuditContext()?.actor ?? SYSTEM_ACTOR,
          teamId: target.teamId,
          target: { sandboxId: handle.sandboxId, userId: target.userId },
        });
      }
    });
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
    wake(target) {
      const key = `${target.teamId}:${target.userId}`;
      const running = inflight.get(key);
      if (running) return running;
      const p = wakeOnce(target)
        .catch((err: unknown) => {
          metrics.wakeFailures += 1;
          throw err;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
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
      await provider.hibernateSandbox(team, target.userId, sandboxId);
      const connection = await markHibernated(tx, target);
      if (connection) await notifyHintInTx(tx, { kind: "hib", id: connection });
      await recordAudit(tx, {
        action: "sandbox.hibernated",
        actor: SYSTEM_ACTOR,
        teamId: target.teamId,
        target: { sandboxId, userId: target.userId, idleMinutes: force ? 0 : idleMinutes },
      });
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
    wake(t) {
      if (!target) {
        return Promise.reject(
          new SandboxWakeError(
            "sandbox_unavailable",
            "sandboxes are not configured on this server",
          ),
        );
      }
      return target.wake(t);
    },
  };
}
