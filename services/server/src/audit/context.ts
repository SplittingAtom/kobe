import { AsyncLocalStorage } from "node:async_hooks";
import { BlockList, isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuditActor } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";

/**
 * The request an audited action happens in: who (once authenticated) and from where. Set by
 * middleware for the whole request, so `recordAudit()` deep inside a store function attributes the
 * event without every signature carrying the actor. Code outside a request (jobs, the isolation
 * gate) has no context and must name its actor explicitly.
 */
export interface RequestAuditContext {
  readonly actor?: AuditActor;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestAuditContext>();

export function currentAuditContext(): RequestAuditContext | undefined {
  return storage.getStore();
}

export function runWithAuditContext<T>(context: RequestAuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = "", prefix] = cidr.split("/");
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (isIP(address) === 0) continue;
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** A plain address (IPv4-mapped IPv6 unwrapped), or null; zone ids are refused. */
function plainIp(value: string | undefined): string | null {
  if (!value || value.includes("%")) return null;
  const ip = value.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return isIP(ip) === 0 ? null : ip;
}

const familyOf = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");

/**
 * The client address for the audit record. A peer that is not a trusted proxy is the client,
 * whatever headers it sends (a forged X-Forwarded-For can't change the record). Behind a trusted
 * proxy (or in-process, with no socket), X-Forwarded-For is read the way Better Auth reads it for
 * rate limits: the rightmost hop that isn't a trusted proxy; without trusted proxies only a
 * single-entry header counts. Null when nothing trustworthy is left.
 */
export function clientIp(c: Context, trusted: BlockList, hasTrusted: boolean): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = plainIp(env?.incoming?.socket?.remoteAddress);
  if (peer && !(hasTrusted && trusted.check(peer, familyOf(peer)))) return peer;
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (!hasTrusted) return hops.length === 1 ? plainIp(hops[0]) : peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = plainIp(hops[i]);
    if (!hop) return null;
    if (!trusted.check(hop, familyOf(hop))) return hop;
  }
  return null;
}

function requestContext(deps: ServerDeps) {
  const cidrs = deps.auth.options.advanced?.ipAddress?.trustedProxies ?? [];
  const trusted = blockListOf(cidrs);
  return (c: Context, actor?: AuditActor): RequestAuditContext => ({
    ...(actor ? { actor } : {}),
    ip: clientIp(c, trusted, cidrs.length > 0),
    userAgent: c.req.header("user-agent") ?? null,
  });
}

/** Request metadata for unauthenticated routes (sign-in, setup); handlers name their actor. */
export function auditRequestContext(deps: ServerDeps): MiddlewareHandler {
  const contextOf = requestContext(deps);
  return createMiddleware(async (c, next) => runWithAuditContext(contextOf(c), next));
}

/** The signed-in user as the actor of everything audited in this request. After requireSession. */
export function auditUserContext(deps: ServerDeps) {
  const contextOf = requestContext(deps);
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) =>
    runWithAuditContext(contextOf(c, { kind: "user", id: c.get("user").id }), next),
  );
}
