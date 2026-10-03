import { createHash, timingSafeEqual } from "node:crypto";
import { accounts, createDb, installRoles, users, type KobeDatabase } from "@kobe/db";
import { AuditAnchorLogger } from "./audit/anchor.js";
import { AuthAttemptAudit } from "./audit/attempts.js";
import { recordAudit } from "./audit/record.js";
import { BackgroundTasks } from "./background.js";
import { createAuth, type KobeAuth } from "./auth/auth.js";
import { createRunEventHub, type HubOptions, type RunEventHub } from "./event-stream/hub.js";
import { createStreamReader, type StreamReader } from "./event-stream/read.js";
import { STREAM_DEFAULTS, type StreamTimings } from "./event-stream/stream.js";
import type { Mailer } from "./mail/mailer.js";
import {
  createDbRunContextSource,
  createSandboxWire,
  type SandboxWire,
  type SandboxWireOptions,
} from "./sandbox-wire/index.js";
import {
  DbRunOrchestrator,
  type RunOrchestratorOptions,
  type ServerRunOrchestrator,
} from "./runs/index.js";
import { UserLifecycle } from "./users/lifecycle.js";

export interface ServerDepsOptions {
  readonly databaseUrl: string;
  readonly publicUrl: string;
  readonly authSecret: string;
  /** One-time secret proving possession of the install for first-run setup. */
  readonly setupToken: string;
  readonly trustedProxies: readonly string[];
  /** Kobe Event Stream tuning (tests shorten the timers). */
  readonly eventStream?: {
    readonly hub?: Omit<HubOptions, "connectionString">;
    readonly timings?: Partial<StreamTimings>;
    /** Connections of the stream read pool (default STREAM_POOL_MAX). */
    readonly poolMax?: number;
  };
  /** Outgoing email (invitations, password resets, notifications). */
  readonly mailer: Mailer;
  /** Off-request-path work; tests pass their own to wait on it (default: a new tracker). */
  readonly background?: BackgroundTasks;
  /** Sandbox wire seams and tuning (KOBE-24): approvals, UI, run hooks, wake, policy context. */
  readonly sandboxWire?: Partial<Omit<SandboxWireOptions, "db" | "databaseUrl">>;
  /** Run orchestrator seams and tuning (KOBE-30): agent resolution, budgets, timings. */
  readonly runs?: Partial<Omit<RunOrchestratorOptions, "db" | "router">>;
}

