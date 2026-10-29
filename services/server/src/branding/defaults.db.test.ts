import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openHarness, type Harness } from "../testing/harness.js";
import { seedBrandingDefaults } from "./defaults.js";
import { brandingCache } from "./store.js";

/**
 * KOBE-503 (theming T7): chart values seed the branding settings only while each key is unset,
 * so an admin's later change survives every restart.
 */
let h: Harness;

beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.admin.query(`DELETE FROM site_settings WHERE key LIKE 'branding.%'`);
  brandingCache(h.deps.database.db).invalidate();
});

async function settings(): Promise<Record<string, string>> {
  const { rows } = await h.admin.query<{ key: string; value: string }>(
    `SELECT key, value FROM site_settings WHERE key LIKE 'branding.%' ORDER BY key`,
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function events(since: number) {
  const { rows } = await h.admin.query<{
    actor_kind: string;
    actor_id: string | null;
    team_id: string | null;
    target: { setting: string; value: string };
  }>(
    `SELECT actor_kind, actor_id, team_id, target FROM audit_log
      WHERE action = 'site.branding.updated' AND seq > $1 ORDER BY seq`,
    [since],
  );
  return rows;
}

async function lastSeq(): Promise<number> {
  const { rows } = await h.admin.query<{ seq: string | null }>(
    `SELECT max(seq) AS seq FROM audit_log`,
  );
  return Number(rows[0]?.seq ?? 0);
}

const ALL = { appName: "Acme Assist", preset: "forest", showName: false } as const;

describe("seedBrandingDefaults (KOBE-503)", () => {
  it("seeds every configured key on a fresh site, audited as the system", async () => {
    const since = await lastSeq();
    expect(await seedBrandingDefaults(h.deps.database.db, ALL)).toEqual([
      "app_name",
      "show_name",
      "theme",
    ]);
    expect(await settings()).toEqual({
      "branding.app_name": "Acme Assist",
      "branding.show_name": "false",
      "branding.theme": '{"preset":"forest"}',
    });
    expect(await events(since)).toEqual([
      {
        actor_kind: "system",
        actor_id: null,
        team_id: null,
        target: { setting: "app_name", value: "Acme Assist" },
      },
      {
        actor_kind: "system",
        actor_id: null,
        team_id: null,
        target: { setting: "show_name", value: "false" },
      },
      {
        actor_kind: "system",
        actor_id: null,
        team_id: null,
        target: { setting: "theme", value: "theme:forest" },
      },
    ]);
  });

  it("changes nothing on a second run (a restart)", async () => {
    await seedBrandingDefaults(h.deps.database.db, ALL);
    const before = await settings();
    const since = await lastSeq();
    expect(await seedBrandingDefaults(h.deps.database.db, ALL)).toEqual([]);
    expect(await settings()).toEqual(before);
    expect(await events(since)).toEqual([]);
  });

  it("never overwrites an admin's value; still seeds the keys that are unset", async () => {
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('branding.theme', '{"preset":"plum"}'),
        ('branding.app_name', 'Admin Choice')`,
    );
    const since = await lastSeq();
    expect(await seedBrandingDefaults(h.deps.database.db, ALL)).toEqual(["show_name"]);
    expect(await settings()).toEqual({
      "branding.app_name": "Admin Choice",
      "branding.show_name": "false",
      "branding.theme": '{"preset":"plum"}',
    });
    expect((await events(since)).map((e) => e.target.setting)).toEqual(["show_name"]);
  });

  it("writes nothing when nothing is configured", async () => {
    const since = await lastSeq();
    expect(await seedBrandingDefaults(h.deps.database.db, {})).toEqual([]);
    expect(await settings()).toEqual({});
    expect(await events(since)).toEqual([]);
  });

  it("drops the branding cache, so the public snapshot shows the seeded values at once", async () => {
    const cache = brandingCache(h.deps.database.db);
    expect((await cache.get()).settings.appName).toBe("Kobe");
    await seedBrandingDefaults(h.deps.database.db, { appName: "Acme Assist", preset: "ember" });
    const { settings: seeded } = await cache.get();
    expect(seeded.appName).toBe("Acme Assist");
    expect(seeded.theme).toEqual({ preset: "ember" });
    const res = await h.browser().get("/v1/site/branding");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ appName: "Acme Assist", theme: { preset: "ember" } });
  });
});
