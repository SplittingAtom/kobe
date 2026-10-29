import { z } from "zod";

/**
 * Site branding (theming plan T1, KOBE-497; decisions TH1-TH12 in docs/specs/theming.md):
 * one site-wide name, logo (+ optional dark logo), favicon and style. No raw CSS (TH2): a theme
 * is a preset id, or a custom accent with corners and typeface, each from a closed list.
 *
 * Stored in `site_settings` (`branding.app_name`: the trimmed name; `branding.theme`: JSON per
 * {@link themeSettingsSchema}) and the `site_branding_assets` table (the files, TH7). An unreadable
 * stored value falls back to the default and is logged, never a failed page.
 */

/** The `site_settings` keys of the branding (§4.1). */
export const BRANDING_SETTING_KEYS = {
  appName: "branding.app_name",
  theme: "branding.theme",
  /** `"true"`/`"false"`: whether the header shows the name next to the logo (default true). */
  showName: "branding.show_name",
} as const;

/** Whether the header shows the app name by default (`branding.show_name` unset). */
export const DEFAULT_SHOW_NAME = true;

/** Shipped presets (TH9, Chris 2026-10-28); `default` is today's neutral look and the default. */
export const PRESET_IDS = ["default", "slate", "forest", "plum", "ember", "tokyo-nights"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Display names of the presets (TH9). */
export const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  default: "Default",
  slate: "Slate",
  forest: "Forest",
  plum: "Plum",
  ember: "Ember",
  "tokyo-nights": "Tokyo Nights",
};

/** Radius scales (TH11); `soft` is today's. */
export const CORNER_STYLES = ["sharp", "soft", "round"] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

/** System font stacks (TH10); `system` is today's `system-ui`. No font files in v1. */
export const FONT_STACKS = ["system", "humanist", "grotesk", "serif"] as const;
export type FontStack = (typeof FONT_STACKS)[number];

/** An accent colour: `#rrggbb`, lowercase hex only (it is written into CSS, so nothing else). */
export const ACCENT_PATTERN = /^#[0-9a-f]{6}$/;

export const presetIdSchema = z.enum(PRESET_IDS);

export const themeSettingsSchema = z.discriminatedUnion("preset", [
  z.strictObject({ preset: presetIdSchema }),
  z.strictObject({
    preset: z.literal("custom"),
    accent: z.string().regex(ACCENT_PATTERN),
    corners: z.enum(CORNER_STYLES),
    font: z.enum(FONT_STACKS),
  }),
]);
export type ThemeSettings = z.infer<typeof themeSettingsSchema>;
export type CustomThemeSettings = Extract<ThemeSettings, { preset: "custom" }>;

export const DEFAULT_THEME: ThemeSettings = Object.freeze({ preset: "default" });

/** The app name's bounds in characters (code points), after trimming (§4.1). */
export const APP_NAME_MIN_LENGTH = 1;
export const APP_NAME_MAX_LENGTH = 40;
export const DEFAULT_APP_NAME = "Kobe";

const codePoints = (s: string): number => [...s].length;

/**
 * The app name: plain text, trimmed, 1-40 characters; no control (Cc), format (Cf: bidi overrides,
 * zero-width joiners) or line/paragraph separator characters.
 */
export const appNameSchema = z
  .string()
  .trim()
  .refine((s) => codePoints(s) >= APP_NAME_MIN_LENGTH && codePoints(s) <= APP_NAME_MAX_LENGTH, {
    message: `The name must be ${APP_NAME_MIN_LENGTH} to ${APP_NAME_MAX_LENGTH} characters`,
  })
  .refine((s) => /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u.test(s), {
    message: "The name must be plain text on one line",
  });

/** Kinds of branding files (`site_branding_assets.kind`). */
export const BRANDING_ASSET_KINDS = ["logo", "logo_dark", "favicon"] as const;
export type BrandingAssetKind = (typeof BRANDING_ASSET_KINDS)[number];
export const brandingAssetKindSchema = z.enum(BRANDING_ASSET_KINDS);

const KIB = 1024;
/** Upload caps per kind in bytes (TH7). */
export const BRANDING_ASSET_MAX_BYTES: Readonly<Record<BrandingAssetKind, number>> = {
  logo: 512 * KIB,
  logo_dark: 512 * KIB,
  favicon: 256 * KIB,
};
/** Content types the server stores per kind (detected from the bytes, TH8; mirrors the DB check). */
export const BRANDING_ASSET_CONTENT_TYPES = {
  logo: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  logo_dark: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
  favicon: ["image/png", "image/svg+xml", "image/x-icon"],
} as const satisfies Readonly<Record<BrandingAssetKind, readonly string[]>>;
export type BrandingAssetContentType =
  (typeof BRANDING_ASSET_CONTENT_TYPES)[BrandingAssetKind][number];
/** The longest side a raster asset may have, in pixels. */
export const BRANDING_ASSET_MAX_SIDE_PX = 4096;

/** An asset URL as the server builds it (`/v1/site/branding/assets/<kind>?v=<sha256>`). */
const assetUrl = z.string().min(1).max(2048);
/** A raster asset's side in pixels. */
const assetSide = z.number().int().positive().max(BRANDING_ASSET_MAX_SIDE_PX);

/** `GET /v1/site/branding` (public, TH6): what every page needs for its first paint. */
export const siteBrandingSchema = z.strictObject({
  appName: appNameSchema,
  showName: z.boolean(),
  logo: z
    .strictObject({
      url: assetUrl,
      dark: assetUrl.optional(),
      /** The logo's pixel size (raster only), so the page can reserve its space (KOBE-500). */
      width: assetSide.optional(),
      height: assetSide.optional(),
      /** The dark logo's pixel size, likewise. */
      darkWidth: assetSide.optional(),
      darkHeight: assetSide.optional(),
    })
    .nullable(),
  favicon: assetUrl.nullable(),
  theme: themeSettingsSchema,
});
export type SiteBranding = z.infer<typeof siteBrandingSchema>;
