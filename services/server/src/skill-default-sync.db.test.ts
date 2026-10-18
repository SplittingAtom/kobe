import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logger } from "./logger.js";
import { defaultSyncOnce } from "./skills/default-sync.js";
import { queueDefaultSync } from "./skills/default-sync.js";
import { newestApproved } from "./skills/default-target.js";
import { changeTeamInstall } from "./skills/team-installs.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-314 (SK5–SK8): tags and the Default sync. Topic vocabulary and system tags by Site admins
 * (audited); adding Default installs the skill in every team except opt-outs, as a job with
 * progress, and in every new team; opt-outs are sticky across re-syncs and a simulated upgrade;
 * removing Default leaves installs (origin team) and clears opt-outs; moving to a new major moves
 * only untouched Default installs; one job runner at a time across replicas.
 */
let h: Harness;
const team = { finance: randomUUID(), legal: randomUUID(), ops: randomUUID() };
const ids = { site: "", reviewer: "", finance: "", legal: "", ops: "", member: "" };
const as = {} as Record<"site" | "finance" | "member", TestBrowser>;
let skill = "";
const versions = { v100: "", v110: "", v200: "" };

const sync = () =>
  defaultSyncOnce({
    database: h.deps.database,
    log: logger,
    mailer: h.mailer,
    publicUrl: "https://kobe.test",
  });

async function install(teamId: string) {
  const r = await h.admin.query(
    `SELECT i.pin_mode, i.access, i.origin, v.semver, i.installed_by
     FROM team_skill_installs i JOIN registry_versions v ON v.id = i.version_id
     WHERE i.team_id = $1 AND i.skill_id = $2`,
    [teamId, skill],
  );
  return r.rows[0] as
    | { pin_mode: string; access: string; origin: string; semver: string; installed_by: string }
    | undefined;
}

const optouts = async (teamId: string) =>
  (
    await h.admin.query(
      `SELECT reason FROM team_skill_optouts WHERE team_id = $1 AND skill_id = $2`,
      [teamId, skill],
    )
  ).rows;

const audits = async (action: string) =>
  (
    await h.admin.query(`SELECT team_id, target FROM audit_log WHERE action = $1 ORDER BY seq`, [
      action,
    ])
  ).rows as { team_id: string | null; target: Record<string, unknown> }[];

