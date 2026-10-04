import {
  PROVIDER_MODEL_PATTERN,
  eq,
  gatewayProviderName,
  modelProviders,
  type KobeDb,
  type ModelProviderKind,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { hitRateLimit, type RateLimitRule } from "../rate-limit.js";
import {
  BifrostAdminError,
  MAX_LISTED_MODELS,
  type BifrostAdmin,
  type ObservedKey,
} from "./bifrost-admin.js";

/**
 * Model discovery for the catalog editor (KOBE-44): which models a provider serves, so an install
 * admin picks a model id instead of typing it. Read through Bifrost, which already holds the
 * provider's key and is the only component allowed to reach providers (its NetworkPolicy): the
 * server never sends a provider key anywhere itself, and nothing here returns one. A refresh makes
 * Bifrost call the provider's list-models API with the key, so it is audited and rate-limited.
 */
export type ModelDiscovery = Pick<BifrostAdmin, "listKeys" | "listModels" | "refreshModels">;

export type DiscoveryStatus =
  /** The provider's list-models call worked with its key. */
  | "ok"
  /** The provider refused or failed the call (wrong key, wrong endpoint, provider down). */
  | "failed"
  /** Bifrost has not tried yet (no key, keyless provider, or no discovery since the last sync). */
  | "unknown";

export interface ProviderModelsView {
  readonly provider_id: string;
  /** Model ids as the catalog stores them (no gateway prefix), sorted, deduplicated. */
  readonly models: readonly string[];
  /** Bifrost's last list-models result for the provider's key. */
  readonly discovery: DiscoveryStatus;
  /** The provider's failure reason, scrubbed of anything that looks like a credential. */
  readonly detail: string | null;
  /** True when the list was cut at `MAX_LISTED_MODELS`. */
  readonly truncated: boolean;
}

export type DiscoveryError =
  | "provider_not_found"
  /** The gateway has not received this provider yet (the sync is behind). */
  | "provider_not_synced"
  | "gateway_unavailable"
  | "refresh_rate_limited";

export type DiscoveryResult =
  | { readonly ok: true; readonly view: ProviderModelsView }
  | { readonly ok: false; readonly error: DiscoveryError };

/** Refreshes per provider; each one is a provider call with the install's key. */
export const REFRESH_RATE: RateLimitRule = { windowMs: 60_000, max: 6 };

const DETAIL_MAX = 200;
const MODEL_RE = new RegExp(PROVIDER_MODEL_PATTERN);

/**
 * A provider's error text as safe to show: no control characters, anything long and token-like
 * (keys, bearer tokens, base64) replaced, bounded. Providers sometimes echo part of the key.
 */
export function scrubDetail(text: string | undefined): string | null {
  if (text === undefined) return null;
  const cleaned = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[A-Za-z0-9_\-+/=.:]{20,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return null;
  return cleaned.length > DETAIL_MAX ? `${cleaned.slice(0, DETAIL_MAX - 1)}…` : cleaned;
}

/** Bifrost's names as catalog model ids: own provider's prefix dropped, invalid ids skipped. */
export function catalogModelIds(
  names: readonly string[],
  gatewayProvider: string,
): { models: string[]; truncated: boolean } {
  const prefix = `${gatewayProvider}/`;
  const ids = new Set<string>();
  for (const name of names) {
    const id = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (MODEL_RE.test(id)) ids.add(id);
  }
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  return {
    models: sorted.slice(0, MAX_LISTED_MODELS),
    truncated: sorted.length > MAX_LISTED_MODELS || names.length >= MAX_LISTED_MODELS,
  };
}

function statusOf(keys: readonly ObservedKey[]): {
  status: DiscoveryStatus;
  detail: string | null;
} {
  if (keys.some((k) => k.status === "success")) return { status: "ok", detail: null };
  const failed = keys.find((k) => k.status === "list_models_failed");
  if (failed) return { status: "failed", detail: scrubDetail(failed.description) };
  return { status: "unknown", detail: null };
}

const gatewayError = (err: unknown): DiscoveryError => {
  if (err instanceof BifrostAdminError && err.status === 404) return "provider_not_synced";
  return "gateway_unavailable";
};

async function readView(
  discovery: ModelDiscovery,
  providerId: string,
  gatewayProvider: string,
): Promise<DiscoveryResult> {
  try {
    // Keys first: an unknown provider is a 404 there (the models list would just be empty).
    const keys = await discovery.listKeys(gatewayProvider);
    const names = await discovery.listModels(gatewayProvider);
    const { models, truncated } = catalogModelIds(names, gatewayProvider);
    const { status, detail } = statusOf(keys);
    return {
      ok: true,
      view: { provider_id: providerId, models, discovery: status, detail, truncated },
    };
  } catch (err) {
    return { ok: false, error: gatewayError(err) };
  }
}

async function providerRow(
  db: KobeDb,
  providerId: string,
): Promise<{ id: string; kind: ModelProviderKind } | undefined> {
  const [row] = await db
    .select({ id: modelProviders.id, kind: modelProviders.kind })
    .from(modelProviders)
    .where(eq(modelProviders.id, providerId));
  return row;
}

/** The models the gateway knows for a configured provider (Bifrost's cache; no provider call). */
export async function listProviderModels(
  db: KobeDb,
  discovery: ModelDiscovery,
  providerId: string,
): Promise<DiscoveryResult> {
  const row = await providerRow(db, providerId);
  if (!row) return { ok: false, error: "provider_not_found" };
  return readView(discovery, row.id, gatewayProviderName(row.id, row.kind));
}

/**
 * Makes the gateway ask the provider for its models now (with the stored key), then reads them.
 * Audited (`models.provider.models_refreshed`, outcome only, never provider text) and limited per
 * provider across replicas.
 */
export async function refreshProviderModels(
  db: KobeDb,
  discovery: ModelDiscovery,
  providerId: string,
  rate: RateLimitRule = REFRESH_RATE,
): Promise<DiscoveryResult> {
  const row = await providerRow(db, providerId);
  if (!row) return { ok: false, error: "provider_not_found" };
  if (!(await hitRateLimit(db, `models-refresh:${row.id}`, rate))) {
    return { ok: false, error: "refresh_rate_limited" };
  }
  const gatewayProvider = gatewayProviderName(row.id, row.kind);
  let refreshError: DiscoveryError | undefined;
  try {
    await discovery.refreshModels(gatewayProvider);
  } catch (err) {
    // 409: a refresh is already running in Bifrost; reading now shows the last result.
    if (!(err instanceof BifrostAdminError && err.status === 409)) refreshError = gatewayError(err);
  }
  const result = refreshError
    ? { ok: false as const, error: refreshError }
    : await readView(discovery, row.id, gatewayProvider);
  const outcome = !result.ok ? "unavailable" : result.view.discovery === "failed" ? "failed" : "ok";
  await db.transaction((tx) =>
    recordAudit(tx, {
      action: "models.provider.models_refreshed",
      target: {
        providerId: row.id,
        kind: row.kind,
        outcome,
        models: result.ok ? result.view.models.length : 0,
      },
    }),
  );
  return result;
}
