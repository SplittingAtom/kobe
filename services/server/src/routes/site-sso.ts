import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { validateDiscovery, type DiscoveryReport, type DiscoveryTarget } from "../sso/discovery.js";
import { issuerFor } from "../sso/issuer.js";
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
  type ProviderPatch,
} from "../sso/providers.js";
import {
  accessClaimSchema,
  clientIdSchema,
  clientSecretSchema,
  displayNameSchema,
  emailDomainsSchema,
  kindDefaults,
  maxSessionHoursSchema,
  mfaRuleSchema,
  slugSchema,
  subjectClaimSchema,
} from "../sso/schemas.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";

/** Discovery tests (save or the Test button) one site admin may run per minute: outbound calls. */
export const SSO_TESTS_PER_ADMIN_PER_MINUTE = 20;

const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entra"), tenantId: z.string().max(100) }).strict(),
  z.object({ kind: z.literal("oidc"), issuer: z.string().max(2048) }).strict(),
]);

const common = {
  displayName: displayNameSchema,
  clientId: clientIdSchema,
  subjectClaim: subjectClaimSchema.optional(),
  accessClaim: accessClaimSchema.default("roles"),
  mfaRule: mfaRuleSchema.optional(),
  allowedEmailDomains: emailDomainsSchema.default([]),
  jitProvisioning: z.boolean().default(true),
  maxSessionHours: maxSessionHoursSchema.nullable().default(null),
};

const createSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("entra"),
      slug: slugSchema,
      tenantId: z.string().max(100),
      clientSecret: clientSecretSchema,
      ...common,
    })
    .strict(),
  z
    .object({
      kind: z.literal("oidc"),
      slug: slugSchema,
      issuer: z.string().max(2048),
      clientSecret: clientSecretSchema,
      ...common,
    })
    .strict(),
]);

/** Kind and slug never change (the slug is in the redirect URI pasted into the IdP). */
const patchSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    tenantId: z.string().max(100).optional(),
    issuer: z.string().max(2048).optional(),
    clientId: clientIdSchema.optional(),
    clientSecret: clientSecretSchema.optional(),
    subjectClaim: subjectClaimSchema.optional(),
    accessClaim: accessClaimSchema.optional(),
    mfaRule: mfaRuleSchema.optional(),
    allowedEmailDomains: emailDomainsSchema.optional(),
    jitProvisioning: z.boolean().optional(),
    maxSessionHours: maxSessionHoursSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const notFound = (c: Context) =>
  c.json({ code: "not_found", message: "No such single sign-on provider." }, 404);

const FAILURES = {
  slug_taken: [409, "Another provider already uses that slug."],
  credentials_unavailable: [
    503,
    "This site cannot store client secrets yet: the envelope key (envelope.keySecret) is missing.",
  ],
  managed_by_helm: [
    409,
    "This provider is set in the chart's values (auth.sso.providers); change it there.",
  ],
  identities_linked: [
    409,
    "People have signed in with this provider. Disable it instead of deleting it.",
  ],
} as const;

function failure(c: Context, code: keyof typeof FAILURES) {
  const [status, message] = FAILURES[code];
  return c.json({ code, message }, status);
}

/**
 * Single sign-on providers (`/v1/site/sso/providers`, spec sso-oidc-scim §4; KOBE-626), for
 * `site.users.manage`. Saving runs discovery and refuses on failure; the Test endpoints run it
 * alone and report each check. The client secret is write-only: sent on create or to replace it,
 * never returned (views say `set` or `missing`). Helm providers are read-only here. With
 * `auth.sso.enabled: false` every route answers 404, as if single sign-on did not exist.
 */
