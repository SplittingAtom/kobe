import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { PolicyEngine, ToolRegistry } from "@kobe/protocol";
import { SYSTEM_ACTOR, eq, getMembership, users, withTeam, type KobeDb } from "@kobe/db";
import { logger as rootLogger } from "../logger.js";
import { recordAudit } from "../audit/record.js";
import { createPolicyEngine } from "../policy/engine.js";
import { createToolRegistry } from "../policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "../policy/rule-store.js";
import { createSandboxBus, type BusHint } from "./bus.js";
import { SandboxConnection } from "./connection.js";
import { WIRE_DEFAULTS, type WireTuning } from "./constants.js";
import { newMetrics, type LeaseViolation, type WireContext, type WireMetrics } from "./context.js";
import { attachSandboxGateway } from "./gateway.js";
import { DEFAULT_RUN_CONTEXT, DENY_APPROVALS } from "./policy-check.js";
import { ConnectionRegistry } from "./registry.js";
import { CommandRouter } from "./router.js";
import { sweepOnce, type SweepResult } from "./sweeper.js";
import type {
  ApprovalBroker,
  RunLifecycleHooks,
  RunPolicyContextSource,
  SandboxLiveness,
  SandboxRouter,
  SandboxTarget,
  SandboxWaker,
  SessionTokenVerifier,
  UiBroker,
} from "./types.js";

export interface SandboxWireOptions {
  readonly db: KobeDb;
  /** App-role URL for the LISTEN connection (direct or session-mode pooler). */
  readonly databaseUrl: string;
  readonly engine?: PolicyEngine;
  readonly tools?: ToolRegistry;
  readonly approvals?: ApprovalBroker;
  readonly ui?: UiBroker;
  readonly hooks?: RunLifecycleHooks;
  readonly runContext?: RunPolicyContextSource;
  readonly waker?: SandboxWaker;
  readonly tuning?: Partial<WireTuning>;
  /** Connections one replica accepts. */
  readonly maxConnections?: number;
  /** Run the lost-sandbox sweep on a timer (default true; tests call `sweep()`). */
  readonly sweep?: boolean;
}

export interface SandboxWire {
  readonly replicaId: string;
  readonly router: SandboxRouter;
  /**
   * Serves `/v1/sandbox/connect` on `server` — the sandbox listener (KOBE-22 port 8081), never the
   * user API. `verify` and `liveness` come from the sandbox provider. Returns a detach function.
   */
  attach(
    server: Server,
    auth: { readonly verify: SessionTokenVerifier; readonly liveness: SandboxLiveness },
  ): () => void;
  /** Closes every connection of a user on every replica (deactivation, KOBE-13 lifecycle hook). */
  disconnectUser(userId: string): Promise<void>;
  /** One lost-sandbox sweep + command expiry now. */
  sweep(): Promise<SweepResult>;
  metrics(): WireMetrics & { readonly connections: number; readonly waiting: number };
  close(): Promise<void>;
}

/** Kobe v1 has no UI for Pi extension dialogs: dialogs are cancelled, notifications ignored. */
export const CANCEL_DIALOGS: UiBroker = {
  handle({ request }) {
    const dialog = ["select", "confirm", "input", "editor"].includes(request.method);
    return Promise.resolve(
      dialog ? { type: "extension_ui_response", id: request.id, cancelled: true } : undefined,
    );
  },
};

const NO_WAKE: SandboxWaker = { wake: () => Promise.resolve() };
const NOT_LIVE: SandboxLiveness = { isLive: () => Promise.resolve(false) };
const VIOLATION_AUDIT_EVERY_MS = 5 * 60_000;

