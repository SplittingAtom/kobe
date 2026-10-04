import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { validateZipBundle } from "./skills/bundle.js";
import { sha256Hex } from "./skills/storage.js";

/**
 * Skill bundle uploads over HTTP (KOBE-78): zip and SKILL.md uploads become immutable numbered
 * versions with the bundle in object storage, personal and team scopes, authorization per role,
 * validation errors, audit, and team walls.
 */
type Person = "alice" | "bob" | "carol" | "dave";
// Finance: alice team_admin, bob builder, carol member. Marketing: dave builder.
const PEOPLE: readonly Person[] = ["alice", "bob", "carol", "dave"];
const ids = {} as Record<Person, string>;
const as = {} as Record<Person, TestBrowser>;
const finance = randomUUID();
const marketing = randomUUID();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
let h: Harness;

const skillMd = (name: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: Skill ${name}\n---\n# ${name}\n${body}\n`;
const zipOf = (name: string, extra: Record<string, string> = {}) =>
  zipSync({
    "SKILL.md": strToU8(skillMd(name)),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])),
  });
const asZip = (bytes: Uint8Array) => new RawBody(bytes, "application/zip");
const asMd = (text: string) => new RawBody(text, "text/markdown");
/** The object key a stored version names (the API never exposes it). */
async function keyOf(contentHash: string): Promise<string> {
  const { rows } = await h.admin.query<{ storage_key: string }>(
    `SELECT storage_key FROM team_skill_versions WHERE content_hash = $1
     UNION ALL SELECT storage_key FROM install_skill_versions WHERE content_hash = $1`,
    [contentHash],
  );
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]?.storage_key as string;
}
const upload = (who: Person, scope: string, body: RawBody) =>
  as[who].post(`/v1/skills?scope=${scope}`, body);

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: PREFIX } });
  for (const who of PEOPLE) ids[who] = await h.createUser(`${who}@skills.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [marketing, "dave", "builder"],
  ];
  for (const [team, who, role] of members) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  for (const who of PEOPLE) {
    as[who] = await h.signIn(`${who}@skills.test`);
    const team = who === "dave" ? marketing : finance;
    const res = await as[who].put("/v1/me/teams/active", { teamId: team });
    expect(res.status).toBe(200);
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("uploading", () => {
  it("creates version 1 from a zip, stores the bundle by hash and audits it", async () => {
    const bytes = zipOf("report-writer", { "scripts/run.py": "print(1)" });
    const res = await upload("bob", "team", asZip(bytes));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    // The stored and hashed bytes are the canonical repack, not the upload.
    const checked = validateZipBundle(bytes);
    if (!checked.ok) throw new Error(checked.error.code);
    const canonical = checked.value.zip;
    const hash = sha256Hex(canonical);
    expect(hash).not.toBe(sha256Hex(bytes));
    expect(res.json.skill).toMatchObject({
      scope: "team",
      slug: "report-writer",
      latestVersion: 1,
      ownerUserId: ids.bob,
    });
    expect(res.json.version).toMatchObject({
      version: 1,
      source: "zip",
      contentHash: hash,
      sizeBytes: canonical.length,
      fileCount: 2,
      uploadedBy: ids.bob,
    });
    expect(res.json.version.storageKey).toBeUndefined();
    const key = await keyOf(hash);
    expect(key).toMatch(new RegExp(`^${PREFIX}skills/teams/${finance}/${hash}/[0-9a-f-]{36}$`));
    expect(objects.objects.get(key)?.equals(Buffer.from(canonical))).toBe(true);
    const { rows } = await h.admin.query<{ team_id: string; target: Record<string, unknown> }>(
      `SELECT team_id, target FROM audit_log WHERE action = 'skill.uploaded' AND target->>'skillId' = $1`,
      [res.json.skill.id],
    );
    expect(rows).toEqual([
      {
        team_id: finance,
        target: {
          skillId: res.json.skill.id,
          scope: "team",
          slug: "report-writer",
          version: 1,
          bundleHash: hash,
          bytes: canonical.length,
          files: 2,
          source: "zip",
        },
      },
    ]);
  });

  it("makes each changed upload a new immutable version and refuses an identical one", async () => {
    const v1 = await upload("bob", "team", asZip(zipOf("evolving")));
    const id = v1.json.skill.id as string;
    const again = await upload("bob", "team", asZip(zipOf("evolving")));
    expect(again).toMatchObject({ status: 409, json: { code: "unchanged" } });
    const v2 = await upload("alice", "team", asZip(zipOf("evolving", { "notes.md": "more" })));
    expect(v2.status).toBe(201);
    expect(v2.json.skill).toMatchObject({ id, latestVersion: 2 });
    expect(v2.json.version.version).toBe(2);

    const list = await as.carol.get(`/v1/skills/${id}/versions`);
    expect(list.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const first = await as.carol.get(`/v1/skills/${id}/versions/1`);
    expect(first.json.version.contentHash).toBe(v1.json.version.contentHash);
    // The first version still names its own bytes.
    const row = await h.admin.query(
      `SELECT content_hash FROM team_skill_versions WHERE skill_id = $1 AND version = 1`,
      [id],
    );
    expect(row.rows[0].content_hash).toBe(v1.json.version.contentHash);
  });

  it("wraps a bare SKILL.md into a bundle", async () => {
    const res = await upload("bob", "team", asMd(skillMd("plain-md")));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.version).toMatchObject({ source: "skill_md", fileCount: 1 });
    expect(objects.objects.has(await keyOf(res.json.version.contentHash))).toBe(true);
  });

  it("applies the role rules: builders upload team skills, members only personal ones", async () => {
    const denied = await upload("carol", "team", asMd(skillMd("members-no")));
    expect(denied).toMatchObject({ status: 403, json: { code: "forbidden" } });
    const personal = await upload("carol", "personal", asMd(skillMd("carol-own")));
    expect(personal.status).toBe(201);
    expect(personal.json.skill).toMatchObject({ scope: "personal", ownerUserId: ids.carol });
    expect(objects.keys(`${PREFIX}skills/users/${ids.carol}/`)).toHaveLength(1);
  });

  it("rejects invalid bundles with a code and stores nothing", async () => {
    const before = objects.keys().length;
    const traversal = zipSync({ "SKILL.md": strToU8(skillMd("t")), "../x": strToU8("x") });
    const cases: [RawBody, number, string][] = [
      [asZip(traversal), 400, "unsafe_path"],
      [asZip(strToU8("nope")), 400, "invalid_zip"],
      [asZip(zipSync({ "a.txt": strToU8("x") })), 400, "skill_md_missing"],
      [asMd("no frontmatter"), 400, "invalid_skill_md"],
      [new RawBody("{}", "application/json"), 415, "unsupported_media_type"],
      [asZip(new Uint8Array(6 * 1024 * 1024)), 413, "bundle_too_large"],
    ];
    for (const [body, status, code] of cases) {
      const res = await upload("bob", "team", body);
      expect([res.status, res.json.code]).toEqual([status, code]);
    }
    expect(objects.keys().length).toBe(before);
    expect((await upload("bob", "galaxy", asMd(skillMd("x")))).status).toBe(400);
  });
});

describe("wrapper directories", () => {
  const files = { "SKILL.md": strToU8(skillMd("wrapped")), "ref/a.md": strToU8("a") };
  const wrapped = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [`top/${k}`, v])),
  );

  it("strips one top-level directory and hashes the stored (normalized) bytes", async () => {
    const res = await upload("bob", "team", asZip(wrapped));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const stored = objects.objects.get(await keyOf(res.json.version.contentHash));
    expect(stored && sha256Hex(stored)).toBe(res.json.version.contentHash);
    expect(res.json.version.contentHash).not.toBe(sha256Hex(wrapped));
    // The same files without a wrapper are the same bundle: nothing new to upload.
    const plain = await upload("bob", "team", asZip(zipSync(files)));
    expect(plain).toMatchObject({ status: 409, json: { code: "unchanged" } });
  });

  it("stores dense frontmatter the database check accepts (no 500)", async () => {
    const dense = Array.from({ length: 8000 }, () => "1").join(",");
    const md = `---\nname: dense\ndescription: d\nlist: [${dense}]\n---\nx`;
    expect((await upload("bob", "team", asMd(md))).status).toBe(201);
  });

  it("rejects two top-level directories", async () => {
    const two = zipSync({ "a/SKILL.md": strToU8(skillMd("two")), "b/x.md": strToU8("x") });
    expect((await upload("bob", "team", asZip(two))).json.code).toBe("skill_md_missing");
  });
});

describe("failed uploads and limits", () => {
  it("deletes the blob of a refused upload, but never one a version still names", async () => {
    const uid = ids.bob;
    const maxed = await h.admin.query<{ id: string }>(
      `INSERT INTO team_skills (team_id, owner_user_id, slug, description, latest_version)
       VALUES ($1, $2, 'maxed', 'd', 500) RETURNING id`,
      [finance, uid],
    );
    await h.admin.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, version, frontmatter, source, content_hash,
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
       VALUES ($1, $2, 500, '{}', 'zip', $3, 'k', 1, 1, 1, $4)`,
      [finance, maxed.rows[0]?.id, "e".repeat(64), uid],
    );
    const bytes = zipOf("maxed", { "x.md": "new" });
    const res = await upload("bob", "team", asZip(bytes));
    const maxedZip = validateZipBundle(bytes);
    expect(res).toMatchObject({ status: 409, json: { code: "version_limit" } });
    const maxedHash = maxedZip.ok ? sha256Hex(maxedZip.value.zip) : "";
    expect(objects.keys(`${PREFIX}skills/teams/${finance}/${maxedHash}/`)).toEqual([]);

    const ok = await upload("bob", "team", asZip(zipOf("kept-blob")));
    const again = await upload("bob", "team", asZip(zipOf("kept-blob")));
    expect(again.json.code).toBe("unchanged");
    const hash = ok.json.version.contentHash;
    expect(objects.objects.has(await keyOf(hash))).toBe(true);
    // The refused attempt cleaned up only its own object.
    expect(objects.keys(`${PREFIX}skills/teams/${finance}/${hash}/`)).toHaveLength(1);
  });

  it("two concurrent identical uploads: one wins, the loser's cleanup leaves the winner's blob", async () => {
    const bytes = zipOf("racing", { "x.md": "same" });
    const [a, b] = await Promise.all([
      upload("bob", "team", asZip(bytes)),
      upload("bob", "team", asZip(bytes)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const hash = winner.json.version.contentHash;
    const key = await keyOf(hash);
    expect(objects.objects.has(key)).toBe(true);
    expect(objects.keys(`${PREFIX}skills/teams/${finance}/${hash}/`)).toEqual([key]);
  });

  it("rate-limits uploads per user", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await upload("alice", "personal", asMd(skillMd(`rate-${i}`)))).status;
    }
    expect(last).toBe(429);
    expect((await upload("dave", "personal", asMd(skillMd("other-user")))).status).toBe(201);
  });
});

