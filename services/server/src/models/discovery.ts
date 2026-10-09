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
export type ModelDiscovery = Pick<BifrostAdmin, "listKeys" | "listModelInfo" | "refreshModels">;

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
  /** The subset of `models` the provider reports as accepting image input (KOBE-191). */
  readonly image_models: readonly string[];
  /** Bifrost's last list-models result for the provider's key. */
  readonly discovery: DiscoveryStatus;
  /** Why the provider refused, as a fixed sentence (never the provider's own text). */
  readonly detail: string | null;
  /** True when the list may have been cut at `MAX_LISTED_MODELS`. */
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

const MODEL_RE = new RegExp(PROVIDER_MODEL_PATTERN);

/**
 * Why a provider refused to list its models, as one of a few fixed sentences. The provider's own
 * text is never passed on: providers echo parts of the key in their errors ("Incorrect API key
 * provided: sk-…abcd"), and no redaction is reliable for every key format.
 */
const FAILURE_REASONS: readonly (readonly [RegExp, string])[] = [
  [
    /\b(401|403)\b|unauthori[sz]ed|forbidden|api.?key|authenticat|permission/i,
    "the provider refused the API key",
  ],
  [/\b429\b|rate.?limit|too many requests|quota/i, "the provider is rate-limiting requests"],
  [/\b404\b|not found/i, "the endpoint has no model list (check the base URL)"],
  [
    /timeout|timed out|refused|unreachable|no such host|dial|connection|dns|tls|certificate|\b5\d\d\b/i,
    "the provider could not be reached",
  ],
];

export function failureReason(text: string | undefined): string {
  const found = FAILURE_REASONS.find(([pattern]) => pattern.test(text ?? ""));
  return found?.[1] ?? "the provider returned an error";
}

/** Bifrost's names as catalog model ids: own provider's prefix dropped, invalid ids skipped. */
export function catalogModelIds(
  names: readonly string[],
  gatewayProvider: string,
  imageNames: ReadonlySet<string> = new Set(),
): { models: string[]; imageModels: string[]; truncated: boolean } {
  const prefix = `${gatewayProvider}/`;
  const ids = new Set<string>();
  const images = new Set<string>();
  for (const name of names) {
    const id = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!MODEL_RE.test(id)) continue;
    ids.add(id);
    if (imageNames.has(name)) images.add(id);
  }
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  const models = sorted.slice(0, MAX_LISTED_MODELS);
  return {
    models,
    imageModels: models.filter((id) => images.has(id)),
    truncated: sorted.length > MAX_LISTED_MODELS || names.length >= MAX_LISTED_MODELS,
  };
}

function statusOf(keys: readonly ObservedKey[]): {
  status: DiscoveryStatus;
  detail: string | null;
} {
  if (keys.some((k) => k.status === "success")) return { status: "ok", detail: null };
  const failed = keys.find((k) => k.status === "list_models_failed");
  if (failed) return { status: "failed", detail: failureReason(failed.description) };
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
    const listed = await discovery.listModelInfo(gatewayProvider);
    const imageNames = new Set(
      listed.filter((m) => m.inputModalities.includes("image")).map((m) => m.name),
    );
    const { models, imageModels, truncated } = catalogModelIds(
      listed.map((m) => m.name),
      gatewayProvider,
      imageNames,
    );
    const { status, detail } = statusOf(keys);
    return {
      ok: true,
      view: {
        provider_id: providerId,
        models,
        image_models: imageModels,
        discovery: status,
        detail,
        truncated,
      },
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
