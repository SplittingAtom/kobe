/**
 * Site console: model providers and the catalog (`/v1/site/models`, site.models.manage;
 * KOBE-40 API, KOBE-44 UI). Provider keys are write-only: the API says only whether one is set.
 */
import type { ThinkingPolicy } from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../../../api/client";

const enc = encodeURIComponent;
const BASE = "/v1/site/models";

export const PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "openai_compatible",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly allowPrivateNetwork: boolean;
  /** Whether an API key is stored; the key itself is never returned. */
  readonly keySet: boolean;
  readonly keyRevision: number;
  readonly gatewayProvider: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CatalogModel {
  readonly alias: string;
  readonly providerId: string;
  readonly model: string;
  readonly label: string | null;
  /** What the model accepts as input: always `text`, plus `image` when it can see images. */
  readonly inputModalities: readonly string[];
  /** `<gateway provider>/<model>`: what sandboxes send to the model gateway. */
  readonly gatewayModel: string;
  /** Output limit and context window in tokens (KOBE-259); null: the site default. */
  readonly maxOutputTokens: number | null;
  readonly contextWindow: number | null;
  /** The model reasons before answering: it gets the higher default output limit. */
  readonly reasoning: boolean;
  /**
   * KOBE-260: how the gateway sets its thinking (control), whether thinking may be on, the
   * default and the maximum level. Absent from an older server.
   */
  readonly thinking?: ThinkingPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a model without its own limits gets (chart values; KOBE-259). */
export interface TokenDefaults {
  readonly maxOutputTokens: number;
  readonly reasoningMaxOutputTokens: number;
  readonly contextWindow: number;
}

export interface GatewayStatus {
  readonly desiredVersion: number;
  readonly syncedVersion: number;
  readonly inSync: boolean;
  readonly lastSyncedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
}

export interface SiteModels {
  readonly providers: readonly ModelProvider[];
  readonly catalog: readonly CatalogModel[];
  readonly gateway: GatewayStatus;
  /** False when the site runs without the model gateway (no Bifrost settings). */
  readonly configured: boolean;
  /** Absent from an older server. */
  readonly tokenDefaults?: TokenDefaults;
}

export interface NewProvider {
  readonly kind: ProviderKind;
  /** OpenAI-compatible endpoints only (vendor kinds are their own id). */
  readonly id?: string | undefined;
  readonly name: string;
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly allowPrivateNetwork: boolean;
}

export interface ProviderChange {
  readonly name?: string | undefined;
  /** null clears it (vendor kinds). */
  readonly baseUrl?: string | null | undefined;
  /** A new key; null removes it (keyless kinds only). Absent: the stored key stays. */
  readonly apiKey?: string | null | undefined;
  readonly allowPrivateNetwork?: boolean | undefined;
}

export interface CatalogEntryInput {
  readonly alias: string;
  readonly providerId: string;
  readonly model: string;
  readonly label?: string | null | undefined;
  /** Sent as `["text", "image"]` or `["text"]`; absent: unchanged (update) or text only (add). */
  readonly inputModalities?: readonly string[] | undefined;
  /** null: the site default (KOBE-259); absent: unchanged (update) or the default (add). */
  readonly maxOutputTokens?: number | null | undefined;
  readonly contextWindow?: number | null | undefined;
  readonly reasoning?: boolean | undefined;
  /** KOBE-260: the whole thinking policy; absent: unchanged (update) or none (add). */
  readonly thinking?: ThinkingPolicy | undefined;
}

export type ModelDiscovery = "ok" | "failed" | "unknown";

/** What the gateway knows a provider serves (the catalog editor's model picker, KOBE-44). */
export interface ProviderModels {
  readonly providerId: string;
  readonly models: readonly string[];
  /** The models of `models` the provider reports as accepting images (KOBE-191). */
  readonly imageModels: readonly string[];
  readonly discovery: ModelDiscovery;
  /** The provider's failure reason (scrubbed by the server); null when none. */
  readonly detail: string | null;
  readonly truncated: boolean;
}

/** Drops undefined fields so PATCH bodies carry exactly what changed. */
function defined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

export function getSiteModels(): Promise<ApiResult<SiteModels>> {
  return apiRequest(BASE);
}

export async function addProvider(input: NewProvider): Promise<ApiResult<ModelProvider>> {
  const res = await apiRequest<{ provider: ModelProvider }>(`${BASE}/providers`, {
    method: "POST",
    json: defined({
      kind: input.kind,
      id: input.id,
      name: input.name,
      base_url: input.baseUrl,
      api_key: input.apiKey,
      allow_private_network: input.allowPrivateNetwork,
    }),
  });
  return res.ok ? { ...res, data: res.data.provider } : res;
}

export async function updateProvider(
  id: string,
  change: ProviderChange,
): Promise<ApiResult<ModelProvider>> {
  const res = await apiRequest<{ provider: ModelProvider }>(`${BASE}/providers/${enc(id)}`, {
    method: "PATCH",
    json: defined({
      name: change.name,
      base_url: change.baseUrl,
      api_key: change.apiKey,
      allow_private_network: change.allowPrivateNetwork,
    }),
  });
  return res.ok ? { ...res, data: res.data.provider } : res;
}

export function deleteProvider(id: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/providers/${enc(id)}`, { method: "DELETE" });
}

export async function addCatalogModel(input: CatalogEntryInput): Promise<ApiResult<CatalogModel>> {
  const res = await apiRequest<{ model: CatalogModel }>(`${BASE}/catalog`, {
    method: "POST",
    json: defined({
      alias: input.alias,
      provider_id: input.providerId,
      model: input.model,
      label: input.label ?? undefined,
      input_modalities: input.inputModalities,
      reasoning: input.reasoning,
      thinking: input.thinking,
      max_output_tokens: input.maxOutputTokens ?? undefined,
      context_window: input.contextWindow ?? undefined,
    }),
  });
  return res.ok ? { ...res, data: res.data.model } : res;
}

export async function updateCatalogModel(
  alias: string,
  change: Partial<Omit<CatalogEntryInput, "alias">>,
): Promise<ApiResult<CatalogModel>> {
  const res = await apiRequest<{ model: CatalogModel }>(`${BASE}/catalog/${enc(alias)}`, {
    method: "PATCH",
    json: defined({
      provider_id: change.providerId,
      model: change.model,
      label: change.label,
      input_modalities: change.inputModalities,
      reasoning: change.reasoning,
      thinking: change.thinking,
      max_output_tokens: change.maxOutputTokens,
      context_window: change.contextWindow,
    }),
  });
  return res.ok ? { ...res, data: res.data.model } : res;
}

export function deleteCatalogModel(alias: string): Promise<ApiResult<void>> {
  return apiRequest(`${BASE}/catalog/${enc(alias)}`, { method: "DELETE" });
}

/** The models the gateway already knows for a provider (no call to the provider). */
export function listProviderModels(id: string): Promise<ApiResult<ProviderModels>> {
  return apiRequest(`${BASE}/providers/${enc(id)}/models`);
}

/** Asks the gateway to list the provider's models now, with its key (audited). */
export function refreshProviderModels(id: string): Promise<ApiResult<ProviderModels>> {
  return apiRequest(`${BASE}/providers/${enc(id)}/models/refresh`, { method: "POST" });
}