describe("reading and walls", () => {
  it("lists team and personal skills, and hides them from other teams and users", async () => {
    const team = await upload("bob", "team", asMd(skillMd("finance-only")));
    const mine = await upload("bob", "personal", asMd(skillMd("bobs-private")));
    const list = await as.bob.get("/v1/skills");
    const slugs = list.json.skills.map((s: { slug: string }) => s.slug);
    expect(slugs).toEqual(expect.arrayContaining(["finance-only", "bobs-private"]));
    expect((await as.bob.get("/v1/skills?scope=personal")).json.skills).toHaveLength(1);

    for (const id of [team.json.skill.id, mine.json.skill.id]) {
      const wrong = id === team.json.skill.id ? as.dave : as.carol;
      expect((await wrong.get(`/v1/skills/${id}`)).status).toBe(404);
      expect((await wrong.get(`/v1/skills/${id}/versions`)).status).toBe(404);
      expect((await wrong.get(`/v1/skills/${id}/versions/1`)).status).toBe(404);
    }
    const daves = (await as.dave.get("/v1/skills")).json.skills.map(
      (x: { slug: string }) => x.slug,
    );
    expect(daves).not.toContain("finance-only");
    expect(daves).not.toContain("bobs-private");
    expect((await as.carol.get(`/v1/skills/${team.json.skill.id}`)).status).toBe(200);
  });

  it("keeps the same skill name separate per team and per owner", async () => {
    expect((await upload("bob", "team", asMd(skillMd("shared-name")))).status).toBe(201);
    expect((await upload("dave", "team", asMd(skillMd("shared-name")))).status).toBe(201);
    expect((await upload("dave", "personal", asMd(skillMd("shared-name")))).status).toBe(201);
  });

  it("never lets another member write to or list a personal skill, even by name", async () => {
    const mine = await upload("bob", "personal", asMd(skillMd("bobs-notes")));
    const other = await upload("carol", "personal", asMd(skillMd("bobs-notes", "Carol's take")));
    expect(other.status).toBe(201);
    expect(other.json.skill.id).not.toBe(mine.json.skill.id);
    expect(other.json.skill.ownerUserId).toBe(ids.carol);
    const bob = await as.bob.get(`/v1/skills/${mine.json.skill.id}`);
    expect(bob.json.skill.latestVersion).toBe(1);
    const carols = (await as.carol.get("/v1/skills?scope=personal")).json.skills;
    const carolIds = carols.map((s: { id: string }) => s.id);
    expect(carolIds).toContain(other.json.skill.id);
    expect(carolIds).not.toContain(mine.json.skill.id);
  });

  it("answers 404 for malformed ids", async () => {
    expect((await as.bob.get("/v1/skills/not-a-uuid")).status).toBe(404);
  });
});

