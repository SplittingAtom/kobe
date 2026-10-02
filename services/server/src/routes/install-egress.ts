import { Hono, type Context } from "hono";
import type { z } from "zod";
import { EGRESS_PRESETS } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  addCeilingDomain,
  deleteCeilingDomain,
  listCeiling,
  setCeilingMembership,
  setPresetMembership,
} from "../egress/ceiling-store.js";
import {
  addCeilingBodySchema,
  ceilingMembershipBodySchema,
  domainPatternSchema,
  presetSchema,
} from "../egress/schemas.js";
import { invalidRequest } from "../teams/http.js";

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
 * The install egress ceiling (`/v1/install/egress-ceiling`, spec D6, D8, D28): the domains teams
 * may enable for their sandboxes, presets included. Install Owner/Admins only.
 */
export function installEgressRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.egress.manage"));

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

  app.put("/:domain", async (c) => {
    const domain = domainPatternSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return notFound(c);
    const parsed = await body(c, ceilingMembershipBodySchema);
    if (!parsed.ok) return parsed.response;
    const entry = await setCeilingMembership(db, domain.data, parsed.value.in_ceiling);
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
