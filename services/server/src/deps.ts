import { createHash, timingSafeEqual } from "node:crypto";
import { accounts, createDb, installRoles, users, type KobeDatabase } from "@kobe/db";
import { AuditAnchorLogger } from "./audit/anchor.js";
import { AuthAttemptAudit } from "./audit/attempts.js";
import { recordAudit } from "./audit/record.js";
import { createAuth, type KobeAuth } from "./auth/auth.js";
import { createRunEventHub, type HubOptions, type RunEventHub } from "./event-stream/hub.js";
import { createStreamReader, type StreamReader } from "./event-stream/read.js";
import { STREAM_DEFAULTS, type StreamTimings } from "./event-stream/stream.js";
import { DEFAULT_VERSION_LIMITS } from "./agents/versions.js";
import type { Mailer } from "./mail/mailer.js";
import type { RateLimitRule } from "./rate-limit.js";
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
  /** Logs and attests the audit chain head (started by index.ts, not in tests). */
  readonly auditAnchor: AuditAnchorLogger;
  /** Aggregated audit of unauthenticated auth attempts (flushed on close). */
  readonly authAttempts: AuthAttemptAudit;
  /** Downstream steps of deactivation/reactivation (sandboxes, grants, schedules, audit). */
  readonly lifecycle: UserLifecycle;
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
  const auth = createAuth({
    attempts: authAttempts,
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

  return {
    database,
    auth,
    publicUrl: new URL(options.publicUrl).origin,
    eventStream: { hub, reader, timings: { ...STREAM_DEFAULTS, ...options.eventStream?.timings } },
    mailer: options.mailer,
    agentLimits: { ...AGENT_LIMIT_DEFAULTS, ...options.agents },
    authAttempts,
    auditAnchor: new AuditAnchorLogger(database.db, options.authSecret),
    lifecycle: new UserLifecycle(),
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
      await hub.close();
      await reader.close();
      options.mailer.close();
      await authAttempts.stop();
      await database.close();
    },
  };
}
