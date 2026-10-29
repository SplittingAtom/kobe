import { PRESET_IDS, appNameSchema, type PresetId } from "@kobe/protocol";
import { z } from "zod";

/**
 * Chart-seeded branding defaults (theming plan T7, KOBE-503): `branding.appName`,
 * `branding.preset` and `branding.showName` in the chart become `KOBE_BRANDING_*` on the API
 * server, which writes each into `site_settings` at start ONLY while that key is unset. An
 * admin's later change (or a value seeded earlier) is never overwritten on a restart. A setting
 * reset on the Appearance page is unset again, so the next start seeds the chart's value back;
 * remove the chart value to keep the built-in default.
 */
export interface BrandingDefaults {
  readonly appName?: string;
  readonly preset?: PresetId;
  readonly showName?: boolean;
}

/** An empty or blank value is "not set" (the chart renders only what is set; this is the guard). */
const unsetWhenBlank = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const brandingDefaultsSchema = z
  .object({
    KOBE_BRANDING_APP_NAME: z.preprocess(unsetWhenBlank, appNameSchema.optional()),
    KOBE_BRANDING_PRESET: z.preprocess(
      unsetWhenBlank,
      z
        .enum(PRESET_IDS, {
          error: `KOBE_BRANDING_PRESET must be one of ${PRESET_IDS.join(", ")}`,
        })
        .optional(),
    ),
    KOBE_BRANDING_SHOW_NAME: z.preprocess(
      unsetWhenBlank,
      z
        .enum(["true", "false"], { error: "KOBE_BRANDING_SHOW_NAME must be true or false" })
        .transform((v) => v === "true")
        .optional(),
    ),
  })
  .transform((env): BrandingDefaults => ({
    ...(env.KOBE_BRANDING_APP_NAME === undefined ? {} : { appName: env.KOBE_BRANDING_APP_NAME }),
    ...(env.KOBE_BRANDING_PRESET === undefined ? {} : { preset: env.KOBE_BRANDING_PRESET }),
    ...(env.KOBE_BRANDING_SHOW_NAME === undefined ? {} : { showName: env.KOBE_BRANDING_SHOW_NAME }),
  }));
