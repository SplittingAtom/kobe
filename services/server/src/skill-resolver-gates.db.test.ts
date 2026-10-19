import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSkillBundle } from "@kobe/skill-scanner";
import { withTeam } from "@kobe/db";
import { runWithAuditContext } from "./audit/context.js";
import { resolveEffective } from "./resolver/resolve.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./runs/resolver-input.js";
import { uploadSkillVersion } from "./skills/store.js";
import { catalogSeed, hashOf } from "./testing/catalog-seed.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-315 review (S1, S2, S4–S6, N1): the team's gates on catalog skills hold at run start.
 * A team block drops installs and member adds; member adds load only while the team allows them
 * and never for a Hidden install; a Required or named skill that is left out keeps its name; a
 * team skill can't take an installed catalog skill's name, and a draft never hides the install;
 * the install route refuses blocked and suspended versions and marks a version-only change as the
 * team's; runs with no agent load Required skills.
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

async function resolveFor(team: string, userId: string, agentSkillNames: string[]) {
  return withTeam(f.fx.db, team, async (tx) => {
    const facts = await loadTeamFacts(tx, team);
    const skills = await loadSkillFacts(tx, {
      teamId: team,
      userId,
      agentSkillNames,
      personalSkillsDisabled: facts.personalSkillsDisabled,
    });
    const r = resolveEffective(
      buildResolveInput({
        frontmatter: { name: "A", skills: agentSkillNames } as never,
        versionMode: "ask-on-write",
        floor: "auto",
        team: facts,
        skills,
        connectedConnectors: [],
      }),
    );
    if (!r.ok) throw new Error(r.error.code);
    return {
      skills: r.value.skills.map((s) => `${s.name}@${s.semver ?? ""}:${s.source ?? ""}`),
      omissions: r.value.omissions
        .filter((o) => o.kind === "skill")
        .map((o) => `${o.name}:${o.reason}`),
    };
  });
}

async function memberAdd(team: string, userId: string, skill: string, versionId: string) {
  await admin().query(
    `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, enabled, version_id,
       pin_mode) VALUES ($1, $2, $3, true, $4, 'pinned')`,
    [team, userId, skill, versionId],
  );
}

async function world() {
  const w = await f.world();
  const reviewer = (await f.world()).owner.id;
  const tag = Math.random().toString(36).slice(2, 7);
  const catalog = async (name: string, versions: Parameters<typeof seed.catalogSkill>[3]) => ({
    ...(await seed.catalogSkill(`${name}-${tag}`, w.owner.id, reviewer, versions)),
    name: `${name}-${tag}`,
  });
  return { w, team: w.team, me: w.owner.id, tag, catalog };
}

