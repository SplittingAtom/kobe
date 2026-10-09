import { z } from "zod";
import { loadAuditForwardingConfig, type AuditForwardingConfig } from "./audit/forward/config.js";
import { smtpSchema, type SmtpConfig } from "./mail/config.js";

const configSchema = z.object({
  PORT: z.coerce
    .number({ error: "PORT must be a number" })
    .int("PORT must be an integer")
    .min(1, "PORT must be between 1 and 65535")
    .max(65535, "PORT must be between 1 and 65535")
    .default(8080),
  // One image, two processes: the API server and the Postgres-leased scheduler (spec D32).
  KOBE_PROCESS: z
    .enum(["server", "scheduler"], { error: "KOBE_PROCESS must be server or scheduler" })
    .default("server"),
  // App-role connection (never the owner); team data is reachable only through withTeam().
  KOBE_DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KOBE_DATABASE_URL must be a postgres:// URL",
  }),
  // RuntimeClass sandboxes run under; the isolation gate verifies its handler (spec D4). Unset
  // keeps the server up with agents disabled, so the admin console can show the fix.
  KOBE_RUNTIME_CLASS: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(
      z
        .string()
        .max(253)
        .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "KOBE_RUNTIME_CLASS must be a RuntimeClass name")
        .optional(),
    )
    .optional(),
  // Published versions per agent (KOBE-46): versions are immutable and never deleted by the app.
  KOBE_AGENT_MAX_VERSIONS: z.coerce
    .number({ error: "KOBE_AGENT_MAX_VERSIONS must be a number" })
    .int("KOBE_AGENT_MAX_VERSIONS must be an integer")
    .min(1, "KOBE_AGENT_MAX_VERSIONS must be between 1 and 100000")
    .max(100_000, "KOBE_AGENT_MAX_VERSIONS must be between 1 and 100000")
    .default(1000),
  // Internal listener (KOBE-58): the MCP proxy's policy re-check. Only with the proxy's key.
  KOBE_INTERNAL_PORT: z.coerce
    .number({ error: "KOBE_INTERNAL_PORT must be a number" })
    .int("KOBE_INTERNAL_PORT must be an integer")
    .min(1, "KOBE_INTERNAL_PORT must be between 1 and 65535")
    .max(65535, "KOBE_INTERNAL_PORT must be between 1 and 65535")
    .default(8082),
  KOBE_MCP_PROXY_INTERNAL_KEY: z
    .string()
    .min(32, "KOBE_MCP_PROXY_INTERNAL_KEY must be at least 32 characters")
    .optional(),
  // The MCP proxy's address for the pinning probe (KOBE-101); with the key above. Unset: no pinning.
  KOBE_MCP_PROXY_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_MCP_PROXY_URL must be an http(s) URL" })
    .optional(),
  // UTC hour the nightly retention pass runs in (KOBE-18, D18).
  KOBE_RETENTION_HOUR_UTC: z.coerce
    .number({ error: "KOBE_RETENTION_HOUR_UTC must be a number" })
    .int("KOBE_RETENTION_HOUR_UTC must be an integer")
    .min(0, "KOBE_RETENTION_HOUR_UTC must be between 0 and 23")
    .max(23, "KOBE_RETENTION_HOUR_UTC must be between 0 and 23")
    .default(3),
  // Seconds between reconciles of every team namespace's managed objects (KOBE-115); 0 turns the
  // interval off (the run at server start stays).
  KOBE_TEAM_RECONCILE_SECONDS: z.coerce
    .number({ error: "KOBE_TEAM_RECONCILE_SECONDS must be a number" })
    .int("KOBE_TEAM_RECONCILE_SECONDS must be an integer")
    .refine(
      (n) => n === 0 || (n >= 30 && n <= 86_400),
      "KOBE_TEAM_RECONCILE_SECONDS must be 0 or between 30 and 86400",
    )
    .default(300),
  // Seconds between re-probes of every pinned connector for tool drift (KOBE-102); 0 = never.
  KOBE_CONNECTOR_REFRESH_SECONDS: z.coerce
    .number({ error: "KOBE_CONNECTOR_REFRESH_SECONDS must be a number" })
    .int("KOBE_CONNECTOR_REFRESH_SECONDS must be an integer")
    .refine(
      (n) => n === 0 || (n >= 60 && n <= 86_400),
      "KOBE_CONNECTOR_REFRESH_SECONDS must be 0 or between 60 and 86400",
    )
    .default(3600),
});

