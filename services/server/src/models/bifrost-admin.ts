/**
 * The subset of Bifrost's admin API (v2.2, `/api/*`) the gateway sync uses (KOBE-40). Admin calls
 * authenticate with `Authorization: Bearer base64(user:password)` (Bifrost's local-admin form;
 * plain Basic is treated as an inference credential and refused on admin routes).
 *
 * Errors carry the method, path and status only: never a request body (provider keys) or a
 * response body (virtual key values).
 */

export interface ObservedKey {
  readonly id: string;
  readonly name: string;
}

export interface ObservedProvider {
  readonly name: string;
  readonly baseUrl: string | undefined;
  readonly allowPrivateNetwork: boolean;
  /** Custom (OpenAI-compatible) provider without keys. */
  readonly keyless: boolean;
  readonly custom: boolean;
}

export interface ObservedCustomer {
  readonly id: string;
  readonly name: string;
}

export interface ObservedTeam {
  readonly id: string;
  readonly name: string;
  readonly customerId: string | undefined;
}

export interface ObservedVirtualKey {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly isActive: boolean;
  readonly teamId: string | undefined;
  /** provider → allowed models (sorted), only providers with a config row. */
  readonly models: Readonly<Record<string, readonly string[]>>;
  /** Every provider config may use every key of its provider. */
  readonly allKeys: boolean;
}

/** Budgets and rate limits Bifrost enforces (KOBE-42 fills these; KOBE-40 sends none). */
export interface GatewayLimits {
  readonly budgets?: readonly { readonly max_limit: number; readonly reset_duration: string }[];
  readonly rate_limit?: Readonly<Record<string, number | string>>;
}

export interface ProviderSpec {
  readonly name: string;
  /** `openai_compatible` providers are Bifrost custom providers on the OpenAI base. */
  readonly custom: boolean;
  readonly keyless: boolean;
  readonly baseUrl: string | undefined;
  readonly allowPrivateNetwork: boolean;
}

export interface KeySpec {
  readonly name: string;
  readonly value: string;
  /** Ollama keys carry the server URL. */
  readonly ollamaUrl?: string;
}

export interface VirtualKeySpec {
  readonly name: string;
  readonly teamId: string;
  readonly models: Readonly<Record<string, readonly string[]>>;
  readonly limits?: GatewayLimits | undefined;
}

export interface BifrostAdmin {
  listProviders(): Promise<ObservedProvider[]>;
  listKeys(provider: string): Promise<ObservedKey[]>;
  addProvider(spec: ProviderSpec): Promise<void>;
  updateProvider(spec: ProviderSpec): Promise<void>;
  deleteProvider(name: string): Promise<void>;
  addKey(provider: string, key: KeySpec): Promise<void>;
  deleteKey(provider: string, id: string): Promise<void>;
  listCustomers(): Promise<ObservedCustomer[]>;
  addCustomer(name: string, limits?: GatewayLimits): Promise<ObservedCustomer>;
  deleteCustomer(id: string): Promise<void>;
  listTeams(): Promise<ObservedTeam[]>;
  addTeam(name: string, customerId: string, limits?: GatewayLimits): Promise<ObservedTeam>;
  updateTeam(id: string, customerId: string): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  listVirtualKeys(): Promise<ObservedVirtualKey[]>;
  addVirtualKey(spec: VirtualKeySpec): Promise<{ id: string; value: string }>;
  updateVirtualKey(id: string, spec: VirtualKeySpec): Promise<void>;
  deleteVirtualKey(id: string): Promise<void>;
}

export class BifrostAdminError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | undefined,
  ) {
    super(
      status === undefined
        ? `bifrost admin ${method} ${path}: unreachable`
        : `bifrost admin ${method} ${path}: HTTP ${status}`,
    );
    this.name = "BifrostAdminError";
  }

  /** Machine-readable cause for `model_gateway_state.last_error`. */
  get code(): "bifrost_unreachable" | "bifrost_unauthorized" | "bifrost_rejected" {
    if (this.status === undefined) return "bifrost_unreachable";
    if (this.status === 401 || this.status === 403) return "bifrost_unauthorized";
    return "bifrost_rejected";
  }
}

export interface HttpBifrostAdminOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
const record = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(record) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const enc = encodeURIComponent;

/** Bifrost's request body for a VK's limits (KOBE-42 seam): omitted fields are left as they are. */
const limitsBody = (limits: GatewayLimits | undefined): Json => ({
  ...(limits?.budgets ? { budgets: limits.budgets } : {}),
  ...(limits?.rate_limit ? { rate_limit: limits.rate_limit } : {}),
});

const providerBody = (spec: ProviderSpec): Json => ({
  network_config: {
    ...(spec.baseUrl ? { base_url: spec.baseUrl } : {}),
    allow_private_network: spec.allowPrivateNetwork,
    // Bifrost's defaults leave timeouts at 0 (none); model calls may stream for minutes.
    default_request_timeout_in_seconds: 600,
    max_retries: 0,
    retry_backoff_initial: 500,
    retry_backoff_max: 5000,
  },
  concurrency_and_buffer_size: { concurrency: 1000, buffer_size: 5000 },
  ...(spec.custom
    ? { custom_provider_config: { base_provider_type: "openai", is_key_less: spec.keyless } }
    : {}),
});

/** A virtual key with no allowed model is deactivated: never rely on how Bifrost reads `[]`. */
export const vkActive = (spec: Pick<VirtualKeySpec, "models">): boolean =>
  Object.values(spec.models).some((m) => m.length > 0);

