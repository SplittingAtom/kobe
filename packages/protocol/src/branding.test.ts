import { describe, expect, it } from "vitest";
import {
  APP_NAME_MAX_LENGTH,
  BRANDING_ASSET_CONTENT_TYPES,
  BRANDING_ASSET_KINDS,
  BRANDING_ASSET_MAX_BYTES,
  BRANDING_ASSET_MAX_SIDE_PX,
  BRANDING_SETTING_KEYS,
  CORNER_STYLES,
  DEFAULT_APP_NAME,
  DEFAULT_THEME,
  FONT_STACKS,
  PRESET_IDS,
  PRESET_LABELS,
  appNameSchema,
  brandingAssetKindSchema,
  siteBrandingSchema,
  themeSettingsSchema,
} from "./branding.js";

const custom = { preset: "custom", accent: "#1a73e8", corners: "round", font: "serif" } as const;

describe("theme settings (TH2, TH9-TH11)", () => {
  it("ships the six presets, `default` first", () => {
    expect(PRESET_IDS).toEqual(["default", "slate", "forest", "plum", "ember", "tokyo-nights"]);
    expect(DEFAULT_THEME).toEqual({ preset: "default" });
    expect(PRESET_LABELS["tokyo-nights"]).toBe("Tokyo Nights");
    expect(Object.keys(PRESET_LABELS)).toEqual([...PRESET_IDS]);
  });

  it.each(PRESET_IDS)("accepts the preset %s", (preset) => {
    expect(themeSettingsSchema.parse({ preset })).toEqual({ preset });
  });

  it("accepts a custom theme with every corner and font choice", () => {
    expect(themeSettingsSchema.parse(custom)).toEqual(custom);
    for (const corners of CORNER_STYLES)
      for (const font of FONT_STACKS)
        expect(themeSettingsSchema.safeParse({ ...custom, corners, font }).success).toBe(true);
    expect(CORNER_STYLES).toEqual(["sharp", "soft", "round"]);
    expect(FONT_STACKS).toEqual(["system", "humanist", "grotesk", "serif"]);
  });

  it.each(["1a73e8", "#1A73E8", "#1a73e", "#1a73e8ff", "#fff", "#gggggg", " #1a73e8", "#1a73e8\n"])(
    "refuses the accent %j",
    (accent) => {
      expect(themeSettingsSchema.safeParse({ ...custom, accent }).success).toBe(false);
    },
  );

  it.each([
    ["corners", "pill"],
    ["corners", ""],
    ["font", "comic"],
    ["font", "System"],
  ])("refuses %s = %j", (field, value) => {
    expect(themeSettingsSchema.safeParse({ ...custom, [field]: value }).success).toBe(false);
  });

  it("refuses unknown presets, missing custom fields and extra keys", () => {
    for (const bad of [
      { preset: "kobe" },
      { preset: "Default" },
      {},
      { preset: "custom" },
      { preset: "custom", accent: "#1a73e8", corners: "soft" },
      { preset: "slate", accent: "#1a73e8" },
      { ...custom, css: "body{}" },
      "default",
      null,
    ]) {
      expect(themeSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("app name (§4.1)", () => {
  it("trims and accepts 1 to 40 characters", () => {
    expect(appNameSchema.parse("  Acme  ")).toBe("Acme");
    expect(appNameSchema.parse("a")).toBe("a");
    expect(appNameSchema.parse("x".repeat(APP_NAME_MAX_LENGTH))).toHaveLength(40);
    expect(appNameSchema.parse(` ${"x".repeat(40)} `)).toHaveLength(40);
    expect(DEFAULT_APP_NAME).toBe("Kobe");
  });

  it("counts characters, not UTF-16 units", () => {
    expect(appNameSchema.safeParse("🙂".repeat(40)).success).toBe(true);
    expect(appNameSchema.safeParse("🙂".repeat(41)).success).toBe(false);
  });

  it.each([
    "",
    "   ",
    "x".repeat(41),
    "Ac\nme",
    "Ac\u0000me",
    "Ac\u007fme", // DEL (Cc)
    "Ac\u2028me", // line separator (Zl)
    "Ac\u202eme", // right-to-left override (Cf)
    "Ac\u200dme", // zero-width joiner (Cf)
  ])("refuses %j", (name) => {
    expect(appNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("site_settings keys and asset limits (TH7)", () => {
  it("names the two site_settings keys", () => {
    expect(BRANDING_SETTING_KEYS).toEqual({
      appName: "branding.app_name",
      theme: "branding.theme",
    });
  });

  it("caps assets per kind", () => {
    expect(BRANDING_ASSET_KINDS).toEqual(["logo", "logo_dark", "favicon"]);
    expect(BRANDING_ASSET_MAX_BYTES).toEqual({
      logo: 512 * 1024,
      logo_dark: 512 * 1024,
      favicon: 256 * 1024,
    });
    expect(BRANDING_ASSET_MAX_SIDE_PX).toBe(4096);
    expect(brandingAssetKindSchema.safeParse("banner").success).toBe(false);
  });

  it("allows per kind exactly the content types the database check allows", () => {
    expect(BRANDING_ASSET_CONTENT_TYPES).toEqual({
      logo: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
      logo_dark: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
      favicon: ["image/png", "image/svg+xml", "image/x-icon"],
    });
    expect(Object.keys(BRANDING_ASSET_CONTENT_TYPES)).toEqual([...BRANDING_ASSET_KINDS]);
    expect(Object.keys(BRANDING_ASSET_MAX_BYTES)).toEqual([...BRANDING_ASSET_KINDS]);
  });
});

describe("public branding (GET /v1/site/branding)", () => {
  const url = (kind: string) => `/v1/site/branding/assets/${kind}?v=${"a".repeat(64)}`;

  it("accepts the defaults and a fully branded site", () => {
    expect(
      siteBrandingSchema.parse({
        appName: "Kobe",
        logo: null,
        favicon: null,
        theme: DEFAULT_THEME,
      }),
    ).toBeTruthy();
    expect(
      siteBrandingSchema.parse({
        appName: "Acme",
        logo: { url: url("logo"), dark: url("logo_dark") },
        favicon: url("favicon"),
        theme: custom,
      }),
    ).toBeTruthy();
  });

  it("refuses an invalid theme, name or extra keys", () => {
    const ok = { appName: "Kobe", logo: null, favicon: null, theme: DEFAULT_THEME };
    expect(siteBrandingSchema.safeParse({ ...ok, theme: { preset: "kobe" } }).success).toBe(false);
    expect(siteBrandingSchema.safeParse({ ...ok, appName: "" }).success).toBe(false);
    expect(siteBrandingSchema.safeParse({ ...ok, css: "x" }).success).toBe(false);
  });
});
