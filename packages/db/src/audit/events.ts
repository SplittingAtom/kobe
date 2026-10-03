import { z } from "zod";
import { teamRole } from "../schema/team-members.js";

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

/** Wire and storage limits a sandbox can hit (KOBE-24). */
export const SANDBOX_LIMITS = [
  "frame_rate",
  "byte_rate",
  "frame_size",
  "run_events",
  "run_bytes",
  "thread_entries",
] as const;

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
    setting: z.enum(["require_two_factor"]),
    value: z.union([z.boolean(), label]),
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

  // ── thread: lifecycle metadata only, never titles or content (KOBE-34, D18, D23) ──
  "thread.trashed": event("team", { threadId: id }),
  "thread.restored": event("team", { threadId: id }),
  "thread.sharing_changed": event("team", { threadId: id, projectId: id, shared: z.boolean() }),
  /** The thread's pinned agent version changed (D19 one-click switch, KOBE-46). */
  "thread.agent_switched": event("team", {
    threadId: id,
    agentId: id,
    scope: agentScope,
    fromVersion: version,
    toVersion: version,
  }),

  // ── run: lifecycle metadata the server decides on its own (KOBE-24; never content) ──
  /** The wire ended an active run as interrupted (D14: sandbox or Pi lost; actor: system). */
  "run.interrupted": event("team", {
    runId: id,
    threadId: id,
    cause: z.enum(["sandbox_gone", "not_resumed", "pi_exited"]),
  }),
  /** The thread owner stopped a run, or deleted a queued message (D17; KOBE-30). */
  "run.cancelled": event("team", { runId: id, threadId: id, wasActive: z.boolean() }),
  /** The thread owner retried an interrupted run; `runId` is the new run (D14; KOBE-30). */
  "run.retried": event("team", { runId: id, threadId: id, retryOfRunId: id }),
  /** A run ended because a budget is used up, after its current step (D30; system). */
  "run.budget_stopped": event("team", {
    runId: id,
    threadId: id,
    scope: z.enum(["install", "team", "user"]),
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

  // ── agent: definitions (D19); team agents in the team view, personal and gallery install-only ──
  "agent.created": event("any", {
    ...agentRef,
    source: z.enum(["json", "import", "fork"]),
    forkedFrom: id.optional(),
  }),
  "agent.updated": event("any", {
    ...agentRef,
    revision: z.number().int().positive(),
    source: z.enum(["json", "import"]),
  }),
  "agent.deleted": event("any", agentRef),
  "agent.status_changed": event("any", { ...agentRef, status: z.enum(["active", "suspended"]) }),
  "agent.exported": event("any", agentRef),
  // Versions (KOBE-46): publish freezes the draft and its tool manifest; rollback republishes.
  "agent.published": event("any", { ...agentRef, version, draftRevision: version }),
  "agent.rolled_back": event("any", { ...agentRef, version, fromVersion: version }),
  /** An agent with versions retired instead of deleted (pinned threads keep their version). */
  "agent.archived": event("any", agentRef),
  "agent.unarchived": event("any", agentRef),
} as const;

export type AuditAction = keyof typeof AUDIT_EVENTS;
export type AuditTarget<A extends AuditAction> = z.input<(typeof AUDIT_EVENTS)[A]["target"]>;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

/** Top-level categories (`auth`, `identity`, …), for filtering. */
export const AUDIT_CATEGORIES = [...new Set(AUDIT_ACTIONS.map((a) => a.split(".")[0] ?? a))];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_EVENTS, value);
}
