import type { KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import type { ReconcileLock } from "../sandbox/reconcile-lock.js";
import {
  liveSandboxTeams,
  liveSandboxUsers,
  offboardSandbox,
  type OffboardOutcome,
} from "./destroy.js";
import { listOffboarded, startExport, type ExportStart, type OffboardedMember } from "./export.js";
import { departedNotOffboarded, dueForPurge, purgeDeparted } from "./purge.js";
import { reinstateReturning } from "./reinstate.js";
import type { Departed, OffboardProvider, OffboardTrigger, OffboardingContext } from "./types.js";

export { RETAIN_DAYS, type OffboardTrigger } from "./types.js";
export type { ExportStart, OffboardedMember, OffboardOutcome };

export const OFFBOARDING_SWEEP_LOCK = "kobe.offboarding-sweep";
/** Departures and purges handled per sweep (the next sweep goes on). */
const SWEEP_LIMIT = 200;

export interface SweepSummary {
  /** Sandboxes of departed members found still alive and destroyed now. */
  readonly offboarded: number;
  /** Volumes and workspace copies deleted after their 30 days. */
  readonly purged: number;
  /** Past retention but under a legal hold (kept). */
  readonly held: number;
  readonly failed: number;
}

export interface Offboarding {
  /** The sandbox provider exists only after the server deps (index.ts sets it). */
  setProvider(provider: OffboardProvider | undefined): void;
  /** Member removed from a team: destroy their sandbox there, keep the volume 30 days. */
  offboardMember(
    teamId: string,
    userId: string,
    trigger: OffboardTrigger,
  ): Promise<OffboardOutcome>;
  /** Account deactivated: every team's sandbox of the user. Throws if any team failed. */
  offboardUser(userId: string, trigger: OffboardTrigger): Promise<void>;
  /** Team removed: every member's sandbox. Throws if any failed. */
  offboardTeam(teamId: string): Promise<number>;
  /** A returning member's wake: drops the old retained volume. False: refuse (legal hold). */
  reinstate(target: Departed): Promise<boolean>;
  list(teamId: string): Promise<OffboardedMember[]>;
  startExport(teamId: string, userId: string): Promise<ExportStart>;
  /** One pass: catch departures that were missed, then delete what is past its 30 days. */
  sweep(): Promise<SweepSummary>;
  /** Sweeps now and every `everyMs`, one replica at a time under `lock`; returns a stop function. */
  start(options: { readonly lock: ReconcileLock; readonly everyMs: number }): () => void;
}

export interface OffboardingOptions {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly log: Pick<Logger, "info" | "warn" | "error" | "debug">;
}

async function settle<T>(items: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  const results = await Promise.allSettled(items.map(run));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((f) => f.reason),
      `${failed.length} of ${items.length} offboardings failed`,
    );
  }
}

export function createOffboarding(options: OffboardingOptions): Offboarding {
  let provider: OffboardProvider | undefined;
  const ctx: OffboardingContext = {
    db: options.db,
    blobs: options.blobs,
    log: options.log,
    provider: () => provider,
  };
  const log = options.log;

  const sweep = async (): Promise<SweepSummary> => {
    let offboarded = 0;
    let purged = 0;
    let held = 0;
    let failed = 0;
    for (const departed of await departedNotOffboarded(ctx, SWEEP_LIMIT)) {
      try {
        if ((await offboardSandbox(ctx, departed, "reconciled")) === "offboarded") offboarded += 1;
      } catch (err) {
        failed += 1;
        log.error(
          { err, team_id: departed.teamId, user_id: departed.userId },
          "offboarding failed",
        );
      }
    }
    for (const due of await dueForPurge(ctx, SWEEP_LIMIT)) {
      try {
        const outcome = await purgeDeparted(ctx, due);
        if (outcome === "deleted") purged += 1;
        if (outcome === "held") held += 1;
      } catch (err) {
        failed += 1;
        log.error({ err, team_id: due.teamId, user_id: due.userId }, "volume purge failed");
      }
    }
    return { offboarded, purged, held, failed };
  };

  return {
    setProvider(next) {
      provider = next;
    },
    offboardMember: (teamId, userId, trigger) => offboardSandbox(ctx, { teamId, userId }, trigger),
    async offboardUser(userId, trigger) {
      const teamIds = await liveSandboxTeams(ctx, userId);
      await settle(teamIds, (teamId) => offboardSandbox(ctx, { teamId, userId }, trigger));
    },
    async offboardTeam(teamId) {
      const userIds = await liveSandboxUsers(ctx, teamId);
      await settle(userIds, (userId) => offboardSandbox(ctx, { teamId, userId }, "team_removed"));
      return userIds.length;
    },
    reinstate: (target) => reinstateReturning(ctx, target),
    list: (teamId) => listOffboarded(ctx, teamId),
    startExport: (teamId, userId) => startExport(ctx, teamId, userId),
    sweep,
    start({ lock, everyMs }) {
      let running = false;
      const run = () => {
        if (running) return;
        running = true;
        lock
          .runExclusive(sweep)
          .then((outcome) => {
            if (!outcome.ran) return log.debug("offboarding sweep: another replica runs it");
            const s = outcome.value;
            if (s.offboarded + s.purged + s.held + s.failed > 0) log.info(s, "offboarding sweep");
          })
          .catch((err: unknown) => log.warn({ err }, "offboarding sweep failed"))
          .finally(() => {
            running = false;
          });
      };
      run();
      const timer = setInterval(run, everyMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
