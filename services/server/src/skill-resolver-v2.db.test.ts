import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { resolveEffective } from "./resolver/resolve.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./runs/resolver-input.js";
import { RunFixture } from "./testing/run-fixture.js";
import { catalogSeed } from "./testing/catalog-seed.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-315 (SK27): resolver v2 against the database. Catalog installs resolve at their pin with
 * Required first; member choices turn installs on and off and add their own; the omissions are
 * named; `run.start` records name, semver and hash per skill; a version change shows a "Skill
 * updated" marker on the next run of an existing thread; installing a catalog skill whose name a
 * team skill has is refused.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const admin = () => f.fx.admin;
const { teamSkill, addVersion, catalogSkill, install } = catalogSeed(admin);

async function models(team: string, ownerId: string) {
  await admin().query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [ownerId],
  );
  await admin().query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [ownerId],
  );
  await admin().query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [team, ownerId],
  );
}

async function publishAgent(p: Person, frontmatter: Record<string, unknown>): Promise<string> {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Agent ${randomBytes(2).toString("hex")}`, ...frontmatter },
    prompt: "You help.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

async function resolveFor(
  team: string,
  userId: string,
  agentSkillNames: string[],
  exclusive = false,
) {
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
        frontmatter: {
          name: "A",
          skills: exclusive ? { exclusive: agentSkillNames } : agentSkillNames,
        } as never,
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
      omissions: r.value.omissions.map((o) => `${o.name}:${o.reason}`),
    };
  });
}

describe("catalog installs at their pins, in SK27 order (ac-1)", () => {
  it("Required, named, installs on for the member and their adds, personal", async () => {
    const w = await f.world();
    const reviewer = (await f.world()).owner.id;
    const team = w.team;
    const me = w.owner.id;
    const xlsx = await catalogSkill("xlsx-v2", me, reviewer, [
      ["1.4.2", "approved"],
      ["1.4.3", "approved"],
      ["2.0.0", "approved"],
    ]);
    const policy = await catalogSkill("policy-v2", me, reviewer, [["1.0.0", "approved"]]);
    const charts = await catalogSkill("charts-v2", me, reviewer, [["1.0.0", "approved"]]);
    const pdf = await catalogSkill("pdf-v2", me, reviewer, [
      ["1.0.0", "approved"],
      ["1.1.0", "approved"],
    ]);
    const gone = await catalogSkill("gone-v2", me, reviewer, [["1.0.0", "revoked"]]);
    const flagged = await catalogSkill("flagged-v2", me, reviewer, [
      ["1.0.0", "approved"],
      ["1.1.0", "approved", true],
    ]);
    const off = await catalogSkill("off-v2", me, reviewer, [["1.0.0", "approved"]]);
    await install(team, me, xlsx, "1.4.2", "within_major", "default_on");
    await install(team, me, policy, "1.0.0", "pinned", "required");
    await install(team, me, gone, "1.0.0", "pinned", "default_on");
    await install(team, me, flagged, "1.0.0", "within_major", "default_on");
    await install(team, me, off, "1.0.0", "pinned", "default_on");
    // The member turned one install off and added pdf for themselves, pinned at 1.0.0.
    await admin().query(
      `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, enabled)
       VALUES ($1, $2, $3, false)`,
      [team, me, off.skill],
    );
    await admin().query(
      `INSERT INTO member_skill_enablements (team_id, user_id, catalog_skill_id, enabled, version_id,
         pin_mode) VALUES ($1, $2, $3, true, $4, 'pinned')`,
      [team, me, pdf.skill, pdf.ids["1.0.0"]],
    );
    const named = await teamSkill(team, me, "house-style");
    await addVersion(team, me, named, "house-style", 1);
    const r = await resolveFor(team, me, ["house-style", "charts-v2"]);
    expect(r.skills).toEqual([
      "policy-v2@1.0.0:catalog",
      "house-style@0.1.0:team",
      "xlsx-v2@1.4.3:catalog",
      "pdf-v2@1.0.0:catalog",
    ]);
    expect(r.omissions).toEqual(
      expect.arrayContaining([
        "charts-v2:not_installed",
        "gone-v2:revoked",
        "flagged-v2:suspended",
      ]),
    );
    expect(charts.skill).toBeTruthy();
    // Exclusive: Required and named only.
    const ex = await resolveFor(team, me, ["house-style"], true);
    expect(ex.skills).toEqual(["policy-v2@1.0.0:catalog", "house-style@0.1.0:team"]);
  });
});

describe("run.start records and the Skill updated marker (ac-2, ac-3)", () => {
  it("records name, semver and hash; the next run after a version change marks it", async () => {
    const w = await f.world();
    await models(w.team, w.owner.id);
    const skill = await teamSkill(w.team, w.owner.id, "pretty-v2");
    const h1 = await addVersion(w.team, w.owner.id, skill, "pretty-v2", 1);
    const agent = await publishAgent(w.owner, { skills: ["pretty-v2"] });
    const created = await f.on(0, w.owner).post("/v1/threads", { agent_id: agent });
    const thread = created.json.thread_id as string;
    const ws = await f.connect(w, 0);

    const first = await f.message(w.owner, thread, "one");
    const s1 = await ws.started(first);
    expect(s1.config?.skill_bundles?.map((b) => b.sha256)).toEqual([h1]);
    const refs1 = await admin().query(`SELECT skill_refs FROM runs WHERE id = $1`, [first]);
    expect(refs1.rows[0]?.skill_refs).toEqual([
      { name: "pretty-v2", source: "team", sha256: h1, semver: "0.1.0" },
    ]);
    ws.reply(s1, "done");
    await f.until(w.team, first, "completed");

    // A newer approved version: the next run of the same thread gets it, with a marker.
    const h2 = await addVersion(w.team, w.owner.id, skill, "pretty-v2", 2);
    const second = await f.message(w.owner, thread, "two");
    const s2 = await ws.started(second);
    expect(s2.config?.skill_bundles?.map((b) => b.sha256)).toEqual([h2]);
    const events = await f.events(w.team, second);
    expect(events.filter((e) => e.type === "thread.skill_updated").map((e) => e.payload)).toEqual([
      { thread_id: thread, skills: [{ name: "pretty-v2", from: "0.1.0", to: "0.2.0" }] },
    ]);
    ws.reply(s2, "done");
    await f.until(w.team, second, "completed");
    const markers = await f.on(0, w.owner).get(`/v1/threads/${thread}/markers`);
    const { user_entry_id } = await f.run(w.team, second);
    expect(markers.json.skill_updates).toEqual([
      { run_id: second, user_entry_id, name: "pretty-v2", from: "0.1.0", to: "0.2.0" },
    ]);
  });

  it("names a catalog skill whose bundle this server does not hold, and still starts", async () => {
    const w = await f.world();
    await models(w.team, w.owner.id);
    const reviewer = (await f.world()).owner.id;
    const c = await catalogSkill("unstored-v2", w.owner.id, reviewer, [["1.0.0", "approved"]]);
    await install(w.team, w.owner.id, c, "1.0.0", "pinned", "default_on");
    const agent = await publishAgent(w.owner, {});
    const created = await f.on(0, w.owner).post("/v1/threads", { agent_id: agent });
    const ws = await f.connect(w, 0);
    const run = await f.message(w.owner, created.json.thread_id as string, "hi");
    const s = await ws.started(run);
    expect(s.config?.skill_bundles ?? []).toEqual([]);
    const omitted = (await f.events(w.team, run)).find((e) => e.type === "context.omitted");
    expect(omitted?.payload).toEqual({
      items: [{ kind: "skill", name: "unstored-v2", reason: "unavailable" }],
    });
  });
});

describe("installing a catalog skill (SK25, name clash)", () => {
  it("refuses a name one of the team's skills has; installs and audits otherwise", async () => {
    const w = await f.world();
    const reviewer = (await f.world()).owner.id;
    await teamSkill(w.team, w.owner.id, "clash-v2");
    const clash = await catalogSkill("clash-v2", w.owner.id, reviewer, [["1.0.0", "approved"]]);
    const fine = await catalogSkill("fine-v2", w.owner.id, reviewer, [
      ["1.0.0", "approved"],
      ["1.1.0", "revoked"],
    ]);
    const b = f.on(0, w.owner);
    const body = { version: "1.0.0", pinMode: "pinned", access: "required" };
    const refused = await b.put(`/v1/team/skills/installs/${clash.skill}`, body);
    expect([refused.status, refused.json.code]).toEqual([409, "name_clash"]);
    const revoked = await b.put(`/v1/team/skills/installs/${fine.skill}`, {
      ...body,
      version: "1.1.0",
    });
    expect([revoked.status, revoked.json.code]).toEqual([409, "not_installable"]);
    const ok = await b.put(`/v1/team/skills/installs/${fine.skill}`, body);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const audit = await admin().query(
      `SELECT target FROM audit_log WHERE action = 'skill.catalog.configured' AND team_id = $1`,
      [w.team],
    );
    expect(audit.rows).toEqual([
      {
        target: {
          skillId: fine.skill,
          name: "fine-v2",
          semver: "1.0.0",
          pinMode: "pinned",
          access: "required",
          deprecated: false,
        },
      },
    ]);
  });
});
