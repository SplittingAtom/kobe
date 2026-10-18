import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { resolveEffective } from "./resolver/resolve.js";
import { PINNED_AGENTS } from "./runs/agents.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./runs/resolver-input.js";
import { catalogSeed } from "./testing/catalog-seed.js";
import { must, type Person } from "./testing/event-stream-fixture.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-318 (SK28): publishing a team agent freezes the exact local skill versions it names; runs
 * of that version load them and nothing newer until a republish. A frozen version that is later
 * blocklisted, suspended by a rescan or no longer approved is omitted with a notice, never
 * swapped; a republish freezes the newest valid version. Catalog skills (Kobe's too) are never
 * frozen: they follow the team install. The builder lists skill updates and frozen notices.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };
const admin = () => f.fx.admin;
const seed = catalogSeed(admin);

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const tag = () => randomBytes(3).toString("hex");

async function createAgent(p: Person, skills: unknown): Promise<string> {
  const created = await f.on(0, p).post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Frozen ${tag()}`, skills },
    prompt: "You help.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json.agent.id as string;
}

/** Publishes the agent's draft; returns the new version number (or the refusal's status). */
async function publish(p: Person, agentId: string): Promise<number> {
  const pub = await f.on(0, p).request("POST", `/v1/agents/${agentId}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return pub.json.version.version as number;
}

async function manifestOf(team: string, agentId: string, version: number) {
  const { rows } = await admin().query<{ skill_manifest: { skills: unknown[] } }>(
    `SELECT skill_manifest FROM team_agent_versions WHERE team_id = $1 AND agent_id = $2
       AND version = $3`,
    [team, agentId, version],
  );
  return must(rows[0], "version").skill_manifest;
}

/** Run-start resolution of a pinned version: skills as `name@semver:source`, skill omissions. */
async function runOf(team: string, userId: string, agentId: string, version: number) {
  const db = f.fx.replica(0).deps.database.db;
  const res = await withTeam(db, team, (tx) =>
    PINNED_AGENTS.resolve(tx, {
      teamId: team,
      ownerUserId: userId,
      threadId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000000",
      trigger: "user",
      agentScope: "team",
      agentId,
      agentVersion: version,
      approvalMode: "auto",
    }),
  );
  if (!res.ok) throw new Error(res.error.code);
  return {
    skills: (res.skillRefs ?? []).map((s) => `${s.name}@${s.semver ?? ""}:${s.source ?? ""}`),
    hashes: (res.config?.skill_bundles ?? []).map((b) => b.sha256),
    omissions: (res.omissions ?? [])
      .filter((o) => o.kind === "skill")
      .map((o) => `${o.name}:${o.reason}`),
  };
}

/**
 * The resolver's skills for a pinned version, before materialization: catalog versions seeded
 * here have no stored bundle, so a run start would list them `unavailable`.
 */
async function resolvedOf(team: string, userId: string, agentId: string, version: number) {
  const { rows } = await admin().query<{ frontmatter: { skills: string[] } }>(
    `SELECT frontmatter FROM team_agent_versions WHERE team_id = $1 AND agent_id = $2
       AND version = $3`,
    [team, agentId, version],
  );
  const frontmatter = must(rows[0], "version").frontmatter;
  const manifest = await manifestOf(team, agentId, version);
  return withTeam(f.fx.db, team, async (tx) => {
    const facts = await loadTeamFacts(tx, team);
    const skills = await loadSkillFacts(tx, {
      teamId: team,
      userId,
      agentSkillNames: frontmatter.skills,
      personalSkillsDisabled: facts.personalSkillsDisabled,
      frozen: manifest.skills as never,
    });
    const r = resolveEffective(
      buildResolveInput({
        frontmatter: frontmatter as never,
        versionMode: "ask-on-write",
        floor: "auto",
        team: facts,
        skills,
        connectedConnectors: [],
      }),
    );
    if (!r.ok) throw new Error(r.error.code);
    return r.value.skills.map((s) => `${s.name}@${s.semver ?? ""}:${s.source ?? ""}`);
  });
}

