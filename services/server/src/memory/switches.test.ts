import { describe, expect, it } from "vitest";
import { pickLearningModel } from "./learning-model.js";
import {
  MEMORY_SITE_SETTINGS_DEFAULTS,
  memorySiteSettingsSchema,
  parseMemorySiteSettings,
} from "./site-settings.js";
import {
  SITE_SWITCHES_ON,
  SITE_SWITCH_NAMES,
  WORKSPACE_SWITCHES_ON,
  WORKSPACE_SWITCH_NAMES,
  effectiveMemory,
  type SiteMemorySwitches,
  type WorkspaceMemorySwitches,
} from "./switch-model.js";
import { parseTeamMemoryJson } from "./switches.js";

/** KOBE-381 ac-1, ac-2, ac-4: the effective-switch matrix and the learning model, without a DB. */

const site = (off: Partial<SiteMemorySwitches> = {}): SiteMemorySwitches => ({
  ...SITE_SWITCHES_ON,
  ...off,
});
const ws = (off: Partial<WorkspaceMemorySwitches> = {}): WorkspaceMemorySwitches => ({
  ...WORKSPACE_SWITCHES_ON,
  ...off,
});

const ALL_ON = {
  notes: { user: true, project: true },
  memories: true,
  scopes: { user: true, portable: true, team: true, site: true },
  policy: true,
  learn: true,
  siteProposals: true,
};
const ALL_OFF = {
  notes: { user: false, project: false },
  memories: false,
  scopes: { user: false, portable: false, team: false, site: false },
  policy: false,
  learn: false,
  siteProposals: false,
};

describe("effective memory switches (ac-1)", () => {
  it("defaults are all on, so an upgrade changes nothing", () => {
    expect(effectiveMemory(site(), ws())).toEqual(ALL_ON);
  });

  it("the master switch at either level turns off Notes and Memories (the widening)", () => {
    expect(effectiveMemory(site({ memoryEnabled: false }), ws())).toEqual(ALL_OFF);
    expect(effectiveMemory(site(), ws({ memoryEnabled: false }))).toEqual(ALL_OFF);
  });

  it("Memories off at either level keeps Notes", () => {
    for (const e of [
      effectiveMemory(site({ memoriesEnabled: false }), ws()),
      effectiveMemory(site(), ws({ memoriesEnabled: false })),
    ]) {
      expect(e).toEqual({ ...ALL_OFF, notes: { user: true, project: true } });
    }
  });

  // One row per switch: what turning only that switch off changes (everything else stays on).
  const SITE_ROWS: Record<(typeof SITE_SWITCH_NAMES)[number], object> = {
    memoryEnabled: ALL_OFF,
    projectMemoryEnabled: { ...ALL_ON, notes: { user: true, project: false } },
    memoriesEnabled: { ...ALL_OFF, notes: { user: true, project: true } },
    portableEnabled: { ...ALL_ON, scopes: { ...ALL_ON.scopes, portable: false } },
    learnEnabled: { ...ALL_ON, learn: false },
    siteProposalsEnabled: { ...ALL_ON, siteProposals: false },
  };
  const WS_ROWS: Record<(typeof WORKSPACE_SWITCH_NAMES)[number], object> = {
    memoryEnabled: ALL_OFF,
    projectMemoryEnabled: { ...ALL_ON, notes: { user: true, project: false } },
    memoriesEnabled: { ...ALL_OFF, notes: { user: true, project: true } },
    workspaceMemoriesEnabled: {
      ...ALL_ON,
      scopes: { ...ALL_ON.scopes, team: false },
      siteProposals: false,
    },
    siteMemoriesEnabled: { ...ALL_ON, scopes: { ...ALL_ON.scopes, site: false } },
    learnEnabled: { ...ALL_ON, learn: false },
    siteProposalsEnabled: { ...ALL_ON, siteProposals: false },
  };

  it.each(SITE_SWITCH_NAMES.map((n) => [n]))("Site %s off", (name) => {
    expect(effectiveMemory(site({ [name]: false }), ws())).toEqual(SITE_ROWS[name]);
  });

  it.each(WORKSPACE_SWITCH_NAMES.map((n) => [n]))("Workspace %s off", (name) => {
    expect(effectiveMemory(site(), ws({ [name]: false }))).toEqual(WS_ROWS[name]);
  });

  it("every pair of a Site and a Workspace switch is AND-ed", () => {
    for (const s of SITE_SWITCH_NAMES) {
      for (const w of WORKSPACE_SWITCH_NAMES) {
        const both = effectiveMemory(site({ [s]: false }), ws({ [w]: false }));
        const one = effectiveMemory(site({ [s]: false }), ws());
        const other = effectiveMemory(site(), ws({ [w]: false }));
        const and = (a: unknown, b: unknown): unknown =>
          typeof a === "boolean"
            ? a && (b as boolean)
            : Object.fromEntries(
                Object.entries(a as object).map(([k, v]) => [
                  k,
                  and(v, (b as Record<string, unknown>)[k]),
                ]),
              );
        expect(both, `${s} + ${w}`).toEqual(and(one, other));
      }
    }
  });
});

