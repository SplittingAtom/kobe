import { Hono, type Context } from "hono";
import { z } from "zod";
import { EGRESS_PRESETS } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  addCeilingDomain,
  deleteCeilingDomain,
  listCeiling,
  setCeilingFlags,
  setPresetMembership,
} from "../egress/ceiling-store.js";
import {
  DECISION_BODY_HINT,
  decideAndRespond,
  decisionWithPatternBodySchema,
} from "../egress/decision-http.js";
import { listSiteEgressRequests } from "../egress/request-store.js";
import {
  addCeilingBodySchema,
  ceilingFlagsBodySchema,
  ceilingMembershipBodySchema,
  domainPatternSchema,
  presetSchema,
} from "../egress/schemas.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const statusQuerySchema = z.enum(["pending", "approved", "denied", "all"]).default("pending");

/** Parses a JSON body; the 400 names the first problem without echoing input. */
async function body<T>(c: Context, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (parsed.success) return { ok: true as const, value: parsed.data };
  const message = parsed.error.issues[0]?.message ?? "invalid";
  return { ok: false as const, response: invalidRequest(c, `Check the request: ${message}.`) };
}

/** Shown when a ceiling domain is on shared hosting or a CDN (domain fronting, KOBE-38 docs). */
export const SHARED_HOSTING_WARNING =
  "This domain is on shared hosting or a CDN. The proxy sees only the TLS server name, so a " +
  "sandbox allowed to reach it may also reach other sites hosted behind the same front " +
  "(domain fronting). Prefer the provider's own domain if it has one.";

const notFound = (c: Context) =>
  c.json({ code: "domain_not_found", message: "That domain is not listed." }, 404);

/**
 * The site egress ceiling (`/v1/site/egress-ceiling`, spec D6, D8, D28): the domains teams
 * may enable for their sandboxes, presets included, each optionally internal (same cluster,
 * KOBE-602), and the site-scope access requests. Site Owner/Admins only.
 */
export function siteEgressRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.egress.manage"));

  app.get("/", async (c) => c.json({ domains: await listCeiling(db), presets: EGRESS_PRESETS }));

  app.post("/", async (c) => {
    const parsed = await body(c, addCeilingBodySchema);
    if (!parsed.ok) return parsed.response;
    const result = await addCeilingDomain(db, parsed.value, c.get("user").id);
    if (result.ok) {
      const warnings = result.entry.shared_hosting ? [SHARED_HOSTING_WARNING] : [];
      return c.json({ domain: result.entry, warnings }, result.created ? 201 : 200);
    }
    return result.error === "already_in_ceiling"
      ? c.json(
          { code: "already_in_ceiling", message: "That domain is already in the ceiling." },
          409,
        )
      : c.json(
          {
            code: "too_many_domains",
            message: "The ceiling has reached its domain limit. Remove one first.",
          },
          409,
        );
  });

  app.put("/presets/:preset", async (c) => {
    const preset = presetSchema.safeParse(c.req.param("preset"));
    if (!preset.success)
      return c.json({ code: "preset_not_found", message: "No such preset." }, 404);
    const parsed = await body(c, ceilingMembershipBodySchema);
    if (!parsed.ok) return parsed.response;
    await setPresetMembership(db, preset.data, parsed.value.in_ceiling);
    return c.json({ domains: await listCeiling(db), presets: EGRESS_PRESETS });
  });

  // Site-scope access requests across teams (KOBE-602, EA1): outside the ceiling or internal.
  app.get("/requests", async (c) => {
    const status = statusQuerySchema.safeParse(c.req.query("status") ?? undefined);
    if (!status.success) return invalidRequest(c, "status is pending, approved, denied or all.");
    return c.json({ requests: await listSiteEgressRequests(db, { status: status.data }) });
  });

  // The same decision as the card's, as a site admin, for any team's request (EA2, EA3).
  app.post("/requests/:teamId/:id/decision", async (c) => {
    const teamId = z.uuid().safeParse(c.req.param("teamId"));
    const id = z.uuid().safeParse(c.req.param("id"));
    const parsed = await parseBody(c, decisionWithPatternBodySchema);
    if (!parsed) return invalidRequest(c, DECISION_BODY_HINT);
    if (!teamId.success || !id.success) {
      return c.json({ code: "request_not_found", message: "That request does not exist." }, 404);
    }
    return decideAndRespond(c, deps, {
      teamId: teamId.data,
      requestId: id.data,
      adminId: c.get("user").id,
      decision: parsed.decision,
      role: "site_admin",
      pattern: parsed.pattern,
      internal: parsed.internal,
    });
  });

  app.put("/:domain", async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    const parsed = await body(c, ceilingFlagsBodySchema);
    if (!parsed.ok) return parsed.response;
    const entry = await setCeilingFlags(db, domain.data, {
      inCeiling: parsed.value.in_ceiling,
      internal: parsed.value.internal,
    });
    return entry ? c.json({ domain: entry }) : notFound(c);
  });

  app.delete("/:domain", async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    const result = await deleteCeilingDomain(db, domain.data);
    if (result === "deleted") return c.body(null, 204);
    if (result === "preset") {
      return c.json(
        {
          code: "preset_domain",
          message: "Preset domains can be taken out of the ceiling, not deleted.",
        },
        409,
      );
    }
    return notFound(c);
  });

  return app;
}
