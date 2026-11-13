import { z } from "zod";
import {
  MODEL_ALIAS_PATTERN,
  eq,
  modelCatalog,
  siteSettings,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES,
  SEMANTIC_MEMORY_BLOCK_MAX_BYTES,
  SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
  SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
} from "@kobe/protocol";
import { logger } from "../logger.js";

/**
 * Site memory settings (KOBE-381, SM27, SM14): one `site_settings` key holding a JSON document
 * (no migration). Every field has a default; a field missing from the stored document, or one that
 * no longer parses, reads as its default (logged), so an upgrade changes nothing. There is no
 * full-text search language setting: search uses fixed English stemming (Q11).
 *
 * The values are read by the tickets that enforce them: the context budget by the selector
 * (KOBE-382; the `run.start` contract allows the whole range), scope limits and the version cap by
 * the item store (KOBE-378), the stale threshold and retention window by the sweeps (KOBE-386),
 * rate limits and the learning model by Learn (KOBE-393). The embedding model is for Phase D and
 * unused until vectors are earned.
 */
export const MEMORY_SITE_SETTINGS_KEY = "memory.settings";

/** The contract's rendered-block range, in KiB (4 to 16, default 8). */
export const MEMORY_CONTEXT_BUDGET_KIB_MIN = SEMANTIC_MEMORY_BLOCK_MIN_BYTES / 1024;
export const MEMORY_CONTEXT_BUDGET_KIB_MAX = SEMANTIC_MEMORY_BLOCK_MAX_BYTES / 1024;
const MEMORY_CONTEXT_BUDGET_KIB_DEFAULT = SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES / 1024;

const alias = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));
const scopeLimit = z.number().int().min(1).max(SEMANTIC_MEMORY_SCOPE_MAX_ITEMS);

export const memorySiteSettingsFields = {
  learning_model_alias: alias.nullable(),
  embedding_model_alias: alias.nullable(),
  context_budget_kib: z
    .number()
    .int()
    .min(MEMORY_CONTEXT_BUDGET_KIB_MIN)
    .max(MEMORY_CONTEXT_BUDGET_KIB_MAX),
  scope_limits: z.strictObject({
    user: scopeLimit,
    portable: scopeLimit,
    team: scopeLimit,
    site: scopeLimit,
  }),
  version_cap: z.number().int().min(5).max(500),
  stale_after_days: z.number().int().min(7).max(3650),
  rate_limits: z.strictObject({
    learn_passes_per_hour: z.number().int().min(1).max(100),
    saves_per_minute: z.number().int().min(1).max(600),
  }),
  retention_days: z.number().int().min(30).max(3650),
} as const;

export const memorySiteSettingsSchema = z.strictObject(memorySiteSettingsFields);
export type MemorySiteSettings = z.infer<typeof memorySiteSettingsSchema>;
export type MemorySiteSettingName = keyof MemorySiteSettings;
export const MEMORY_SITE_SETTING_NAMES = Object.keys(
  memorySiteSettingsFields,
) as MemorySiteSettingName[];

export const MEMORY_SITE_SETTINGS_DEFAULTS: MemorySiteSettings = Object.freeze({
  learning_model_alias: null,
  embedding_model_alias: null,
  context_budget_kib: MEMORY_CONTEXT_BUDGET_KIB_DEFAULT,
  scope_limits: Object.freeze({
    user: SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
    portable: SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
    team: SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
    site: SEMANTIC_MEMORY_SCOPE_MAX_ITEMS,
  }),
  version_cap: 50,
  stale_after_days: 90,
  rate_limits: Object.freeze({ learn_passes_per_hour: 10, saves_per_minute: 30 }),
  retention_days: 365,
});

/** The stored document over the defaults, field by field (pure; tested). */
export function parseMemorySiteSettings(raw: string | null | undefined): MemorySiteSettings {
  if (raw === null || raw === undefined) return MEMORY_SITE_SETTINGS_DEFAULTS;
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    logger.warn("memory site settings: stored value is not JSON; using defaults");
    return MEMORY_SITE_SETTINGS_DEFAULTS;
  }
  const obj = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const name of MEMORY_SITE_SETTING_NAMES) {
    const value = obj[name];
    const parsed = memorySiteSettingsFields[name].safeParse(value);
    if (parsed.success) out[name] = parsed.data;
    else {
      if (value !== undefined) logger.warn({ setting: name }, "memory site settings: default used");
      out[name] = MEMORY_SITE_SETTINGS_DEFAULTS[name];
    }
  }
  return out as MemorySiteSettings;
}

export async function readMemorySiteSettings(db: KobeDb | KobeTx): Promise<MemorySiteSettings> {
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, MEMORY_SITE_SETTINGS_KEY));
  return parseMemorySiteSettings(row?.value);
}

const stable = (v: unknown) => JSON.stringify(v);

export type SiteSettingsWrite =
  | {
      readonly ok: true;
      readonly settings: MemorySiteSettings;
      readonly changed: readonly MemorySiteSettingName[];
    }
  | { readonly ok: false; readonly code: "unknown_alias"; readonly message: string };

/**
 * Saves the given fields over the current document (inside the caller's transaction). A model
 * alias must name a catalog model; whether a Workspace enabled it is checked when it is used.
 */
export async function writeMemorySiteSettings(
  tx: KobeTx,
  change: { readonly [K in MemorySiteSettingName]?: MemorySiteSettings[K] | undefined },
): Promise<SiteSettingsWrite> {
  for (const key of ["learning_model_alias", "embedding_model_alias"] as const) {
    const a = change[key];
    if (a === undefined || a === null) continue;
    const [m] = await tx
      .select({ alias: modelCatalog.alias })
      .from(modelCatalog)
      .where(eq(modelCatalog.alias, a));
    if (!m) {
      return { ok: false, code: "unknown_alias", message: `No model in the catalog is "${a}".` };
    }
  }
  const before = await readMemorySiteSettings(tx);
  const given = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined));
  const next: MemorySiteSettings = { ...before, ...given };
  const changed = MEMORY_SITE_SETTING_NAMES.filter((k) => stable(before[k]) !== stable(next[k]));
  if (changed.length > 0) {
    const value = JSON.stringify(next);
    await tx
      .insert(siteSettings)
      .values({ key: MEMORY_SITE_SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
  }
  return { ok: true, settings: next, changed };
}