describe("Policy (ac-2)", () => {
  it("reaches a Workspace that opted out of Site memories", () => {
    const e = effectiveMemory(site(), ws({ siteMemoriesEnabled: false }));
    expect(e.scopes.site).toBe(false);
    expect(e.policy).toBe(true);
  });

  it("still needs Memories (and the master switch)", () => {
    expect(effectiveMemory(site({ memoriesEnabled: false }), ws()).policy).toBe(false);
    expect(effectiveMemory(site(), ws({ memoryEnabled: false })).policy).toBe(false);
  });
});

describe("stored Workspace values", () => {
  it("a missing object or key reads as on, a non-boolean as on, a bad alias as none", () => {
    const on = {
      memoriesEnabled: true,
      workspaceMemoriesEnabled: true,
      siteMemoriesEnabled: true,
      learnEnabled: true,
      siteProposalsEnabled: true,
      learningModelAlias: null,
    };
    expect(parseTeamMemoryJson(null)).toEqual(on);
    expect(parseTeamMemoryJson([])).toEqual(on);
    expect(
      parseTeamMemoryJson({ memories_enabled: "no", learning_model_alias: "Bad Alias" }),
    ).toEqual(on);
    expect(
      parseTeamMemoryJson({
        site_memories_enabled: false,
        learn_enabled: false,
        learning_model_alias: "gpt-x",
      }),
    ).toEqual({
      ...on,
      siteMemoriesEnabled: false,
      learnEnabled: false,
      learningModelAlias: "gpt-x",
    });
  });
});

describe("Site memory settings", () => {
  it("defaults: 8 KiB budget, version cap 50, stale 90 d, retention 365 d, no models", () => {
    expect(parseMemorySiteSettings(null)).toEqual(MEMORY_SITE_SETTINGS_DEFAULTS);
    expect(MEMORY_SITE_SETTINGS_DEFAULTS).toMatchObject({
      learning_model_alias: null,
      embedding_model_alias: null,
      context_budget_kib: 8,
      version_cap: 50,
      stale_after_days: 90,
      retention_days: 365,
    });
  });

  it("has no full-text search language setting (Q11)", () => {
    expect(Object.keys(MEMORY_SITE_SETTINGS_DEFAULTS).filter((k) => /lang|fts/.test(k))).toEqual(
      [],
    );
  });

  it("the context budget is 4 to 16 KiB", () => {
    const at = (kib: number) =>
      memorySiteSettingsSchema.safeParse({
        ...MEMORY_SITE_SETTINGS_DEFAULTS,
        context_budget_kib: kib,
      }).success;
    expect([at(3), at(4), at(16), at(17), at(8.5)]).toEqual([false, true, true, false, false]);
  });

  it("reads a stored document field by field; a bad field reads as its default", () => {
    const stored = JSON.stringify({ version_cap: 20, stale_after_days: -1, extra: 1 });
    expect(parseMemorySiteSettings(stored)).toEqual({
      ...MEMORY_SITE_SETTINGS_DEFAULTS,
      version_cap: 20,
    });
    expect(parseMemorySiteSettings("{not json")).toEqual(MEMORY_SITE_SETTINGS_DEFAULTS);
  });
});

describe("learning model (ac-4)", () => {
  const enabledIn =
    (...aliases: string[]) =>
    (a: string) =>
      Promise.resolve(aliases.includes(a));

  it("the Site's model when the Workspace enabled it", async () => {
    expect(await pickLearningModel("site-m", "ws-m", enabledIn("site-m", "ws-m"))).toEqual({
      ok: true,
      alias: "site-m",
      source: "site",
    });
  });

  it("else the Workspace's own model while it is enabled", async () => {
    expect(await pickLearningModel("site-m", "ws-m", enabledIn("ws-m"))).toEqual({
      ok: true,
      alias: "ws-m",
      source: "team",
    });
    expect(await pickLearningModel(null, "ws-m", enabledIn("ws-m"))).toMatchObject({
      alias: "ws-m",
    });
  });

  it("unset: unavailable with a reason, even when the Workspace has enabled models", async () => {
    const r = await pickLearningModel(null, null, () => Promise.resolve(true));
    expect(r).toMatchObject({ ok: false, reason: "no_learning_model" });
    expect(r.ok ? "" : r.message).toMatch(/No learning model is set/);
  });

  it("not enabled: unavailable with a reason, never another model", async () => {
    const asked: string[] = [];
    const r = await pickLearningModel("site-m", "ws-m", (a) => {
      asked.push(a);
      return Promise.resolve(false);
    });
    expect(r).toMatchObject({ ok: false, reason: "learning_model_not_enabled" });
    // Only the two chosen aliases are ever considered: no thread or default model.
    expect(asked).toEqual(["site-m", "ws-m"]);
    expect(pickLearningModel.length).toBe(3);
  });
});
