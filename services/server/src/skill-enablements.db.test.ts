import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { resolveEffective } from "./resolver/resolve.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./runs/resolver-input.js";
import { catalogSeed } from "./testing/catalog-seed.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-316 (SK25, SK27, D22): members turn their personal skills on or off per team, and the team's
 * Available and On by default skills for themselves; team skills get the access mode selector
 * (Required: Team admins only, audited, a warning at 5); the team's catalog switches have a Team
 * admin route; Builders install catalog skills while the switch allows, never Required or
 * deprecated.
 */
const f = new RunFixture();
const admin = () => f.fx.admin;
const seed = catalogSeed(admin);

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

async function loaded(team: string, userId: string, names: string[] = []) {
  return withTeam(f.fx.db, team, async (tx) => {
    const facts = await loadTeamFacts(tx, team);
    const skills = await loadSkillFacts(tx, {
      teamId: team,
      userId,
      agentSkillNames: names,
      personalSkillsDisabled: facts.personalSkillsDisabled,
    });
    const r = resolveEffective(
      buildResolveInput({
        frontmatter: { name: "A", skills: names } as never,
        versionMode: "ask-on-write",
        floor: "auto",
        team: facts,
        skills,
        connectedConnectors: [],
      }),
    );
    if (!r.ok) throw new Error(r.error.code);
    return r.value.skills.map((s) => s.name).sort();
  });
}

const audits = async (team: string, action: string) =>
  (
    await admin().query(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
      [team, action],
    )
  ).rows.map((r) => r.target as Record<string, unknown>);

async function role(team: string, p: Person, r: "builder" | "member") {
  await admin().query(`UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2`, [
    team,
    p.id,
    r,
  ]);
}

const tag = () => Math.random().toString(36).slice(2, 7);

