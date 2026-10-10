import type { ForwardDestination } from "./audit/forward/types.js";
import { DEFAULT_TIMEOUT_MS } from "./connectors/oauth/http.js";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  headerBox,
  type Envelope,
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
import type { ModelDiscovery } from "./models/discovery.js";
import {
  createDbRunContextSource,
  createSandboxWire,
  type SandboxWire,
  type SandboxWireOptions,
} from "./sandbox-wire/index.js";
import { createWebSearchService } from "./web-search/service.js";
import {
  DbRunOrchestrator,
  PINNED_AGENTS,
  type RunOrchestratorOptions,
  type ServerRunOrchestrator,
} from "./runs/index.js";
import type { RunAgentResolver } from "./runs/seams.js";
import { createOffboarding, type Offboarding } from "./offboarding/index.js";
import { UserLifecycle } from "./users/lifecycle.js";
import { approvalVerifierForMcp } from "./mcp/approvals.js";
import { createDbMcpCatalog } from "./mcp/catalog.js";
import {
  DEFAULT_ALLOWED_PORTS,
  resolveAll,
  type ConnectorUrlPolicy,
} from "./connectors/url-policy.js";
import { NO_PROBE, type ConnectorProbe } from "./connectors/probe.js";
import { createMcpService, type McpService } from "./mcp/service.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createToolRegistry } from "./policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { logger } from "./logger.js";
import { BudgetMonitor } from "./budgets/monitor.js";
import { DB_RUN_BUDGET_GATE } from "./budgets/run-gate.js";
import type { BlobStore } from "./retention/blobs.js";
import type { UploadSettings } from "./uploads/settings.js";

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
  /** SIEM destinations configured by Helm values (KOBE-19); the admin health view lists them. */
  readonly auditForwardingDestinations?: readonly ForwardDestination[];
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
  /** Where registered connectors may point (KOBE-100); default: https, port 443, public addresses. */
  readonly connectors?: Partial<ConnectorUrlPolicy>;
  /** Probes a registered connector's tools through the MCP proxy (KOBE-101); unset = cannot pin. */
  readonly connectorProbe?: ConnectorProbe;
  /** MCP proxy re-check seams (KOBE-58). */
  readonly mcp?: { readonly now?: () => Date };
  /**
   * Model gateway (KOBE-40): the secrets sealing provider API keys (current first) and the
   * operator's unsafe-endpoints switch; unset = not configured.
   */
  readonly models?: {
    readonly providerKeySecrets: readonly string[];
    readonly allowUnsafeEndpoints?: boolean;
    /** Bifrost's model listing for the catalog editor (KOBE-44); unset: no model picker. */
    readonly discovery?: ModelDiscovery;
  };
  /**
   * The install's approval HMAC key (KOBE-37, config `KOBE_APPROVAL_KEY`); without it, tool calls
   * that need approval are denied.
   */
  readonly approvalKeys?: ApprovalKeyring;
  /** Approval tuning (tests shorten the TTL and the poll). */
  readonly approvals?: Partial<Omit<ApprovalServiceOptions, "db" | "keys">>;
  /**
   * Header injection (KOBE-39, config `KOBE_EGRESS_HEADER_SECRET`): the secrets sealing injected
   * header values (current first); unset = header injection off.
   */
  readonly egressHeaderSecrets?: readonly string[];
  /** Install envelope (KOBE-107, `KOBE_ENVELOPE_KEY`) for per-record secrets; unset = off. */
  readonly envelope?: Envelope;
  /**
   * Object storage (`s3.*`, KOBE-27) for thread blobs: export reads offloaded entries, retention
   * deletes released keys (KOBE-18). Unset: nothing is read or deleted from a bucket.
   */
  readonly blobs?: BlobStore;
  /** Upload limits and the default team storage quota (KOBE-143); unset: the contract defaults. */
  readonly uploads?: UploadSettings;
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
  /** Destinations audit events are forwarded to (empty: forwarding off). */
  readonly auditForwardingDestinations: readonly ForwardDestination[];
  /** Aggregated audit of unauthenticated auth attempts (flushed on close). */
  readonly authAttempts: AuthAttemptAudit;
  /** Downstream steps of deactivation/reactivation (sandboxes, grants, schedules, audit). */
  readonly lifecycle: UserLifecycle;
  /**
   * Offboarding (KOBE-28, D12): destroys a departed member's sandbox, retains the volume 30 days,
   * exports it for team admins and deletes it afterwards. The sandbox provider is set later.
   */
  readonly offboarding: Offboarding;
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
  /** The run orchestrator's agent resolver (KOBE-44: the thread API asks it for the agent's model pin). */
  readonly runAgents: RunAgentResolver;
  /** Model gateway admin (KOBE-40): seals provider API keys; undefined when not configured. */
  readonly models:
    | {
        readonly providerKeys: SecretBox;
        readonly allowUnsafeEndpoints: boolean;
        readonly discovery: ModelDiscovery | undefined;
      }
    | undefined;
  /**
   * The MCP proxy's policy re-check (KOBE-58): exposed tools and a decision per call, served on
   * the internal listener only (`routes/internal.ts`).
   */
  readonly mcp: McpService;
  /** The address policy registered connector URLs must pass (KOBE-100). */
  readonly connectorUrlPolicy: ConnectorUrlPolicy;
  /** Fetches a connector's live `tools/list` through the MCP proxy, to pin it (KOBE-101). */
  readonly connectorProbe: ConnectorProbe;
  /**
   * Approvals (KOBE-37, D29): the wire's broker, `POST /v1/approvals/{id}`, the TTL sweep, and the
   * signed-approval verifier the MCP proxy (KOBE-58) calls.
   */
  readonly approvals: ApprovalService;
  /** Seals team-injected egress header values (KOBE-39); undefined when not configured. */
  readonly egressHeaders: SecretBox | undefined;
  /** Envelope encryption for connector credentials and other per-record secrets (KOBE-107). */
  readonly envelope: Envelope | undefined;
  /**
   * Budgets (KOBE-42, D30): watches spend, records and emails warnings, budget-stops runs.
   * `index.ts` starts it (LISTEN + sweep); tests call `evaluate()` / `sweep()` directly.
   */
  readonly budgets: BudgetMonitor;
  /** Object storage for thread blobs (KOBE-18 export and retention); undefined when not set. */
  readonly blobs: BlobStore | undefined;
  /** Upload limits (KOBE-143); undefined: the contract defaults. */
  readonly uploads: UploadSettings | undefined;
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
  // One policy engine for both enforcement points (D29): the sandbox's policy.check and the MCP
  // proxy's re-check. MCP tools resolve from the pinned connector snapshots (KOBE-58 catalog).
  const mcpCatalog = createDbMcpCatalog(database.db);
  const toolRegistry = createToolRegistry(mcpCatalog);
  const policySources = {
    rules: createDbRuleSource(database.db),
    settings: createDbSettingsSource(database.db),
    registry: toolRegistry,
    connectors: mcpCatalog,
    onError: (err: unknown) => logger.error({ err }, "policy engine error (denied)"),
  };
  const policyEngine = createPolicyEngine(policySources);
  const runContext = options.sandboxWire?.runContext ?? createDbRunContextSource();
  const sandboxWire = createSandboxWire({
    tools: toolRegistry,
    engine: policyEngine,
    ...options.sandboxWire,
    approvals: options.sandboxWire?.approvals ?? approvals.broker,
    approvalVerifier: options.sandboxWire?.approvalVerifier ?? approvals.verifier,
    background,
    runContext,
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(options.uploads ? { uploads: options.uploads } : {}),
    webSearch:
      options.sandboxWire?.webSearch ??
      createWebSearchService({ db: database.db, envelope: options.envelope }),
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
  const runAgents = options.runs?.agents ?? PINNED_AGENTS;
  const runs: ServerRunOrchestrator = new DbRunOrchestrator({
    ...options.runs,
    agents: runAgents,
    budget: options.runs?.budget ?? DB_RUN_BUDGET_GATE,
    db: database.db,
    router: sandboxWire.router,
  });
  late.runs = runs;
  approvals.bind({
    router: sandboxWire.router,
    onRunEnded: (event) => runs.onRunEnded(event),
  });
  const connectorUrlPolicy: ConnectorUrlPolicy = {
    allowHttp: false,
    allowedPorts: DEFAULT_ALLOWED_PORTS,
    allowedInternalCidrs: [],
    deniedCidrs: [],
    resolve: resolveAll,
    ...options.connectors,
  };
  const mcp = createMcpService({
    oauthIo: { policy: connectorUrlPolicy, timeoutMs: DEFAULT_TIMEOUT_MS },
    db: database.db,
    policy: policySources,
    runContext,
    // Gate 2: KOBE-37's verifier (finds, verifies and consumes the signed approval).
    approvals: approvalVerifierForMcp(database.db, approvals.verifier),
    ...(options.envelope ? { envelope: options.envelope } : {}),
    ...(options.mcp?.now ? { now: options.mcp.now } : {}),
  });
  const budgets = new BudgetMonitor({
    db: database.db,
    connectionString: options.databaseUrl,
    runs,
    mailer: options.mailer,
    publicUrl: new URL(options.publicUrl).origin,
    logger: logger.child({ component: "budgets" }),
  });
  const lifecycle = new UserLifecycle();
  // A deactivated user's sandboxes lose their connections on every replica at once (KOBE-13).
  lifecycle.on("deactivated", {
    name: "sandbox-wire",
    run: (userId) => sandboxWire.revalidateUser(userId),
  });
  const offboarding = createOffboarding({
    db: database.db,
    blobs: options.blobs,
    log: logger.child({ component: "offboarding" }),
  });
  // Deactivation destroys the user's sandboxes in every team now; volumes stay 30 days (D12).
  lifecycle.on("deactivated", {
    name: "sandbox-offboarding",
    run: (userId) => offboarding.offboardUser(userId, "deactivated"),
  });

  return {
    database,
    models: options.models
      ? {
          providerKeys: new SecretBox(options.models.providerKeySecrets, PROVIDER_KEY_PURPOSE),
          allowUnsafeEndpoints: options.models.allowUnsafeEndpoints ?? false,
          discovery: options.models.discovery,
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
    auditForwardingDestinations: options.auditForwardingDestinations ?? [],
    lifecycle,
    offboarding,
    sandboxWire,
    runs,
    runAgents,
    mcp,
    connectorUrlPolicy,
    connectorProbe: options.connectorProbe ?? NO_PROBE,
    approvals,
    envelope: options.envelope,
    egressHeaders: options.egressHeaderSecrets ? headerBox(options.egressHeaderSecrets) : undefined,
    budgets,
    blobs: options.blobs,
    uploads: options.uploads,
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
      await budgets.close();
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
