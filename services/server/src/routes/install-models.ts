import { Hono, type Context } from "hono";
import type { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  addCatalogEntry,
  addProvider,
  deleteCatalogEntry,
  deleteProvider,
  gatewayStatus,
  listCatalog,
  listProviders,
  updateCatalogEntry,
  updateProvider,
} from "../models/admin-store.js";
import {
  addCatalogSchema,
  addProviderSchema,
  aliasSchema,
  providerIdSchema,
  updateCatalogSchema,
  updateProviderSchema,
} from "../models/schemas.js";
import { invalidRequest } from "../teams/http.js";
import {
  listProviderModels,
  refreshProviderModels,
  type DiscoveryResult,
} from "../models/discovery.js";

/** Parses a JSON body; the 400 names the first problem without echoing input (API keys). */
async function body<T>(c: Context, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (parsed.success) return { ok: true as const, value: parsed.data };
  const message = parsed.error.issues[0]?.message ?? "invalid";
  return { ok: false as const, response: invalidRequest(c, `Check the request: ${message}.`) };
}

const err = (c: Context, status: 404 | 409 | 503, code: string, message: string) =>
  c.json({ code, message }, status);
/** Endpoint rules (admin-store.ts `endpointProblem`). */
const endpointError = (c: Context, problem: "vendor_endpoint_fixed" | "insecure_endpoint") =>
  c.json(
    problem === "vendor_endpoint_fixed"
      ? {
          code: "vendor_endpoint_fixed",
          message:
            "OpenAI, Anthropic and Gemini providers use their vendor's endpoint (no base_url).",
        }
      : {
          code: "insecure_endpoint",
          message: "A provider with an API key needs an https:// base_url.",
        },
    400,
  );
/** The model picker's answer (KOBE-44): the list, or why there is none (never provider text). */
function discoveryResponse(c: Context, result: DiscoveryResult) {
  if (result.ok) return c.json(result.view);
  switch (result.error) {
    case "provider_not_found":
      return providerNotFound(c);
    case "provider_not_synced":
      return err(
        c,
        409,
        "provider_not_synced",
        "The model gateway hasn't picked up this provider yet. Try again in a few seconds.",
      );
    case "refresh_rate_limited":
      return c.json(
        {
          code: "rate_limited",
          message: "This provider's models were refreshed several times just now. Wait a minute.",
        },
        429,
      );
    case "gateway_unavailable":
      return err(
        c,
        503,
        "gateway_unavailable",
        "The model gateway can't be reached right now, so models can't be listed. Type the model id instead.",
      );
  }
}

const providerNotFound = (c: Context) =>
  err(c, 404, "provider_not_found", "That provider is not configured.");
const aliasNotFound = (c: Context) =>
  err(c, 404, "model_not_found", "That model is not in the catalog.");

/**
 * Install model administration (`/v1/install/models`, spec D6, D8, D30): providers and their API
 * keys (write-only), and the model catalog. Owner/Admins only (`install.models.manage`). Changes
 * reach Bifrost through the gateway sync; `gateway` reports whether it has caught up.
 */
