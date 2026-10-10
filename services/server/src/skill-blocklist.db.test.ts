import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { withTeam } from "@kobe/db";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { resolveEffective } from "./resolver/resolve.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./runs/resolver-input.js";

/**
 * Install skill blocklist (KOBE-81, D22): a blocklisted bundle hash can't be uploaded, can't be
 * approved by a team's review queue, and is dropped at every run start in every team, the moment
 * it is listed (nothing is cached).
 */
const finance = randomUUID();
const marketing = randomUUID();
const ids: Record<string, string> = {};
const browsers: Record<string, TestBrowser> = {};
const as = (who: string): TestBrowser => {
  const b = browsers[who];
  if (!b) throw new Error(`no browser for ${who}`);
  return b;
};
const id = (who: string): string => {
  const v = ids[who];
  if (!v) throw new Error(`no user ${who}`);
  return v;
};
let h: Harness;
const BASE = "/v1/install/skill-blocklist";

const zipOf = (name: string, note = "body") =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(`---\nname: ${name}\ndescription: Skill ${name}\n---\n${note}\n`),
    }),
    "application/zip",
  );

async function upload(who: string, scope: "team" | "personal", name: string, note?: string) {
  const res = await as(who).post(`/v1/skills?scope=${scope}`, zipOf(name, note));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { skillId: res.json.skill.id as string, hash: res.json.version.contentHash as string };
}
const block = (hash: string, reason = "malware") =>
  as("root").post(BASE, { contentHash: hash, reason });
const approve = (teamAdmin: string, skillId: string, version = 1) =>
  as(teamAdmin).post(`/v1/team/skill-review/${skillId}/versions/${version}`, {
    decision: "approved",
  });

/** What a run of `userId` in `teamId` would resolve for an agent naming `skills`. */
async function resolved(teamId: string, userId: string, skills: string[]) {
  const db = h.deps.database.db;
  const input = await withTeam(db, teamId, async (tx) => {
    const team = await loadTeamFacts(tx, teamId);
    const facts = await loadSkillFacts(tx, {
      teamId,
      userId,
      agentSkillNames: skills,
      personalSkillsDisabled: team.personalSkillsDisabled,
    });
    return buildResolveInput({
      frontmatter: { name: "A", skills },
      versionMode: "auto",
      floor: "auto",
      team,
      skills: facts,
      connectedConnectors: [],
    });
  });
  const out = resolveEffective(input);
  if (!out.ok) throw new Error(out.error.message);
  return {
    skills: out.value.skills.map((s) => s.name).sort(),
    omissions: out.value.omissions
      .filter((o) => o.kind === "skill")
      .map((o) => `${o.name}:${o.reason}`)
      .sort(),
  };
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects: new MemoryObjects(), prefix: "kobe/" } });
  ids.root = await h.createUser("root@blocklist.test", "admin");
  for (const who of ["alice", "bob", "dave"]) ids[who] = await h.createUser(`${who}@bl.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, string, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [marketing, "dave", "team_admin"],
    [marketing, "bob", "builder"],
  ];
  for (const [t, who, role] of members)
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      t,
      ids[who],
      role,
    ]);
  browsers.root = await h.signIn("root@blocklist.test");
  for (const who of ["alice", "bob", "dave"]) {
    browsers[who] = await h.signIn(`${who}@bl.test`);
    const teamId = who === "dave" ? marketing : finance;
    expect((await as(who).put("/v1/me/teams/active", { teamId })).status).toBe(200);
    as(who).team = teamId;
  }
});
afterAll(async () => {
  await h?.close();
});

describe("upload", () => {
  it("rejects a blocklisted bundle in every team and as a personal skill, stores nothing", async () => {
    const first = await upload("bob", "team", "upl-skill");
    expect((await block(first.hash)).status).toBe(201);
    // The same canonical bytes under the same name in the other team, and as a personal skill.
    expect((await as("bob").put("/v1/me/teams/active", { teamId: marketing })).status).toBe(200);
    as("bob").team = marketing;
    for (const scope of ["team", "personal"] as const) {
      const res = await as("bob").post(`/v1/skills?scope=${scope}`, zipOf("upl-skill"));
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("skill_blocklisted");
    }
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM team_skill_versions WHERE content_hash = $1`,
      [first.hash],
    );
    expect(rows[0].n).toBe(1);
    // A different bundle still uploads.
    await upload("bob", "team", "upl-other");
    expect((await as("bob").put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    as("bob").team = finance;
  });
});

describe("review queue", () => {
  it("refuses to approve a blocklisted version but still lets it be rejected", async () => {
    const s = await upload("bob", "team", "queue-skill");
    expect((await block(s.hash)).status).toBe(201);
    const res = await approve("alice", s.skillId);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("skill_blocklisted");
    const rejected = await as("alice").post(`/v1/team/skill-review/${s.skillId}/versions/1`, {
      decision: "rejected",
    });
    expect(rejected.status).toBe(200);
    // Unblocking lets the team admin decide again.
    expect((await as("root").delete(`${BASE}/${s.hash}`)).status).toBe(204);
    expect((await approve("alice", s.skillId)).status).toBe(200);
  });
});

