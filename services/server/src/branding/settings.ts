import {
  BRANDING_SETTING_KEYS,
  DEFAULT_APP_NAME,
  DEFAULT_SHOW_NAME,
  DEFAULT_THEME,
  appNameSchema,
  themeSettingsSchema,
  type ThemeSettings,
} from "@kobe/protocol";
import { eq, inArray, siteSettings, type KobeDb, type KobeTx } from "@kobe/db";
import { logger } from "../logger.js";

/**
 * The branding's `site_settings` keys (§4.1): the name, whether the header shows it, the theme.
 * An unreadable stored value falls back to the default and is logged, never a failed request.
 */

export interface BrandingSettings {
  readonly appName: string;
  readonly showName: boolean;
  readonly theme: ThemeSettings;
}

export const BRANDING_KEYS = [
  BRANDING_SETTING_KEYS.appName,
  BRANDING_SETTING_KEYS.showName,
  BRANDING_SETTING_KEYS.theme,
] as const;

function fallback<T>(key: string, value: T): T {
  logger.warn({ key }, "unreadable branding setting; using the default");
  return value;
}

function parseAppName(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_APP_NAME;
  const parsed = appNameSchema.safeParse(raw);
  return parsed.success ? parsed.data : fallback(BRANDING_SETTING_KEYS.appName, DEFAULT_APP_NAME);
}

function parseShowName(raw: string | undefined): boolean {
  if (raw === undefined) return DEFAULT_SHOW_NAME;
  if (raw === "true" || raw === "false") return raw === "true";
  return fallback(BRANDING_SETTING_KEYS.showName, DEFAULT_SHOW_NAME);
}

function parseTheme(raw: string | undefined): ThemeSettings {
  if (raw === undefined) return DEFAULT_THEME;
  try {
    const parsed = themeSettingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // falls through
  }
  return fallback(BRANDING_SETTING_KEYS.theme, DEFAULT_THEME);
}

/** The three settings, each defaulted when unset or unreadable. */
export async function readBrandingSettings(db: KobeDb | KobeTx): Promise<BrandingSettings> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...BRANDING_KEYS]));
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    appName: parseAppName(value(BRANDING_SETTING_KEYS.appName)),
    showName: parseShowName(value(BRANDING_SETTING_KEYS.showName)),
    theme: parseTheme(value(BRANDING_SETTING_KEYS.theme)),
  };
}

/** The configured app name (mail, titles), "Kobe" when unset or unreadable. */
export async function readAppName(db: KobeDb | KobeTx): Promise<string> {
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, BRANDING_SETTING_KEYS.appName));
  return parseAppName(row?.value);
}

/** The audit label of a theme (TH12): `theme:<preset>` or `theme:custom <accent>`. */
export function themeLabel(theme: ThemeSettings): string {
  return theme.preset === "custom" ? `theme:custom ${theme.accent}` : `theme:${theme.preset}`;
}

/** Writes one setting (insert or update). */
export async function storeSetting(tx: KobeTx, key: string, value: string): Promise<void> {
  await tx
    .insert(siteSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
}