async function suspend(team: string, skillId: string, version: number) {
  await admin().query(
    `UPDATE team_skill_reviews SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL,
       suspended_at = now() WHERE team_id = $1 AND skill_id = $2 AND version = $3`,
    [team, skillId, version],
  );
}

async function blocklist(hash: string, by: string) {
  await admin().query(
    `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'malware', $2)`,
    [hash, by],
  );
}

async function teamWithSkill(versions = 1) {
  const w = await f.world();
  const name = `house-${tag()}`;
  const skill = await seed.teamSkill(w.team, w.owner.id, name);
  const hashes: string[] = [];
  for (let n = 1; n <= versions; n++)
    hashes.push(await seed.addVersion(w.team, w.owner.id, skill, name, n));
  return { w, team: w.team, me: w.owner.id, name, skill, hashes };
}

describe("publish freezes local skill versions (ac-2)", () => {
  it("approving a newer version changes nothing until republish", async () => {
    const { w, team, me, name, skill, hashes } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    expect(await manifestOf(team, agent, v1)).toEqual({
      skills: [{ name, skill_id: skill, version: 1 }],
    });
    const h2 = await seed.addVersion(team, me, skill, name, 2);
    const before = await runOf(team, me, agent, v1);
    expect(before.skills).toEqual([`${name}@0.1.0:team`]);
    expect(before.hashes).toEqual(hashes);

    // Republishing the same draft picks the new version up (not "unchanged").
    const v2 = await publish(w.owner, agent);
    expect(v2).toBe(v1 + 1);
    expect((await runOf(team, me, agent, v2)).hashes).toEqual([h2]);
    // Threads pinned to v1 keep v1's frozen version.
    expect((await runOf(team, me, agent, v1)).hashes).toEqual(hashes);
    // Nothing new: a third publish is refused as unchanged.
    const again = await f.on(0, w.owner).request("POST", `/v1/agents/${agent}/publish`, {}, ANY);
    expect(again.status).toBe(409);
  });

  it("a name with no approved version at publish stays not_approved until republish", async () => {
    const w = await f.world();
    const name = `later-${tag()}`;
    const skill = await seed.teamSkill(w.team, w.owner.id, name);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    expect(await manifestOf(w.team, agent, v1)).toEqual({ skills: [] });
    await seed.addVersion(w.team, w.owner.id, skill, name, 1);
    expect((await runOf(w.team, w.owner.id, agent, v1)).omissions).toEqual([
      `${name}:not_approved`,
    ]);
    const v2 = await publish(w.owner, agent);
    expect((await runOf(w.team, w.owner.id, agent, v2)).skills).toEqual([`${name}@0.1.0:team`]);
  });

  it("a rollback keeps the frozen versions of the version it restores", async () => {
    const { w, team, me, name, skill, hashes } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    await seed.addVersion(team, me, skill, name, 2);
    await publish(w.owner, agent);
    const rb = await f.on(0, w.owner).post(`/v1/agents/${agent}/rollback`, { version: v1 });
    expect(rb.status, JSON.stringify(rb.json)).toBe(201);
    const v3 = rb.json.version.version as number;
    expect(await manifestOf(team, agent, v3)).toEqual(await manifestOf(team, agent, v1));
    expect((await runOf(team, me, agent, v3)).hashes).toEqual(hashes);
  });
});

