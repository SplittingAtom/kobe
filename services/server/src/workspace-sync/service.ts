import { SYSTEM_ACTOR, type AuditActor, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { SandboxAuthenticator } from "./auth.js";
import { collectAll, collectWorkspace, type CollectOptions, type CollectResult } from "./gc.js";
import { sharedKey, type WorkspaceOwner } from "./keys.js";
import type { ObjectStore } from "./object-store.js";
import {
  limitsQuota,
  resolveLimits,
  withTeamStorage,
  type QuotaCheck,
  type WorkspaceLimits,
} from "./quota.js";
import { workspaceRoutes, type WorkspaceRoutesDeps } from "./routes.js";
import {
  currentEntry,
  deleteServerFile,
  putServerFile,
  type ServerFile,
  type ServerWriteArea,
  type StoredEntry,
} from "./store.js";

export interface WorkspaceSyncOptions {
  readonly db: KobeDb;
  readonly objects: ObjectStore;
  /** Object key prefix (KOBE_S3_PREFIX), "" or ending in "/". */
  readonly prefix: string;
  readonly limits: WorkspaceLimits;
  /** KOBE-53 seam: D26's per-team quota. Default: {@link limitsQuota}. */
  readonly quota?: QuotaCheck;
  /**
   * KOBE-185: when set, the default check also enforces the team storage quota (the same one
   * uploads use, with this install default) under the team's storage lock. Ignored with `quota`.
   */
  readonly teamStorageDefaultBytes?: number;
  readonly collect?: Partial<Omit<CollectOptions, "prefix">>;
  readonly log: Pick<Logger, "error" | "warn" | "info">;
  /** Overrides of the routes' database caps and timeouts (tests). */
  readonly dbLimits?: WorkspaceRoutesDeps["dbLimits"];
}

export const COLLECT_DEFAULTS = {
  // Long enough for a reader that resolved an entry to fetch it (downloads, shareFile).
  blobGraceMs: 15 * 60_000,
  tombstoneTtlMs: 7 * 24 * 60 * 60_000,
  batch: 500,
  budgetMs: 20_000,
} as const;

const KICK_EVERY_MS = 5 * 60_000;
const KICK_BUDGET_MS = 5_000;

export interface SharedFile {
  /** Durable object key (KOBE-54 stores it as `files.blob_ref`). Never sent to a sandbox. */
  readonly blobKey: string;
  readonly sharedId: string;
  readonly sha256: string;
  readonly size: number;
}

export interface WorkspaceSync {
  /** The sandbox-facing endpoints (mount at WORKSPACE_SYNC_PATH on the sandbox listener). */
  routes(authenticate: SandboxAuthenticator): ReturnType<typeof workspaceRoutes>;
  /** One collection pass now. */
  collect(): Promise<CollectResult>;
  /** Runs `collect` every `everyMs` (jittered); returns a stop function. */
  startCollector(everyMs: number): () => void;
  /**
   * Copies a live workspace file to a durable object of its own (`share_file`, KOBE-54), so the
   * download outlives the volume and the workspace copy. Runs in the caller's team transaction,
   * which also gets the `workspace.file_shared` audit row (last). Undefined: no such live file.
   */
  shareFile(
    tx: KobeTx,
    owner: WorkspaceOwner,
    path: string,
    actor?: AuditActor,
  ): Promise<SharedFile | undefined>;
  /**
   * A server write into a workspace (KOBE-53/54/57): `store.putServerFile` with this install's
   * key prefix (the object must be under the team's tree, and inside `users/` the user's own)
   * and row cap. In the caller's team transaction.
   */
  putServerFile(
    tx: KobeTx,
    owner: WorkspaceOwner,
    file: ServerFile,
    area: ServerWriteArea,
  ): Promise<StoredEntry>;
  deleteServerFile(
    tx: KobeTx,
    owner: WorkspaceOwner,
    path: string,
  ): Promise<StoredEntry | undefined>;
  readonly objects: ObjectStore;
  readonly prefix: string;
  /** This install's limits and quota check, for server writes that must honour them (KOBE-148). */
  readonly limits: WorkspaceLimits;
  readonly quota: QuotaCheck;
}

export function createWorkspaceSync(options: WorkspaceSyncOptions): WorkspaceSync {
  const { db, objects, prefix, limits, log } = options;
  const quota =
    options.quota ??
    (options.teamStorageDefaultBytes === undefined
      ? limitsQuota(limits)
      : withTeamStorage(limitsQuota(limits), options.teamStorageDefaultBytes));
  const collectOptions: CollectOptions = { ...COLLECT_DEFAULTS, ...options.collect, prefix };
  const collect = () => collectAll(db, objects, collectOptions, log);
  const maxRows = resolveLimits(limits).maxRows;
  const kicked = new Map<string, number>();
  let kicking = false;
  return {
    objects,
    prefix,
    limits,
    quota,
    putServerFile: (tx, owner, file, area) =>
      putServerFile(tx, owner, file, { prefix, area, maxRows }),
    deleteServerFile: (tx, owner, path) => deleteServerFile(tx, owner, path),
    routes: (authenticate) =>
      workspaceRoutes({
        db,
        objects,
        authenticate,
        prefix,
        limits,
        quota,
        log,
        ...(options.dbLimits ? { dbLimits: options.dbLimits } : {}),
        onQuotaPressure: (owner) => {
          // A workspace at its upload budget: collect it now (at most every 5 minutes) rather
          // than at the next hourly pass, so released content past its grace frees room.
          // One such collection per replica at a time (each holds a connection for its budget).
          const key = `${owner.teamId}:${owner.userId}`;
          const last = kicked.get(key) ?? 0;
          if (kicking || Date.now() - last < KICK_EVERY_MS) return;
          if (kicked.size > 10_000) kicked.clear();
          kicked.set(key, Date.now());
          kicking = true;
          void collectWorkspace(db, objects, owner, { ...collectOptions, budgetMs: KICK_BUDGET_MS })
            .catch((err: unknown) =>
              log.error({ err }, "workspace collection on quota pressure failed"),
            )
            .finally(() => {
              kicking = false;
            });
        },
      }),
    collect,
    startCollector(everyMs) {
      let timer: NodeJS.Timeout | undefined;
      let stopped = false;
      const schedule = () => {
        if (stopped) return;
        timer = setTimeout(
          () => {
            collect()
              .catch((err: unknown) => log.error({ err }, "workspace collection failed"))
              .finally(schedule);
          },
          everyMs * (0.5 + Math.random()),
        );
        timer.unref();
      };
      schedule();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
    async shareFile(tx, owner, path, actor = SYSTEM_ACTOR) {
      const entry = await currentEntry(tx, owner, path);
      if (!entry || entry.deleted || entry.blobKey === null || entry.sha256 === undefined) {
        return undefined;
      }
      const shared = sharedKey(prefix, owner);
      await objects.copy(entry.blobKey, shared.key);
      await recordAudit(tx, {
        action: "workspace.file_shared",
        actor,
        teamId: owner.teamId,
        target: { userId: owner.userId, sharedId: shared.id, bytes: entry.size },
      });
      return { blobKey: shared.key, sharedId: shared.id, sha256: entry.sha256, size: entry.size };
    },
  };
}
