import { Hono } from "hono";
import { listAuditEvents, verifyAuditChain } from "@kobe/db";
import { auditPageBody, parseAuditQuery } from "../audit/http.js";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";

/** Full-chain checks one admin may start per minute (each reads the whole table). */
export const INTEGRITY_CHECKS_PER_MINUTE = 3;

/**
 * The install-wide audit log (spec D6, D8; §6.1 `/v1/install/audit`), install Owner/Admin only:
 * every event, newest first, keyset-paginated (`before`/`after` = seq) and filterable by action,
 * category, actor, team and time. `GET /integrity` recomputes the hash chain.
 */
export function installAuditRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.audit.read"));

  app.get("/", async (c) => {
    const query = parseAuditQuery(c);
    if (!query.ok) return query.response;
    return c.json(auditPageBody(await listAuditEvents(db, query.value)));
  });

  /** Recomputes the whole chain; `head` is the value to anchor outside the database. */
  app.get("/integrity", async (c) => {
    const allowed = await hitRateLimit(db, `audit-integrity:${c.get("user").id}`, {
      windowMs: 60_000,
      max: INTEGRITY_CHECKS_PER_MINUTE,
    });
    if (!allowed) {
      return c.json({ code: "rate_limited", message: "Try the check again in a minute." }, 429);
    }
    return c.json(await verifyAuditChain(db));
  });

  return app;
}
