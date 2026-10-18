import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * Semver on skill versions (KOBE-308, spec SK14): uploads take an optional `semver` and
 * `changelog`, default to the next minor (0.1.0 first, in step with the 0.<n>.0 backfill), refuse
 * a number not above the latest, and every read shows the semver, newest (highest seq) first.
 * Team skills carry their access mode, kept in step with "Offer to all agents".
 */
const team = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
let admin: TestBrowser;
let member: TestBrowser;

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: Skill ${name}\n---\n# ${name}\n${body}\n`;
const md = (name: string, body: string) => new RawBody(skillMd(name, body), "text/markdown");
const upload = (who: TestBrowser, scope: string, body: RawBody, query = "") =>
  who.post(`/v1/skills?scope=${scope}${query}`, body);
const q = (params: Record<string, string>) => `&${new URLSearchParams(params).toString()}`;
/** A multipart upload: the SKILL.md as the `bundle` part, plus text fields. */
async function form(name: string, body: string, fields: Record<string, string>): Promise<RawBody> {
  const data = new FormData();
  data.set("bundle", new File([skillMd(name, body)], "SKILL.md", { type: "text/markdown" }));
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  const req = new Request("http://form.test", { method: "POST", body: data });
  return new RawBody(
    new Uint8Array(await req.arrayBuffer()),
    req.headers.get("content-type") ?? "",
  );
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } });
  const adminId = await h.createUser("admin@semver.test");
  const memberId = await h.createUser("member@semver.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'semver', 'Semver')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'), ($1, $3, 'member')`,
    [team, adminId, memberId],
  );
  admin = await h.signIn("admin@semver.test");
  member = await h.signIn("member@semver.test");
  for (const who of [admin, member]) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("numbering uploads", () => {
  it("defaults to 0.1.0, then the next minor; takes a higher requested number and a changelog", async () => {
    const v1 = await upload(member, "personal", md("numbered", "One."));
    expect(v1.status, JSON.stringify(v1.json)).toBe(201);
    expect(v1.json.version).toMatchObject({ version: 1, seq: 1, semver: "0.1.0", changelog: null });
    expect(v1.json.skill).toMatchObject({ latestVersion: 1, latestSemver: "0.1.0" });
    const v2 = await upload(member, "personal", md("numbered", "Two."));
    expect(v2.json.version).toMatchObject({ seq: 2, semver: "0.2.0" });
    const v3 = await upload(
      member,
      "personal",
      await form("numbered", "Three.", { semver: "1.0.0", changelog: "First stable release." }),
    );
    expect(v3.status, JSON.stringify(v3.json)).toBe(201);
    expect(v3.json.version).toMatchObject({
      seq: 3,
      semver: "1.0.0",
      changelog: "First stable release.",
    });
    // A package with no evals/ or manifest: its package hash is its runtime hash (KOBE-310).
    expect(v3.json.version.packageHash).toBe(v3.json.version.contentHash);
    expect(v3.json.skill).toMatchObject({ latestVersion: 3, latestSemver: "1.0.0" });
    const v4 = await upload(member, "personal", md("numbered", "Four."));
    expect(v4.json.version.semver).toBe("1.1.0");
  });

  it("refuses a number that is not above the latest, and stores nothing", async () => {
    const first = await upload(member, "personal", md("strict", "A."), q({ semver: "2.3.0" }));
    expect(first.status).toBe(201);
    const blobs = objects.objects.size;
    for (const semver of ["2.3.0", "2.2.9", "1.9.0"]) {
      const res = await upload(member, "personal", md("strict", `B ${semver}.`), q({ semver }));
      expect(res.status).toBe(409);
      expect(res.json).toEqual({
        code: "semver_not_increasing",
        message: `Version ${semver} must be higher than the latest version, 2.3.0.`,
      });
    }
    expect(objects.objects.size).toBe(blobs);
    const list = await member.get(`/v1/skills/${first.json.skill.id}/versions`);
    expect(list.json.versions).toHaveLength(1);
  });

  it("rejects a malformed number or changelog before storing anything", async () => {
    for (const query of [
      q({ semver: "1.0" }),
      q({ semver: "v1.0.0" }),
      q({ semver: "1.0.0-beta" }),
      // Free text never travels in the URL (access logs): the changelog goes in the form.
      q({ changelog: "Fixes." }),
    ]) {
      const res = await upload(member, "personal", md("malformed", "M."), query);
      expect(res.status, query).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
    for (const fields of [
      { changelog: "x".repeat(1025) },
      { changelog: "  " },
      { semver: "1.0" },
      { semver: "1000000000.0.0" },
    ]) {
      const res = await upload(member, "personal", await form("malformed", "M.", fields));
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(res.json.code).toBe("invalid_request");
    }
    const conflicting = await upload(
      member,
      "personal",
      await form("malformed", "M.", { semver: "1.0.0" }),
      q({ semver: "2.0.0" }),
    );
    expect(conflicting.status).toBe(400);
    const noBundle = await member.post(
      "/v1/skills?scope=personal",
      new RawBody("--x--\r\n", "multipart/form-data; boundary=x"),
    );
    expect(noBundle.status).toBe(415);
    const list = await member.get("/v1/skills?scope=personal");
    expect(list.json.skills.map((s: { slug: string }) => s.slug)).not.toContain("malformed");
  });

  it("asks for a number when the next minor would leave the nine-digit range", async () => {
    const top = await upload(
      member,
      "personal",
      md("crowded", "A."),
      q({ semver: "1.999999999.0" }),
    );
    expect(top.status).toBe(201);
    const next = await upload(member, "personal", md("crowded", "B."));
    expect(next.status).toBe(400);
    expect(next.json.code).toBe("semver_required");
    const major = await upload(member, "personal", md("crowded", "B."), q({ semver: "2.0.0" }));
    expect(major.json.version.semver).toBe("2.0.0");
  });
});

describe("reading versions", () => {
  it("lists newest first by seq and finds a version by seq or semver", async () => {
    const v1 = await upload(admin, "team", md("ordered", "1."), q({ semver: "0.9.0" }));
    const id = v1.json.skill.id as string;
    await upload(admin, "team", md("ordered", "2."), q({ semver: "0.10.0" }));
    await upload(
      admin,
      "team",
      await form("ordered", "3.", { semver: "2.0.0", changelog: "Major." }),
    );
    const list = await member.get(`/v1/skills/${id}/versions`);
    expect(
      list.json.versions.map((v: { seq: number; semver: string }) => [v.seq, v.semver]),
    ).toEqual([
      [3, "2.0.0"],
      [2, "0.10.0"],
      [1, "0.9.0"],
    ]);
    const bySemver = await member.get(`/v1/skills/${id}/versions/0.10.0`);
    expect(bySemver.json.version).toMatchObject({ seq: 2, semver: "0.10.0" });
    const bySeq = await member.get(`/v1/skills/${id}/versions/3`);
    expect(bySeq.json.version).toMatchObject({ semver: "2.0.0", changelog: "Major." });
    expect((await member.get(`/v1/skills/${id}/versions/9.9.9`)).status).toBe(404);
    const bundle = await member.get(`/v1/skills/${id}/versions/2.0.0/bundle`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-disposition")).toBe(
      'attachment; filename="ordered-v2.0.0.zip"',
    );
  });

  it("records the semver in the upload audit", async () => {
    const res = await upload(member, "personal", md("audited", "A."), q({ semver: "3.1.4" }));
    const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'skill.uploaded' AND target->>'skillId' = $1`,
      [res.json.skill.id],
    );
    expect(rows.map((r) => r.target.semver)).toEqual(["3.1.4"]);
  });

  it("shows the semver in the team's review queue", async () => {
    await upload(admin, "team", md("queued", "Q."), q({ semver: "4.0.0" }));
    const queue = await admin.get("/v1/team/skill-review?status=pending");
    expect(queue.status, JSON.stringify(queue.json)).toBe(200);
    const row = queue.json.reviews.find((r: { slug: string }) => r.slug === "queued");
    expect(row).toMatchObject({ version: 1, semver: "4.0.0" });
  });
});

describe("team skill access", () => {
  it("starts available, follows Offer to all agents, and is never archived by upload", async () => {
    const res = await upload(admin, "team", md("offerable", "O."));
    const id = res.json.skill.id as string;
    expect(res.json.skill).toMatchObject({ access: "available", archivedAt: null });
    expect((await admin.put(`/v1/skills/${id}/offer`, { offerToAll: true })).status).toBe(200);
    expect((await member.get(`/v1/skills/${id}`)).json.skill.access).toBe("default_on");
    expect((await admin.put(`/v1/skills/${id}/offer`, { offerToAll: false })).status).toBe(200);
    expect((await member.get(`/v1/skills/${id}`)).json.skill.access).toBe("available");
  });

  it("repairs an access mode a rolled-back release left behind when the offer is saved again", async () => {
    const res = await upload(admin, "team", md("drifted", "D."));
    const id = res.json.skill.id as string;
    // A release before KOBE-308 turned the offer on and wrote only offer_to_all.
    await h.admin.query(
      `UPDATE team_skills SET offer_to_all = true, access = 'available' WHERE id = $1`,
      [id],
    );
    const before = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'skill.offer.changed' AND target->>'skillId' = $1`,
      [id],
    );
    const save = await admin.put(`/v1/skills/${id}/offer`, { offerToAll: true });
    expect(save.json).toEqual({ offerToAll: true });
    expect((await member.get(`/v1/skills/${id}`)).json.skill.access).toBe("default_on");
    // The offer itself did not change: no audit row.
    const after = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'skill.offer.changed' AND target->>'skillId' = $1`,
      [id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("gives personal skills no access mode", async () => {
    const res = await upload(member, "personal", md("own-access", "P."));
    expect(res.json.skill).toMatchObject({ access: null, archivedAt: null });
  });
});