export function siteSsoRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  // Read per request, not at construction (createApp builds every router up front).
  const storeOf = () => deps.sso.providers;
  // The kill switch first: nothing about SSO is visible, not even to site admins.
  app.use(async (c, next) => {
    if (!deps.sso.settings.enabled) {
      return c.json({ code: "not_found", message: "Not found." }, 404);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(requireSitePermission("site.users.manage"));

  /** Runs discovery within the admin's per-minute cap; undefined when over it (429 sent). */
  async function discover(c: Context<{ Variables: AuthVariables }>, t: DiscoveryTarget) {
    const allowed = await hitRateLimit(deps.database.db, `sso-test:${c.get("user").id}`, {
      windowMs: 60_000,
      max: SSO_TESTS_PER_ADMIN_PER_MINUTE,
    });
    if (!allowed) return undefined;
    return validateDiscovery(deps.sso.net, t);
  }
  const tooMany = (c: Context) =>
    c.json({ code: "rate_limited", message: "Too many discovery tests. Try again later." }, 429);
  const refused = (c: Context, report: DiscoveryReport) =>
    c.json(
      {
        code: "discovery_failed",
        message: report.message ?? "Discovery failed.",
        discovery: report,
      },
      422,
    );

  app.get("/providers", async (c) => c.json({ providers: await listProviders(storeOf()) }));

  app.get("/providers/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const provider = id.success ? await getProvider(storeOf(), id.data) : undefined;
    return provider ? c.json({ provider }) : notFound(c);
  });

  /** The Test button on an unsaved form: what saving would check. */
  app.post("/providers/test", async (c) => {
    const body = await parseBody(c, target);
    if (!body) return invalidRequest(c, "Give the kind and the tenant ID or issuer.");
    const report = await discover(c, body);
    return report ? c.json({ discovery: report }) : tooMany(c);
  });

  /** The Test button of a saved provider (Helm ones included). */
  app.post("/providers/:id/test", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const provider = id.success ? await getProvider(storeOf(), id.data) : undefined;
    if (!provider) return notFound(c);
    const t: DiscoveryTarget =
      provider.kind === "entra"
        ? { kind: "entra", tenantId: provider.tenantId ?? "" }
        : { kind: "oidc", issuer: provider.issuer };
    const report = await discover(c, t);
    return report ? c.json({ discovery: report }) : tooMany(c);
  });

  app.post("/providers", async (c) => {
    const body = await parseBody(c, createSchema);
    if (!body) return invalidRequest(c, "Check the provider's fields and try again.");
    if (!deps.envelope) return failure(c, "credentials_unavailable");
    const t: DiscoveryTarget =
      body.kind === "entra"
        ? { kind: "entra", tenantId: body.tenantId }
        : { kind: "oidc", issuer: body.issuer };
    const report = await discover(c, t);
    if (!report) return tooMany(c);
    if (!report.ok || report.issuer === null) return refused(c, report);
    const defaults = kindDefaults(body.kind);
    const result = await createProvider(
      storeOf(),
      {
        slug: body.slug,
        kind: body.kind,
        displayName: body.displayName,
        issuer: report.issuer,
        tenantId: body.kind === "entra" ? body.tenantId.trim().toLowerCase() : null,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        subjectClaim: body.subjectClaim ?? defaults.subjectClaim,
        accessClaim: body.accessClaim,
        mfaRule: body.mfaRule ?? defaults.mfaRule,
        allowedEmailDomains: body.allowedEmailDomains,
        jitProvisioning: body.jitProvisioning,
        maxSessionHours: body.maxSessionHours,
      },
      c.get("user").id,
    );
    if (!result.ok) return failure(c, result.failure);
    return c.json({ provider: result.provider, discovery: report }, 201);
  });

  app.patch("/providers/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const body = await parseBody(c, patchSchema);
    if (!body) return invalidRequest(c, "Check the provider's fields and try again.");
    const current = await getProvider(storeOf(), id.data);
    if (!current) return notFound(c);
    if (current.managedBy === "helm") return failure(c, "managed_by_helm");
    const { tenantId, issuer, ...rest } = body;
    if (current.kind === "entra" ? issuer !== undefined : tenantId !== undefined) {
      return invalidRequest(
        c,
        current.kind === "entra"
          ? "An Entra provider is set by its tenant ID."
          : "A generic provider is set by its issuer.",
      );
    }
    // Absent fields stay as they are (exact optional types: no explicit undefined).
    const patch: { -readonly [K in keyof ProviderPatch]: ProviderPatch[K] } = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    let discovery: DiscoveryReport | undefined;
    // A new tenant or issuer is discovered again before it is saved.
    const t: DiscoveryTarget | undefined =
      tenantId !== undefined
        ? { kind: "entra", tenantId }
        : issuer !== undefined
          ? { kind: "oidc", issuer }
          : undefined;
    if (t) {
      const pinned = issuerFor(t);
      if (!pinned.ok || pinned.issuer !== current.issuer) {
        discovery = await discover(c, t);
        if (!discovery) return tooMany(c);
        if (!discovery.ok || discovery.issuer === null) return refused(c, discovery);
      }
      if (pinned.ok) {
        patch.issuer = pinned.issuer;
        if (t.kind === "entra") patch.tenantId = t.tenantId.trim().toLowerCase();
      }
    }
    const result = await updateProvider(storeOf(), id.data, patch);
    if (!result.ok)
      return result.failure === "not_found" ? notFound(c) : failure(c, result.failure);
    return c.json({ provider: result.provider, ...(discovery ? { discovery } : {}) });
  });

  app.delete("/providers/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const result = await deleteProvider(storeOf(), id.data);
    if (result.ok) return c.body(null, 204);
    return result.failure === "not_found" ? notFound(c) : failure(c, result.failure);
  });

  return app;
}
