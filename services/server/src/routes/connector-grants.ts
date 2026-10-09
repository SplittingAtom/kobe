import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { pinConnector, type PinOutcome } from "../connectors/pinning.js";
import {
  listGrants,
  putGrant,
  putGrantSchema,
  removeGrant,
  type GrantSummary,
} from "../connectors/grants.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const idSchema = z.uuid();

/** The only shape of a grant any API returns: no key, no ciphertext. */
const summaryBody = (g: GrantSummary) => ({
  connector_id: g.connectorId,
  hint: g.hint,
  created_at: g.createdAt.toISOString(),
  updated_at: g.updatedAt.toISOString(),
});

const notAvailable = (c: Context) =>
  c.json(
    { code: "connector_not_available", message: "That connector is not enabled for your team." },
    404,
  );

/**
 * A user's own connector API keys (`/v1/connector-grants`, KOBE-108; D27: no shared team
 * credentials). The key goes in on PUT and never comes back: responses carry a masked hint and
 * timestamps only. Every request acts on the caller's own grants in the active team.
 *
 * GET    /                 → 200 `{grants: [{connector_id, hint, created_at, updated_at}]}`
 * PUT    /{connector_id}   `{api_key}` → 200 `{grant, pin?}` (201 when new); 404 not enabled;
 *                          422 `not_api_key`; 503 when the install has no envelope key
 * DELETE /{connector_id}   → 204; 404 when there is no key
 */
export function connectorGrantRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/", async (c) => {
    const grants = await listGrants(db, c.get("team").id, c.get("user").id);
    return c.json({ grants: grants.map(summaryBody) });
  });

  app.put("/:connectorId", async (c) => {
    const id = idSchema.safeParse(c.req.param("connectorId"));
    if (!id.success) return notAvailable(c);
    const body = await parseBody(c, putGrantSchema);
    if (!body) {
      return invalidRequest(c, "Send the API key as api_key (8 to 2048 visible characters).");
    }
    if (!deps.envelope) {
      return c.json(
        { code: "credentials_unavailable", message: "This install cannot store credentials yet." },
        503,
      );
    }
    const subject = { teamId: c.get("team").id, userId: c.get("user").id, connectorId: id.data };
    const result = await putGrant(db, deps.envelope, subject, body.api_key);
    if (!result.ok) {
      return result.failure === "not_available"
        ? notAvailable(c)
        : c.json(
            { code: "not_api_key", message: "That connector does not use an API key." },
            422,
          );
    }
    // The key can now pin a connector no admin could probe (it needs a credential): only while it
    // has no pins, and a failed probe never fails the save.
    const pin = await pinConnector(db, deps.connectorProbe, id.data, body.api_key);
    return c.json(
      { grant: summaryBody(result.grant), ...(pin && pinShown(pin) ? { pin: pinBody(pin) } : {}) },
      result.replaced ? 200 : 201,
    );
  });

  app.delete("/:connectorId", async (c) => {
    const id = idSchema.safeParse(c.req.param("connectorId"));
    if (!id.success) return notAvailable(c);
    const removed = await removeGrant(db, {
      teamId: c.get("team").id,
      userId: c.get("user").id,
      connectorId: id.data,
    });
    return removed ? c.body(null, 204) : c.json({ code: "not_found", message: "No key stored." }, 404);
  });

  return app;
}

const pinShown = (pin: PinOutcome) => pin.ok || pin.failure !== "already_pinned";
const pinBody = (pin: PinOutcome) =>
  pin.ok ? { ok: true as const, tools: pin.tools } : { ok: false as const, failure: pin.failure };