async function version(semver: string, seq: number, state: "approved" | "in_review") {
  const approved = state === "approved";
  const r = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash, manifest,
       provenance, source, scan, verdict, state, submitted_by, reviewed_by, approved_at)
     VALUES ($1, $2, $3, repeat($4, 64), repeat($4, 64), '{}', '{}', '{}', '{}', 'pass', $5, $6,
       $7, $8) RETURNING id`,
    [
      skill,
      semver,
      seq,
      String(seq),
      state,
      ids.member,
      approved ? ids.reviewer : null,
      approved ? new Date() : null,
    ],
  );
  return r.rows[0]?.id as string;
}

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@default.test", "admin");
  ids.reviewer = await h.createUser("reviewer@default.test", "admin");
  for (const t of ["finance", "legal", "ops"] as const)
    ids[t] = await h.createUser(`${t}@default.test`);
  ids.member = await h.createUser("member@default.test");
  for (const [slug, id] of Object.entries(team)) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $3)`, [
      id,
      slug,
      slug[0]?.toUpperCase() + slug.slice(1),
    ]);
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [id, ids[slug as keyof typeof team]],
    );
  }
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team.finance, ids.member],
  );
  const s = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ('xlsx-pro', 'Spreadsheets.') RETURNING id`,
  );
  skill = s.rows[0]?.id as string;
  versions.v100 = await version("1.0.0", 1, "approved");
  versions.v110 = await version("1.1.0", 2, "approved");
  versions.v200 = await version("2.0.0", 3, "in_review");
  as.site = await h.signIn("site@default.test");
  for (const who of ["finance", "member"] as const) {
    as[who] = await h.signIn(`${who}@default.test`);
    expect((await as[who].put("/v1/me/teams/active", { teamId: team.finance })).status).toBe(200);
    as[who].team = team.finance;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("topic vocabulary (SK5)", () => {
  it("Site admins add, rename, retire and restore topic tags; audited", async () => {
    const made = await as.site.post("/v1/site/skills/tags", { name: "finanse" });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.tag.id as string;
    expect((await as.site.post("/v1/site/skills/tags", { name: "finanse" })).status).toBe(409);
    expect((await as.site.post("/v1/site/skills/tags", { name: "Bad Name" })).status).toBe(400);
    const renamed = await as.site.patch(`/v1/site/skills/tags/${id}`, { name: "finance" });
    expect(renamed.json.tag).toMatchObject({ name: "finance", kind: "topic", status: "active" });
    await as.site.post("/v1/site/skills/tags", { name: "legacy" });
    const list = await as.site.get("/v1/site/skills/tags");
    const legacy = list.json.tags.find((t: { name: string }) => t.name === "legacy");
    expect(
      (await as.site.patch(`/v1/site/skills/tags/${legacy.id}`, { status: "retired" })).json.tag
        .status,
    ).toBe("retired");
    expect(list.json.tags.map((t: { name: string; kind: string }) => [t.name, t.kind])).toEqual(
      expect.arrayContaining([
        ["default", "system"],
        ["finance", "topic"],
      ]),
    );
    // The system tag is not a topic tag to rename.
    const system = list.json.tags.find((t: { name: string }) => t.name === "default");
    expect((await as.site.patch(`/v1/site/skills/tags/${system.id}`, { name: "x" })).status).toBe(
      404,
    );
    expect((await audits("skill.tag.created")).map((a) => a.target.name)).toEqual([
      "finanse",
      "legacy",
    ]);
    expect((await audits("skill.tag.updated"))[0]?.target).toMatchObject({
      name: "finance",
      previousName: "finanse",
    });
  });

  it("refuses members and team admins", async () => {
    expect((await as.finance.get("/v1/site/skills/tags")).status).toBe(403);
    expect((await as.member.post("/v1/site/skills/tags", { name: "x" })).status).toBe(403);
  });

  it("refuses retired or unknown topic tags on a skill", async () => {
    const r = await as.site.put(`/v1/site/skills/catalog/${skill}/tags`, {
      system: [],
      topic: ["legacy", "nope"],
    });
    expect(r.status).toBe(400);
    expect(r.json.tags).toEqual(["legacy", "nope"]);
  });
});

describe("adding Default (SK6, SK8; ac-1)", () => {
  it("installs in every team except opt-outs, as a job with progress", async () => {
    // Legal installed it itself (pinned, available); Ops opted out earlier.
    await h.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
       VALUES ($1, $2, $3, 'pinned', 'available', $4)`,
      [team.legal, skill, versions.v100, ids.legal],
    );
    await h.admin.query(
      `INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by) VALUES ($1, $2, $3)`,
      [team.ops, skill, ids.ops],
    );
    const put = await as.site.put(`/v1/site/skills/catalog/${skill}/tags`, {
      system: ["default"],
      topic: ["finance"],
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({ system: ["default"], topic: ["finance"] });
    const queued = await as.site.get("/v1/site/skills/default-syncs");
    expect(queued.json.syncs[0]).toMatchObject({
      id: put.json.syncId,
      kind: "add",
      major: 1,
      status: "queued",
      teamsDone: 0,
    });

    expect(await sync()).toBe(1);
    expect(await install(team.finance)).toMatchObject({
      pin_mode: "within_major",
      access: "default_on",
      origin: "default_tag",
      semver: "1.1.0",
      installed_by: ids.site,
    });
    expect(await install(team.legal)).toMatchObject({
      pin_mode: "pinned",
      access: "available",
      origin: "team",
      semver: "1.0.0",
    });
    expect(await install(team.ops)).toBeUndefined();
    const done = await as.site.get("/v1/site/skills/default-syncs");
    expect(done.json.syncs[0]).toMatchObject({
      status: "done",
      teamsTotal: 3,
      teamsDone: 3,
      // One opted-out team is below the minimum count: the whole breakdown is hidden, so it
      // can't be worked out by subtraction.
      counts: null,
    });
    expect(
      (await as.site.get("/v1/site/skills/catalog")).json.skills.find(
        (s: { id: string }) => s.id === skill,
      ),
    ).toMatchObject({ system: ["default"], topic: ["finance"], defaultMajor: 1, optOuts: "few" });
    expect((await audits("skill.catalog.tags_changed"))[0]?.target).toMatchObject({
      skillId: skill,
      systemAdded: ["default"],
      topicAdded: ["finance"],
    });
    expect((await audits("skill.default.synced"))[0]?.target).toEqual({
      skillId: skill,
      name: "xlsx-pro",
      kind: "add",
      teams: 3,
      masked: true,
    });
    // Each team's audit shows what the sync changed there.
    expect(await audits("skill.default.applied")).toEqual([
      {
        team_id: team.finance,
        target: { skillId: skill, name: "xlsx-pro", change: "installed", semver: "1.1.0" },
      },
    ]);
    // Team admins of the teams it reached get a notice; the opted-out team does not.
    expect(h.mailer.to("finance@default.test").at(-1)?.subject).toContain("xlsx-pro");
    expect(h.mailer.to("legal@default.test").at(-1)?.text).toContain("settings");
    expect(h.mailer.to("ops@default.test")).toHaveLength(0);
  });

  it("shows the badge in the team's installs", async () => {
    const r = await as.member.get("/v1/team/skills/installs");
    expect(r.status).toBe(200);
    expect(r.json.installs).toEqual([
      expect.objectContaining({ skillId: skill, name: "xlsx-pro", isDefault: true }),
    ]);
  });

  it("installs Default skills in a new team at creation", async () => {
    const r = await as.site.post("/v1/site/teams", {
      slug: "new-team",
      name: "New team",
      adminUserId: ids.ops,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.team.id as string;
    expect(await install(id)).toMatchObject({
      origin: "default_tag",
      semver: "1.1.0",
      access: "default_on",
    });
    expect((await audits("skill.default.applied")).at(-1)).toEqual({
      team_id: id,
      target: { skillId: skill, name: "xlsx-pro", change: "installed", semver: "1.1.0" },
    });
  });
});

