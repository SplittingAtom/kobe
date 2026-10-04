import { injectedHeadersSchema } from "@kobe/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { clearTeamDomainHeaders, setTeamDomainHeaders } from "../egress/header-store.js";
import { deliverEgressRequestNotifications } from "../egress/request-notify.js";
import { decideEgressRequest, listTeamEgressRequests } from "../egress/request-store.js";
import { domainPatternSchema } from "../egress/schemas.js";
import { disableTeamDomain, enableTeamDomain, listTeamEgress } from "../egress/team-store.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const notFound = (c: Context) =>
  c.json({ code: "domain_not_found", message: "That domain is not enabled." }, 404);

const notInCeiling = (c: Context) =>
  c.json(
    {
      code: "not_in_ceiling",
      message: "That domain is not in the install's egress ceiling. Ask an install admin.",
    },
    409,
  );

const headersBodySchema = z.strictObject({ headers: injectedHeadersSchema });
const decisionBodySchema = z.strictObject({ decision: z.enum(["approve", "deny"]) });
const statusQuerySchema = z.enum(["pending", "approved", "denied", "all"]).default("pending");

/**
 * Team egress (`/v1/team/egress`, spec D6, D8, D28). Every member can see what the team's sandboxes
 * may reach (it explains blocked requests); only team admins enable or disable domains, within the
 * install ceiling, decide access requests (KOBE-39) and configure injected headers (write-only:
 * names are listed, values never leave the server except sealed to the egress proxy). Members never
 * self-allow (D28): they ask through `/v1/egress/requests`.
 */
export function teamEgressRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) =>
    c.json({
      domains: await listTeamEgress(db, c.get("team").id),
      header_injection: deps.egressHeaders !== undefined,
    }),
  );

  app.put("/domains/:domain", requireTeamPermission("team.egress.manage"), async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notInCeiling(c);
    const result = await enableTeamDomain(db, c.get("team").id, domain.data, c.get("user").id);
    if (result === "not_in_ceiling") return notInCeiling(c);
    return c.json({ domain: domain.data, enabled: true }, result === "enabled" ? 201 : 200);
  });

  app.delete("/domains/:domain", requireTeamPermission("team.egress.manage"), async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    return (await disableTeamDomain(db, c.get("team").id, domain.data))
      ? c.body(null, 204)
      : notFound(c);
  });

  // Header injection (KOBE-39): replaces the domain's whole list; values are write-only.
  app.put("/domains/:domain/headers", requireTeamPermission("team.egress.manage"), async (c) => {
    const box = deps.egressHeaders;
    if (!box) {
      return c.json(
        {
          code: "header_injection_unavailable",
          message:
            "Header injection is not configured on this install (KOBE_EGRESS_HEADER_SECRET).",
        },
        503,
      );
    }
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    const body = await parseBody(c, headersBodySchema);
    if (!body) {
      return invalidRequest(
        c,
        'Send {"headers": [{"name", "value"}]}: 1–8 headers, valid names (not Host, ' +
          "Content-Length, Connection, Proxy-*, …), visible ASCII values without line breaks.",
      );
    }
    const result = await setTeamDomainHeaders(db, box, {
      teamId: c.get("team").id,
      domain: domain.data,
      userId: c.get("user").id,
      headers: body.headers,
    });
    if (result === "not_enabled") return notFound(c);
    return c.json({ domain: domain.data, header_names: body.headers.map((h) => h.name) });
  });

  app.delete("/domains/:domain/headers", requireTeamPermission("team.egress.manage"), async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    const result = await clearTeamDomainHeaders(db, {
      teamId: c.get("team").id,
      domain: domain.data,
      userId: c.get("user").id,
    });
    return result === "not_enabled" ? notFound(c) : c.body(null, 204);
  });

  // Request access (KOBE-39): the team's requests and the admins' decisions.
  app.get("/requests", requireTeamPermission("team.egress.manage"), async (c) => {
    const status = statusQuerySchema.safeParse(c.req.query("status") ?? undefined);
    if (!status.success) return invalidRequest(c, "status is pending, approved, denied or all.");
    return c.json({
      requests: await listTeamEgressRequests(db, c.get("team").id, { status: status.data }),
    });
  });

  app.post("/requests/:id", requireTeamPermission("team.egress.manage"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const body = await parseBody(c, decisionBodySchema);
    if (!body) return invalidRequest(c, 'Send {"decision": "approve" | "deny"}.');
    const teamId = c.get("team").id;
    const result = id.success
      ? await decideEgressRequest(db, {
          teamId,
          requestId: id.data,
          adminId: c.get("user").id,
          decision: body.decision,
        })
      : { kind: "not_found" as const };
    if (result.kind === "not_in_ceiling") return notInCeiling(c);
    if (result.kind === "not_found") {
      return c.json({ code: "request_not_found", message: "That request does not exist." }, 404);
    }
    if (result.kind === "already_decided") {
      return c.json(
        {
          code: "already_decided",
          message: `That request was already ${result.request.status}.`,
          request: result.request,
        },
        409,
      );
    }
    deps.background.run(
      "egress request notification failed",
      () => deliverEgressRequestNotifications(deps, teamId),
      { team: teamId },
    );
    return c.json({ request: result.request, settled: result.settled, enabled: result.enabled });
  });

  return app;
}