export function installModelsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.models.manage"));

  app.get("/", async (c) => {
    const [providers, catalog, gateway] = await Promise.all([
      listProviders(db),
      listCatalog(db),
      gatewayStatus(db),
    ]);
    return c.json({ providers, catalog, gateway, configured: deps.models !== undefined });
  });

  app.post("/providers", async (c) => {
    if (!deps.models) {
      return err(c, 503, "models_not_configured", "The model gateway is not configured.");
    }
    const parsed = await body(c, addProviderSchema);
    if (!parsed.ok) return parsed.response;
    const result = await addProvider(
      db,
      deps.models.providerKeys,
      parsed.value,
      c.get("user").id,
      deps.models,
    );
    if (result.ok) return c.json({ provider: result.provider }, 201);
    if (result.error === "exists") {
      return err(c, 409, "provider_exists", "That provider is already configured.");
    }
    if (result.error === "too_many") {
      return err(c, 409, "too_many_providers", "The install has reached its provider limit.");
    }
    return endpointError(c, result.error);
  });

  app.patch("/providers/:id", async (c) => {
    if (!deps.models) {
      return err(c, 503, "models_not_configured", "The model gateway is not configured.");
    }
    const id = providerIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return providerNotFound(c);
    const parsed = await body(c, updateProviderSchema);
    if (!parsed.ok) return parsed.response;
    const result = await updateProvider(
      db,
      deps.models.providerKeys,
      id.data,
      parsed.value,
      deps.models,
    );
    if (result.ok) return c.json({ provider: result.provider });
    if (result.error === "not_found") return providerNotFound(c);
    if (result.error === "key_required") {
      return invalidRequest(
        c,
        "This provider needs an API key; replace it instead of removing it.",
      );
    }
    if (result.error === "base_url_required") {
      return invalidRequest(c, "This provider needs a base_url.");
    }
    if (result.error === "key_required_for_new_endpoint") {
      return c.json(
        {
          code: "key_required_for_new_endpoint",
          message: "Changing the endpoint needs the API key again (send api_key with base_url).",
        },
        400,
      );
    }
    return endpointError(c, result.error);
  });

  app.delete("/providers/:id", async (c) => {
    const id = providerIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return providerNotFound(c);
    const result = await deleteProvider(db, id.data);
    if (result === "deleted") return c.body(null, 204);
    return result === "in_use"
      ? err(c, 409, "provider_in_use", "Remove this provider's catalog models first.")
      : providerNotFound(c);
  });

  /**
   * The models a provider serves, for the catalog editor's picker (KOBE-44): read through the
   * gateway (Bifrost holds the key and reaches the provider), never returning a key.
   */
  app.get("/providers/:id/models", async (c) => {
    const discovery = deps.models?.discovery;
    if (!discovery) {
      return err(c, 503, "models_not_configured", "The model gateway is not configured.");
    }
    const id = providerIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return providerNotFound(c);
    return discoveryResponse(c, await listProviderModels(db, discovery, id.data));
  });

  /** Has the gateway ask the provider for its models now, with its key (audited, rate-limited). */
  app.post("/providers/:id/models/refresh", async (c) => {
    const discovery = deps.models?.discovery;
    if (!discovery) {
      return err(c, 503, "models_not_configured", "The model gateway is not configured.");
    }
    const id = providerIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return providerNotFound(c);
    return discoveryResponse(c, await refreshProviderModels(db, discovery, id.data));
  });

  app.post("/catalog", async (c) => {
    const parsed = await body(c, addCatalogSchema);
    if (!parsed.ok) return parsed.response;
    const result = await addCatalogEntry(db, parsed.value, c.get("user").id);
    if (result.ok) return c.json({ model: result.entry }, 201);
    if (result.error === "provider_not_found") return providerNotFound(c);
    return result.error === "exists"
      ? err(c, 409, "model_exists", "That alias is already in the catalog.")
      : err(c, 409, "too_many_models", "The catalog has reached its size limit.");
  });

  app.patch("/catalog/:alias", async (c) => {
    const alias = aliasSchema.safeParse(c.req.param("alias"));
    if (!alias.success) return aliasNotFound(c);
    const parsed = await body(c, updateCatalogSchema);
    if (!parsed.ok) return parsed.response;
    const result = await updateCatalogEntry(db, alias.data, parsed.value);
    if (result.ok) return c.json({ model: result.entry });
    return result.error === "not_found" ? aliasNotFound(c) : providerNotFound(c);
  });

  app.delete("/catalog/:alias", async (c) => {
    const alias = aliasSchema.safeParse(c.req.param("alias"));
    if (!alias.success) return aliasNotFound(c);
    return (await deleteCatalogEntry(db, alias.data)) ? c.body(null, 204) : aliasNotFound(c);
  });

  return app;
}
