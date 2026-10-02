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
const email = z.email().max(254);
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
const isolationState = z.enum(["checking", "verified", "missing"]);

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
  "identity.invitation.created": event("install", { invitationId: id, email }),
  "identity.invitation.resent": event("install", { invitationId: id, email }),
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
  "identity.team_invitation.created": event("team", { invitationId: id, email, role }),
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
} as const;

export type AuditAction = keyof typeof AUDIT_EVENTS;
export type AuditTarget<A extends AuditAction> = z.input<(typeof AUDIT_EVENTS)[A]["target"]>;

export const AUDIT_ACTIONS = Object.keys(AUDIT_EVENTS) as AuditAction[];

/** Top-level categories (`auth`, `identity`, …), for filtering. */
export const AUDIT_CATEGORIES = [...new Set(AUDIT_ACTIONS.map((a) => a.split(".")[0] ?? a))];

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_EVENTS, value);
}
