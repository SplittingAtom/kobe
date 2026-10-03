import { createHash, timingSafeEqual } from "node:crypto";
import {
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  accounts,
  createDb,
  installRoles,
  users,
  type KobeDatabase,
} from "@kobe/db";
import {
  ApprovalService,
  type ApprovalKeyring,
  type ApprovalServiceOptions,
} from "./approvals/index.js";
import { AuditAnchorLogger } from "./audit/anchor.js";
import { AuthAttemptAudit } from "./audit/attempts.js";
import { recordAudit } from "./audit/record.js";
import { BackgroundTasks } from "./background.js";
import { createAuth, type KobeAuth } from "./auth/auth.js";
import { createRunEventHub, type HubOptions, type RunEventHub } from "./event-stream/hub.js";
import { createStreamReader, type StreamReader } from "./event-stream/read.js";
import { STREAM_DEFAULTS, type StreamTimings } from "./event-stream/stream.js";
import { DEFAULT_VERSION_LIMITS } from "./agents/versions.js";
import type { Mailer } from "./mail/mailer.js";
import type { RateLimitRule } from "./rate-limit.js";
import {
  createDbRunContextSource,
  createSandboxWire,
  type SandboxWire,
  type SandboxWireOptions,
} from "./sandbox-wire/index.js";
import {
  DbRunOrchestrator,
  PINNED_AGENTS,
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
  /** Agent version limits (KOBE-46); defaults in `AGENT_LIMIT_DEFAULTS`. */
  readonly agents?: Partial<AgentLimits>;
  /** Off-request-path work; tests pass their own to wait on it (default: a new tracker). */
  readonly background?: BackgroundTasks;
  /** Sandbox wire seams and tuning (KOBE-24): approvals, UI, run hooks, wake, policy context. */
  readonly sandboxWire?: Partial<Omit<SandboxWireOptions, "db" | "databaseUrl">>;
  /** Run orchestrator seams and tuning (KOBE-30): agent resolution, budgets, timings. */
  readonly runs?: Partial<Omit<RunOrchestratorOptions, "db" | "router">>;
  /**
   * Model gateway (KOBE-40): the secrets sealing provider API keys (current first) and the
   * operator's unsafe-endpoints switch; unset = not configured.
   */
  readonly models?: {
    readonly providerKeySecrets: readonly string[];
    readonly allowUnsafeEndpoints?: boolean;
  };
  /**
   * The install's approval HMAC key (KOBE-37, config `KOBE_APPROVAL_KEY`); without it, tool calls
   * that need approval are denied.
   */
  readonly approvalKeys?: ApprovalKeyring;
  /** Approval tuning (tests shorten the TTL and the poll). */
  readonly approvals?: Partial<Omit<ApprovalServiceOptions, "db" | "keys">>;
}

/** Limits on publishing agent versions (KOBE-46 review M3). */
export interface AgentLimits {
  /** Versions per agent (config `KOBE_AGENT_MAX_VERSIONS`). */
  readonly maxVersions: number;
  /** Publishes + rollbacks per user, across agents. */
  readonly publishRate: RateLimitRule;
}

export const AGENT_LIMIT_DEFAULTS: AgentLimits = {
  maxVersions: DEFAULT_VERSION_LIMITS.maxVersions,
  publishRate: { windowMs: 10 * 60_000, max: 30 },
};

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
  readonly agentLimits: AgentLimits;
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
  /** Model gateway admin (KOBE-40): seals provider API keys; undefined when not configured. */
  readonly models:
    { readonly providerKeys: SecretBox; readonly allowUnsafeEndpoints: boolean } | undefined;
  /**
   * Approvals (KOBE-37, D29): the wire's broker, `POST /v1/approvals/{id}`, the TTL sweep, and the
   * signed-approval verifier the MCP proxy (KOBE-58) calls.
   */
  readonly approvals: ApprovalService;
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

  const approvals = new ApprovalService({
    ...(options.sandboxWire?.tuning?.runMaxEvents === undefined
      ? {}
      : { runMaxEvents: options.sandboxWire.tuning.runMaxEvents }),
    ...options.approvals,
    db: database.db,
    ...(options.approvalKeys ? { keys: options.approvalKeys } : {}),
  });
  // The wire is created first (the orchestrator needs its router); its run-ended hook reaches the
  // orchestrator through this late binding.
  const late: { runs?: ServerRunOrchestrator } = {};
  const extraHooks = options.sandboxWire?.hooks;
  const sandboxWire = createSandboxWire({
    ...options.sandboxWire,
    approvals: options.sandboxWire?.approvals ?? approvals.broker,
    background,
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
    agents: options.runs?.agents ?? PINNED_AGENTS,
    db: database.db,
    router: sandboxWire.router,
  });
  late.runs = runs;
  approvals.bind({
    router: sandboxWire.router,
    onRunEnded: (event) => runs.onRunEnded(event),
  });
  const lifecycle = new UserLifecycle();
  // A deactivated user's sandboxes lose their connections on every replica at once (KOBE-13).
  lifecycle.on("deactivated", {
    name: "sandbox-wire",
    run: (userId) => sandboxWire.revalidateUser(userId),
  });

  return {
    database,
    models: options.models
      ? {
          providerKeys: new SecretBox(options.models.providerKeySecrets, PROVIDER_KEY_PURPOSE),
          allowUnsafeEndpoints: options.models.allowUnsafeEndpoints ?? false,
        }
      : undefined,
    auth,
    publicUrl: new URL(options.publicUrl).origin,
    eventStream: { hub, reader, timings: { ...STREAM_DEFAULTS, ...options.eventStream?.timings } },
    mailer: options.mailer,
    agentLimits: { ...AGENT_LIMIT_DEFAULTS, ...options.agents },
    background,
    authAttempts,
    auditAnchor: new AuditAnchorLogger(database.db, options.authSecret),
    lifecycle,
    sandboxWire,
    runs,
    approvals,
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
      approvals.stop();
      runs.close();
      await sandboxWire.close();
      await approvals.broker.close();
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