describe("a frozen version that later fails a check is omitted, never swapped (313)", () => {
  it("a rescan suspends it: runs show `suspended`; republish picks the newest valid one", async () => {
    const { w, team, me, name, skill } = await teamWithSkill(2);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    await suspend(team, skill, 2);
    const run = await runOf(team, me, agent, v1);
    // Version 1 is approved and valid, but the agent froze version 2.
    expect(run.skills).toEqual([]);
    expect(run.omissions).toEqual([`${name}:suspended`]);
    const v2 = await publish(w.owner, agent);
    expect(await manifestOf(team, agent, v2)).toEqual({
      skills: [{ name, skill_id: skill, version: 1 }],
    });
    expect((await runOf(team, me, agent, v2)).skills).toEqual([`${name}@0.1.0:team`]);
  });

  it("with no valid version left, republish keeps the reason visible", async () => {
    const { w, team, me, name, skill } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    await publish(w.owner, agent);
    await suspend(team, skill, 1);
    // The manifest is unchanged (still version 1, now suspended): the publish is refused.
    const again = await f.on(0, w.owner).request("POST", `/v1/agents/${agent}/publish`, {}, ANY);
    expect(again.status).toBe(409);
    const v1run = await runOf(team, me, agent, 1);
    expect(v1run.omissions).toEqual([`${name}:suspended`]);
  });

  it("a blocklisted frozen version is omitted; no personal skill stands in", async () => {
    const { w, team, me, name, skill, hashes } = await teamWithSkill(2);
    await seed.personalSkill(me, name);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    await blocklist(must(hashes[1], "v2 hash"), me);
    const run = await runOf(team, me, agent, v1);
    expect(run.skills).toEqual([]);
    expect(run.omissions).toEqual(
      expect.arrayContaining([`${name}:blocklisted`, `${name}:shadowed_by_agent`]),
    );
    // Republish skips the blocked version for the newest one that isn't.
    const v2 = await publish(w.owner, agent);
    expect(await manifestOf(team, agent, v2)).toEqual({
      skills: [{ name, skill_id: skill, version: 1 }],
    });
  });

  it("a frozen version the team no longer approves is not_approved", async () => {
    const { w, team, me, name, skill } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    await admin().query(
      `UPDATE team_skill_reviews SET status = 'rejected' WHERE team_id = $1 AND skill_id = $2`,
      [team, skill],
    );
    expect((await runOf(team, me, agent, v1)).omissions).toEqual([`${name}:not_approved`]);
  });
});

describe("frozen versions next to Required, archive, catalog and the cap", () => {
  it("the team's Required skill of the same name wins at its newest version", async () => {
    const { w, team, me, name, skill } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    await seed.addVersion(team, me, skill, name, 2);
    await admin().query(
      `UPDATE team_skills SET access = 'required' WHERE team_id = $1 AND id = $2`,
      [team, skill],
    );
    // Step 1 (Required) comes first; the frozen named version of the same skill is a duplicate.
    expect((await runOf(team, me, agent, v1)).skills).toEqual([`${name}@0.2.0:team`]);
  });

  it("an archived frozen skill keeps resolving, even after the team installs its name", async () => {
    const { w, team, me, name, skill } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    const reviewer = (await f.world()).owner.id;
    await admin().query(
      `UPDATE team_skills SET archived_at = now() WHERE team_id = $1 AND id = $2`,
      [team, skill],
    );
    const c = await seed.catalogSkill(name, me, reviewer, [["1.0.0", "approved"]]);
    await seed.install(team, me, c, "1.0.0", "pinned", "available");
    expect((await runOf(team, me, agent, v1)).skills).toEqual([`${name}@0.1.0:team`]);
    // A republish hands the name to the install (the name-clash rule).
    const v2 = await publish(w.owner, agent);
    expect(await manifestOf(team, agent, v2)).toEqual({ skills: [] });
    expect(await resolvedOf(team, me, agent, v2)).toEqual([`${name}@1.0.0:catalog`]);
  });

  it("catalog skills are not frozen: they follow the team install's pin", async () => {
    const w = await f.world();
    const reviewer = (await f.world()).owner.id;
    const name = `cat-${tag()}`;
    const c = await seed.catalogSkill(name, w.owner.id, reviewer, [
      ["1.0.0", "approved"],
      ["1.1.0", "approved"],
    ]);
    await seed.install(w.team, w.owner.id, c, "1.0.0", "pinned", "available");
    const agent = await createAgent(w.owner, [name]);
    const v1 = await publish(w.owner, agent);
    expect(await manifestOf(w.team, agent, v1)).toEqual({ skills: [] });
    expect(await resolvedOf(w.team, w.owner.id, agent, v1)).toEqual([`${name}@1.0.0:catalog`]);
    await admin().query(
      `UPDATE team_skill_installs SET version_id = $3 WHERE team_id = $1 AND skill_id = $2`,
      [w.team, c.skill, c.ids["1.1.0"]],
    );
    expect(await resolvedOf(w.team, w.owner.id, agent, v1)).toEqual([`${name}@1.1.0:catalog`]);
  });

  it("a team skill named like a Kobe skill is never frozen", async () => {
    const w = await f.world();
    const skill = await seed.teamSkill(w.team, w.owner.id, "pdf");
    await seed.addVersion(w.team, w.owner.id, skill, "pdf", 1);
    const agent = await createAgent(w.owner, ["pdf"]);
    expect(await manifestOf(w.team, agent, await publish(w.owner, agent))).toEqual({
      skills: [],
    });
  });

  it("frozen named skills count after Required against the cap of 64", async () => {
    const { w, team, me, name } = await teamWithSkill(1);
    for (let i = 0; i < 63; i++) {
      const slug = `req-${String(i).padStart(2, "0")}-${tag()}`;
      const id = await seed.teamSkill(team, me, slug, "required");
      await seed.addVersion(team, me, id, slug, 1);
    }
    const second = `zz-${tag()}`;
    const other = await seed.teamSkill(team, me, second);
    await seed.addVersion(team, me, other, second, 1);
    const agent = await createAgent(w.owner, [name, second]);
    const run = await runOf(team, me, agent, await publish(w.owner, agent));
    expect(run.skills).toHaveLength(64);
    expect(run.skills.at(-1)).toBe(`${name}@0.1.0:team`);
    expect(run.omissions).toEqual([`${second}:skill_limit`]);
  });
});

