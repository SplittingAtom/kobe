import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { loadCatalogFacts } from "./runs/catalog-facts.js";
import { validateZipBundle } from "./skills/bundle.js";
import { ensureObject } from "./skills/kobe-seed.js";
import { sha256Hex } from "./skills/storage.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-338 (SK25, U31): a member's Add for me loads only in their own runs in that team; the team
 * switch "Members may add catalog skills for themselves" hides it; a Team admin's block removes
 * the adds and refuses new ones; Request for team notifies the team's admins. Teams are walls:
 * nothing here reaches another team.
 */
const teamA = randomUUID();
const teamB = randomUUID();
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
let h: Harness;
const ids = { adminA: "", memberA: "", otherA: "", adminB: "", maintainer: "" };
type Who = "adminA" | "memberA" | "otherA" | "adminB";
const as = {} as Record<Who, TestBrowser>;
let skillId = "";
let secondId = "";
const NAME = "invoice-check";
const SECOND = "invoice-other";

async function version(skill: string, name: string, semver: string, seq: number, state: string) {
  const manifest = `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: ${semver}\nsummary: Invoices.\nlicense: MIT\n`;
  const valid = validateZipBundle(
    zipSync({
      "SKILL.md": strToU8(
        `---\nname: ${name}\ndescription: Checks invoices. Use it for invoices.\n---\n# Invoices\n\n${semver}\n`,
      ),
      "kobe.skill.yaml": strToU8(manifest),
    }),
  );
  if (!valid.ok) throw new Error(valid.error.message);
  const b = valid.value;
  const runtimeHash = sha256Hex(b.zip);
  const runtimeKey = await ensureObject(blobs, b.zip, runtimeHash);
  const packageKey = b.packageZip ? await ensureObject(blobs, b.packageZip, b.packageHash) : null;
  await h.admin.query(
    `INSERT INTO registry_versions (skill_id, semver, seq, runtime_hash, package_hash,
       runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
       scan, verdict, submitted_by, state, reviewed_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}', '{}', '{"findings": []}', 'pass', $10,
       $11::registry_version_state, $12, now())`,
    [
      skill,
      semver,
      seq,
      runtimeHash,
      b.packageHash,
      runtimeKey,
      b.zip.length,
      packageKey,
      JSON.stringify(b.manifest),
      ids.maintainer,
      state,
      ids.adminB,
    ],
  );
}