describe("opt-outs are sticky (SK7; ac-2)", () => {
  it("a Team admin's uninstall of a Default install records an opt-out; members can't", async () => {
    expect((await as.member.delete(`/v1/team/skills/installs/${skill}`)).status).toBe(403);
    const r = await as.finance.request("DELETE", `/v1/team/skills/installs/${skill}`, {
      reason: "We use our own.",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ optedOut: true });
    expect(await install(team.finance)).toBeUndefined();
    expect(await optouts(team.finance)).toEqual([{ reason: "We use our own." }]);
    expect((await audits("skill.catalog.removed")).at(-1)).toMatchObject({
      team_id: team.finance,
      target: { origin: "default_tag", optedOut: true, reasonGiven: true },
    });
    const list = await as.finance.get("/v1/team/skills/installs");
    expect(list.json.installs).toEqual([]);
    expect(list.json.removedDefaults).toEqual([
      expect.objectContaining({ skillId: skill, name: "xlsx-pro", reason: "We use our own." }),
    ]);
  });

  it("survives a re-sync and a simulated upgrade (the seed re-adds Default)", async () => {
    const target = await newestApproved(h.deps.database.db, skill, 1);
    await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, {
        skillId: skill,
        kind: "add",
        ...(target ? { target } : {}),
        requestedBy: ids.site,
      }),
    );
    // Two replicas at once: one holds the lease, the job runs once.
    const runs = await Promise.all([sync(), sync()]);
    expect(runs.filter((n) => n === 1)).toHaveLength(1);
    expect(runs.filter((n) => n === null || n === 0)).toHaveLength(1);
    expect(await install(team.finance)).toBeUndefined();
    expect(await install(team.ops)).toBeUndefined();
    expect(await install(team.legal)).toMatchObject({ origin: "team", pin_mode: "pinned" });
    // A rerun finds nothing to do.
    expect(await sync()).toBe(0);
  });

  it("Reinstall clears the opt-out", async () => {
    const r = await as.finance.post(`/v1/team/skills/removed-defaults/${skill}/reinstall`);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await optouts(team.finance)).toEqual([]);
    expect(await install(team.finance)).toMatchObject({
      origin: "default_tag",
      pin_mode: "within_major",
      installed_by: ids.finance,
    });
    expect((await audits("skill.default.restored")).at(-1)?.team_id).toBe(team.finance);
    expect(
      (await as.finance.post(`/v1/team/skills/removed-defaults/${skill}/reinstall`)).status,
    ).toBe(404);
  });
});