describe("personal skills per team (ac-1)", () => {
  it("a member's toggle takes effect on the next run, in that team only", async () => {
    const a = await f.world();
    const b = await f.world();
    await f.fx.addMember(b.team, a.owner);
    const name = `mine-${tag()}`;
    const mine = await seed.personalSkill(a.owner.id, name);
    expect(await loaded(a.team, a.owner.id)).toEqual([name]);

    const off = await f.on(0, a.owner).put("/v1/me/skills/enablements", {
      kind: "personal",
      skillId: mine.id,
      enabled: false,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(await loaded(a.team, a.owner.id)).toEqual([]);
    expect(await loaded(b.team, a.owner.id)).toEqual([name]);
    // Turned off: not queued for the team's review either, and no notice.
    const list = await f.on(0, a.owner).get("/v1/me/skills/enablements");
    expect(list.json.personal).toEqual([{ skillId: mine.id, name, enabled: false }]);
    expect(await audits(a.team, "skill.enablement.changed")).toEqual([
      { kind: "personal", skillId: mine.id, name, enabled: false },
    ]);

    const on = await f.on(0, a.owner).put("/v1/me/skills/enablements", {
      kind: "personal",
      skillId: mine.id,
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(await loaded(a.team, a.owner.id)).toEqual([name]);
  });

  it("nobody toggles another member's personal skill", async () => {
    const w = await f.world();
    const other = await f.member(w.team);
    const theirs = await seed.personalSkill(other.id, `theirs-${tag()}`);
    const res = await f.on(0, w.owner).put("/v1/me/skills/enablements", {
      kind: "personal",
      skillId: theirs.id,
      enabled: false,
    });
    expect([res.status, res.json.code]).toEqual([404, "not_found"]);
  });
});

describe("team skills for one member (ac-3)", () => {
  it("turns On by default off and Available on; Required and Hidden can't be toggled", async () => {
    const w = await f.world();
    const t = tag();
    const ids: Record<string, string> = {};
    for (const access of ["default_on", "available", "required", "hidden"] as const) {
      const slug = `${access.replace("_", "-")}-${t}`;
      ids[access] = await seed.teamSkill(w.team, w.owner.id, slug, access);
      await seed.addVersion(w.team, w.owner.id, ids[access], slug, 1);
    }
    const me = f.on(0, w.owner);
    expect(await loaded(w.team, w.owner.id)).toEqual([`default-on-${t}`, `required-${t}`]);
    const put = (access: string, enabled: boolean) =>
      me.put("/v1/me/skills/enablements", { kind: "team", skillId: ids[access], enabled });
    expect((await put("default_on", false)).status).toBe(200);
    expect((await put("available", true)).status).toBe(200);
    expect(await loaded(w.team, w.owner.id)).toEqual([`available-${t}`, `required-${t}`]);
    for (const access of ["required", "hidden"]) {
      const res = await put(access, false);
      expect([res.status, res.json.code], access).toEqual([409, "not_toggleable"]);
    }
    const list = await me.get("/v1/me/skills/enablements");
    expect(
      (list.json.team as { name: string; access: string; enabled: boolean }[]).map(
        (s) => `${s.name}:${s.access}:${s.enabled}`,
      ),
    ).toEqual([
      `available-${t}:available:true`,
      `default-on-${t}:default_on:false`,
      `required-${t}:required:true`,
    ]);
  });

  it("toggles an install the team made Available or On by default", async () => {
    const w = await f.world();
    const reviewer = (await f.world()).owner.id;
    const c = await seed.catalogSkill(`inst-${tag()}`, w.owner.id, reviewer, [
      ["1.0.0", "approved"],
    ]);
    await seed.install(w.team, w.owner.id, c, "1.0.0", "pinned", "available");
    const me = f.on(0, w.owner);
    const res = await me.put("/v1/me/skills/enablements", {
      kind: "catalog",
      skillId: c.skill,
      enabled: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await loaded(w.team, w.owner.id)).length).toBe(1);
  });
});

describe("access modes for team skills (ac-2)", () => {
  it("Builders set Available, On by default and Hidden; Required is Team admin only", async () => {
    const w = await f.world();
    const builder = await f.member(w.team);
    await role(w.team, builder, "builder");
    const slug = `mode-${tag()}`;
    const id = await seed.teamSkill(w.team, w.owner.id, slug);
    const as = (p: Person, access: string) => f.on(0, p).put(`/v1/skills/${id}/access`, { access });
    expect((await as(builder, "default_on")).status).toBe(200);
    expect((await as(builder, "hidden")).status).toBe(200);
    const refused = await as(builder, "required");
    expect([refused.status, refused.json.code]).toEqual([403, "forbidden"]);
    const ok = await as(w.owner, "required");
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ access: "required", requiredCount: 1 });
    // A Builder can't take Required away again either.
    expect((await as(builder, "available")).status).toBe(403);
    const member = await f.member(w.team);
    expect((await as(member, "available")).status).toBe(403);
    expect(await audits(w.team, "skill.access.changed")).toEqual([
      { skillId: id, slug, access: "default_on", previous: "available" },
      { skillId: id, slug, access: "hidden", previous: "default_on" },
      { skillId: id, slug, access: "required", previous: "hidden" },
    ]);
    const row = await admin().query(`SELECT offer_to_all FROM team_skills WHERE id = $1`, [id]);
    expect(row.rows).toEqual([{ offer_to_all: false }]);
  });

  it("warns once the team has 5 Required skills", async () => {
    const w = await f.world();
    const t = tag();
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      const id = await seed.teamSkill(w.team, w.owner.id, `req-${i}-${t}`);
      const res = await f.on(0, w.owner).put(`/v1/skills/${id}/access`, { access: "required" });
      expect(res.status).toBe(200);
      if (i === 3) expect(res.json.warning).toBeUndefined();
      last = res.json;
    }
    expect(last).toMatchObject({ requiredCount: 5, warning: "many_required" });
  });
});

describe("the team's catalog switches and Builder installs", () => {
  it("Team admins change the switches (audited); Builders install only while allowed", async () => {
    const w = await f.world();
    const reviewer = (await f.world()).owner.id;
    const builder = await f.member(w.team);
    await role(w.team, builder, "builder");
    const c = await seed.catalogSkill(`bld-${tag()}`, w.owner.id, reviewer, [
      ["1.0.0", "approved"],
      ["1.1.0", "deprecated"],
    ]);
    const put = (p: Person, body: Record<string, unknown>) =>
      f.on(0, p).put(`/v1/team/skills/installs/${c.skill}`, {
        version: "1.0.0",
        pinMode: "pinned",
        access: "default_on",
        ...body,
      });
    expect((await put(builder, { access: "required" })).status).toBe(403);
    const deprecated = await put(builder, { version: "1.1.0" });
    expect([deprecated.status, deprecated.json.code]).toEqual([403, "forbidden"]);
    expect((await put(builder, {})).status).toBe(200);

    const settings = f.on(0, w.owner);
    expect(
      (
        await f
          .on(0, builder)
          .put("/v1/team/skill-review/settings", { buildersMayInstallCatalog: false })
      ).status,
    ).toBe(403);
    const off = await settings.put("/v1/team/skill-review/settings", {
      buildersMayInstallCatalog: false,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json).toEqual({
      personalSkillsDisabled: false,
      membersMayAddCatalog: true,
      buildersMayInstallCatalog: false,
      evalJudgeAlias: null,
    });
    expect((await put(builder, { access: "available" })).status).toBe(403);
    expect((await put(w.owner, { access: "required" })).status).toBe(200);
    expect(await audits(w.team, "skill.catalog_switches.changed")).toEqual([
      { buildersMayInstallCatalog: false },
    ]);
    // Switched back on: a Builder still can't change a Required install.
    await settings.put("/v1/team/skill-review/settings", { buildersMayInstallCatalog: true });
    expect((await put(builder, { access: "available" })).status).toBe(403);
    const bad = await settings.put("/v1/team/skill-review/settings", { buildersMayInstall: 1 });
    expect(bad.status).toBe(400);
  });
});

describe("review fixes (KOBE-316 review)", () => {
  it("the legacy offer route never changes Required or Hidden, and audits as access", async () => {
    const w = await f.world();
    const t = tag();
    const ids: Record<string, string> = {};
    for (const access of ["required", "hidden", "available"] as const)
      ids[access] = await seed.teamSkill(w.team, w.owner.id, `${access}-${t}`, access);
    const offer = (id: string | undefined, offerToAll: boolean) =>
      f.on(0, w.owner).put(`/v1/skills/${id}/offer`, { offerToAll });
    for (const access of ["required", "hidden"]) {
      for (const on of [true, false]) {
        const res = await offer(ids[access], on);
        expect([res.status, res.json.code], access).toEqual([409, "access_mode"]);
      }
      const row = await admin().query(`SELECT access FROM team_skills WHERE id = $1`, [
        ids[access],
      ]);
      expect(row.rows).toEqual([{ access }]);
    }
    expect((await offer(ids.available, true)).json).toEqual({ offerToAll: true });
    expect(await audits(w.team, "skill.access.changed")).toEqual([
      {
        skillId: ids.available,
        slug: `available-${t}`,
        access: "default_on",
        previous: "available",
      },
    ]);
    expect((await audits(w.team, "skill.offer.changed")).length).toBe(1);
  });

  it("two admins changing different switches at once both stick", async () => {
    const w = await f.world();
    const other = await f.member(w.team);
    await admin().query(
      `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
      [w.team, other.id],
    );
    const [a, b] = await Promise.all([
      f.on(0, w.owner).put("/v1/team/skill-review/settings", { membersMayAddCatalog: false }),
      f.on(0, other).put("/v1/team/skill-review/settings", { buildersMayInstallCatalog: false }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const now = await f.on(0, w.owner).get("/v1/team/skill-review/settings");
    expect(now.json).toMatchObject({
      membersMayAddCatalog: false,
      buildersMayInstallCatalog: false,
    });
    expect((await audits(w.team, "skill.catalog_switches.changed")).length).toBe(2);
  });

  it("Builders change only installs a Builder or member made, never Default ones", async () => {
    const w = await f.world();
    const reviewer = (await f.world()).owner.id;
    const builder = await f.member(w.team);
    await role(w.team, builder, "builder");
    const t = tag();
    const byAdmin = await seed.catalogSkill(`adm-${t}`, w.owner.id, reviewer, [
      ["1.0.0", "approved"],
    ]);
    const byDefault = await seed.catalogSkill(`dft-${t}`, w.owner.id, reviewer, [
      ["1.0.0", "approved"],
    ]);
    const own = await seed.catalogSkill(`own-${t}`, w.owner.id, reviewer, [["1.0.0", "approved"]]);
    await seed.install(w.team, w.owner.id, byAdmin, "1.0.0", "pinned", "default_on");
    await admin().query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin,
         installed_by) VALUES ($1, $2, $3, 'within_major', 'default_on', 'default_tag', $4)`,
      [w.team, byDefault.skill, byDefault.ids["1.0.0"], builder.id],
    );
    const put = (skill: string) =>
      f.on(0, builder).put(`/v1/team/skills/installs/${skill}`, {
        version: "1.0.0",
        pinMode: "pinned",
        access: "hidden",
      });
    expect((await put(byAdmin.skill)).status).toBe(403);
    expect((await put(byDefault.skill)).status).toBe(403);
    expect((await put(own.skill)).status).toBe(200);
    expect((await put(own.skill)).status).toBe(200);
  });

  it("the access of an archived skill is not changed", async () => {
    const w = await f.world();
    const id = await seed.teamSkill(w.team, w.owner.id, `old-${tag()}`);
    await admin().query(`UPDATE team_skills SET archived_at = now() WHERE id = $1`, [id]);
    const res = await f.on(0, w.owner).put(`/v1/skills/${id}/access`, { access: "default_on" });
    expect(res.status).toBe(404);
  });
});
