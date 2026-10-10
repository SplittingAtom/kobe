import { z } from "zod";
import { DOMAIN_PATTERN_SQL } from "../schema/egress.js";
import {
  MODEL_ALIAS_PATTERN,
  MODEL_PROVIDER_KINDS,
  PROVIDER_ID_PATTERN,
  PROVIDER_MODEL_PATTERN,
} from "../schema/models.js";
import {
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  BUDGET_UNITS,
  MAX_BUDGET_TOKENS,
  MAX_BUDGET_USD,
} from "../schema/budgets.js";
import { BREAK_GLASS_MAX_MINUTES, BREAK_GLASS_NOTIFICATION_EVENTS } from "../schema/break-glass.js";
import { RETENTION_PERIODS } from "../schema/retention.js";
import { teamRole } from "../schema/team-members.js";
import { PI_TOOL_NAME_PATTERN } from "../connectors/snapshot.js";

/**
 * The audit event taxonomy (KOBE-15, spec D31). Every audited action is one entry: its dotted name,
 * which audit view it belongs to, and the **allowlist** of metadata fields it may record. Targets
 * are strict zod objects of ids, enums, booleans, counts and short labels, so a secret, token,
 * password, prompt or message text can't be recorded by accident: unknown keys are rejected and
 * the write fails (with the action it was meant to record).
 *
 * Adding an event: add an entry here (never reuse or rename a published action; export and SIEM
 * consumers key on it), call `audit()` in the transaction that performs the action, and test it.
 */

/** Where an event appears: install audit only, the team's audit view too, or either. */
export type AuditScope =
  /** `teamId` must be null: install-level (users, install settings, gallery, platform). */
  | "install"
  /** `teamId` is required: the team's audit view shows it (team admins). */
  | "team"
  /** Team when the subject is a team's (e.g. a team agent), install otherwise (personal agents). */
  | "any";

const id = z.uuid();
/** A short human label (team or agent name): no control characters, bounded. */
const label = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);
const role = z.enum(teamRole.enumValues);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
/** Machine-readable reason (e.g. a Better Auth error code), never a free-text message. */
const reasonCode = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);

export const SIGN_IN_METHODS = [
  "password",
  "totp",
  "backup_code",
  "passkey",
  "invitation",
] as const;
const signInMethod = z.enum(SIGN_IN_METHODS);
const agentScope = z.enum(["team", "personal", "gallery"]);
const agentRef = { agentId: id, scope: agentScope, slug };
/** A published agent version number (or a draft revision): a positive integer. */
const version = z.number().int().positive();
const isolationState = z.enum(["checking", "verified", "missing"]);
/** A tool rule (KOBE-35) by its policy metadata; never its free-text note or arg values. */
const toolRule = {
  ruleId: id,
  scope: z.enum(["install", "team", "user"]),
  effect: z.enum(["deny", "ask", "allow"]),
  /** Tool-name glob (e.g. `mcp__jira__*`), policy metadata. */
  toolGlob: z.string().min(1).max(512),
  /** How many `arg_pattern` entries the rule has (the patterns themselves are not recorded). */
  argPatternEntries: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
};

/** An egress domain pattern or host (the `egress_domains` grammar): never a URL or path. */
const egressDomain = z.string().max(253).regex(new RegExp(DOMAIN_PATTERN_SQL));
const count = z.number().int().nonnegative();
/** A budget amount in dollars (KOBE-42). */
const usdAmount = z.number().nonnegative().max(MAX_BUDGET_USD);
/** A token budget (KOBE-42, user decision: token budgets beside dollar budgets). */
const tokenAmount = z.number().int().nonnegative().max(MAX_BUDGET_TOKENS);
/** Model gateway (KOBE-40): ids and names as the `model_providers` / `model_catalog` grammar. */
const providerId = z.string().max(32).regex(new RegExp(PROVIDER_ID_PATTERN));
const providerKind = z.enum(MODEL_PROVIDER_KINDS);
const modelAlias = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));
const providerModel = z.string().max(200).regex(new RegExp(PROVIDER_MODEL_PATTERN));
/** A provider endpoint's host (name or IP literal, no path or credentials); null: vendor default. */
const endpointHost = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9.:[\]-]+$/)
  .nullable();

/** A break-glass grant (KOBE-16) by its scope; never the free-text reason. */
const breakGlassScope = {
  grantId: id,
  scope: z.enum(["team", "user", "thread"]),
  subjectUserId: id.optional(),
  threadId: id.optional(),
  legalHold: z.boolean(),
};

/**
 * A legal hold (KOBE-17) by its id only: never the team, the scope, the held user or the reason
 * (a held install admin reads the install log; the console resolves the id).
 */
const legalHoldRef = { holdId: id };

/** How many people a break-glass change queued notifications for (outbox rows), and how many of them are the team's admins. */
const notified = {
  recipients: z.number().int().nonnegative(),
  teamAdmins: z.number().int().nonnegative().optional(),
};

/** Wire and storage limits a sandbox can hit (KOBE-24). */
export const SANDBOX_LIMITS = [
  "frame_rate",
  "byte_rate",
  "frame_size",
  "run_events",
  "run_bytes",
  "thread_entries",
  // Workspace sync (KOBE-27): a push refused for size, count or quota.
  "workspace_bytes",
  "workspace_files",
  "workspace_file_size",
] as const;

/** Why the server refused an `artifact.put` (audit `sandbox.artifact_refused`). */
export const ARTIFACT_PUT_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "artifact_not_found",
] as const;

/** Why the server refused a `file.share` (audit `sandbox.file_share_refused`, KOBE-150). */
export const FILE_SHARE_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "path_mismatch",
  "not_synced",
  "not_found",
  "too_large",
  "quota_exceeded",
  "scan_rejected",
] as const;

/** Why the server refused a `memory.put` / `memory.read` (audit `sandbox.memory_refused`, KOBE-156). */
export const MEMORY_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "memory_disabled",
  "no_project",
  "not_a_member",
  "approval_denied",
] as const;

/** Why the server refused a `web_search.query` (audit `sandbox.web_search_refused`, KOBE-114). */
export const WEB_SEARCH_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "replayed",
] as const;

/** A Pi tool call id (`idSchema` in @kobe/protocol): no control characters, ≤ 128. */
const toolCallId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}]*$/u);
/** A tool name as Pi sees it (`bash`, `mcp__jira__create_issue`): policy metadata. */
const toolName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);