export interface NewUser {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

export interface ServerDeps {
  readonly database: KobeDatabase;
  readonly auth: KobeAuth;
  readonly publicUrl: string;
  /** Kobe Event Stream fan-out (one LISTEN connection per process) and SSE timings (KOBE-31). */
  readonly eventStream: {
    readonly hub: RunEventHub;
    readonly reader: StreamReader;
    readonly timings: StreamTimings;
  };
  readonly mailer: Mailer;
  /** Off-request-path work (emails, attempt audit); drained by close(). */
  readonly background: BackgroundTasks;
  /** Logs and attests the audit chain head (started by index.ts, not in tests). */
  readonly auditAnchor: AuditAnchorLogger;
  /** Aggregated audit of unauthenticated auth attempts (flushed on close). */
  readonly authAttempts: AuthAttemptAudit;
  /** Downstream steps of deactivation/reactivation (sandboxes, grants, schedules, audit). */
  readonly lifecycle: UserLifecycle;
  /**
   * Sandbox connection registry and routing (KOBE-24): `router` sends commands to any (user, team)
   * sandbox from any replica; `attach` serves the WebSocket on the sandbox listener only.
   */
  readonly sandboxWire: SandboxWire;
  /**
   * Run orchestrator (KOBE-30): messages, queue, steer, stop, retry. Reaches sandboxes through
   * `sandboxWire.router`; the wire calls back when it ends a run.
   */
  readonly runs: ServerRunOrchestrator;
  /** Creates an email+password user (and optional install role) atomically, without sign-up. */
  createUserWithPassword(
    input: NewUser,
    options?: { installRole?: "owner" | "admin"; recordSetup?: boolean },
  ): Promise<{ id: string }>;
  /** Deletes every session of a user; the next request with any of their cookies is rejected. */
  revokeAllSessions(userId: string): Promise<void>;
  /** Constant-time comparison against the install's setup token. */
  isSetupToken(candidate: unknown): boolean;
  close(): Promise<void>;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export function createServerDeps(options: ServerDepsOptions): ServerDeps {
  const database = createDb(options.databaseUrl);
  const authAttempts = new AuthAttemptAudit(database.db);
  authAttempts.start();
  const background = options.background ?? new BackgroundTasks();
  const auth = createAuth({
    attempts: authAttempts,
    background,
    db: database.db,
    publicUrl: options.publicUrl,
    secret: options.authSecret,
    trustedProxies: options.trustedProxies,
    mailer: options.mailer,
  });
  const setupDigest = digest(options.setupToken);
  const hub = createRunEventHub({
    ...options.eventStream?.hub,
    connectionString: options.databaseUrl,
  });
  const reader = createStreamReader({
    connectionString: options.databaseUrl,
    ...(options.eventStream?.poolMax ? { max: options.eventStream.poolMax } : {}),
  });

  // The wire is created first (the orchestrator needs its router); its run-ended hook reaches the
  // orchestrator through this late binding.
  const late: { runs?: ServerRunOrchestrator } = {};
  const extraHooks = options.sandboxWire?.hooks;
  const sandboxWire = createSandboxWire({
    ...options.sandboxWire,
    runContext: options.sandboxWire?.runContext ?? createDbRunContextSource(),
    hooks: {
      async onRunEnded(event) {
        try {
          await extraHooks?.onRunEnded?.(event);
        } finally {
          await late.runs?.onRunEnded(event);
        }
      },
    },
    db: database.db,
    databaseUrl: options.databaseUrl,
  });
  const runs: ServerRunOrchestrator = new DbRunOrchestrator({
    ...options.runs,
    db: database.db,
    router: sandboxWire.router,
  });
  late.runs = runs;
  const lifecycle = new UserLifecycle();
  // A deactivated user's sandboxes lose their connections on every replica at once (KOBE-13).
  lifecycle.on("deactivated", {
    name: "sandbox-wire",
    run: (userId) => sandboxWire.revalidateUser(userId),
  });

  return {
    database,
    auth,
    publicUrl: new URL(options.publicUrl).origin,
    eventStream: { hub, reader, timings: { ...STREAM_DEFAULTS, ...options.eventStream?.timings } },
    mailer: options.mailer,
    background,
    authAttempts,
    auditAnchor: new AuditAnchorLogger(database.db, options.authSecret),
    lifecycle,
    sandboxWire,
    runs,
    async createUserWithPassword({ email, name, password }, { installRole, recordSetup } = {}) {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(password);
      // One transaction: a failure can't leave a half-created user (e.g. an Owner without a role).
      return database.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: email.toLowerCase(), name, emailVerified: true })
          .returning({ id: users.id });
        if (!user) throw new Error("user insert returned no row");
        await tx.insert(accounts).values({
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: hash,
        });
        if (installRole)
          await tx.insert(installRoles).values({ userId: user.id, role: installRole });
        if (recordSetup) {
          await recordAudit(tx, {
            action: "identity.setup.completed",
            actor: { kind: "user", id: user.id },
            target: { ownerUserId: user.id },
          });
        }
        return { id: user.id };
      });
    },
    async revokeAllSessions(userId) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(userId);
    },
    isSetupToken(candidate) {
      return typeof candidate === "string" && timingSafeEqual(digest(candidate), setupDigest);
    },
    async close() {
      runs.close();
      await sandboxWire.close();
      // In-flight emails and audit writes finish before the mailer and database go away.
      await background.idle();
      await hub.close();
      await reader.close();
      options.mailer.close();
      await authAttempts.stop();
      await database.close();
    },
  };
}
