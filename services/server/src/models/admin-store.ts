import {
  asc,
  bumpModelsConfig,
  count,
  eq,
  gatewayProviderName,
  modelCatalog,
  modelGatewayState,
  modelProviders,
  providerKeyContext,
  sql,
  type KobeDb,
  type ModelProviderKind,
  type SecretBox,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import {
  MAX_CATALOG_ENTRIES,
  MAX_PROVIDERS,
  type AddCatalogInput,
  type AddProviderInput,
  type UpdateCatalogInput,
  type UpdateProviderInput,
} from "./schemas.js";

/**
 * Install model administration (spec D6, D8, D30; `/v1/install/models`): providers with their API
 * keys, and the model catalog. Every change is audited and bumps the gateway's desired version
 * with a change hint in the same transaction (the sync pushes it to Bifrost). API keys are sealed
 * before they reach the database and are never returned.
 */
export interface ProviderView {
  readonly id: string;
  readonly kind: ModelProviderKind;
  readonly name: string;
  readonly base_url: string | null;
  readonly allow_private_network: boolean;
  /** Whether an API key is stored (the key itself is write-only). */
  readonly key_set: boolean;
  /** How many times the key was set or replaced. */
  readonly key_revision: number;
  /** Bifrost's provider name: sandboxes name models `<gateway_provider>/<model>`. */
  readonly gateway_provider: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CatalogView {
  readonly alias: string;
  readonly provider_id: string;
  readonly model: string;
  readonly label: string | null;
  /** The model id to send to the gateway (`<gateway provider>/<model>`). */
  readonly gateway_model: string;
  /** Dollars per million tokens (KOBE-43); null: not set (cache prices then use the input's). */
  readonly input_usd_per_mtok: number | null;
  readonly output_usd_per_mtok: number | null;
  readonly cache_read_usd_per_mtok: number | null;
  readonly cache_write_usd_per_mtok: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GatewayStatusView {
  readonly desired_version: number;
  readonly synced_version: number;
  /** Bifrost reflects every committed change. */
  readonly in_sync: boolean;
  readonly last_synced_at: string | null;
  readonly last_attempt_at: string | null;
  readonly last_error: string | null;
}

type ProviderRow = typeof modelProviders.$inferSelect;
type CatalogRow = typeof modelCatalog.$inferSelect;

const providerView = (r: ProviderRow): ProviderView => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  base_url: r.baseUrl,
  allow_private_network: r.allowPrivateNetwork,
  key_set: r.apiKeyEnc !== null,
  key_revision: r.keyRevision,
  gateway_provider: gatewayProviderName(r.id, r.kind),
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

export const catalogView = (r: CatalogRow, kind: ModelProviderKind): CatalogView => ({
  alias: r.alias,
  provider_id: r.providerId,
  model: r.model,
  label: r.label,
  gateway_model: `${gatewayProviderName(r.providerId, kind)}/${r.model}`,
  input_usd_per_mtok: r.inputUsdPerMtok,
  output_usd_per_mtok: r.outputUsdPerMtok,
  cache_read_usd_per_mtok: r.cacheReadUsdPerMtok,
  cache_write_usd_per_mtok: r.cacheWriteUsdPerMtok,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

export async function listProviders(db: KobeDb): Promise<ProviderView[]> {
  const rows = await db.select().from(modelProviders).orderBy(asc(modelProviders.id));
  return rows.map(providerView);
}

export async function listCatalog(db: KobeDb): Promise<CatalogView[]> {
  const rows = await db
    .select({ entry: modelCatalog, kind: modelProviders.kind })
    .from(modelCatalog)
    .innerJoin(modelProviders, eq(modelProviders.id, modelCatalog.providerId))
    .orderBy(asc(modelCatalog.alias));
  return rows.map((r) => catalogView(r.entry, r.kind));
}

export async function gatewayStatus(db: KobeDb): Promise<GatewayStatusView> {
  const [s] = await db.select().from(modelGatewayState);
  return {
    desired_version: s?.desiredVersion ?? 0,
    synced_version: s?.syncedVersion ?? 0,
    in_sync: (s?.syncedVersion ?? 0) >= (s?.desiredVersion ?? 1),
    last_synced_at: s?.lastSyncedAt?.toISOString() ?? null,
    last_attempt_at: s?.lastAttemptAt?.toISOString() ?? null,
    last_error: s?.lastError ?? null,
  };
}

/**
 * Where a provider's key may be sent (KOBE-40 review): a stored key is write-only, so moving it to
 * another endpoint must not be possible without re-entering it, vendor providers keep their
 * vendor's endpoint, and a key never travels over plain http. The operator switch
 * (`allowUnsafeEndpoints`, Helm only) lifts the last two for test installs.
 */
export interface EndpointPolicy {
  readonly allowUnsafeEndpoints: boolean;
}

export type EndpointProblem = "vendor_endpoint_fixed" | "insecure_endpoint";

const VENDOR_KINDS: readonly ModelProviderKind[] = ["openai", "anthropic", "gemini"];

export function endpointProblem(
  kind: ModelProviderKind,
  baseUrl: string | null,
  hasKey: boolean,
  policy: EndpointPolicy,
): EndpointProblem | undefined {
  if (policy.allowUnsafeEndpoints || baseUrl === null) return undefined;
  if (VENDOR_KINDS.includes(kind)) return "vendor_endpoint_fixed";
  if (hasKey && baseUrl.startsWith("http://")) return "insecure_endpoint";
  return undefined;
}

/** The host a provider's requests (and key) go to, for the audit log; null: the vendor default. */
export const endpointHost = (baseUrl: string | null): string | null =>
  baseUrl === null ? null : new URL(baseUrl).host;

export type AddProviderResult =
  | { readonly ok: true; readonly provider: ProviderView }
  | { readonly ok: false; readonly error: "exists" | "too_many" | EndpointProblem };

export async function addProvider(
  db: KobeDb,
  box: SecretBox,
  input: AddProviderInput,
  userId: string,
  policy: EndpointPolicy,
): Promise<AddProviderResult> {
  const id = input.kind === "openai_compatible" ? (input.id ?? "") : input.kind;
  const baseUrl = input.base_url ?? null;
  const problem = endpointProblem(input.kind, baseUrl, input.api_key !== undefined, policy);
  if (problem) return { ok: false, error: problem };
  return db.transaction(async (tx) => {
    // Serializes concurrent adds so the cap holds (install-wide table, small).
    await tx.execute(sql`LOCK TABLE ${modelProviders} IN SHARE ROW EXCLUSIVE MODE`);
    const [existing] = await tx.select().from(modelProviders).where(eq(modelProviders.id, id));
    if (existing) return { ok: false, error: "exists" };
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(modelProviders);
    if (n >= MAX_PROVIDERS) return { ok: false, error: "too_many" };
    const revision = input.api_key ? 1 : 0;
    const [row] = await tx
      .insert(modelProviders)
      .values({
        id,
        kind: input.kind,
        name: input.name,
        baseUrl,
        allowPrivateNetwork: input.allow_private_network,
        apiKeyEnc: input.api_key ? box.seal(input.api_key, providerKeyContext(id, revision)) : null,
        keyRevision: revision,
        createdBy: userId,
      })
      .returning();
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.provider.added",
      target: {
        providerId: id,
        kind: input.kind,
        keySet: input.api_key !== undefined,
        privateNetwork: input.allow_private_network,
        endpointHost: endpointHost(baseUrl),
      },
    });
    return { ok: true, provider: providerView(must(row)) };
  });
}

export type UpdateProviderResult =
  | { readonly ok: true; readonly provider: ProviderView }
  | {
      readonly ok: false;
      readonly error:
        | "not_found"
        | "key_required"
        | "base_url_required"
        | "key_required_for_new_endpoint"
        | EndpointProblem;
    };

export async function updateProvider(
  db: KobeDb,
  box: SecretBox,
  id: string,
  input: UpdateProviderInput,
  policy: EndpointPolicy,
): Promise<UpdateProviderResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.id, id))
      .for("update");
    if (!before) return { ok: false, error: "not_found" };
    if (input.api_key === null && VENDOR_KINDS.includes(before.kind)) {
      return { ok: false, error: "key_required" };
    }
    if (input.base_url === null && ["ollama", "openai_compatible"].includes(before.kind)) {
      return { ok: false, error: "base_url_required" };
    }
    const keyChanged = input.api_key !== undefined;
    const baseUrl = input.base_url === undefined ? before.baseUrl : input.base_url;
    const baseUrlChanged = baseUrl !== before.baseUrl;
    const hasKey = keyChanged ? input.api_key !== null : before.apiKeyEnc !== null;
    // A stored key never follows an endpoint change: whoever moves the endpoint re-enters the key.
    if (baseUrlChanged && hasKey && !keyChanged) {
      return { ok: false, error: "key_required_for_new_endpoint" };
    }
    const problem = endpointProblem(before.kind, baseUrl, hasKey, policy);
    if (problem && (baseUrlChanged || keyChanged)) return { ok: false, error: problem };
    const privateNetwork = input.allow_private_network ?? before.allowPrivateNetwork;
    const revision = keyChanged ? before.keyRevision + 1 : before.keyRevision;
    const [row] = await tx
      .update(modelProviders)
      .set({
        name: input.name ?? before.name,
        baseUrl,
        allowPrivateNetwork: privateNetwork,
        ...(keyChanged
          ? {
              apiKeyEnc: input.api_key
                ? box.seal(input.api_key, providerKeyContext(id, revision))
                : null,
              keyRevision: revision,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(modelProviders.id, id))
      .returning();
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.provider.changed",
      target: {
        providerId: id,
        kind: before.kind,
        keyChanged,
        baseUrlChanged,
        privateNetwork,
        endpointHost: endpointHost(baseUrl),
      },
    });
    return { ok: true, provider: providerView(must(row)) };
  });
}