describe("bundle download", () => {
  it("streams the stored canonical zip to team members and the personal owner", async () => {
    const up = await upload("bob", "team", asZip(zipOf("dl-team", { "a.txt": "hi" })));
    const hash = up.json.version.contentHash as string;
    const key = await keyOf(hash);
    for (const who of ["bob", "carol"] as const) {
      const res = await as[who].get(`/v1/skills/${up.json.skill.id}/versions/1/bundle`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.bytes).equals(objects.objects.get(key) as Buffer)).toBe(true);
      expect(sha256Hex(res.bytes)).toBe(hash);
      expect(res.headers.get("content-type")).toBe("application/zip");
      expect(res.headers.get("content-disposition")).toMatch(
        /^attachment; filename="dl-team-v1\.zip"$/,
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    const mine = await upload("bob", "personal", asMd(skillMd("dl-mine")));
    const own = await as.bob.get(`/v1/skills/${mine.json.skill.id}/versions/1/bundle`);
    expect(own.status).toBe(200);
  });

  it("answers 404 to other teams, other users' personal skills and missing versions", async () => {
    const team = await upload("bob", "team", asMd(skillMd("dl-wall")));
    const mine = await upload("bob", "personal", asMd(skillMd("dl-wall-mine")));
    const t = team.json.skill.id;
    const p = mine.json.skill.id;
    expect((await as.dave.get(`/v1/skills/${t}/versions/1/bundle`)).status).toBe(404);
    expect((await as.carol.get(`/v1/skills/${p}/versions/1/bundle`)).status).toBe(404);
    expect((await as.bob.get(`/v1/skills/${t}/versions/9/bundle`)).status).toBe(404);
    expect((await as.bob.get(`/v1/skills/${t}/versions/0/bundle`)).status).toBe(404);
    expect((await as.bob.get(`/v1/skills/nope/versions/1/bundle`)).status).toBe(404);
    for (const bad of ["1e30", "99999999999", "1.5", "abc"]) {
      expect((await as.bob.get(`/v1/skills/${t}/versions/${bad}/bundle`)).status).toBe(404);
      expect((await as.bob.get(`/v1/skills/${t}/versions/${bad}`)).status).toBe(404);
    }
  });
});

describe("storage", () => {
  it("answers 503 when no object store is configured", async () => {
    const bare = await openHarness();
    try {
      const team = randomUUID();
      const user = await bare.createUser("bare@skills.test");
      await bare.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'bare', 'Bare')`, [
        team,
      ]);
      await bare.admin.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'builder')`,
        [team, user],
      );
      const b = await bare.signIn("bare@skills.test");
      expect((await b.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      b.team = team;
      const res = await b.post("/v1/skills?scope=personal", asMd(skillMd("x")));
      expect(res).toMatchObject({ status: 503, json: { code: "skills_unavailable" } });
    } finally {
      await bare.close();
    }
  });
});
