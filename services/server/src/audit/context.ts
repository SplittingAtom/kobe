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

/**
 * The client address, read from X-Forwarded-For the way Better Auth reads it for rate limits
 * (same trusted proxies): the rightmost hop that isn't a trusted proxy; without trusted proxies
 * only a single-entry header counts. Falls back to the socket's peer address.
 */
export function clientIp(c: Context, trusted: BlockList, hasTrusted: boolean): string | null {
  const hops = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const family = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");
  if (hops.length > 0) {
    if (!hasTrusted) return hops.length === 1 && isIP(hops[0] ?? "") ? (hops[0] ?? null) : null;
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i] ?? "";
      if (isIP(hop) === 0) return null;
      if (!trusted.check(hop, family(hop))) return hop;
    }
    return null;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
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