/** Every provider config of a VK may use all of its provider's keys (Kobe has one per provider). */
const vkBody = (spec: VirtualKeySpec): Json => ({
  name: spec.name,
  team_id: spec.teamId,
  is_active: vkActive(spec),
  provider_configs: Object.entries(spec.models).map(([provider, models]) => ({
    provider,
    allowed_models: [...models],
    key_ids: ["*"],
  })),
  ...limitsBody(spec.limits),
});

export function createHttpBifrostAdmin(options: HttpBifrostAdminOptions): BifrostAdmin {
  const base = options.baseUrl.replace(/\/+$/, "");
  const auth = `Bearer ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call(method: string, path: string, body?: Json): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new BifrostAdminError(method, path, undefined);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new BifrostAdminError(method, path, res.status);
    }
    const text = await res.text();
    if (text === "") return {};
    try {
      return record(JSON.parse(text));
    } catch {
      throw new BifrostAdminError(method, path, res.status);
    }
  }

  return {
    async listProviders() {
      const res = await call("GET", "/api/providers");
      return list(res.providers).map((p) => {
        const net = record(p.network_config);
        const custom = record(p.custom_provider_config);
        return {
          name: str(p.name) ?? "",
          baseUrl: str(net.base_url) || undefined,
          allowPrivateNetwork: net.allow_private_network === true,
          keyless: custom.is_key_less === true,
          custom: p.custom_provider_config != null,
        };
      });
    },
    async listKeys(provider) {
      const res = await call("GET", `/api/providers/${enc(provider)}/keys`);
      return list(res.keys).map((k) => ({ id: str(k.id) ?? "", name: str(k.name) ?? "" }));
    },
    async addProvider(spec) {
      await call("POST", "/api/providers", { provider: spec.name, ...providerBody(spec) });
    },
    async updateProvider(spec) {
      await call("PUT", `/api/providers/${enc(spec.name)}`, providerBody(spec));
    },
    async deleteProvider(name) {
      await call("DELETE", `/api/providers/${enc(name)}`);
    },
    async addKey(provider, key) {
      await call("POST", `/api/providers/${enc(provider)}/keys`, {
        name: key.name,
        value: key.value,
        models: ["*"],
        weight: 1,
        ...(key.ollamaUrl ? { ollama_key_config: { url: key.ollamaUrl } } : {}),
      });
    },
    async deleteKey(provider, id) {
      await call("DELETE", `/api/providers/${enc(provider)}/keys/${enc(id)}`);
    },
    async listCustomers() {
      const res = await call("GET", "/api/governance/customers");
      return list(res.customers).map((c) => ({ id: str(c.id) ?? "", name: str(c.name) ?? "" }));
    },
    async addCustomer(name, limits) {
      const res = await call("POST", "/api/governance/customers", { name, ...limitsBody(limits) });
      const c = record(res.customer);
      return { id: str(c.id) ?? "", name: str(c.name) ?? name };
    },
    async deleteCustomer(id) {
      await call("DELETE", `/api/governance/customers/${enc(id)}`);
    },
    async listTeams() {
      const res = await call("GET", "/api/governance/teams");
      return list(res.teams).map((t) => ({
        id: str(t.id) ?? "",
        name: str(t.name) ?? "",
        customerId: str(t.customer_id),
      }));
    },
    async addTeam(name, customerId, limits) {
      const res = await call("POST", "/api/governance/teams", {
        name,
        customer_id: customerId,
        ...limitsBody(limits),
      });
      const t = record(res.team);
      return { id: str(t.id) ?? "", name: str(t.name) ?? name, customerId: str(t.customer_id) };
    },
    async updateTeam(id, customerId) {
      await call("PUT", `/api/governance/teams/${enc(id)}`, { customer_id: customerId });
    },
    async deleteTeam(id) {
      await call("DELETE", `/api/governance/teams/${enc(id)}`);
    },
    async listVirtualKeys() {
      const res = await call("GET", "/api/governance/virtual-keys");
      return list(res.virtual_keys).map((v) => {
        const configs = list(v.provider_configs);
        const models: Record<string, string[]> = {};
        for (const pc of configs) {
          const provider = str(pc.provider);
          if (!provider) continue;
          const allowed = Array.isArray(pc.allowed_models)
            ? pc.allowed_models.filter((m): m is string => typeof m === "string")
            : [];
          models[provider] = [...allowed].sort();
        }
        return {
          id: str(v.id) ?? "",
          name: str(v.name) ?? "",
          value: str(v.value) ?? "",
          isActive: v.is_active !== false,
          teamId: str(v.team_id),
          models,
          allKeys: configs.every((pc) => pc.allow_all_keys === true),
        };
      });
    },
    async addVirtualKey(spec) {
      const res = await call("POST", "/api/governance/virtual-keys", vkBody(spec));
      const v = record(res.virtual_key);
      const id = str(v.id);
      const value = str(v.value);
      if (!id || !value) throw new BifrostAdminError("POST", "/api/governance/virtual-keys", 200);
      return { id, value };
    },
    async updateVirtualKey(id, spec) {
      await call("PUT", `/api/governance/virtual-keys/${enc(id)}`, vkBody(spec));
    },
    async deleteVirtualKey(id) {
      await call("DELETE", `/api/governance/virtual-keys/${enc(id)}`);
    },
  };
}