describe("moving Default installs to a new major (SK6; ac-3)", () => {
  it("moves only untouched Default installs; audited", async () => {
    expect(
      (await as.site.post(`/v1/site/skills/catalog/${skill}/default/move-major`, { to: 2 })).json
        .code,
    ).toBe("no_version");
    await h.admin.query(
      `UPDATE registry_versions SET state = 'approved', reviewed_by = $2, approved_at = now()
       WHERE id = $1`,
      [versions.v200, ids.reviewer],
    );
    // Touched installs keep the team's choice: the new team pinned and went back to Track within
    // major; another team only changed the access mode.
    const newTeam = (await h.admin.query(`SELECT id FROM teams WHERE slug = 'new-team'`)).rows[0]
      ?.id as string;
    const db = h.deps.database.db;
    expect(await changeTeamInstall(db, newTeam, skill, { pinMode: "pinned" })).toBe(true);
    expect(await changeTeamInstall(db, newTeam, skill, { pinMode: "within_major" })).toBe(true);
    const touch = await as.site.post("/v1/site/teams", {
      slug: "touch-team",
      name: "Touch team",
      adminUserId: ids.ops,
    });
    const touchTeam = touch.json.team.id as string;
    expect(await changeTeamInstall(db, touchTeam, skill, { access: "available" })).toBe(true);
    const r = await as.site.post(`/v1/site/skills/catalog/${skill}/default/move-major`, { to: 2 });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect(r.json.semver).toBe("2.0.0");
    expect(await sync()).toBe(1);
    expect((await install(team.finance))?.semver).toBe("2.0.0");
    expect((await install(team.legal))?.semver).toBe("1.0.0");
    expect(await install(newTeam)).toMatchObject({ semver: "1.1.0", pin_mode: "within_major" });
    expect(await install(touchTeam)).toMatchObject({ semver: "1.1.0", access: "available" });
    expect((await audits("skill.default.applied")).at(-1)).toEqual({
      team_id: team.finance,
      target: { skillId: skill, name: "xlsx-pro", change: "moved", semver: "2.0.0" },
    });
    expect((await audits("skill.default.major_moved"))[0]?.target).toMatchObject({
      fromMajor: 1,
      toMajor: 2,
      semver: "2.0.0",
    });
    expect((await audits("skill.default.synced")).at(-1)?.target).toMatchObject({
      kind: "move_major",
      moved: 1,
    });
    const again = await as.site.post(`/v1/site/skills/catalog/${skill}/default/move-major`, {
      to: 2,
    });
    expect([again.status, again.json.code]).toEqual([409, "not_newer"]);
  });

  it("new teams get the new major", async () => {
    const r = await as.site.post("/v1/site/teams", {
      slug: "newer-team",
      name: "Newer team",
      adminUserId: ids.ops,
    });
    expect(r.status).toBe(201);
    expect((await install(r.json.team.id))?.semver).toBe("2.0.0");
  });
});

describe("removing Default (SK8; ac-3)", () => {
  it("leaves installs (origin team), clears opt-outs, notifies; new teams get nothing", async () => {
    const before = h.mailer.sent.length;
    const r = await as.site.put(`/v1/site/skills/catalog/${skill}/tags`, {
      system: [],
      topic: ["finance"],
    });
    expect(r.status).toBe(200);
    expect(r.json.system).toEqual([]);
    expect(await sync()).toBe(1);
    expect(await install(team.finance)).toMatchObject({ origin: "team", semver: "2.0.0" });
    expect(await install(team.legal)).toMatchObject({ origin: "team", pin_mode: "pinned" });
    expect(await optouts(team.ops)).toEqual([]);
    expect((await audits("skill.catalog.tags_changed")).at(-1)?.target).toMatchObject({
      systemRemoved: ["default"],
    });
    expect((await audits("skill.default.synced")).at(-1)?.target).toMatchObject({
      kind: "remove",
      masked: true,
    });
    const applied = (await audits("skill.default.applied")).filter((a) =>
      ["converted", "optout_cleared"].includes(String(a.target.change)),
    );
    expect(applied.map((a) => [a.team_id, a.target.change])).toEqual(
      expect.arrayContaining([
        [team.finance, "converted"],
        [team.ops, "optout_cleared"],
      ]),
    );
    const notices = h.mailer.sent.slice(before).map((m) => m.to);
    expect(notices).toEqual(
      expect.arrayContaining(["finance@default.test", "legal@default.test", "ops@default.test"]),
    );
    const t = await as.site.post("/v1/site/teams", {
      slug: "later-team",
      name: "Later team",
      adminUserId: ids.ops,
    });
    expect(await install(t.json.team.id)).toBeUndefined();
    // A non-Default uninstall records no opt-out.
    const un = await as.finance.delete(`/v1/team/skills/installs/${skill}`);
    expect(un.json).toEqual({ optedOut: false });
    expect(await optouts(team.finance)).toEqual([]);
  });
});

describe("resuming a job (ac-4)", () => {
  it("continues after the last team a crashed run finished", async () => {
    const target = await newestApproved(h.deps.database.db, skill, 2);
    await h.admin.query(`UPDATE registry_versions SET state = 'approved' WHERE id = $1`, [
      versions.v200,
    ]);
    const id = await h.deps.database.db.transaction((tx) =>
      queueDefaultSync(tx, {
        skillId: skill,
        kind: "add",
        ...(target ? { target } : {}),
        requestedBy: ids.site,
      }),
    );
    const sorted = (await h.admin.query<{ id: string }>(`SELECT id FROM teams ORDER BY id`)).rows;
    const first = sorted[0]?.id as string;
    // As if a replica died after its first team: running, cursor past team one, one team done.
    await h.admin.query(
      `UPDATE skill_default_syncs SET status = 'running', started_at = now(), teams_total = $3,
         teams_done = 1, after_team_id = $2 WHERE id = $1`,
      [id, first, sorted.length],
    );
    expect(await sync()).toBe(1);
    const row = (
      await h.admin.query(`SELECT status, teams_done FROM skill_default_syncs WHERE id = $1`, [id])
    ).rows[0];
    expect(row).toEqual({ status: "done", teams_done: sorted.length });
  });
});
