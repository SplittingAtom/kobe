import type { SkillMirrorStatus } from "@kobe/protocol";
import { decideEgress, loadEgressCeiling } from "@kobe/db";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { readRegistrySettings } from "../skills/registry/settings.js";
import { mirrorCounts, retryMirrorNow } from "../skills/mirror/mirror-store.js";
import type { MirrorMissing } from "../skills/mirror/runner.js";

/** What the routes need of the mirror job: a kick, and what this server lacks to push. */
export interface MirrorKick {
  kick(): void;
}
export interface SkillMirrorHandle extends MirrorKick {
  missing(): readonly MirrorMissing[];
}

/**
 * The git mirror's status and Retry (`/v1/site/skills/registry/mirror`, KOBE-343, SK29): Site
 * admins see whether it can push (token Secret, egress proxy, the host in the ceiling), how many
 * catalog versions are pushed, pending and failing, and each failure's last error. The
 * configuration itself is a Registry setting (`mirror`).
 */
export function siteSkillMirrorRoutes(
  deps: ServerDeps,
  mirror: SkillMirrorHandle | undefined,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use("*", requireSitePermission("site.skills.catalog.manage"));

  app.get("/", async (c) => {
    const settings = (await readRegistrySettings(db)).mirror;
    const url = settings.url ?? null;
    const missing = mirror ? [...mirror.missing()] : (["token", "egress_proxy"] as const);
    let hostInCeiling: boolean | null = null;
    if (url) {
      const ceiling = new Set(await loadEgressCeiling(db));
      hostInCeiling = decideEgress(ceiling, ceiling, new URL(url).hostname).allowed;
    }
    const counts = await mirrorCounts(db, settings.enabled ? url : null);
    const status: SkillMirrorStatus = {
      enabled: settings.enabled,
      url,
      branch: settings.branch ?? "main",
      ready: missing.length === 0,
      missing: [...missing],
      hostInCeiling,
      ...counts,
    };
    return c.json(status);
  });

  // Retry now: every failed version is due at once (otherwise each backs off on its own).
  app.post("/retry", async (c) => {
    const settings = (await readRegistrySettings(db)).mirror;
    if (!settings.enabled || !settings.url)
      return c.json({ code: "mirror_off", message: "The git mirror is off." }, 409);
    const versions = await retryMirrorNow(db, settings.url);
    mirror?.kick();
    return c.json({ versions });
  });

  return app;
}