export type DeleteProviderResult = "deleted" | "not_found" | "in_use";

export async function deleteProvider(db: KobeDb, id: string): Promise<DeleteProviderResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.id, id))
      .for("update");
    if (!row) return "not_found";
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(modelCatalog)
      .where(eq(modelCatalog.providerId, id));
    if (n > 0) return "in_use";
    await tx.delete(modelProviders).where(eq(modelProviders.id, id));
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.provider.removed",
      target: { providerId: id, kind: row.kind },
    });
    return "deleted";
  });
}

export type AddCatalogResult =
  | { readonly ok: true; readonly entry: CatalogView }
  | {
      readonly ok: false;
      readonly error: "exists" | "provider_not_found" | "too_many" | "partial_prices";
    };

interface Prices {
  readonly inputUsdPerMtok: number | null;
  readonly outputUsdPerMtok: number | null;
  readonly cacheReadUsdPerMtok: number | null;
  readonly cacheWriteUsdPerMtok: number | null;
}

/**
 * KOBE-43 review: prices come as a set: input and output together (one without the other would
 * leave every call unpriced), cache prices only on top of them. A model without prices is capped
 * by token budgets instead (KOBE-42).
 */
export function partialPrices(p: Prices): boolean {
  const base = [p.inputUsdPerMtok, p.outputUsdPerMtok].filter((v) => v !== null).length;
  const cache = p.cacheReadUsdPerMtok !== null || p.cacheWriteUsdPerMtok !== null;
  return base === 1 || (base === 0 && cache);
}