export function createSandboxWire(options: SandboxWireOptions): SandboxWire {
  const replicaId = randomUUID();
  const log = rootLogger.child({ component: "sandbox-wire", replica: replicaId.slice(0, 8) });
  const tuning: WireTuning = { ...WIRE_DEFAULTS, ...options.tuning };
  const db = options.db;
  const metrics = newMetrics();
  const tools = options.tools ?? createToolRegistry();
  const engine =
    options.engine ??
    createPolicyEngine({
      rules: createDbRuleSource(db),
      settings: createDbSettingsSource(db),
      registry: tools,
      onError: (err) => log.error({ err }, "policy engine error (denied)"),
    });
  let liveness: SandboxLiveness = NOT_LIVE;
  const violationAudits = new Map<string, number>();

  const onHint = (hint: BusHint) => {
    switch (hint.kind) {
      case "cmd":
        registry.get(hint.id)?.pokeCommands();
        return;
      case "res":
        router.onResult(hint.id);
        return;
      case "kick":
        registry.get(hint.id)?.close("replaced", "replaced by a newer connection");
        return;
      case "user":
        for (const c of registry.forUser(hint.id)) c.close("unauthorized", "account deactivated");
        return;
    }
  };
  const bus = createSandboxBus({
    connectionString: options.databaseUrl,
    onHint,
    onResync: () => {
      router.resync();
      for (const c of registry.all()) c.pokeCommands();
    },
    reconnectMinMs: tuning.reconnectMinMs,
    reconnectMaxMs: tuning.reconnectMaxMs,
  });
  // Hints and resyncs only arrive after bus.start() below, when both exist.
  const registry = new ConnectionRegistry(db, bus, replicaId);
  const router = new CommandRouter({
    db,
    bus,
    tuning,
    replicaId,
    registry,
    waker: options.waker ?? NO_WAKE,
    log,
  });
  bus.start();

  const principalAllowed = async (target: SandboxTarget): Promise<boolean> => {
    const [account] = await db
      .select({ deactivatedAt: users.deactivatedAt })
      .from(users)
      .where(eq(users.id, target.userId));
    if (!account || account.deactivatedAt !== null) return false;
    return (await getMembership(db, target.teamId, target.userId)) !== null;
  };

  const hooks = options.hooks ?? {};
  const ctx: WireContext = {
    db,
    bus,
    tuning,
    replicaId,
    tools,
    policy: {
      db,
      engine,
      registry: tools,
      approvals: options.approvals ?? DENY_APPROVALS,
      runContext: options.runContext ?? DEFAULT_RUN_CONTEXT,
    },
    ui: options.ui ?? CANCEL_DIALOGS,
    hooks,
    get liveness() {
      return liveness;
    },
    metrics,
    log,
    auditViolation(target, sandboxId, violation: LeaseViolation, frameType) {
      const key = `${target.teamId}:${target.userId}:${violation}`;
      const last = violationAudits.get(key) ?? 0;
      if (Date.now() - last < VIOLATION_AUDIT_EVERY_MS) return;
      violationAudits.set(key, Date.now());
      void withTeam(db, target.teamId, (tx) =>
        recordAudit(tx, {
          action: "sandbox.lease_violation",
          actor: SYSTEM_ACTOR,
          teamId: target.teamId,
          target: { sandboxId, userId: target.userId, violation, frameType },
        }),
      ).catch((err: unknown) => log.error({ err }, "could not audit a lease violation"));
    },
    localResult: (id) => router.onResult(id),
    runEnded(event) {
      void Promise.resolve()
        .then(() => hooks.onRunEnded?.(event))
        .catch((err: unknown) => log.error({ err, run_id: event.runId }, "run-ended hook failed"));
    },
    principalAllowed,
  };

  const sweep = async (): Promise<SweepResult> => {
    const result = await sweepOnce(db, bus, tuning, log);
    for (const run of result.interrupted) {
      metrics.runsInterrupted += 1;
      ctx.runEnded({ ...run, status: "interrupted" });
    }
    if (result.interrupted.length > 0) {
      log.warn({ runs: result.interrupted.length }, "interrupted runs of lost sandboxes");
    }
    return result;
  };
  let sweepTimer: NodeJS.Timeout | undefined;
  const scheduleSweep = () => {
    sweepTimer = setTimeout(
      () => {
        sweep()
          .catch((err: unknown) => log.error({ err }, "sandbox sweep failed"))
          .finally(scheduleSweep);
      },
      tuning.sweepMs * (0.5 + Math.random()),
    );
    sweepTimer.unref();
  };
  if (options.sweep !== false) scheduleSweep();

  const detachers: (() => void)[] = [];
  let sockets = 0;
  let closed = false;

  return {
    replicaId,
    router,
    attach(server, auth) {
      liveness = auth.liveness;
      const detach = attachSandboxGateway(server, {
        verify: auth.verify,
        liveness: auth.liveness,
        principalAllowed,
        log,
        maxConnections: options.maxConnections ?? 5_000,
        connections: () => sockets,
        onRefused: (status, reason) => {
          metrics.upgradesRefused += 1;
          log.info({ status, reason }, "sandbox upgrade refused");
        },
        accept: (socket, claims) => {
          if (closed) {
            socket.close(1001, "server shutting down");
            return;
          }
          sockets += 1;
          socket.once("close", () => {
            sockets -= 1;
          });
          new SandboxConnection(
            ctx,
            socket,
            { sandboxId: claims.sub, teamId: claims.team_id, userId: claims.user_id },
            registry,
          ).start();
        },
      });
      detachers.push(detach);
      return detach;
    },
    async disconnectUser(userId) {
      for (const c of registry.forUser(userId)) c.close("unauthorized", "account deactivated");
      await bus.notify(db, { kind: "user", id: userId });
    },
    sweep,
    metrics() {
      return { ...metrics, connections: registry.size, waiting: router.waiting };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (sweepTimer) clearTimeout(sweepTimer);
      for (const detach of detachers) detach();
      router.close();
      // Sandboxes reconnect to another replica and resume from their durable cursors.
      for (const c of registry.all()) c.close("internal", "server shutting down");
      await bus.close();
    },
  };
}
