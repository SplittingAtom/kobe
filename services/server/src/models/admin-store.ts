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

export type AddProviderResult =
  | { readonly ok: true; readonly provider: ProviderView }
  | { readonly ok: false; readonly error: "exists" | "too_many" };

export async function addProvider(
  db: KobeDb,
  box: SecretBox,
  input: AddProviderInput,
  userId: string,
): Promise<AddProviderResult> {
  const id = input.kind === "openai_compatible" ? (input.id ?? "") : input.kind;
  return db.transaction(async (tx) => {
    // Serializes concurrent adds so the cap holds (install-wide table, small).
    await tx.execute(sql`LOCK TABLE ${modelProviders} IN SHARE ROW EXCLUSIVE MODE`);
    const [existing] = await tx.select().from(modelProviders).where(eq(modelProviders.id, id));
    if (existing) return { ok: false, error: "exists" };
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(modelProviders);
    if (n >= MAX_PROVIDERS) return { ok: false, error: "too_many" };
    const [row] = await tx
      .insert(modelProviders)
      .values({
        id,
        kind: input.kind,
        name: input.name,
        baseUrl: input.base_url ?? null,
        allowPrivateNetwork: input.allow_private_network,
        apiKeyEnc: input.api_key ? box.seal(input.api_key, providerKeyContext(id)) : null,
        keyRevision: input.api_key ? 1 : 0,
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
      },
    });
    return { ok: true, provider: providerView(must(row)) };
  });
}

export type UpdateProviderResult =
  | { readonly ok: true; readonly provider: ProviderView }
  | { readonly ok: false; readonly error: "not_found" | "key_required" | "base_url_required" };

export async function updateProvider(
  db: KobeDb,
  box: SecretBox,
  id: string,
  input: UpdateProviderInput,
): Promise<UpdateProviderResult> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.id, id))
      .for("update");
    if (!before) return { ok: false, error: "not_found" };
    const keyedKind = ["openai", "anthropic", "gemini"].includes(before.kind);
    if (input.api_key === null && keyedKind) return { ok: false, error: "key_required" };
    if (input.base_url === null && ["ollama", "openai_compatible"].includes(before.kind)) {
      return { ok: false, error: "base_url_required" };
    }
    const keyChanged = input.api_key !== undefined;
    const baseUrl = input.base_url === undefined ? before.baseUrl : input.base_url;
    const privateNetwork = input.allow_private_network ?? before.allowPrivateNetwork;
    const [row] = await tx
      .update(modelProviders)
      .set({
        name: input.name ?? before.name,
        baseUrl,
        allowPrivateNetwork: privateNetwork,
        ...(keyChanged
          ? {
              apiKeyEnc: input.api_key ? box.seal(input.api_key, providerKeyContext(id)) : null,
              keyRevision: before.keyRevision + 1,
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
        baseUrlChanged: baseUrl !== before.baseUrl,
        privateNetwork,
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
  | { readonly ok: false; readonly error: "exists" | "provider_not_found" | "too_many" };

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
    const [row] = await tx
      .insert(modelCatalog)
      .values({
        alias: input.alias,
        providerId: input.provider_id,
        model: input.model,
        label: input.label ?? null,
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
      },
    });
    return { ok: true, entry: catalogView(must(row), provider.kind) };
  });
}

export type UpdateCatalogResult =
  | { readonly ok: true; readonly entry: CatalogView }
  | { readonly ok: false; readonly error: "not_found" | "provider_not_found" };

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
    const [row] = await tx
      .update(modelCatalog)
      .set({
        providerId,
        model: input.model ?? before.model,
        label: input.label === undefined ? before.label : input.label,
        updatedAt: new Date(),
      })
      .where(eq(modelCatalog.alias, alias))
      .returning();
    const entry = must(row);
    await bumpModelsConfig(tx);
    await recordAudit(tx, {
      action: "models.catalog.changed",
      target: { alias, change: "updated", providerId, model: entry.model },
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

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("model admin write returned no row");
  return value;
}
