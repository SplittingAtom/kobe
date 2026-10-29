import { BRANDING_SETTING_KEYS, type ThemeSettings } from "@kobe/protocol";
import { SYSTEM_ACTOR, siteSettings, type KobeDb } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import type { BrandingDefaults } from "./defaults-config.js";
import { themeLabel } from "./settings.js";
import { brandingCache } from "./store.js";

/** The start-up seed of the chart's branding defaults (KOBE-503; see defaults-config.ts). */
type Setting = "app_name" | "show_name" | "theme";

interface Seed {
  readonly setting: Setting;
  readonly key: string;
  readonly value: string;
  /** The audit value (TH12), as the admin route records it. */
  readonly label: string;
}

function seedsOf(defaults: BrandingDefaults): Seed[] {
  const seeds: Seed[] = [];
  if (defaults.appName !== undefined) {
    const name = defaults.appName;
    seeds.push({
      setting: "app_name",
      key: BRANDING_SETTING_KEYS.appName,
      value: name,
      label: name,
    });
  }
  if (defaults.showName !== undefined) {
    const value = String(defaults.showName);
    seeds.push({ setting: "show_name", key: BRANDING_SETTING_KEYS.showName, value, label: value });
  }
  if (defaults.preset !== undefined) {
    const theme: ThemeSettings = { preset: defaults.preset };
    seeds.push({
      setting: "theme",
      key: BRANDING_SETTING_KEYS.theme,
      value: JSON.stringify(theme),
      label: themeLabel(theme),
    });
  }
  return seeds;
}

/**
 * Writes each configured default whose key is unset (INSERT … ON CONFLICT DO NOTHING per key, so
 * two replicas starting together seed once), records one `site.branding.updated` event per
 * written key with the system actor (as the gallery seed records its agents), and drops this
 * replica's branding cache. Returns the settings it wrote.
 */
export async function seedBrandingDefaults(
  db: KobeDb,
  defaults: BrandingDefaults,
): Promise<Setting[]> {
  const seeds = seedsOf(defaults);
  if (seeds.length === 0) return [];
  const written = await db.transaction(async (tx) => {
    const done: Seed[] = [];
    for (const seed of seeds) {
      const rows = await tx
        .insert(siteSettings)
        .values({ key: seed.key, value: seed.value })
        .onConflictDoNothing({ target: siteSettings.key })
        .returning({ key: siteSettings.key });
      if (rows.length > 0) done.push(seed);
    }
    // Audit last: every write first, then one event per seeded setting.
    for (const seed of done) {
      await recordAudit(tx, {
        actor: SYSTEM_ACTOR,
        action: "site.branding.updated",
        target: { setting: seed.setting, value: seed.label },
      });
    }
    return done.map((s) => s.setting);
  });
  if (written.length > 0) brandingCache(db).invalidate();
  return written;
}