export async function addCatalogEntry(
  db: KobeDb,
  input: AddCatalogInput,
  userId: string,
): Promise<AddCatalogResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE ${modelCatalog} IN SHARE ROW EXCLUSIVE MODE`);
    const [provider] = await tx
      .select({ kind: modelProviders.kind })
      .from(modelProviders)
      .where(eq(modelProviders.id, input.provider_id))
      .for("share");
    if (!provider) return { ok: false, error: "provider_not_found" };
    const [existing] = await tx
      .select({ alias: modelCatalog.alias })
      .from(modelCatalog)
      .where(eq(modelCatalog.alias, input.alias));
    if (existing) return { ok: false, error: "exists" };
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(modelCatalog);
    if (n >= MAX_CATALOG_ENTRIES) return { ok: false, error: "too_many" };
    if (
      partialPrices({
        inputUsdPerMtok: input.input_usd_per_mtok ?? null,
        outputUsdPerMtok: input.output_usd_per_mtok ?? null,
        cacheReadUsdPerMtok: input.cache_read_usd_per_mtok ?? null,
        cacheWriteUsdPerMtok: input.cache_write_usd_per_mtok ?? null,
      })
    ) {
      return { ok: false, error: "partial_prices" };
    }
    const [row] = await tx
      .insert(modelCatalog)
      .values({
        alias: input.alias,
        providerId: input.provider_id,
        model: input.model,
        label: input.label ?? null,
        inputUsdPerMtok: input.input_usd_per_mtok ?? null,
        outputUsdPerMtok: input.output_usd_per_mtok ?? null,
        cacheReadUsdPerMtok: input.cache_read_usd_per_mtok ?? null,
        cacheWriteUsdPerMtok: input.cache_write_usd_per_mtok ?? null,
        createdBy: userId,
      })
      .returning();
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.catalog.changed",
      target: {
        alias: input.alias,
        change: "added",
        providerId: input.provider_id,
        model: input.model,
        pricesChanged: PRICE_KEYS.some((k) => input[k] !== undefined && input[k] !== null),
      },
    });
    return { ok: true, entry: catalogView(must(row), provider.kind) };
  });
}

export type UpdateCatalogResult =
  | { readonly ok: true; readonly entry: CatalogView }
  | { readonly ok: false; readonly error: "not_found" | "provider_not_found" | "partial_prices" };

export async function updateCatalogEntry(
  db: KobeDb,
  alias: string,
  input: UpdateCatalogInput,
): Promise<UpdateCatalogResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.alias, alias))
      .for("update");
    if (!before) return { ok: false, error: "not_found" };
    const providerId = input.provider_id ?? before.providerId;
    const [provider] = await tx
      .select({ kind: modelProviders.kind })
      .from(modelProviders)
      .where(eq(modelProviders.id, providerId))
      .for("share");
    if (!provider) return { ok: false, error: "provider_not_found" };
    const prices = {
      inputUsdPerMtok: keep(input.input_usd_per_mtok, before.inputUsdPerMtok),
      outputUsdPerMtok: keep(input.output_usd_per_mtok, before.outputUsdPerMtok),
      cacheReadUsdPerMtok: keep(input.cache_read_usd_per_mtok, before.cacheReadUsdPerMtok),
      cacheWriteUsdPerMtok: keep(input.cache_write_usd_per_mtok, before.cacheWriteUsdPerMtok),
    };
    if (partialPrices(prices)) return { ok: false, error: "partial_prices" };
    const [row] = await tx
      .update(modelCatalog)
      .set({
        providerId,
        model: input.model ?? before.model,
        label: input.label === undefined ? before.label : input.label,
        ...prices,
        updatedAt: new Date(),
      })
      .where(eq(modelCatalog.alias, alias))
      .returning();
    const entry = must(row);
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.catalog.changed",
      target: {
        alias,
        change: "updated",
        providerId,
        model: entry.model,
        pricesChanged:
          entry.inputUsdPerMtok !== before.inputUsdPerMtok ||
          entry.outputUsdPerMtok !== before.outputUsdPerMtok ||
          entry.cacheReadUsdPerMtok !== before.cacheReadUsdPerMtok ||
          entry.cacheWriteUsdPerMtok !== before.cacheWriteUsdPerMtok,
      },
    });
    return { ok: true, entry: catalogView(entry, provider.kind) };
  });
}

/**
 * Removes an alias from the catalog; every team's enablement of it goes with it (FK cascade across
 * teams; `team_models` is behind RLS, so the event does not count them).
 */
export async function deleteCatalogEntry(db: KobeDb, alias: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.alias, alias))
      .for("update");
    if (!row) return false;
    await tx.delete(modelCatalog).where(eq(modelCatalog.alias, alias));
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.catalog.changed",
      target: { alias, change: "removed", providerId: row.providerId, model: row.model },
    });
    return true;
  });
}

const PRICE_KEYS = [
  "input_usd_per_mtok",
  "output_usd_per_mtok",
  "cache_read_usd_per_mtok",
  "cache_write_usd_per_mtok",
] as const;

/** An optional update field: undefined keeps the old value, null clears it. */
const keep = <T>(next: T | null | undefined, before: T | null): T | null =>
  next === undefined ? before : next;

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("model admin write returned no row");
  return value;
}