beforeAll(async () => {
  h = await openHarness({ blobs });
  ids.maintainer = await h.createUser("maintainer@adds.test");
  for (const who of ["adminA", "memberA", "otherA", "adminB"] as Who[])
    ids[who] = await h.createUser(`${who.toLowerCase()}@adds.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'aa', 'Alpha'), ($2, 'bb', 'Beta')`,
    [teamA, teamB],
  );
  // memberA belongs to both teams: an add in Alpha must not reach their runs in Beta.
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'),
       ($1, $3, 'member'), ($1, $4, 'member'), ($5, $6, 'team_admin'), ($5, $3, 'member')`,
    [teamA, ids.adminA, ids.memberA, ids.otherA, teamB, ids.adminB],
  );
  for (const who of ["adminA", "memberA", "otherA", "adminB"] as Who[]) {
    as[who] = await h.signIn(`${who.toLowerCase()}@adds.test`);
    const team = who === "adminB" ? teamB : teamA;
    expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    as[who].team = team;
  }
  const skills = await h.admin.query<{ id: string }>(
    `INSERT INTO registry_skills (name, summary) VALUES ($1, 'Invoices.'), ($2, 'Other.')
     RETURNING id`,
    [NAME, SECOND],
  );
  skillId = skills.rows[0]?.id as string;
  secondId = skills.rows[1]?.id as string;
  await version(skillId, NAME, "0.8.0", 1, "deprecated");
  await version(skillId, NAME, "0.9.0", 2, "revoked");
  await version(skillId, NAME, "1.0.0", 3, "approved");
  await version(skillId, NAME, "1.1.0", 4, "approved");
  await version(skillId, NAME, "1.2.0", 5, "withdrawn");
  await version(secondId, SECOND, "1.0.0", 1, "approved");
});

afterAll(async () => {
  await h?.close();
});

const add = (who: Who, body: object, id = skillId) =>
  as[who].request("PUT", `/v1/me/skills/adds/${id}`, body);
const unadd = (who: Who, id = skillId) => as[who].request("DELETE", `/v1/me/skills/adds/${id}`);
const block = (who: Who, id = skillId) => as[who].request("PUT", `/v1/team/skills/blocks/${id}`);
const unblock = (who: Who, id = skillId) =>
  as[who].request("DELETE", `/v1/team/skills/blocks/${id}`);
const switches = (membersMayAddCatalog: boolean) =>
  as.adminA.put("/v1/team/skill-review/settings", { membersMayAddCatalog });

/** What a run of `userId` in `team` loads from the catalog (step 3), as run start resolves it. */
async function offered(team: string, userId: string) {
  const facts = await withTeam(h.deps.database.db, team, (tx) =>
    loadCatalogFacts(tx, { teamId: team, userId, namedCatalog: [] }),
  );
  return facts.offered.map((r) => `${r.name}@${r.semver}`);
}

const audits = async (action: string) =>
  (
    await h.admin.query<{ team_id: string; target: Record<string, unknown> }>(
      `SELECT team_id, target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows;

describe("Add for me (ac-1)", () => {
  it("loads only in that member's runs in that team, at the chosen version and pin", async () => {
    const r = await add("memberA", { version: "1.0.0", pinMode: "pinned" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ semver: "1.0.0", pinMode: "pinned", runs: "1.0.0" });
    expect(await offered(teamA, ids.memberA)).toEqual([`${NAME}@1.0.0`]);
    // Not another member of the team, not the member's runs in another team.
    expect(await offered(teamA, ids.otherA)).toEqual([]);
    expect(await offered(teamB, ids.memberA)).toEqual([]);

    // Track within major takes 1.1.0 (1.2.0 is withdrawn).
    const tracked = await add("memberA", { version: "1.0.0", pinMode: "within_major" });
    expect(tracked.json).toMatchObject({ runs: "1.1.0" });
    expect(await offered(teamA, ids.memberA)).toEqual([`${NAME}@1.1.0`]);

    const mine = await as.memberA.get("/v1/me/skills/adds");
    expect(mine.json.adds).toEqual([
      expect.objectContaining({
        skillId,
        name: NAME,
        semver: "1.0.0",
        pinMode: "within_major",
        runs: "1.1.0",
      }),
    ]);
    expect((await as.otherA.get("/v1/me/skills/adds")).json.adds).toEqual([]);
    expect((await audits("skill.member_add.added")).map((a) => [a.team_id, a.target])).toEqual([
      [teamA, { skillId, name: NAME, semver: "1.0.0", pinMode: "pinned" }],
    ]);
    expect((await audits("skill.member_add.changed")).at(-1)).toMatchObject({
      team_id: teamA,
      target: { semver: "1.0.0", pinMode: "within_major", previous: { pinMode: "pinned" } },
    });
  });

  it("refuses retired, unknown and deprecated versions, Hidden and Required installs", async () => {
    for (const version of ["1.2.0", "0.9.0"]) {
      const r = await add("otherA", { version, pinMode: "pinned" });
      expect([r.status, r.json.code], version).toEqual([409, "not_installable"]);
    }
    const unknown = await add("otherA", { version: "3.0.0", pinMode: "pinned" });
    expect([unknown.status, unknown.json.code]).toEqual([404, "no_version"]);
    // Deprecated blocks new installs; only a Team admin may override it (SK31).
    const dep = await add("otherA", { version: "0.8.0", pinMode: "pinned" });
    expect([dep.status, dep.json.code]).toEqual([409, "deprecated"]);
    const missing = await add("otherA", { version: "1.0.0", pinMode: "pinned" }, randomUUID());
    expect(missing.status).toBe(404);
    const bad = await add("otherA", { version: "1.0", pinMode: "pinned" });
    expect(bad.status).toBe(400);

    for (const access of ["hidden", "required"] as const) {
      const i = await as.adminA.put(`/v1/team/skills/installs/${secondId}`, {
        version: "1.0.0",
        pinMode: "pinned",
        access,
      });
      expect(i.status, JSON.stringify(i.json)).toBe(200);
      const r = await add("otherA", { version: "1.0.0", pinMode: "pinned" }, secondId);
      expect([r.status, r.json.code], access).toEqual([409, access]);
    }
    expect((await as.adminA.request("DELETE", `/v1/team/skills/installs/${secondId}`)).status).toBe(
      200,
    );
  });

  it("removes the member's own add; the console lists the team's adds to Team admins only", async () => {
    expect((await add("otherA", { version: "1.1.0", pinMode: "pinned" })).status).toBe(200);
    const list = await as.adminA.get("/v1/team/skills/member-adds");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.adds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ids.memberA, name: NAME, runs: "1.1.0" }),
        expect.objectContaining({ userId: ids.otherA, name: NAME, semver: "1.1.0" }),
      ]),
    );
    expect((await as.memberA.get("/v1/team/skills/member-adds")).status).toBe(403);
    // Team B's console sees none of team A's adds.
    expect((await as.adminB.get("/v1/team/skills/member-adds")).json.adds).toEqual([]);

    expect((await unadd("otherA")).status).toBe(200);
    expect(await offered(teamA, ids.otherA)).toEqual([]);
    expect((await unadd("otherA")).status).toBe(404);
    expect((await audits("skill.member_add.removed")).at(-1)).toMatchObject({
      team_id: teamA,
      target: { skillId, name: NAME },
    });
  });
});

