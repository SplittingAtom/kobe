import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import {
  createConnector,
  createSchema,
  getConnector,
  listConnectors,
  removeConnector,
  updateConnector,
  updateSchema,
  type NameConflict,
} from "../connectors/registry.js";
import {
  approveConnectorTools,
  approveSchema,
  reviewConnectorTools,
} from "../connectors/reapproval.js";
import { pinConnector, type PinOutcome } from "../connectors/pinning.js";
import { adminPinCredential, nextPinnedBy } from "../connectors/probe-credential.js";
import { removeSiteKey, setSiteKey } from "../connectors/site-key.js";
import { connectorRefreshLocks } from "../connectors/refresh.js";
import { reprobeConnector } from "../connectors/reprobe.js";
import { reprobeReply } from "./reprobe-reply.js";
import { putGrantSchema } from "../connectors/grants.js";
import { checkConnectorUrl } from "../connectors/url-policy.js";
import { appFrameDocument, mayLoadAppFrame } from "../connectors/app-frame.js";
import {
  approveConnectorTemplates,
  approveTemplatesSchema,
  connectorTemplateFrame,
  connectorTemplateSource,
  reviewConnectorTemplates,
} from "../connectors/template-review.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { PIN_MESSAGES } from "./connector-messages.js";

const idSchema = z.uuid();

const notFound = (c: Context) =>
  c.json({ code: "not_found", message: "That connector is not registered." }, 404);

const CONFLICTS: Record<NameConflict, string> = {
  name_taken:
    "A connector with that name is already registered (names that differ only in - and _ count as the same).",
  name_removed:
    "A removed connector that teams still referenced keeps that name (names that differ only in - and _ count as the same). Pick another name.",
};
const nameConflict = (c: Context, error: NameConflict) =>
  c.json({ code: error, message: CONFLICTS[error] }, 409);

/** The `pin` part of a response: what happened to the tool surface (never the server's own text). */
/** A site-key connector is fixed by its key, not by anyone's own key (review L2). */
const SITE_AUTH_REQUIRED =
  "The server asked for credentials: set (or re-enter) this connector's site-wide key. Tools stay unpinned (none are offered).";

const pinBody = (pin: PinOutcome, connector?: { readonly credentialSource: string }) =>
  pin.ok
    ? {
        ok: true as const,
        tools: pin.tools,
        // MCP Apps templates pinned with the tools (KOBE-433), named only when there are any.
        ...(pin.templates > 0 ? { templates: pin.templates } : {}),
      }
    : {
        ok: false as const,
        failure: pin.failure,
        message:
          pin.failure === "auth_required" && connector?.credentialSource === "site"
            ? SITE_AUTH_REQUIRED
            : PIN_MESSAGES[pin.failure],
      };

const TEMPLATE_APPROVAL_MESSAGES = {
  stale: "That template changed again since you reviewed it. Review it again.",
  not_pending: "That template is not waiting for approval.",
  invalid: "That template cannot be pinned (size, type, encoding or hash). It cannot be approved.",
} as const;

const invalidFields =
  "Check the fields: name is lowercase letters and digits joined by - or _ (up to 64), url and iconUrl are https URLs, authKind is none, api_key or oauth, credentialSource is member or site (site needs api_key).";

/**
 * The site connector registry (`/v1/site/connectors`, spec D6, D27; KOBE-100): install
 * Owner/Admins register MCP servers. URLs must pass the address policy the MCP proxy enforces at
 * connect time. Every change is audited without the URL (it may carry a key).
 */
