import { isIP } from "node:net";
import { z } from "zod";
import type { KobeDb, KobeTx } from "../client.js";
import { auditLog, type AuditActorKind } from "../schema/audit.js";
import { AUDIT_EVENTS, isAuditAction, type AuditAction, type AuditTarget } from "./events.js";

/** Who performed the action. `id` is null for system events and unauthenticated attempts. */
export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly id: string | null;
}

export const SYSTEM_ACTOR: AuditActor = Object.freeze({ kind: "system", id: null });

/** Request metadata recorded with the event (both optional; invalid values are dropped). */
export interface AuditRequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** One audited action: a known action, its allowlisted target, and where it belongs. */
export type AuditEvent = {
  [A in AuditAction]: {
    readonly action: A;
    readonly actor: AuditActor;
    /** Required for team-scoped actions, null/omitted for install-level ones (AUDIT_EVENTS scope). */
    readonly teamId?: string | null;
    readonly target: AuditTarget<A>;
    readonly request?: AuditRequestContext;
  };
}[AuditAction];

export interface AuditRecordRef {
  readonly id: string;
  readonly seq: number;
  readonly at: Date;
  readonly hash: string;
}

/** The event can't be recorded as given (a programming error): the action must not proceed. */
export class AuditEventError extends Error {
  override readonly name = "AuditEventError";
}

const uuid = z.uuid();
export const USER_AGENT_MAX = 256;

function checkActor(actor: AuditActor): void {
  if (!["user", "agent", "system"].includes(actor.kind)) {
    throw new AuditEventError(`audit: unknown actor kind ${JSON.stringify(actor.kind)}`);
  }
  if (actor.kind === "system" && actor.id !== null) {
    throw new AuditEventError("audit: system actors have no id");
  }
  if (actor.id !== null && !uuid.safeParse(actor.id).success) {
    throw new AuditEventError("audit: actor id must be a UUID");
  }
}

function checkTeam(action: AuditAction, teamId: string | null): void {
  const { scope } = AUDIT_EVENTS[action];
  if (scope === "install" && teamId !== null) {
    throw new AuditEventError(`audit: ${action} is install-level and takes no team`);
  }
  if (scope === "team" && teamId === null) {
    throw new AuditEventError(`audit: ${action} needs the team it belongs to`);
  }
  if (teamId !== null && !uuid.safeParse(teamId).success) {
    throw new AuditEventError("audit: team id must be a UUID");
  }
}

/** A plain IPv4/IPv6 address, or null (zone ids, ports and garbage are dropped). */
export function normalizeIp(ip: string | null | undefined): string | null {
  // node:net accepts zone ids (fe80::1%eth0); Postgres inet does not.
  if (!ip || ip.includes("%")) return null;
  const bare = ip.trim().replace(/^\[|\]$/g, "");
  return isIP(bare) === 0 ? null : bare;
}

/** Control characters removed, trimmed, at most USER_AGENT_MAX characters; null when empty. */
export function normalizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  // eslint-disable-next-line no-control-regex
  const clean = ua.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean === "" ? null : [...clean].slice(0, USER_AGENT_MAX).join("");
}

/**
 * Records one audited action **inside the transaction that performs it** (spec D31), so the action
 * and its audit row commit or roll back together. Takes a transaction, never the pool: an audit
 * row must not outlive a rolled-back action. Call it as the last write of the transaction: the
 * append holds the audit chain lock until commit.
 *
 * Throws AuditEventError for an unknown action, a target outside the action's allowlist, or a team
 * that doesn't match the action's scope; the caller's transaction then rolls back.
 */
export async function audit(tx: KobeTx, event: AuditEvent): Promise<AuditRecordRef> {
  const { action } = event;
  if (!isAuditAction(action)) {
    throw new AuditEventError(`audit: unknown action ${JSON.stringify(action)}`);
  }
  checkActor(event.actor);
  const teamId = event.teamId ?? null;
  checkTeam(action, teamId);
  const target = AUDIT_EVENTS[action].target.safeParse(event.target);
  if (!target.success) {
    const fields = target.error.issues.map((i) => i.path.join(".") || i.code).join(", ");
    throw new AuditEventError(`audit: ${action} target rejected (${fields})`);
  }
  const [row] = await tx
    .insert(auditLog)
    .values({
      teamId,
      actorKind: event.actor.kind,
      actorId: event.actor.id,
      action,
      target: target.data as Record<string, unknown>,
      ip: normalizeIp(event.request?.ip),
      userAgent: normalizeUserAgent(event.request?.userAgent),
    })
    .returning({ id: auditLog.id, seq: auditLog.seq, at: auditLog.at, hash: auditLog.hash });
  if (!row) throw new Error("audit: insert returned no row");
  return row;
}

/**
 * Records an event in a transaction of its own. Only for actions whose write Kobe doesn't control
 * (Better Auth's sign-in and credential endpoints), for reads (export) and for system observations
 * (isolation state): the action has already happened, so this is best effort by nature.
 */
export async function auditStandalone(db: KobeDb, event: AuditEvent): Promise<AuditRecordRef> {
  return db.transaction((tx) => audit(tx, event));
}