/** Why an enforcement point refused an approved call (`VerifyFailure` + no approval at all). */
export const APPROVAL_REJECT_REASONS = [
  "no_approval",
  "malformed",
  "unknown_key",
  "binding_mismatch",
  "expired",
  "bad_mac",
  "not_allowed",
  "record_mismatch",
  "run_inactive",
  "not_consumable",
  // Server-side, before an approval exists (KOBE-37 review).
  "replayed_tool_call_id",
  "too_many_approvals",
  "run_event_cap",
] as const;

/** Why a signed approval did not authorise an MCP call at the proxy (KOBE-58). */
export const MCP_APPROVAL_FAILURES = [...APPROVAL_REJECT_REASONS, "unavailable"] as const;

/** Why the retention job purged a batch (KOBE-18). */
export const RETENTION_PURGE_REASONS = ["retention", "trash", "offboarding"] as const;
const retentionPeriod = z.enum(RETENTION_PERIODS);
/** What a purge deleted (counts only). */
const purgeCounts = { entries: count, runs: count, events: count, blobs: count };

const event = <const S extends AuditScope, T extends z.ZodRawShape>(scope: S, shape: T) => ({
  scope,
  target: z.strictObject(shape),
});

export const AUDIT_EVENTS = {
  // ── auth: Better Auth sign-in and credential changes (actor: the user) ──
  "auth.sign_in.succeeded": event("install", { method: signInMethod }),
  /** Actor id null (unauthenticated); `userId` only when the attempt named an existing account. */
  "auth.sign_in.failed": event("install", {
    method: signInMethod,
    reason: reasonCode,
    userId: id.optional(),
  }),
  /** Password accepted; the second factor is still outstanding (no session yet). */
  "auth.sign_in.two_factor_required": event("install", { method: signInMethod }),
  /**
   * Unauthenticated attempts are aggregated (KOBE-15 review): the first of each kind per account (or
   * per "no account") and method in a window is recorded as itself; the rest of that window become
   * one summary, so a flood from rotating IPs adds at most two rows per key and window.
   */
  "auth.attempts.summarized": event("install", {
    of: z.enum([
      "auth.sign_in.failed",
      "auth.sign_in.two_factor_required",
      "auth.password.reset_requested",
    ]),
    method: signInMethod.optional(),
    userId: id.optional(),
    /** Attempts in the window after the first (which was recorded as its own event). */
    suppressed: z.number().int().positive(),
    /** Distinct client addresses among them (counted up to 1,000). */
    distinctIps: z.number().int().nonnegative(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  "auth.sign_out": event("install", {}),
  "auth.session.revoked": event("install", { which: z.enum(["one", "others", "all"]) }),
  "auth.password.changed": event("install", {}),
  /** Actor id null: whoever asked; only requests for an existing, active account are recorded. */
  "auth.password.reset_requested": event("install", { userId: id }),
  "auth.password.reset": event("install", { userId: id }),
  "auth.two_factor.enabled": event("install", {}),
  "auth.two_factor.disabled": event("install", {}),
  "auth.two_factor.backup_codes_regenerated": event("install", {}),
  "auth.passkey.added": event("install", {}),
  "auth.passkey.removed": event("install", { passkeyId: z.string().max(128).optional() }),

  // ── identity: users, invitations, roles, teams, membership ──
  "identity.setup.completed": event("install", { ownerUserId: id }),
  // No invitee email (personal data in an append-only log): the invitation id resolves it while
  // the invitation exists (install invitations are kept; KOBE-15 review).
  "identity.invitation.created": event("install", { invitationId: id }),
  "identity.invitation.resent": event("install", { invitationId: id }),
  "identity.invitation.revoked": event("install", { invitationId: id }),
  /** Actor: the new user. */
  "identity.invitation.accepted": event("install", { invitationId: id, userId: id }),
  "identity.user.deactivated": event("install", { userId: id }),
  "identity.user.reactivated": event("install", { userId: id }),
  "identity.install_role.granted": event("install", { userId: id, role: z.literal("admin") }),
  "identity.install_role.revoked": event("install", { userId: id, role: z.literal("admin") }),
  "identity.ownership.transferred": event("install", { fromUserId: id, toUserId: id }),
  "identity.team.created": event("team", { slug, name: label, adminUserId: id }),
  "identity.team.renamed": event("team", { name: label }),
  "identity.team_invitation.created": event("team", { invitationId: id, role }),
  "identity.team_invitation.revoked": event("team", { invitationId: id }),
  /** Actor: the invitee, who joins with `role`. */
  "identity.team_invitation.accepted": event("team", { userId: id, role, invitedBy: id }),
  /** Actor: the invitee. */
  "identity.team_invitation.declined": event("team", {}),
  "identity.member.role_changed": event("team", { userId: id, from: role, to: role }),
  "identity.member.removed": event("team", { userId: id, role }),

  // ── install: install-wide settings ──
  "install.settings.updated": event("install", {
    setting: z.enum(["require_two_factor", "audit_pii_retention_hours"]),
    value: z.union([z.boolean(), z.number().int().nonnegative(), label]),
  }),

  // ── platform: isolation runtime, restore (actor: system) ──
  /** A server replica's isolation state changed (spec D4); boot-time "verified" is not recorded. */
  "platform.isolation.changed": event("install", {
    from: isolationState,
    to: isolationState,
    runtimeClass: z.string().max(253).optional(),
    handler: z.string().max(63).optional(),
    replica: z.string().max(253),
  }),
  /** `kobe restore` loaded a backup into this database (written by the restore transaction). */
  "platform.restore.completed": event("install", {
    backupCreatedAt: z.iso.datetime(),
    tables: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
    /** Who ran the restore (OS user or `--operator`). */
    operator: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
    /** Head of the restored chain, verified inside the restore transaction (absent if empty). */
    auditHeadSeq: z.number().int().positive().optional(),
    auditHeadHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),

  // ── policy: tool rules and switches (D29, KOBE-35); install rules install-only, others team ──
  "policy.rule.created": event("any", toolRule),
  "policy.rule.updated": event("any", toolRule),
  /** Includes a member revoking their own remember-rule (scope `user`). */
  "policy.rule.deleted": event("any", toolRule),
  "policy.settings.updated": event("install", {
    setting: z.enum(["prompt_sandbox_writes"]),
    value: z.boolean(),
  }),

  // ── sandbox: lifecycle metadata only, never pod logs (KOBE-22, D11) ──
  /** A user's sandbox in a team was claimed (system actor, or the user whose request did it). */
  "sandbox.created": event("team", { sandboxId: id, userId: id }),
  /**
   * The server deleted a sandbox (its claim) or a pod because it was not running under the
   * verified isolation runtime, or because isolation was lost (pods only; claims and volumes kept).
   */
  "sandbox.destroyed": event("team", {
    sandboxId: id.optional(),
    userId: id.optional(),
    pod: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
      .optional(),
    reason: z.enum(["isolation_mismatch", "isolation_lost"]),
  }),
  /**
   * The server hibernated an idle sandbox (D14: agent-sandbox `Suspended`, volume kept, /tmp
   * wiped) after `idleMinutes` without activity (system actor).
   */
  "sandbox.hibernated": event("team", {
    sandboxId: id,
    userId: id,
    idleMinutes: z.number().int().min(0).max(1440),
    /** idle: the D14 policy; operator: forced by an operator tool (idle time skipped). */
    trigger: z.enum(["idle", "operator"]),
  }),
  /**
   * The server resumed a hibernated sandbox (D14: a command needed it) through the isolation gate,
   * with the current pod template (system actor, or the user whose request woke it).
   */
  "sandbox.woken": event("team", { sandboxId: id, userId: id }),
  /**
   * A woken sandbox was not Ready within the wake timeout and its run failed
   * `workspace_unavailable` (KOBE-192; system actor). Install scope: `detail` is the cluster's own
   * reason (events, volume phase) and may name nodes and volumes, so team members never see it.
   */
  "sandbox.wake_stalled": event("install", {
    teamId: id,
    sandboxId: id,
    userId: id,
    cause: z.enum(["volume_unschedulable", "volume_attach", "scheduling", "image_pull", "unknown"]),
    detail: z
      .string()
      .max(600)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/),
  }),

  // ── egress: ceiling (install), enablement (team), connections (team; KOBE-38, D28) ──
  "egress.ceiling.added": event("install", { domain: egressDomain }),
  /** A ceiling domain (preset or custom) was put into or taken out of the ceiling. */
  "egress.ceiling.changed": event("install", { domain: egressDomain, inCeiling: z.boolean() }),
  /** A custom domain was deleted; every team's enablement of it went with it. */
  "egress.ceiling.removed": event("install", { domain: egressDomain }),
  "egress.domain.enabled": event("team", { domain: egressDomain }),
  /** `headersRemoved`: the domain's injected headers (KOBE-39) were deleted with it. */
  "egress.domain.disabled": event("team", {
    domain: egressDomain,
    headersRemoved: z.literal(true).optional(),
  }),
  /**
   * Request access (KOBE-39, D28): a member asked the team's admins to enable `pattern` after a
   * blocked request to `domain` (thread metadata only: the thread id; never a URL or prompt).
   */
  "egress.request.created": event("team", {
    requestId: id,
    domain: egressDomain,
    pattern: egressDomain,
    threadId: id.optional(),
    notified: count,
  }),
  /** A team admin approved (enabled the pattern) or denied it; `requests` pending ones settled. */
  "egress.request.decided": event("team", {
    requestId: id,
    pattern: egressDomain,
    decision: z.enum(["approved", "denied"]),
    requests: z.number().int().positive(),
    /** Approved and the pattern was not enabled yet (an `egress.domain.enabled` row goes with it). */
    enabled: z.boolean(),
  }),
  /** Header injection (KOBE-39) set or replaced for an enabled domain: names only, never values. */
  "egress.header.set": event("team", {
    domain: egressDomain,
    headerNames: z
      .array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/))
      .min(1)
      .max(8),
  }),
  "egress.header.cleared": event("team", { domain: egressDomain }),
  /**
   * Sandbox connections through the egress proxy (actor: system), aggregated per (user, sandbox,
   * host, outcome, reason) over a short window: high volume, so one row per key and window, every
   * connection counted in exactly one row (D28 "every connection is logged"). `domain` is absent
   * when the target was not a host name (IP literal, junk).
   */
  "egress.connection": event("team", {
    userId: id,
    sandboxId: id,
    domain: egressDomain.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    outcome: z.enum(["allowed", "blocked", "failed"]),
    reason: z
      .enum([
        "not_enabled",
        "not_in_ceiling",
        "forbidden_address",
        "sni_mismatch",
        "invalid_target",
        "port_not_allowed",
        "plain_http",
        "connection_limit",
        "dns_failure",
        "upstream_unreachable",
        "policy_unavailable",
        "inactive_member",
        // KOBE-39 header injection (plain HTTP upgraded to verified HTTPS by the proxy).
        "headers_required",
        "upstream_tls",
        "upstream_timeout",
        "request_too_large",
        "response_too_large",
      ])
      .optional(),
    /** Plain HTTP the proxy upgraded to HTTPS with the team's injected headers (KOBE-39). */
    upgraded: z.literal(true).optional(),
    /**
     * Set when the row collapses hosts beyond the sandbox's rate of distinct hosts (random-name
     * floods): `domain` is then absent and `connections` counts them all.
     */
    aggregated: z.literal(true).optional(),
    connections: z.number().int().positive(),
    bytesUp: count,
    bytesDown: count,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),

  // ── models: providers and catalog (install), team enablement (team; KOBE-40, D6, D30) ──
  // Never the API key itself: only whether one is set or changed.
  "models.provider.added": event("install", {
    providerId,
    kind: providerKind,
    keySet: z.boolean(),
    privateNetwork: z.boolean(),
    endpointHost,
  }),
  "models.provider.changed": event("install", {
    providerId,
    kind: providerKind,
    keyChanged: z.boolean(),
    baseUrlChanged: z.boolean(),
    privateNetwork: z.boolean(),
    /** The endpoint's host after the change (where the stored key is sent). */
    endpointHost,
  }),
  "models.provider.removed": event("install", { providerId, kind: providerKind }),
  /**
   * An install admin had the gateway call the provider's list-models API with the stored key
   * (KOBE-44 model picker). The outcome only: never the provider's answer or the key.
   */
  "models.provider.models_refreshed": event("install", {
    providerId,
    kind: providerKind,
    outcome: z.enum(["ok", "failed", "unavailable"]),
    models: count,
  }),
  /** A catalog alias was added, re-pointed or removed (removal also disables it for every team). */
  "models.catalog.changed": event("install", {
    alias: modelAlias,
    change: z.enum(["added", "updated", "removed"]),
    providerId: providerId.optional(),
    model: providerModel.optional(),
    /** Its prices were set or changed (KOBE-43; the amounts are in the catalog). */
    pricesChanged: z.boolean().optional(),
    /** Its input modalities (image input, KOBE-191) changed. */
    imageSupportChanged: z.boolean().optional(),
  }),
  /** A team admin enabled or disabled a catalog alias for the team, or changed its default. */
  "models.team.changed": event("team", {
    alias: modelAlias,
    enabled: z.boolean(),
    isDefault: z.boolean(),
  }),
  /**
   * A budget or rate limit was set, changed or removed (KOBE-42, D30): the install's (install
   * admins; no team), the team's or one member's (team admins). Amounts in dollars; null = none.
   */
  "models.budget.changed": event("any", {
    scope: z.enum(BUDGET_SCOPES),
    userId: id.optional(),
    monthlyUsd: usdAmount.nullable(),
    dailyUsd: usdAmount.nullable(),
    /** Token budgets (named "volume": audit field names never say "token"). */
    monthlyVolume: tokenAmount.nullable().optional(),
    dailyVolume: tokenAmount.nullable().optional(),
    /** The team's default member budget (team scope only). */
    memberDefault: z
      .strictObject({
        monthlyUsd: usdAmount.nullable(),
        dailyUsd: usdAmount.nullable(),
        monthlyVolume: tokenAmount.nullable(),
        dailyVolume: tokenAmount.nullable(),
      })
      .optional(),
    /** Per-user requests per minute (install and team levels only); null = the install's. */
    requestsPerMinute: z.number().int().positive().nullable().optional(),
    removed: z.literal(true).optional(),
  }),
  /**
   * A budget was used up (actor: system): from now on new model calls and new runs are refused at
   * its level and active runs end after their current step (D30). Once per budget and period.
   */
  "models.budget.reached": event("any", {
    scope: z.enum(BUDGET_SCOPES),
    userId: id.optional(),
    period: z.enum(BUDGET_PERIODS),
    periodStart: z.iso.date(),
    /** Dollars or tokens. */
    unit: z.enum(BUDGET_UNITS),
    limit: z.number().nonnegative().max(MAX_BUDGET_TOKENS),
    spent: z.number().nonnegative(),
  }),

  // ── mcp: tool calls through the MCP proxy (KOBE-58, D27, D29); metadata only, never inputs ──
  /**
   * The server decided an MCP `tools/call` the proxy asked about (actor: the sandbox's user). Every
   * allowed call is recorded before the proxy forwards it; denied calls are throttled per sandbox.
   * `reason` is the deciding policy reason code (`approval_granted` when a signed approval was
   * verified and consumed); `approvalFailure` says why an approval did not authorise the call.
   */
  "mcp.tool_call": event("team", {
    sandboxId: id,
    userId: id,
    connectorId: id,
    /** Pi tool name (`mcp__<server>__<tool>`), policy metadata. */
    tool: z.string().max(256).regex(PI_TOOL_NAME_PATTERN),
    runId: id.optional(),
    threadId: id.optional(),
    /** Only when the client sent one in `_meta` and it is a plain id. */
    toolCallId: z
      .string()
      .regex(/^[A-Za-z0-9_.:/-]{1,128}$/)
      .optional(),
    decision: z.enum(["allowed", "denied"]),
    reason: reasonCode,
    risk: z.enum(["read", "write", "destructive"]).optional(),
    approvalId: id.optional(),
    approvalFailure: z.enum(MCP_APPROVAL_FAILURES).optional(),
  }),

  /**
   * The MCP proxy asked for the tools of a connector the team has not enabled (KOBE-106); nothing
   * is listed. Throttled per sandbox like denied calls.
   */
  "mcp.list_refused": event("team", {
    sandboxId: id,
    userId: id,
    connectorId: id,
    reason: reasonCode,
  }),

  // ── thread: lifecycle metadata only, never titles or content (KOBE-34, D18, D23) ──
  "thread.trashed": event("team", { threadId: id }),
  "thread.restored": event("team", { threadId: id }),
  /** `visibility` is the share scope after the change (private | project; `team` joins with KOBE-221). */
  "thread.sharing_changed": event("team", {
    threadId: id,
    projectId: id,
    shared: z.boolean(),
    visibility: z.enum(["private", "project"]),
  }),
  /** A new private thread copied from `sourceThreadId`; `threadId` is the fork. */
  "thread.forked": event("team", {
    threadId: id,
    sourceThreadId: id,
    projectId: id.nullable(),
    entries: z.number().int().nonnegative(),
  }),
  // ── project: configuration metadata only, never names, instructions or descriptions (KOBE-161, D23) ──
  "project.created": event("team", { projectId: id, membersMode: z.enum(["team", "selected"]) }),
  /** `fields` lists which settings changed (names, not values). */
  "project.updated": event("team", { projectId: id, fields: z.array(z.string().max(40)).max(10) }),
  "project.deleted": event("team", { projectId: id }),
  "project.member_added": event("team", {
    projectId: id,
    userId: id,
    role: z.enum(["owner", "member"]),
  }),
  "project.member_removed": event("team", { projectId: id, userId: id }),
  "project.member_role_changed": event("team", {
    projectId: id,
    userId: id,
    from: z.enum(["owner", "member"]),
    to: z.enum(["owner", "member"]),
  }),
  /** The thread's chosen model changed (KOBE-44, D30); null = the team's default. */
  "thread.model_changed": event("team", {
    threadId: id,
    from: modelAlias.nullable(),
    to: modelAlias.nullable(),
  }),
  /** The thread's pinned agent version changed (D19 one-click switch, KOBE-46). */
  "thread.agent_switched": event("team", {
    threadId: id,
    agentId: id,
    scope: agentScope,
    fromVersion: version,
    toVersion: version,
  }),

  /** The owner asked to delete a thread from Trash for good (D18); purged at once unless held. */
  "thread.purge_requested": event("team", { threadId: id }),
  /** One thread hard-deleted (the owner's "Delete forever"); counts of what went with it. */
  "thread.purged": event("team", { threadId: id, ...purgeCounts }),
  /** The user downloaded their threads in the team (Pi JSONL + Markdown zip, D18). */
  "thread.exported": event("team", { threads: count, entries: count }),

  // ── retention: periods, purges and compaction (D18, KOBE-18); counts only, never content ──
  /** A team admin changed the team's retention period. */
  "retention.policy.changed": event("team", {
    period: retentionPeriod,
    previous: retentionPeriod,
    /** Set when the change shortens the period: it applies then (7-day grace), not now. */
    effectiveAt: z.iso.datetime({ offset: true }).optional(),
  }),
  /** A team admin cancelled the team's pending shortening during its grace period. */
  "retention.policy.change_cancelled": event("team", {
    period: retentionPeriod,
    kept: retentionPeriod,
  }),
  /** An install admin changed the longest period any team may keep threads. */
  "retention.maximum.changed": event("install", {
    maximum: retentionPeriod,
    previous: retentionPeriod,
    effectiveAt: z.iso.datetime({ offset: true }).optional(),
  }),
  /** An install admin cancelled a pending lowering of the maximum. */
  "retention.maximum.change_cancelled": event("install", {
    maximum: retentionPeriod,
    kept: retentionPeriod,
  }),
  /** Team admins were emailed about an upcoming shortening (counts only, no titles). */
  "retention.shortening_notified": event("team", {
    period: retentionPeriod,
    effectiveAt: z.iso.datetime({ offset: true }),
    threads: count,
    recipients: count,
  }),
  /**
   * A batch of threads purged by the retention job (system): past the team's period, 30 days in
   * Trash, or a departed member's (offboarding, KOBE-28; `userId`). Held data is never in a batch.
   */
  "retention.purged": event("team", {
    reason: z.enum(RETENTION_PURGE_REASONS),
    threads: count,
    ...purgeCounts,
    userId: id.optional(),
  }),
  /** Ended runs' live events folded away 7 days after the run (system; entries keep the content). */
  "retention.compacted": event("team", { runs: count, events: count }),
  /**
   * Memory purged (system; KOBE-188, D24): superseded versions and long-deleted files past the
   * team's window (`retention`), or a departed member's personal memory (`offboarding`, `userId`).
   * Counts only, never paths or content; live files and held owners' memory are never in a batch.
   */
  "retention.memory_purged": event("team", {
    reason: z.enum(["retention", "offboarding"]),
    docs: count,
    versions: count,
    blobs: count,
    userId: id.optional(),
  }),
  /** Objects of purged rows deleted from object storage (system); `kept`: still referenced. */
  "retention.blobs_deleted": event("team", { blobs: count, kept: count }),

  // ── governance: break-glass (D10, KOBE-16); team scope, so the team's audit view shows them ──
  /** An install admin asked for read access to the team (the reason stays in the grant row). */
  "governance.break_glass.requested": event("team", {
    ...breakGlassScope,
    durationMinutes: z.number().int().min(1).max(BREAK_GLASS_MAX_MINUTES),
    ...notified,
  }),
  /** A second install admin approved; `selfApproved` flags a single-admin install (D10). */
  "governance.break_glass.approved": event("team", {
    ...breakGlassScope,
    expiresAt: z.iso.datetime({ offset: true }),
    selfApproved: z.boolean(),
    ...notified,
  }),
  "governance.break_glass.denied": event("team", { grantId: id, ...notified }),
  /** Withdrawn while pending (`wasActive` false) or revoked during its window. */
  "governance.break_glass.revoked": event("team", {
    grantId: id,
    wasActive: z.boolean(),
    ...notified,
  }),
  /** The window ended (`wasActive`) or the request lapsed undecided (actor: system). */
  "governance.break_glass.expired": event("team", {
    grantId: id,
    wasActive: z.boolean(),
    ...notified,
  }),
  /** A queued notification gave up after its retries (actor: system). */
  "governance.break_glass.notification_failed": event("team", {
    grantId: id,
    recipientUserId: id,
    event: z.enum(BREAK_GLASS_NOTIFICATION_EVENTS),
    attempts: z.number().int().positive(),
  }),
  "governance.break_glass.read": event("team", {
    grantId: id,
    object: z.enum(["thread_list", "thread", "thread_entries"]),
    threadId: id.optional(),
  }),

  // ── governance: legal hold (D18, KOBE-17); install scope: holds are confidential, and the team's
  // admins may be the people held. Never the held user's id or the reason (the hold row keeps them).
  /** An install admin asked for a hold on a team, or on one user in it. */
  "governance.legal_hold.requested": event("install", legalHoldRef),
  /** A second install admin approved (or a single-admin install self-approved, flagged): in force. */
  "governance.legal_hold.placed": event("install", { ...legalHoldRef, selfApproved: z.boolean() }),
  "governance.legal_hold.denied": event("install", { holdId: id }),
  "governance.legal_hold.withdrawn": event("install", { holdId: id }),
  /** An install admin asked to release an active hold; it stays in force until approved. */
  "governance.legal_hold.release_requested": event("install", { holdId: id }),
  "governance.legal_hold.release_denied": event("install", { holdId: id }),
  "governance.legal_hold.release_withdrawn": event("install", { holdId: id }),
  /** A second install admin approved the release (single-admin install: flagged): purges resume. */
  "governance.legal_hold.released": event("install", {
    ...legalHoldRef,
    selfApproved: z.boolean(),
  }),

  // ── audit: the audit log's own maintenance (KOBE-17; actor: system) ──
  /** The IP and user agent of rows past the retention period were erased (counts only). */
  "audit.pii_erased": event("install", {
    rows: count,
    olderThanHours: z.number().int().positive(),
  }),
  /**
   * An admin downloaded the log as CSV or JSONL (KOBE-19). Install admins export the whole log
   * (install scope); a team admin's export is the team view and is recorded in the team. `rows` is
   * what was sent; `complete` is false when the download broke off or failed.
   */
  "audit.exported": event("any", {
    format: z.enum(["csv", "jsonl"]),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    rows: count,
    complete: z.boolean(),
  }),
  /** Written once after the chain v2 upgrade (server): the seal over every v1 row (hex SHA-256). */
  "audit.chain.upgraded": event("install", {
    throughSeq: z.number().int().positive(),
    rows: z.number().int().positive(),
    seal: z.string().regex(/^[0-9a-f]{64}$/),
  }),

  // ── run: lifecycle metadata the server decides on its own (KOBE-24; never content) ──
  /** The wire ended an active run as interrupted (D14: sandbox or Pi lost; actor: system). */
  "run.interrupted": event("team", {
    runId: id,
    threadId: id,
    cause: z.enum(["sandbox_gone", "not_resumed", "pi_exited"]),
  }),
  /**
   * The thread owner stopped a run, or deleted a queued message (D17; KOBE-30). `queuePaused`: the
   * Stop paused the messages queued behind the run (KOBE-26).
   */
  "run.cancelled": event("team", {
    runId: id,
    threadId: id,
    wasActive: z.boolean(),
    queuePaused: z.literal(true).optional(),
  }),
  /** The thread owner retried an interrupted run; `runId` is the new run (D14; KOBE-30). */
  "run.retried": event("team", { runId: id, threadId: id, retryOfRunId: id }),
  /** A run ended because a budget is used up, after its current step (D30; system). */
  "run.budget_stopped": event("team", {
    runId: id,
    threadId: id,
    scope: z.enum(["install", "team", "user"]),
  }),

  // ── approval: tool-call approvals (D29; KOBE-37); never the tool input or the signed token ──
  /** A tool call needs a human: an `approvals` row is pending (system; `userId` decides it). */
  "approval.requested": event("team", {
    approvalId: id,
    runId: id,
    threadId: id,
    toolCallId,
    tool: toolName,
    risk: z.enum(["read", "write", "destructive"]),
    userId: id,
  }),
  /**
   * The run's user allowed or denied a pending approval. `remember`: an allow rule was written in
   * the same transaction (its own `policy.rule.created` names it as `ruleId`).
   */
  "approval.decided": event("team", {
    approvalId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    decision: z.enum(["allow", "deny"]),
    remember: z.boolean(),
    ruleId: id.optional(),
  }),
  /** A pending approval ended without a decision: TTL (D29, 1 h) or its run ended (system). */
  "approval.expired": event("team", {
    approvalId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    cause: z.enum(["ttl", "run_cancelled", "run_interrupted", "budget_exhausted", "run_failed"]),
  }),
  /** An enforcement point verified the signed approval and used it, once (system). */
  "approval.consumed": event("team", {
    approvalId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    enforcementPoint: z.enum(["mcp_proxy", "server"]),
  }),
  /**
   * A call needing approval was refused before it could be used: at the MCP proxy (missing,
   * tampered input, replayed, other run, expired, used) or at the server (a tool call id replayed
   * in its run, the run's approval or event cap). Throttled per tool call and reason; `suppressed`
   * counts the repeats since the previous row of that key (system).
   */
  "approval.rejected": event("team", {
    runId: id,
    toolCallId,
    tool: toolName,
    reason: z.enum(APPROVAL_REJECT_REASONS),
    enforcementPoint: z.enum(["mcp_proxy", "server"]),
    approvalId: id.optional(),
    suppressed: count.optional(),
  }),

  // ── sandbox: the sandbox wire (KOBE-24, D13); throttled per sandbox and violation ──
  /** A sandbox named a run, thread or command not leased to its connection (closed; system). */
  "sandbox.lease_violation": event("team", {
    sandboxId: id,
    userId: id,
    violation: z.enum(["unknown_run", "unknown_thread", "unknown_command"]),
    frameType: z.string().regex(/^[a-z][a-z_.]{0,31}$/),
  }),
  /**
   * A validly signed `kobe.sandbox-wire` token was refused: the sandbox is no longer live, its user
   * may not use it (deactivated, left the team), or `hello` named another sandbox (system).
   * Unsigned/forged tokens carry no trustworthy team and are only logged and counted.
   */
  "sandbox.token_rejected": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(["not_live", "not_allowed", "sandbox_mismatch"]),
  }),
  /** A sandbox exceeded a wire or storage limit; connection closed or run stopped (system). */
  "sandbox.limit_exceeded": event("team", {
    sandboxId: id,
    userId: id,
    limit: z.enum(SANDBOX_LIMITS),
    runId: id.optional(),
  }),

  /**
   * The server refused an `artifact.put` (KOBE-129, D3 of KOBE-55): a connection without the
   * capability, a run not active here, a tool call it did not allow (or with another input), or an
   * update of an artifact outside the call's team and thread. Never records content (system;
   * at most one per 5 minutes per reason and user).
   */
  "sandbox.artifact_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(ARTIFACT_PUT_REFUSALS),
    tool: z.enum(["create_artifact", "update_artifact"]),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * The server refused a `file.share` (KOBE-150): no `files` capability, a run not active here, a
   * tool call it did not allow (or other input), a workspace entry that does not match the push,
   * or a size / quota / scan refusal. Never records names, paths or content (system; at most one
   * per 5 minutes per reason and user).
   */
  "sandbox.file_share_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(FILE_SHARE_REFUSALS),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * The server refused a `web_search.query` (KOBE-114): no `web_search` capability, a run not
   * active here, or a tool call it did not allow (or other input). Never records the query (system;
   * at most one per 5 minutes per reason and user).
   */
  "sandbox.web_search_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(WEB_SEARCH_REFUSALS),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * A `web_search` reached the provider (KOBE-114). Counts toward the per-run cap, read back from
   * this table under a per-run lock, so it holds across replicas. Never records the query (system).
   */
  "sandbox.web_search_queried": event("team", {
    sandboxId: id,
    userId: id,
    runId: id,
    toolCallId,
    provider: z.enum(["brave", "tavily", "exa"]),
  }),

  /**
   * The server refused a `memory.put` or `memory.read` (KOBE-156): no `memory` capability, a run
   * not active here, a `remember` call it did not allow (or other input), a disabled scope, a
   * thread outside a project, a user who is not a project member, or a project write whose
   * approval was denied or lapsed. Never records paths or content (system; at most one per 5
   * minutes per reason and user).
   */
  "sandbox.memory_refused": event("team", {
    sandboxId: id,
    userId: id,
    op: z.enum(["put", "read"]),
    reason: z.enum(MEMORY_REFUSALS),
    scope: z.enum(["user", "project"]).optional(),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  // ── workspace: the durable S3 copy of each sandbox's /workspace (KOBE-27, D12, D15, D26) ──
  /**
   * A sandbox restored its workspace onto an empty volume from the durable copy (rebuild after a
   * lost or new volume). Counts are the sandbox's own report (system actor).
   */
  "workspace.restored": event("team", {
    sandboxId: id,
    userId: id,
    files: count,
    bytes: count,
    durationMs: count,
  }),
  /**
   * A sandbox uploaded bytes that did not hash to the name it gave them (tampered or broken;
   * nothing stored). One row per sandbox per minute at most; `failures` counts every mismatch
   * since the previous row, so none is hidden by the throttle (system).
   */
  "workspace.integrity_failed": event("team", {
    sandboxId: id,
    userId: id,
    failures: z.number().int().positive(),
  }),
  /** A workspace file was copied to a durable shared object (KOBE-54 `share_file`). */
  "workspace.file_shared": event("team", { userId: id, sharedId: id, bytes: count }),
  // ── files: user uploads (KOBE-143, 53c of KOBE-53); counts and ids only, never names or content ──
  /** A file was stored (S3 first, then the `files` row). `threadId` absent: not in a thread yet. */
  "workspace.upload_stored": event("team", {
    userId: id,
    fileId: id,
    threadId: id.optional(),
    bytes: count,
  }),
  /** An upload was refused (`bytes` seen before the refusal; 0 when refused up front). */
  "workspace.upload_refused": event("team", {
    userId: id,
    reason: z.enum(["file_too_large", "message_too_large", "quota_exceeded"]),
    bytes: count,
  }),
  /**
   * The virus scan (ClamAV, KOBE-146) rejected an upload, or was unreachable while scanning is on
   * (`reason`); the object was deleted. Counts only: no name, content or signature.
   */
  "workspace.upload_scan_refused": event("team", {
    userId: id,
    reason: z.enum(["scan_rejected", "scan_unavailable"]),
    bytes: count,
  }),
  /** Uploads never attached to a thread within the retention window were deleted (system). */
  "workspace.uploads_expired": event("team", { files: count, bytes: count }),
  /** The user downloaded a file of their own workspace in the file browser (KOBE-148; no names). */
  "workspace.file_downloaded": event("team", { userId: id, bytes: count }),
  /** The user uploaded a file into their own workspace in the file browser (KOBE-148; no names). */
  "workspace.file_uploaded": event("team", { userId: id, bytes: count }),
  /** The user deleted a file or folder of their own workspace in the file browser (KOBE-148). */
  "workspace.file_deleted": event("team", { userId: id, files: count, bytes: count }),
  /** Unreferenced workspace blobs and old tombstones were purged (system; counts only, D18). */
  "workspace.purged": event("team", { userId: id, blobs: count, bytes: count, tombstones: count }),

  // ── sandbox offboarding: a departed member's sandbox and volume (D12, KOBE-28) ──
  /**
   * A member's sandbox in a team was destroyed because the member was removed, deactivated or the
   * team removed (actor: the admin who did it, else the platform). The workspace volume is kept
   * until `retainUntil` (30 days) so a team admin can export it.
   */
  "sandbox.offboarded": event("team", {
    userId: id,
    sandboxId: id.optional(),
    trigger: z.enum(["member_removed", "deactivated", "team_removed", "reconciled"]),
    volumeKept: z.boolean(),
    retainUntil: z.iso.datetime({ offset: true }),
  }),
  /** A team admin downloaded the zip export of a departed member's workspace (counts only). */
  "sandbox.export_downloaded": event("team", { userId: id, files: count, bytes: count }),
  /**
   * The retention sweep deleted a departed member's volume and workspace copy after the 30 days
   * (system; never while a legal hold covers the member in the team). Counts only.
   */
  "sandbox.volume_deleted": event("team", {
    userId: id,
    volumeDeleted: z.boolean(),
    files: count,
    blobs: count,
    bytes: count,
  }),

  // ── agent: definitions (D19); team agents in the team view, personal and gallery install-only ──
  "agent.created": event("any", {
    ...agentRef,
    // "seed": a gallery agent created from the repo's definitions at install or upgrade (KOBE-87).
    source: z.enum(["json", "import", "fork", "seed"]),
    forkedFrom: id.optional(),
    forkedFromVersion: version.optional(),
  }),
  "agent.updated": event("any", {
    ...agentRef,
    revision: z.number().int().positive(),
    source: z.enum(["json", "import", "seed"]),
  }),
  "agent.deleted": event("any", agentRef),
  "agent.status_changed": event("any", { ...agentRef, status: z.enum(["active", "suspended"]) }),
  "agent.exported": event("any", agentRef),
  /** A published version exported as Orbit YAML (KOBE-91). */
  "agent.orbit_exported": event("any", { ...agentRef, version }),
  // Versions (KOBE-46): publish freezes the draft and its tool manifest; rollback republishes.
  "agent.published": event("any", { ...agentRef, version, draftRevision: version }),
  "agent.rolled_back": event("any", { ...agentRef, version, fromVersion: version }),
  // The pre-publish Orbit eval gate (KOBE-93): requested at Publish, finished with a verdict.
  "agent.eval.requested": event("team", { ...agentRef, evalId: id, draftRevision: version }),
  "agent.eval.finished": event("team", {
    ...agentRef,
    evalId: id,
    status: z.enum(["passed", "blocked", "errored"]),
    attackSuccessRate: z.number().min(0).max(1).nullable(),
  }),
  /** A team admin changed the eval gate switch or its attack-success-rate ceiling (KOBE-93). */
  "agent.eval.settings_changed": event("team", {
    enabled: z.boolean(),
    maxAttackSuccessRate: z.number().min(0).max(1),
  }),
  /** An agent with versions retired instead of deleted (pinned threads keep their version). */
  "agent.archived": event("any", agentRef),
  "agent.unarchived": event("any", agentRef),

  // ── skill: uploaded bundles (KOBE-78); team skills in the team view, personal install-only ──
  /** A skill bundle was uploaded as a new immutable version (never the bundle's contents). */
  "skill.uploaded": event("any", {
    skillId: id,
    scope: z.enum(["team", "personal"]),
    slug,
    version,
    bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: count,
    files: count,
    source: z.enum(["zip", "skill_md"]),
    /** Scanner findings (KOBE-80); absent on uploads recorded before the scanner ran. */
    findings: count.optional(),
  }),
  /** A team admin approved or rejected a team skill version (KOBE-80, D22). */
  "skill.reviewed": event("team", {
    skillId: id,
    slug,
    version,
    decision: z.enum(["approved", "rejected"]),
    previous: z.enum(["pending", "approved", "rejected"]),
    flagged: z.boolean(),
  }),
  /** A team admin switched the team's personal skills off or on (KOBE-80, D22). */
  "skill.personal_switch.changed": event("team", { disabled: z.boolean() }),
  /** An install admin put a bundle hash on the install blocklist (KOBE-81); hash only, no reason. */
  "skill.blocklist.added": event("install", { bundleHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  /** An install admin took a bundle hash off the blocklist (KOBE-81). */
  "skill.blocklist.removed": event("install", { bundleHash: z.string().regex(/^[0-9a-f]{64}$/) }),

  // ── connectors: the install registry (KOBE-100); ids, names and field names, never URLs or credentials ──
  /** An install admin registered an MCP server. */
  "mcp.connector.registered": event("install", {
    connectorId: id,
    name: z.string().max(64),
    authKind: z.enum(["none", "api_key", "oauth"]),
  }),
  /** An install admin edited a connector; `changed` names the fields, values are not recorded. */
  "mcp.connector.updated": event("install", {
    connectorId: id,
    name: z.string().max(64),
    changed: z.array(z.enum(["name", "url", "iconUrl", "authKind", "status"])).max(5),
  }),
  /** An install admin removed a connector; `soft` when teams still used it (kept disabled). */
  "mcp.connector.removed": event("install", {
    connectorId: id,
    name: z.string().max(64),
    soft: z.boolean(),
    teams: z.number().int().nonnegative(),
  }),
  /** Kobe probed a connector and pinned its tools (KOBE-101); the hash covers all pinned tools. */
  "mcp.connector.pinned": event("install", {
    connectorId: id,
    name: z.string().max(64),
    tools: z.number().int().nonnegative(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  // ── connectors: team enablement (KOBE-104); names and Pi tool names, never URLs or credentials ──
  /** A team admin enabled a connector for the team, changed its exposure or tick list, or disabled it. */
  "mcp.connector.team_changed": event("team", {
    connectorId: id,
    name: z.string().max(64),
    change: z.enum(["enabled", "exposure_changed", "disabled"]),
    exposure: z.enum(["read_only", "all", "custom"]).optional(),
    /** The custom tick list (Pi tool names); empty unless exposure is custom. */
    tools: z.array(z.string().max(256)).max(1000).optional(),
  }),
  /**
   * The periodic refresh found a connector's live tools differ from its pins (KOBE-102): `changed`
   * and `added` tools are now disabled pending re-approval, `removed` ones are no longer offered.
   * Tool names only, never descriptions or schemas. Written by the system actor; KOBE-103 reads it.
   */
  "mcp.connector.drift": event("install", {
    connectorId: id,
    name: z.string().max(64),
    changed: z.array(z.string().max(128)).max(500),
    added: z.array(z.string().max(128)).max(500),
    removed: z.array(z.string().max(128)).max(500),
  }),
  /**
   * A recipient was handled for one drift event (KOBE-103): `driftSeq` is the `mcp.connector.drift`
   * row. `emailed: false` when the per-connector, per-recipient rate limit suppressed the email.
   * Ids and counts only: no address, no tool names. Also the dedupe and rate-limit record.
   */
  "mcp.connector.drift_notified": event("install", {
    connectorId: id,
    driftSeq: z.number().int().positive(),
    recipientId: id,
    emailed: z.boolean(),
  }),
  /** An install admin re-approved drifted tools (KOBE-102); they are offered again. */
  "mcp.connector.reapproved": event("install", {
    connectorId: id,
    name: z.string().max(64),
    tools: z.array(z.string().max(128)).max(500),
  }),

  // ── memory: file memory (KOBE-155, D24); ids, versions and sizes, never paths or content ──
  /** A memory file got a new version (panel edit, personal `remember`, or an approved project write). */
  "memory.written": event("team", {
    scope: z.enum(["user", "project"]),
    memoryDocId: id,
    version,
    previousVersion: version.optional(),
    actorKind: z.enum(["user", "agent"]),
    sizeBytes: count,
  }),
  /** Undo or restore: a new version copying an earlier one (a deleted file is revived). */
  "memory.restored": event("team", {
    scope: z.enum(["user", "project"]),
    memoryDocId: id,
    fromVersion: version,
    version,
  }),
  /** A memory file was deleted (soft: its versions stay and Undo can restore it). */
  "memory.deleted": event("team", {
    scope: z.enum(["user", "project"]),
    memoryDocId: id,
    version,
  }),
  /** A team admin changed the team's memory switches. */
  "memory.settings_changed": event("team", {
    memoryEnabled: z.boolean(),
    projectMemoryEnabled: z.boolean(),
  }),
  /** An install admin changed the install-wide memory switches. */
  "memory.install_settings_changed": event("install", {
    memoryEnabled: z.boolean(),
    projectMemoryEnabled: z.boolean(),
  }),
  // ── connector grants (KOBE-108): a user's own API key; ids and names only, never the key or its hint ──
  /** A user added their API key for a connector their team enabled. */
  "mcp.grant.added": event("team", { connectorId: id, name: z.string().max(64) }),
  /** A user replaced their API key for a connector. */
  "mcp.grant.replaced": event("team", { connectorId: id, name: z.string().max(64) }),
  /** A user removed their API key for a connector. */
  "mcp.grant.removed": event("team", { connectorId: id, name: z.string().max(64) }),
  /** A stored OAuth token was not served because it was issued for another server (KOBE-109). */
  "mcp.grant.refused": event("team", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.enum(["resource_mismatch", "user_inactive"]),
  }),
  /** An OAuth refresh failed for good (KOBE-110): the grant was dropped and the user must reconnect. */
  "mcp.grant.refresh_failed": event("team", {
    connectorId: id,
    name: z.string().max(64),
    reason: z.enum(["rejected", "no_refresh_token"]),
  }),
  // ── web search (KOBE-113): provider and switches only, never the key or its hint ──
  /** An install admin set the web search provider, its enabled switch, or replaced its key. */
  "mcp.web_search.configured": event("install", {
    provider: z.enum(["brave", "tavily", "exa"]),
    enabled: z.boolean(),
    keyChanged: z.boolean(),
  }),
  /** An install admin removed the web search provider. */
  "mcp.web_search.removed": event("install", { provider: z.enum(["brave", "tavily", "exa"]) }),
  /** A team admin turned web search on or off for the team. */
  "mcp.web_search.team_changed": event("team", { enabled: z.boolean() }),
} as const;

export type AuditAction = keyof typeof AUDIT_EVENTS;
export type AuditTarget<A extends AuditAction> = z.input<(typeof AUDIT_EVENTS)[A]["target"]>;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

/** Top-level categories (`auth`, `identity`, …), for filtering. */
export const AUDIT_CATEGORIES = [...new Set(AUDIT_ACTIONS.map((a) => a.split(".")[0] ?? a))];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_EVENTS, value);
}