describe("the team switch and blocks (ac-2)", () => {
  it("switch off hides Add for me and refuses new adds; existing adds stop loading", async () => {
    expect((await switches(false)).status).toBe(200);
    const page = await as.memberA.get("/v1/skills/catalog");
    expect(page.json.membersMayAdd).toBe(false);
    const r = await add("otherA", { version: "1.0.0", pinMode: "pinned" });
    expect([r.status, r.json.code]).toEqual([403, "adds_off"]);
    expect(await offered(teamA, ids.memberA)).toEqual([]);
    // Team B's switch is its own.
    expect((await as.adminB.get("/v1/skills/catalog")).json.membersMayAdd).toBe(true);
    expect((await switches(true)).status).toBe(200);
    expect((await as.memberA.get("/v1/skills/catalog")).json.membersMayAdd).toBe(true);
    expect(await offered(teamA, ids.memberA)).toEqual([`${NAME}@1.1.0`]);
  });

  it("a Team admin's block removes existing adds and refuses new ones; unblock allows them", async () => {
    expect((await block("memberA")).status).toBe(403);
    // memberA's add in team B is untouched by team A's block.
    const inB = await as.memberA.put("/v1/me/teams/active", { teamId: teamB });
    expect(inB.status).toBe(200);
    as.memberA.team = teamB;
    expect((await add("memberA", { version: "1.0.0", pinMode: "pinned" })).status).toBe(200);
    as.memberA.team = teamA;
    expect((await as.memberA.put("/v1/me/teams/active", { teamId: teamA })).status).toBe(200);

    const b = await block("adminA");
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    expect(b.json).toMatchObject({ blocked: true, addsRemoved: 1 });
    expect(await offered(teamA, ids.memberA)).toEqual([]);
    expect((await as.memberA.get("/v1/me/skills/adds")).json.adds).toEqual([]);
    expect(await offered(teamB, ids.memberA)).toEqual([`${NAME}@1.0.0`]);
    const refused = await add("memberA", { version: "1.0.0", pinMode: "pinned" });
    expect([refused.status, refused.json.code]).toEqual([409, "blocked"]);
    // The catalog shows it blocked here, and not in team B.
    const card = (await as.memberA.get("/v1/skills/catalog")).json.skills.find(
      (s: { id: string }) => s.id === skillId,
    );
    expect(card.state).toMatchObject({ blocked: true, addedByMe: false });
    const cardB = (await as.adminB.get("/v1/skills/catalog")).json.skills.find(
      (s: { id: string }) => s.id === skillId,
    );
    expect(cardB.state.blocked).toBe(false);
    // Again: nothing changes, nothing audited twice.
    expect((await block("adminA")).json).toMatchObject({ blocked: true, changed: false });
    const blocks = await as.adminA.get("/v1/team/skills/blocks");
    expect(blocks.json.blocks).toEqual([
      expect.objectContaining({ skillId, name: NAME, blockedBy: ids.adminA }),
    ]);
    expect((await as.adminB.get("/v1/team/skills/blocks")).json.blocks).toEqual([]);
    expect(await audits("skill.catalog.blocked")).toEqual([
      { team_id: teamA, target: { skillId, name: NAME, addsRemoved: 1 } },
    ]);

    expect((await unblock("memberA")).status).toBe(403);
    expect((await unblock("adminA")).status).toBe(200);
    expect((await unblock("adminA")).status).toBe(404);
    expect((await audits("skill.catalog.unblocked")).map((a) => a.team_id)).toEqual([teamA]);
    expect((await add("memberA", { version: "1.0.0", pinMode: "pinned" })).status).toBe(200);
  });

  it("refuses to block an installed skill (uninstall first)", async () => {
    const i = await as.adminA.put(`/v1/team/skills/installs/${secondId}`, {
      version: "1.0.0",
      pinMode: "pinned",
      access: "available",
    });
    expect(i.status).toBe(200);
    const r = await block("adminA", secondId);
    expect([r.status, r.json.code]).toEqual([409, "installed"]);
    expect((await as.adminA.request("DELETE", `/v1/team/skills/installs/${secondId}`)).status).toBe(
      200,
    );
  });
});

