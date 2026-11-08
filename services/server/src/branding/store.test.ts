import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, siteBrandingSchema, type BrandingAssetKind } from "@kobe/protocol";
import { png, svg } from "../testing/branding-fixtures.js";
import type { BrandingSettings } from "./settings.js";
import { brandingVariants, publicBranding, sha256Hex, type StoredAsset } from "./store.js";
import { FAVICON_SCHEME_STYLE } from "./svg-themed.js";

const settings = (logoThemeColor: boolean): BrandingSettings => ({
  appName: "Acme",
  showName: true,
  theme: DEFAULT_THEME,
  logoThemeColor,
});

function stored(kind: BrandingAssetKind, data: Uint8Array, contentType: string): StoredAsset {
  return {
    kind,
    bytes: Buffer.from(data),
    contentType,
    sha256: sha256Hex(data),
    width: 10,
    height: 10,
  };
}

const files = (...list: StoredAsset[]) => new Map(list.map((a) => [a.kind, a]));
const SVG_LOGO = stored("logo", svg(), "image/svg+xml");
const SVG_DARK = stored("logo_dark", svg('<circle r="1"/>'), "image/svg+xml");
const SVG_FAVICON = stored("favicon", svg(), "image/svg+xml");

function snapshot(on: boolean, assets: Map<BrandingAssetKind, StoredAsset>) {
  const variants = brandingVariants(settings(on), assets);
  return { variants, body: publicBranding(settings(on), assets, variants) };
}

describe("themed branding variants (KOBE-562)", () => {
  it("serves every upload as uploaded while the setting is off (the default)", () => {
    const { variants, body } = snapshot(false, files(SVG_LOGO, SVG_DARK, SVG_FAVICON));
    expect(variants).toEqual({ inlineLogo: null, themedFavicon: null });
    expect(body.logoThemeColor).toBe(false);
    expect(body.logo).toEqual({
      url: `/v1/site/branding/assets/logo?v=${SVG_LOGO.sha256}`,
      width: 10,
      height: 10,
      dark: `/v1/site/branding/assets/logo_dark?v=${SVG_DARK.sha256}`,
      darkWidth: 10,
      darkHeight: 10,
    });
    expect(body.favicon).toBe(`/v1/site/branding/assets/favicon?v=${SVG_FAVICON.sha256}`);
  });

  it("exposes the inline variant by its own hash and leaves the dark logo out when on", () => {
    const { variants, body } = snapshot(true, files(SVG_LOGO, SVG_DARK));
    const inline = variants.inlineLogo;
    expect(inline?.contentType).toBe("image/svg+xml");
    expect(inline?.bytes.toString()).toContain('fill="currentColor"');
    expect(inline?.sha256).toBe(sha256Hex(inline?.bytes ?? ""));
    expect(body.logoThemeColor).toBe(true);
    expect(body.logo).toEqual({
      url: `/v1/site/branding/assets/logo?v=${SVG_LOGO.sha256}`,
      width: 10,
      height: 10,
      inline: `/v1/site/branding/assets/logo?inline=1&v=${inline?.sha256}`,
    });
    expect(siteBrandingSchema.parse(body)).toEqual(body);
  });

  it("serves the themed SVG favicon under its own hash when on", () => {
    const { variants, body } = snapshot(true, files(SVG_FAVICON));
    const themed = variants.themedFavicon;
    expect(themed?.bytes.toString()).toContain(`<style>${FAVICON_SCHEME_STYLE}</style>`);
    expect(body.favicon).toBe(`/v1/site/branding/assets/favicon?v=${themed?.sha256}`);
  });

  it("keeps raster logos and PNG/ICO favicons as they are, dark logo included", () => {
    const logo = stored("logo", png(), "image/png");
    const dark = stored("logo_dark", png(), "image/png");
    const favicon = stored("favicon", png(), "image/png");
    const { variants, body } = snapshot(true, files(logo, dark, favicon));
    expect(variants).toEqual({ inlineLogo: null, themedFavicon: null });
    expect(body.logo).toMatchObject({
      dark: `/v1/site/branding/assets/logo_dark?v=${dark.sha256}`,
    });
    expect(body.logo).not.toHaveProperty("inline");
    expect(body.favicon).toBe(`/v1/site/branding/assets/favicon?v=${favicon.sha256}`);
  });

  it("has no variant for a stored SVG the reader now refuses", () => {
    const bad = stored("logo", new TextEncoder().encode("<svg><script/></svg>"), "image/svg+xml");
    expect(snapshot(true, files(bad)).variants.inlineLogo).toBeNull();
  });
});
