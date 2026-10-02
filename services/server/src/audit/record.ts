import {
  AuditEventError,
  audit,
  type AuditActor,
  type AuditEvent,
  type AuditRecordRef,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { logger } from "../logger.js";
import { currentAuditContext } from "./context.js";

type Distribute<T> = T extends unknown ? Omit<T, "actor" | "request"> : never;

/** An audit event as server code writes it: the actor and request come from the request context. */
export type ServerAuditEvent = Distribute<AuditEvent> & { readonly actor?: AuditActor };

function complete(event: ServerAuditEvent): AuditEvent {
  const context = currentAuditContext();
  const actor = event.actor ?? context?.actor;
  if (!actor) {
    throw new AuditEventError(`audit: ${event.action} has no actor (outside a signed-in request)`);
  }
  // A system event is not the request's doing (e.g. an isolation re-check run by a request):
  // it carries no client address.
  const request =
    actor.kind === "system"
      ? {}
      : { ip: context?.ip ?? null, userAgent: context?.userAgent ?? null };
  return { ...event, actor, request } as AuditEvent;
}

/**
 * Records `event` in `tx`, the transaction performing the action (KOBE-15): both commit or roll
 * back together. The actor defaults to the signed-in user of the current request. Make it the last
 * write of the transaction (it holds the audit chain lock until commit).
 */
export function recordAudit(tx: KobeTx, event: ServerAuditEvent): Promise<AuditRecordRef> {
  return audit(tx, complete(event));
}

/**
 * Records an event that has no transaction of Kobe's to join (Better Auth endpoints, reads such as
 * export, system observations). Never throws: the action already happened, so a failed write is
 * logged at error level (operators alert on it) instead of failing the response.
 */
export async function recordAuditAfter(db: KobeDb, event: ServerAuditEvent): Promise<void> {
  try {
    const full = complete(event);
    await db.transaction((tx) => audit(tx, full));
  } catch (err) {
    logger.error({ err, action: event.action }, "audit event could not be recorded");
  }
}