describe("Request for team (ac-3)", () => {
  it("emails the team's admins only, once a day per member, and lists it in the console", async () => {
    h.mailer.sent.length = 0;
    const r = await as.memberA.post(`/v1/skills/catalog/${secondId}/request`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    expect(r.json).toEqual({ requested: true, alreadyRequested: false });
    await h.mailer.settle();
    expect(h.mailer.to("admina@adds.test")).toHaveLength(1);
    const mail = h.mailer.to("admina@adds.test")[0];
    expect(mail?.subject).toContain(SECOND);
    expect(mail?.text).toContain("/admin/team/skills");
    // Not team B's admin, not other members.
    expect(h.mailer.to("adminb@adds.test")).toEqual([]);
    expect(h.mailer.to("othera@adds.test")).toEqual([]);

    const again = await as.memberA.post(`/v1/skills/catalog/${secondId}/request`, {});
    expect([again.status, again.json.alreadyRequested]).toEqual([200, true]);
    await h.mailer.settle();
    expect(h.mailer.to("admina@adds.test")).toHaveLength(1);
    expect((await as.otherA.post(`/v1/skills/catalog/${secondId}/request`, {})).status).toBe(202);

    const list = await as.adminA.get("/v1/team/skills/install-requests");
    expect(list.status).toBe(200);
    expect(list.json.requests).toEqual([
      expect.objectContaining({ skillId: secondId, name: SECOND, count: 2 }),
    ]);
    expect((await as.memberA.get("/v1/team/skills/install-requests")).status).toBe(403);
    expect((await as.adminB.get("/v1/team/skills/install-requests")).json.requests).toEqual([]);
    expect((await audits("skill.catalog.team_requested")).map((a) => a.team_id)).toEqual([
      teamA,
      teamA,
    ]);

    // Dismissed, it leaves the list until someone asks again.
    const d = await as.adminA.post(`/v1/team/skills/install-requests/${secondId}/dismiss`, {});
    expect(d.status).toBe(200);
    expect((await as.adminA.get("/v1/team/skills/install-requests")).json.requests).toEqual([]);
  });

  it("refuses a skill already installed or blocked here, and an unknown one", async () => {
    expect(
      (
        await as.adminA.put(`/v1/team/skills/installs/${secondId}`, {
          version: "1.0.0",
          pinMode: "pinned",
          access: "available",
        })
      ).status,
    ).toBe(200);
    const installed = await as.otherA.post(`/v1/skills/catalog/${secondId}/request`, {});
    expect([installed.status, installed.json.code]).toEqual([409, "installed"]);
    expect((await block("adminA")).status).toBe(200);
    const blocked = await as.otherA.post(`/v1/skills/catalog/${skillId}/request`, {});
    expect([blocked.status, blocked.json.code]).toEqual([409, "blocked"]);
    const unknown = await as.otherA.post(`/v1/skills/catalog/${randomUUID()}/request`, {});
    expect(unknown.status).toBe(404);
  });
});