export function siteConnectorsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.connectors.manage"));

  // Pins as the acting admin: the site key, else their own grant, never a member's (KOBE-431).
  const pinAs = async (c: Context, connectorId: string) => {
    const adminId = c.get("user").id;
    return pinConnector(db, deps.connectorProbe, connectorId, {
      credential: adminPinCredential(db, deps.envelope, adminId),
      pinnedBy: await nextPinnedBy(db, deps.envelope, connectorId, adminId),
    });
  };

  const badUrl = (c: Context, check: { code: string; message: string }) =>
    c.json({ code: check.code, message: check.message }, 422);

  app.get("/", async (c) => c.json({ connectors: await listConnectors(db) }));

  app.get("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const found = id.success ? await getConnector(db, id.data) : undefined;
    return found ? c.json({ connector: found }) : notFound(c);
  });

  app.post("/", async (c) => {
    const input = await parseBody(c, createSchema);
    if (!input) return invalidRequest(c, invalidFields);
    const checked = await checkConnectorUrl(input.url, deps.connectorUrlPolicy);
    if (!checked.ok) return badUrl(c, checked);
    const result = await createConnector(db, { ...input, url: checked.url }, c.get("user").id);
    if (!result.ok) return nameConflict(c, result.error);
    // Registering snapshots and pins every tool; a failed probe leaves it registered, unpinned.
    const pin = await pinAs(c, result.connector.id);
    const connector = (await getConnector(db, result.connector.id)) ?? result.connector;
    return c.json({ connector, ...(pin ? { pin: pinBody(pin, connector) } : {}) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const input = await parseBody(c, updateSchema);
    if (!input) return invalidRequest(c, invalidFields);
    let patch = input;
    if (input.url !== undefined) {
      const checked = await checkConnectorUrl(input.url, deps.connectorUrlPolicy);
      if (!checked.ok) return badUrl(c, checked);
      patch = { ...input, url: checked.url };
    }
    const result = await updateConnector(db, id.data, patch);
    if (!result.ok) {
      if (result.error === "not_found") return notFound(c);
      if (result.error === "site_needs_api_key") {
        return invalidRequest(
          c,
          "A site-wide key is for API-key connectors only: set authKind to api_key as well.",
        );
      }
      return nameConflict(c, result.error);
    }
    // A new URL cleared the old pins; pin the new server's tools (no-op when pins still exist).
    const pin = patch.url === undefined ? undefined : await pinAs(c, id.data);
    const connector = (await getConnector(db, id.data)) ?? result.connector;
    const shown =
      pin && !(!pin.ok && pin.failure === "already_pinned") ? { pin: pinBody(pin, connector) } : {};
    return c.json({ connector, ...shown });
  });

  // Probe and pin again, for a connector that has none (the registration probe failed).
  app.post("/:id/pin", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const pin = id.success ? await pinAs(c, id.data) : undefined;
    if (!id.success || !pin) return notFound(c);
    const connector = await getConnector(db, id.data);
    return c.json(
      { connector, pin: pinBody(pin, connector) },
      pin.ok || pin.failure === "already_pinned" ? 200 : 502,
    );
  });

  // Re-probe now (KOBE-430): the refresh's probe and drift for this connector, under its lock.
  const reprobeDeps = {
    db,
    prober: deps.connectorProbe,
    envelope: deps.envelope,
    lockFor: connectorRefreshLocks(deps.database.pool),
  };
  app.post("/:id/refresh", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const result = await reprobeConnector(reprobeDeps, id.data, c.get("user").id);
    if (result.kind === "not_found") return notFound(c);
    const connector = await getConnector(db, id.data);
    const reply = reprobeReply(result, connector?.credentialSource);
    return c.json({ ...reply.body, ...(reply.status === 200 ? { connector } : {}) }, reply.status);
  });

  // The connector's site-wide key (KOBE-303): set or replace, then pin with it if unpinned.
  app.put("/:id/site-key", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = await parseBody(c, putGrantSchema);
    if (!body) {
      return invalidRequest(c, "Send the API key as api_key (8 to 2048 visible characters).");
    }
    if (!deps.envelope) {
      return c.json(
        { code: "credentials_unavailable", message: "This site cannot store credentials yet." },
        503,
      );
    }
    const result = await setSiteKey(db, deps.envelope, id.data, body.api_key, c.get("user").id);
    if (!result.ok) {
      return result.failure === "not_found"
        ? notFound(c)
        : c.json(
            {
              code: "not_site_key",
              message: "Choose 'Site-wide key' for this API-key connector first.",
            },
            409,
          );
    }
    const pin = await pinAs(c, id.data);
    const connector = await getConnector(db, id.data);
    const shown =
      pin && !(!pin.ok && pin.failure === "already_pinned") ? { pin: pinBody(pin, connector) } : {};
    return c.json({ connector, replaced: result.replaced, ...shown });
  });

  app.delete("/:id/site-key", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const removed = id.success ? await removeSiteKey(db, id.data) : undefined;
    if (removed === undefined) return notFound(c);
    return removed
      ? c.body(null, 204)
      : c.json({ code: "not_found", message: "No site-wide key is set." }, 404);
  });

  // What each tool is now: approved vs live definition, for the re-approval review (KOBE-102).
  app.get("/:id/tools", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const tools = id.success ? await reviewConnectorTools(db, id.data) : undefined;
    return tools ? c.json({ tools }) : notFound(c);
  });

  // Re-approve drifted tools, each with the hash of the live definition that was reviewed.
  app.post("/:id/tools/approve", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const input = await parseBody(c, approveSchema);
    if (!input) {
      return invalidRequest(c, "Send tools: a list of { name, sha256 } of the reviewed tools.");
    }
    const pinnedBy = await nextPinnedBy(db, deps.envelope, id.data, c.get("user").id);
    const result = await approveConnectorTools(db, id.data, input, pinnedBy);
    if (result.ok) return c.json({ approved: result.approved });
    if (result.error === "not_found") return notFound(c);
    return c.json(
      result.error === "stale"
        ? {
            code: "stale",
            tool: result.tool,
            message: "That tool changed again since you reviewed it. Review it again.",
          }
        : {
            code: "not_pending",
            tool: result.tool,
            message: "That tool is not waiting for approval.",
          },
      409,
    );
  });

  // MCP Apps templates (KOBE-434): approved vs live versions for the review, without the bytes.
  app.get("/:id/templates", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const templates = id.success ? await reviewConnectorTemplates(db, id.data) : undefined;
    return templates ? c.json({ templates }) : notFound(c);
  });

  // A template's bytes for the escaped diff and the stubbed preview: JSON only, never text/html,
  // never cached, never sniffed or run as a page on Kobe's origin (spec MA4).
  app.get("/:id/templates/source", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const uri = c.req.query("uri");
    const source =
      id.success && uri !== undefined ? await connectorTemplateSource(db, id.data, uri) : undefined;
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'");
    return source
      ? c.json({ source })
      : c.json({ code: "not_found", message: "That template is not pinned or pending." }, 404);
  });

  // The admin preview of a template's live or approved bytes (KOBE-434 review M2): text/html only
  // with the app frame's header CSP (sandbox allow-scripts: an opaque origin even top-level, no
  // network), only into a frame of Kobe's own page. Members never reach this route (site
  // permission above); MA-5's member route serves only approved templates.
  app.get("/:id/templates/frame", async (c) => {
    // Only into a frame of Kobe's own page (review LOW-1).
    if (!mayLoadAppFrame(c.req.raw.headers, deps.publicUrl)) {
      return c.json(
        { code: "forbidden_origin", message: "Only Kobe's own frames load this." },
        403,
      );
    }
    const id = idSchema.safeParse(c.req.param("id"));
    const uri = c.req.query("uri");
    const which = c.req.query("version");
    const html =
      id.success && uri !== undefined && (which === "live" || which === "approved")
        ? await connectorTemplateFrame(db, id.data, uri, which)
        : undefined;
    if (html === undefined) {
      return c.json({ code: "not_found", message: "That template version is not there." }, 404);
    }
    // The preview runs exactly the bytes the admin's source read showed (review LOW-2).
    const document = appFrameDocument(html, c.req.query("sha256"));
    if (document === "stale") {
      return c.json(
        { code: "stale", message: "The template changed. Show the source again." },
        409,
      );
    }
    return document;
  });

  // Approve templates, each with the pinned hash of the live version that was reviewed.
  app.post("/:id/templates/approve", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const input = await parseBody(c, approveTemplatesSchema);
    if (!input) {
      return invalidRequest(
        c,
        "Send templates: a list of { uri, pinnedHash } of the reviewed templates.",
      );
    }
    const result = await approveConnectorTemplates(db, id.data, input, c.get("user").id);
    if (result.ok) return c.json({ approved: result.approved });
    if (result.error === "not_found") return notFound(c);
    return c.json(
      { code: result.error, uri: result.uri, message: TEMPLATE_APPROVAL_MESSAGES[result.error] },
      409,
    );
  });

  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const result = id.success ? await removeConnector(db, id.data) : undefined;
    if (!result) return notFound(c);
    const message =
      result.teams > 0
        ? `Removed from the registry. ${result.teams} team${result.teams === 1 ? "" : "s"} had it enabled, so it is kept disabled: it is offered to no team and its calls are refused.`
        : "Removed from the registry. It is kept disabled and its name stays reserved.";
    return c.json({ ...result, message });
  });

  return app;
}