describe("team blocks and the member-add switch (S1)", () => {
  it("a blocked skill loads neither as an install nor as a member add", async () => {
    const { team, me, catalog } = await world();
    const installed = await catalog("blk-inst", [["1.0.0", "approved"]]);
    const added = await catalog("blk-add", [["1.0.0", "approved"]]);
    await seed.install(team, me, installed, "1.0.0", "pinned", "required");
    await memberAdd(team, me, added.skill, must(added.ids["1.0.0"]));
    // Written straight to the table: the resolver must not rely on every writer deleting rows.
    await admin().query(
      `ALTER TABLE team_skill_blocks DISABLE TRIGGER team_skill_blocks_remove_adds`,
    );
    try {
      for (const s of [installed.skill, added.skill])
        await admin().query(
          `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
          [team, s, me],
        );
    } finally {
      await admin().query(
        `ALTER TABLE team_skill_blocks ENABLE TRIGGER team_skill_blocks_remove_adds`,
      );
    }
    const r = await resolveFor(team, me, []);
    expect(r.skills).toEqual([]);
  });

  it("member adds load only while the team allows them, and never for an installed skill", async () => {
    const { team, me, catalog } = await world();
    const hidden = await catalog("hid", [["1.0.0", "approved"]]);
    const free = await catalog("free", [["1.0.0", "approved"]]);
    const onByDefault = await catalog("dflt", [
      ["1.0.0", "approved"],
      ["1.1.0", "approved"],
    ]);
    await seed.install(team, me, hidden, "1.0.0", "pinned", "hidden");
    await seed.install(team, me, onByDefault, "1.1.0", "pinned", "default_on");
    await memberAdd(team, me, hidden.skill, must(hidden.ids["1.0.0"]));
    await memberAdd(team, me, free.skill, must(free.ids["1.0.0"]));
    await memberAdd(team, me, onByDefault.skill, must(onByDefault.ids["1.0.0"]));
    // The team's install governs (KOBE-338 review M3): the add of the On by default install is the
    // member's "on" choice at the team's pin; the add of the Hidden install loads nothing.
    const on = await resolveFor(team, me, []);
    expect(on.skills.sort()).toEqual(
      [`${free.name}@1.0.0:catalog`, `${onByDefault.name}@1.1.0:catalog`].sort(),
    );
    await admin().query(
      `INSERT INTO team_skill_settings (team_id, members_may_add_catalog, updated_by)
       VALUES ($1, false, $2)`,
      [team, me],
    );
    // Adds off: the add is ignored; the On by default install loads at the team's pin.
    const off = await resolveFor(team, me, []);
    expect(off.skills).toEqual([`${onByDefault.name}@1.1.0:catalog`]);
  });

  it("the install route refuses a skill the team blocked", async () => {
    const { w, team, me, catalog } = await world();
    const c = await catalog("blk-route", [["1.0.0", "approved"]]);
    await admin().query(
      `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
      [team, c.skill, me],
    );
    const res = await f.on(0, w.owner).put(`/v1/team/skills/installs/${c.skill}`, {
      version: "1.0.0",
      pinMode: "pinned",
      access: "default_on",
    });
    expect([res.status, res.json.code]).toEqual([409, "blocked"]);
  });
});

describe("a left-out Required or named skill keeps its name (S2, N1)", () => {
  it("Required revoked: the member's personal skill of that name does not load", async () => {
    const { team, me, tag, catalog } = await world();
    const c = await catalog("xlsx", [["1.0.0", "revoked"]]);
    await seed.install(team, me, c, "1.0.0", "pinned", "required");
    await seed.personalSkill(me, c.name);
    await seed.personalSkill(me, `other-${tag}`);
    const r = await resolveFor(team, me, []);
    expect(r.skills).toEqual([`other-${tag}@0.1.0:personal`]);
    expect(r.omissions).toEqual(
      expect.arrayContaining([`${c.name}:revoked`, `${c.name}:shadowed_by_agent`]),
    );
  });

  it("named but not installed: a personal skill of that name does not stand in", async () => {
    const { team, me, catalog } = await world();
    const c = await catalog("named", [["1.0.0", "approved"]]);
    await seed.personalSkill(me, c.name);
    const r = await resolveFor(team, me, [c.name]);
    expect(r.skills).toEqual([]);
    expect(r.omissions).toEqual([`${c.name}:not_installed`, `${c.name}:shadowed_by_agent`]);
  });

  it("a suspended Required team skill is reported and holds its name", async () => {
    const { team, me, tag } = await world();
    const slug = `req-${tag}`;
    const id = await seed.teamSkill(team, me, slug, "required");
    await seed.addVersion(team, me, id, slug, 1);
    await admin().query(
      `UPDATE team_skill_reviews SET status = 'pending', suspended_at = now(), reviewed_by = NULL, reviewed_at = NULL
       WHERE team_id = $1 AND skill_id = $2`,
      [team, id],
    );
    await seed.personalSkill(me, slug);
    const r = await resolveFor(team, me, []);
    expect(r.skills).toEqual([]);
    expect(r.omissions).toEqual([`${slug}:suspended`, `${slug}:shadowed_by_agent`]);
  });
});

describe("team skills don't take an installed catalog skill's name (S4)", () => {
  const upload = (team: string, userId: string, slug: string) =>
    runWithAuditContext({ actor: { kind: "user", id: userId }, ip: null, userAgent: null }, () =>
      uploadSkillVersion(
        f.fx.db,
        { scope: "team", teamId: team },
        {
          slug,
          description: "d",
          frontmatter: {},
          source: "zip",
          contentHash: hashOf(`${team}:${slug}:upload`),
          storageKey: "k",
          packageHash: hashOf(`${team}:${slug}:upload`),
          packageStorageKey: null,
          sizeBytes: 1,
          fileCount: 1,
          uncompressedBytes: 1,
          uploadedBy: userId,
          scan: scanSkillBundle([]),
        },
      ),
    );

  it("refuses a new team skill named like an install; a draft never hides the install", async () => {
    const { team, me, catalog } = await world();
    const c = await catalog("taken", [["1.0.0", "approved"]]);
    await seed.install(team, me, c, "1.0.0", "pinned", "hidden");
    const refused = await upload(team, me, c.name);
    expect(refused).toEqual({ ok: false, error: "name_clash" });
    // A draft of that name that exists anyway (written before the rule, or by a race).
    await seed.teamSkill(team, me, c.name);
    const r = await resolveFor(team, me, [c.name]);
    expect(r.skills).toEqual([`${c.name}@1.0.0:catalog`]);
  });

  it("an archived team skill gives its name to the install", async () => {
    const { team, me, catalog } = await world();
    const c = await catalog("archived", [["1.0.0", "approved"]]);
    const id = await seed.teamSkill(team, me, c.name);
    await seed.addVersion(team, me, id, c.name, 1);
    await admin().query(
      `UPDATE team_skills SET archived_at = now() WHERE team_id = $1 AND id = $2`,
      [team, id],
    );
    await seed.install(team, me, c, "1.0.0", "pinned", "hidden");
    const r = await resolveFor(team, me, [c.name]);
    expect(r.skills).toEqual([`${c.name}@1.0.0:catalog`]);
  });
});

describe("the install route (S5)", () => {
  it("a version-only change is the team's: touched, origin team; suspended is refused", async () => {
    const { w, team, me, catalog } = await world();
    const c = await catalog("moved", [
      ["1.0.0", "approved"],
      ["2.0.0", "approved"],
      ["2.1.0", "approved", true],
    ]);
    await admin().query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin,
         installed_by) VALUES ($1, $2, $3, 'within_major', 'default_on', 'default_tag', $4)`,
      [team, c.skill, c.ids["2.0.0"], me],
    );
    const b = f.on(0, w.owner);
    const body = { version: "1.0.0", pinMode: "within_major", access: "default_on" };
    const rolledBack = await b.put(`/v1/team/skills/installs/${c.skill}`, body);
    expect(rolledBack.status, JSON.stringify(rolledBack.json)).toBe(200);
    const row = await admin().query(
      `SELECT origin, team_changed_at IS NOT NULL AS touched FROM team_skill_installs
       WHERE team_id = $1 AND skill_id = $2`,
      [team, c.skill],
    );
    expect(row.rows).toEqual([{ origin: "team", touched: true }]);
    const suspended = await b.put(`/v1/team/skills/installs/${c.skill}`, {
      ...body,
      version: "2.1.0",
    });
    expect([suspended.status, suspended.json.code]).toEqual([409, "not_installable"]);
  });
});

describe("runs with no agent (S6)", () => {
  it("load the team's Required skills, and nothing else", async () => {
    const { w, team, me, tag } = await world();
    const required = `house-${tag}`;
    const offered = `offered-${tag}`;
    const id = await seed.teamSkill(team, me, required, "required");
    const h = await seed.addVersion(team, me, id, required, 1);
    const other = await seed.teamSkill(team, me, offered, "default_on");
    await seed.addVersion(team, me, other, offered, 1);
    await seed.personalSkill(me, `mine-${tag}`);
    const thread = await f.thread(w.owner);
    const ws = await f.connect(w, 0);
    const run = await f.message(w.owner, thread, "hello");
    const start = await ws.started(run);
    expect(start.config?.skills).toEqual([required]);
    expect(start.config?.skill_bundles?.map((b) => b.sha256)).toEqual([h]);
    ws.reply(start, "ok");
    await f.until(team, run, "completed");
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