describe("review queue badge", () => {
  it("marks blocklisted rows in the same listing", async () => {
    const bad = await upload("bob", "team", "badge-bad");
    const good = await upload("bob", "team", "badge-good");
    expect((await block(bad.hash)).status).toBe(201);
    const res = await as("alice").get("/v1/team/skill-review?status=pending");
    const blocked = new Map(
      res.json.reviews.map((r: { slug: string; blocked: boolean }) => [r.slug, r.blocked]),
    );
    expect(blocked.get("badge-bad")).toBe(true);
    expect(blocked.get("badge-good")).toBe(false);
    expect(good.hash).not.toBe(bad.hash);
  });
});

describe("bundle download", () => {
  it("serves a bundle until its hash is blocklisted, then 422", async () => {
    const s = await upload("bob", "team", "dl-skill");
    const url = `/v1/skills/${s.skillId}/versions/1/bundle`;
    expect((await as("bob").get(url)).status).toBe(200);
    expect((await block(s.hash)).status).toBe(201);
    const res = await as("bob").get(url);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("skill_blocklisted");
    expect((await as("root").delete(`${BASE}/${s.hash}`)).status).toBe(204);
    expect((await as("bob").get(url)).status).toBe(200);
  });
});

describe("run start", () => {
  it("drops an approved team skill the moment its hash is listed, in every team, and restores it on removal", async () => {
    // Approved in both teams (same bytes: same hash).
    const a = await upload("bob", "team", "run-skill");
    expect((await approve("alice", a.skillId)).status).toBe(200);
    expect((await as("bob").put("/v1/me/teams/active", { teamId: marketing })).status).toBe(200);
    as("bob").team = marketing;
    const b = await upload("bob", "team", "run-skill");
    expect(b.hash).toBe(a.hash);
    expect((await approve("dave", b.skillId)).status).toBe(200);
    expect((await as("bob").put("/v1/me/teams/active", { teamId: finance })).status).toBe(200);
    as("bob").team = finance;

    for (const t of [finance, marketing])
      expect(await resolved(t, id("bob"), ["run-skill"])).toEqual({
        skills: ["run-skill"],
        omissions: [],
      });
    expect((await block(a.hash.toUpperCase(), "supply-chain")).status).toBe(201);
    for (const t of [finance, marketing])
      expect(await resolved(t, id("bob"), ["run-skill"])).toEqual({
        skills: [],
        omissions: ["run-skill:blocklisted"],
      });
    expect((await as("root").delete(`${BASE}/${a.hash}`)).status).toBe(204);
    expect((await resolved(finance, id("bob"), ["run-skill"])).skills).toEqual(["run-skill"]);
  });

  it("drops a personal skill in every team", async () => {
    const p = await upload("bob", "personal", "mine-clean", "personal body");
    for (const t of [finance, marketing])
      expect((await resolved(t, id("bob"), [])).skills).toEqual(["mine-clean"]);
    expect((await block(p.hash)).status).toBe(201);
    for (const t of [finance, marketing])
      expect(await resolved(t, id("bob"), [])).toEqual({
        skills: [],
        omissions: ["mine-clean:blocklisted"],
      });
  });
});

describe("management API", () => {
  it("is for install admins only", async () => {
    for (const who of ["alice", "bob"]) {
      expect((await as(who).get(BASE)).status).toBe(403);
      expect((await as(who).post(BASE, { contentHash: "a".repeat(64), reason: "x" })).status).toBe(
        403,
      );
      expect((await as(who).delete(`${BASE}/${"a".repeat(64)}`)).status).toBe(403);
    }
  });

  it("validates hashes and reasons, normalizes case, refuses duplicates", async () => {
    const bad = ["abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), ""];
    for (const contentHash of bad) expect((await block(contentHash)).status, contentHash).toBe(400);
    expect(
      (await as("root").post(BASE, { contentHash: "a".repeat(64), reason: "  " })).status,
    ).toBe(400);
    expect((await as("root").post(BASE, { contentHash: "a".repeat(64) })).status).toBe(400);
    expect((await block("A".repeat(64), "x".repeat(501))).status).toBe(400);
    const ok = await block("AB".repeat(32), "  upper  ");
    expect(ok.status).toBe(201);
    expect(ok.json.entry).toMatchObject({ contentHash: "ab".repeat(32), reason: "upper" });
    expect((await block("ab".repeat(32))).status).toBe(409);
    expect((await as("root").delete(`${BASE}/${"AB".repeat(32)}`)).status).toBe(204);
    expect((await as("root").delete(`${BASE}/${"ab".repeat(32)}`)).status).toBe(404);
    expect((await as("root").delete(`${BASE}/nope`)).status).toBe(404);
  });

  it("lists newest first in pages and audits changes without content", async () => {
    await h.admin.query(`DELETE FROM skill_blocklist`);
    for (let i = 0; i < 5; i++)
      expect((await block(i.toString(16).repeat(64), `reason ${i}`)).status).toBe(201);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await as("root").get(`${BASE}?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.json.entries.map((e: { reason: string }) => e.reason));
      cursor = res.json.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["reason 4", "reason 3", "reason 2", "reason 1", "reason 0"]);
    expect((await as("root").get(`${BASE}?cursor=junk`)).status).toBe(400);
    expect((await as("root").get(`${BASE}?limit=0`)).status).toBe(400);

    const { rows } = await h.admin.query(
      `SELECT action, team_id, target FROM audit_log WHERE action LIKE 'skill.blocklist.%' ORDER BY seq`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(Object.keys(r.target)).toEqual(["bundleHash"]);
      expect(r.team_id).toBeNull();
    }
    expect(rows.map((r) => r.action)).toContain("skill.blocklist.removed");
  });
});