/** Auth settings: required by the API server only (the scheduler never sees these secrets). */
const authSchema = z.object({
  // Public origin of the install: cookie scope and the WebAuthn relying party.
  KOBE_PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_PUBLIC_URL must be an http(s) URL" })
    .refine(
      (u) => URL.canParse(u) && new URL(u).pathname === "/",
      "KOBE_PUBLIC_URL must be an origin without a path",
    )
    .transform((u) => new URL(u).origin),
  KOBE_AUTH_SECRET: z.string().min(32, "KOBE_AUTH_SECRET must be at least 32 characters"),
  KOBE_SETUP_TOKEN: z.string().min(24, "KOBE_SETUP_TOKEN must be at least 24 characters"),
  // Comma-separated CIDRs of the proxies in front of the server (Traefik / load balancer).
  KOBE_TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.cidrv4().or(z.cidrv6()), { error: "KOBE_TRUSTED_PROXIES must be CIDRs" })),
  // Approval HMAC key (D29, KOBE-37): signs approvals; the MCP proxy verifies with it. Unset keeps
  // the server up, but every tool call that needs approval is denied (fail closed).
  KOBE_APPROVAL_KEY: z
    .string()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().min(32, "KOBE_APPROVAL_KEY must be at least 32 characters").optional())
    .optional(),
});

export interface AuthConfig {
  readonly publicUrl: string;
  readonly authSecret: string;
  readonly setupToken: string;
  readonly trustedProxies: readonly string[];
  /** Approval HMAC key; undefined denies every approval request. */
  readonly approvalKey?: string;
}

export interface Config {
  readonly port: number;
  readonly process: "server" | "scheduler";
  readonly databaseUrl: string;
  /** Sandbox RuntimeClass; undefined means agents stay disabled. */
  readonly runtimeClassName: string | undefined;
  /** Published versions per agent (KOBE-46). */
  readonly agentMaxVersions: number;
  /** Internal listener port (MCP proxy re-check, KOBE-58). */
  readonly internalPort: number;
  /** Shared with the MCP proxy; without it the internal listener is not started. */
  readonly mcpProxyInternalKey: string | undefined;
  /** The MCP proxy's base URL, for the pinning probe (KOBE-101). */
  readonly mcpProxyUrl: string | undefined;
  /** UTC hour of the nightly retention pass (KOBE-18). */
  readonly retentionHourUtc: number;
  /** Seconds between team-namespace reconciles; 0 = only at start (KOBE-115). */
  readonly teamReconcileSeconds: number;
  /** Seconds between connector drift refreshes; 0 = off (KOBE-102). */
  readonly connectorRefreshSeconds: number;
  /** SIEM forwarding of audit events (KOBE-19); empty when not configured. */
  readonly auditForwarding: AuditForwardingConfig;
  /** Present for the API server only. */
  readonly auth?: AuthConfig;
  /** Present for the API server only (invites, password resets, notifications). */
  readonly smtp?: SmtpConfig;
}

function fail(error: z.ZodError): never {
  // Messages only (never input values), so secrets can't leak into logs.
  const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const base = configSchema.safeParse(env);
  if (!base.success) fail(base.error);
  const config = {
    port: base.data.PORT,
    process: base.data.KOBE_PROCESS,
    databaseUrl: base.data.KOBE_DATABASE_URL,
    runtimeClassName: base.data.KOBE_RUNTIME_CLASS,
    agentMaxVersions: base.data.KOBE_AGENT_MAX_VERSIONS,
    internalPort: base.data.KOBE_INTERNAL_PORT,
    mcpProxyInternalKey: base.data.KOBE_MCP_PROXY_INTERNAL_KEY,
    mcpProxyUrl: base.data.KOBE_MCP_PROXY_URL,
    retentionHourUtc: base.data.KOBE_RETENTION_HOUR_UTC,
    teamReconcileSeconds: base.data.KOBE_TEAM_RECONCILE_SECONDS,
    connectorRefreshSeconds: base.data.KOBE_CONNECTOR_REFRESH_SECONDS,
    auditForwarding: loadAuditForwardingConfig(env),
  };
  if (config.process !== "server") return config;
  const auth = authSchema.safeParse(env);
  if (!auth.success) fail(auth.error);
  const smtp = smtpSchema.safeParse(env);
  if (!smtp.success) fail(smtp.error);
  return {
    ...config,
    auth: {
      publicUrl: auth.data.KOBE_PUBLIC_URL,
      authSecret: auth.data.KOBE_AUTH_SECRET,
      setupToken: auth.data.KOBE_SETUP_TOKEN,
      trustedProxies: auth.data.KOBE_TRUSTED_PROXIES,
      ...(auth.data.KOBE_APPROVAL_KEY ? { approvalKey: auth.data.KOBE_APPROVAL_KEY } : {}),
    },
    smtp: smtp.data,
  };
}