describe("the builder's skill updates (ac-3)", () => {
  it("lists updates and frozen notices for the current version", async () => {
    const { w, team, me, name, skill, hashes } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    await publish(w.owner, agent);
    const read = () => f.on(0, w.owner).get(`/v1/agents/${agent}/skill-updates`);
    const none = await read();
    expect(none.status).toBe(200);
    expect(none.json).toEqual({
      version: 1,
      skills: [{ name, frozen: { version: 1, semver: "0.1.0" }, status: "ok", update: null }],
    });
    await seed.addVersion(team, me, skill, name, 2);
    expect((await read()).json.skills).toEqual([
      {
        name,
        frozen: { version: 1, semver: "0.1.0" },
        status: "ok",
        update: { version: 2, semver: "0.2.0" },
      },
    ]);
    await blocklist(must(hashes[0], "v1 hash"), me);
    expect((await read()).json.skills).toEqual([
      {
        name,
        frozen: { version: 1, semver: "0.1.0" },
        status: "blocklisted",
        update: { version: 2, semver: "0.2.0" },
      },
    ]);
  });

  it("is 404 for an agent another team owns", async () => {
    const { w } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, []);
    await publish(w.owner, agent);
    const other = await f.world();
    expect((await f.on(0, other.owner).get(`/v1/agents/${agent}/skill-updates`)).status).toBe(404);
  });
});

describe("runs record the frozen version", () => {
  it("run.start lists the frozen bundle after a newer version is approved", async () => {
    const { w, team, me, name, skill, hashes } = await teamWithSkill(1);
    const agent = await createAgent(w.owner, [name]);
    await publish(w.owner, agent);
    await seed.addVersion(team, me, skill, name, 2);
    const created = await f.on(0, w.owner).post("/v1/threads", { agent_id: agent });
    const thread = created.json.thread_id as string;
    const ws = await f.connect(w, 0);
    const run = await f.message(w.owner, thread, "hello");
    const start = await ws.started(run);
    expect(start.config?.skill_bundles?.map((b) => b.sha256)).toEqual(hashes);
    ws.reply(start, "ok");
    await f.until(team, run, "completed");
  });
});
