import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { WEB_SEARCH_PROVIDERS } from "../web-search/providers.js";
import {
  putWebSearch,
  putWebSearchSchema,
  readWebSearch,
  removeWebSearch,
} from "../web-search/store.js";

const toBody = (v: Awaited<ReturnType<typeof readWebSearch>>) => ({
  configured: v.configured,
  provider: v.provider ?? null,
  enabled: v.enabled ?? false,
  hint: v.hint ?? null,
  updated_at: v.updatedAt ?? null,
  providers: WEB_SEARCH_PROVIDERS,
});

/**
 * The install web search provider (`/v1/install/web-search`, KOBE-113). Install Owner/Admins pick
 * a provider and store its API key (sealed with the KOBE-107 envelope). The key goes in on PUT and
 * never comes back: responses carry a masked hint only.
 *
 * GET    → `{configured, provider, enabled, hint, updated_at, providers}`
 * PUT    `{provider, api_key?, enabled?}` → 200; 400 when a new provider has no `api_key`; 503 when
 *        the install has no envelope key
 * DELETE → 204; 404 when none is set
 */
export function installWebSearchRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.settings.manage"));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/", async (c) => c.json(toBody(await readWebSearch(db))));

  app.put("/", async (c) => {
    const parsed = putWebSearchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return invalidRequest(
        c,
        "Send provider (brave, tavily or exa), api_key (8 to 2048 visible characters) and optionally enabled.",
      );
    }
    if (!deps.envelope) {
      return c.json(
        { code: "credentials_unavailable", message: "This install cannot store credentials yet." },
        503,
      );
    }
    const result = await putWebSearch(db, deps.envelope, parsed.data, c.get("user").id);
    if (!result.ok) {
      return invalidRequest(c, "Send api_key when choosing a provider for the first time.");
    }
    return c.json(toBody(result.view));
  });

  app.delete("/", async (c) =>
    (await removeWebSearch(db))
      ? c.body(null, 204)
      : c.json({ code: "not_found", message: "No web search provider is set." }, 404),
  );

  return app;
}
