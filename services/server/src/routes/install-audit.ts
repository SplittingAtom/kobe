import { Hono } from "hono";
import { listAuditEvents, verifyAuditChain } from "@kobe/db";
import { exportResponse, parseExportQuery } from "../audit/export/http.js";
import { EXPORT_PAGE_SIZE } from "../audit/export/stream.js";
import { readForwardingHealth } from "../audit/forward/state.js";
import { auditPageBody, parseAuditQuery } from "../audit/http.js";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";

/** Exports one admin may start per minute (each streams the log). */
export const AUDIT_EXPORTS_PER_MINUTE = 6;

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

  /** CSV or JSONL download of the whole log (optionally one team) for a date range (KOBE-19). */
  app.get("/export", async (c) => {
    const parsed = parseExportQuery(c);
    if (!parsed.ok) return parsed.response;
    const actorId = c.get("user").id;
    const allowed = await hitRateLimit(db, `audit-export:${actorId}`, {
      windowMs: 60_000,
      max: AUDIT_EXPORTS_PER_MINUTE,
    });
    if (!allowed) {
      return c.json({ code: "rate_limited", message: "Try the export again in a minute." }, 429);
    }
    const { since, until, teamId } = parsed.value;
    return exportResponse(c, {
      db,
      query: parsed.value,
      scope: "install",
      actorId,
      fetchPage: (after) =>
        listAuditEvents(db, {
          after,
          limit: EXPORT_PAGE_SIZE,
          ...(since ? { since } : {}),
          ...(until ? { until } : {}),
          ...(teamId ? { teamId } : {}),
        }),
    });
  });

  /** Forwarding health (syslog, OTLP): cursor, lag, failures and the next retry (KOBE-19). */
  app.get("/forwarding", async (c) =>
    c.json(await readForwardingHealth(db, deps.auditForwardingDestinations)),
  );

  /** Recomputes the whole chain; `head` is the value to anchor outside the database. */
  app.get("/integrity", async (c) => {
    const allowed = await hitRateLimit(db, `audit-integrity:${c.get("user").id}`, {
      windowMs: 60_000,
      max: INTEGRITY_CHECKS_PER_MINUTE,
    });
    if (!allowed) {
      return c.json({ code: "rate_limited", message: "Try the check again in a minute." }, 429);
    }
    const report = await verifyAuditChain(db);
    // The head attested with a key outside the database: record it off the box (KOBE-19).
    const anchor = report.head ? deps.auditAnchor.attest(report.head.seq, report.head.hash) : null;
    return c.json({ ...report, anchor });
  });

  return app;
}
