import { createHash, randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RawBody, type TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { seedKobeSkills } from "./skills/kobe-seed.js";
import { withTeam } from "@kobe/db";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * Draft starts (KOBE-322, SK10): a template, an upload (zip or SKILL.md, through the upload's own
 * validation), a fork (provenance from the version actually copied) and a conversation. Each
 * makes a private draft of its author in the active team.
 */
const team = randomUUID();
const otherTeam = randomUUID();
const objects = new MemoryObjects();
let h: Harness;
let author: TestBrowser;
let builder: TestBrowser;
let authorId = "";
let builderId = "";
let sync: WorkspaceSync;
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const workspaceObjects = new MemoryObjects();

const skillMd = (name: string, body = "Be brief.") =>
  `---\nname: ${name}\ndescription: Does ${name} things. Use when asked about ${name}.\n---\n# ${name}\n${body}\n`;
const zip = (name: string, extra: Record<string, string> = {}) =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(skillMd(name)),
      ...Object.fromEntries(Object.entries(extra).map(([p, t]) => [p, strToU8(t)])),
    }),
    "application/zip",
  );

async function filesOf(who: TestBrowser, id: string) {
  const res = await who.get(`/v1/skills/drafts/${id}`);
  expect(res.status).toBe(200);
  return (res.json.files as { path: string }[]).map((f) => f.path).sort();
}

beforeAll(async () => {
  h = await openHarness({ blobs: { objects, prefix: "kobe/" } }, (deps) => {
    sync = createWorkspaceSync({
      db: deps.database.db,
      objects: workspaceObjects,
      prefix: "",
      limits: { maxFileBytes: 8 * 1024 * 1024, maxWorkspaceBytes: 64 * 1024 * 1024, maxFiles: 500 },
      log: silent,
    });
    return { workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } } };
  });
  const ids = await Promise.all(["author", "builder"].map((n) => h.createUser(`${n}@starts.test`)));
  authorId = ids[0] ?? "";
  builderId = ids[1] ?? "";
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'starts', 'Finance'), ($2, 'starts-2', 'Other')`,
    [team, otherTeam],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'builder'), ($4, $2, 'builder')`,
    [team, ids[0], ids[1], otherTeam],
  );
  author = await h.signIn("author@starts.test");
  builder = await h.signIn("builder@starts.test");
  for (const who of [author, builder]) {
    expect((await who.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    who.team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

describe("template and upload starts (ac-1)", () => {
  it("lists the templates and starts a draft from one under the author's name", async () => {
    const list = await author.get("/v1/skills/drafts/templates");
    expect(list.json.templates.map((t: { id: string }) => t.id)).toEqual([
      "document-generator",
      "data-analysis",
      "api-helper",
      "review-checklist",
      "house-style",
    ]);
    const res = await author.post("/v1/skills/drafts", {
      name: "weekly-brief",
      template: "document-generator",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.draft).toMatchObject({
      name: "weekly-brief",
      startedFrom: "template",
      mine: true,
      shared: false,
    });
    expect(await filesOf(author, res.json.draft.id)).toEqual(["SKILL.md", "references/outline.md"]);
    const md = await author.get(`/v1/skills/drafts/${res.json.draft.id}/files/SKILL.md`);
    expect(md.text).toContain("name: weekly-brief");
    expect((await author.post("/v1/skills/drafts", { name: "x", template: "nope" })).status).toBe(
      400,
    );
  });

  it("starts from an uploaded zip, evals and manifest included, named by its SKILL.md", async () => {
    const res = await author.request(
      "POST",
      "/v1/skills/drafts/upload?kind=zip",
      zip("uploaded-notes", {
        "references/a.md": "A.",
        "evals/cases.yaml": "cases: []\n",
      }),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.draft).toMatchObject({ name: "uploaded-notes", startedFrom: "upload" });
    expect(await filesOf(author, res.json.draft.id)).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "references/a.md",
    ]);
    const { rows } = await h.admin.query<{ team_id: string; owner_user_id: string }>(
      `SELECT team_id, owner_user_id FROM skill_drafts WHERE id = $1`,
      [res.json.draft.id],
    );
    expect(rows[0]).toEqual({ team_id: team, owner_user_id: authorId });
  });

  it("starts from a bare SKILL.md, and refuses what an upload refuses", async () => {
    const md = await author.request(
      "POST",
      "/v1/skills/drafts/upload?kind=skill_md",
      new RawBody(skillMd("bare-skill"), "text/markdown"),
    );
    expect(md.status, JSON.stringify(md.json)).toBe(201);
    expect(await filesOf(author, md.json.draft.id)).toEqual(["SKILL.md"]);
    const bad = await author.request(
      "POST",
      "/v1/skills/drafts/upload?kind=skill_md",
      new RawBody("no frontmatter", "text/markdown"),
    );
    expect([bad.status, bad.json.code]).toEqual([400, "invalid_skill_md"]);
    const provenance = await author.request(
      "POST",
      "/v1/skills/drafts/upload?kind=zip",
      zip("with-provenance", { "provenance.json": "{}" }),
    );
    expect(provenance.status).toBe(400);
    const big = await author.request(
      "POST",
      "/v1/skills/drafts/upload?kind=zip",
      zip("too-big", { "references/big.md": "x".repeat(6 * 1024 * 1024) }),
    );
    expect([413, 400]).toContain(big.status);
    expect((await author.request("POST", "/v1/skills/drafts/upload", zip("no-kind"))).status).toBe(
      400,
    );
  });
});

const ifMatch = (rev: number) => ({ "if-match": `"${rev}"` });
const text = (t: string) => new RawBody(t, "text/plain; charset=utf-8");

async function upload(who: TestBrowser, scope: "team" | "personal", body: RawBody) {
  const res = await who.request("POST", `/v1/skills?scope=${scope}`, body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { skill: { id: string }; version: { version: number; semver: string } };
}

async function saveAs(who: TestBrowser, id: string, destination: string, semver: string) {
  const rev = (await who.get(`/v1/skills/drafts/${id}`)).json.draft.rev as number;
  return who.request(
    "POST",
    `/v1/skills/drafts/${id}/versions`,
    { destination, semver, changelog: "From the fork." },
    ifMatch(rev),
  );
}

const MANIFEST = (name: string, version: string) =>
  `apiVersion: kobe.dev/skill/v1\nname: ${name}\nversion: ${version}\nsummary: A skill.\n`;

describe("fork (ac-1, ac-3)", () => {
  it("copies a team version, recording the version actually copied as the parent", async () => {
    const saved = await upload(
      builder,
      "team",
      zip("team-report", { "kobe.skill.yaml": MANIFEST("team-report", "0.1.0") }),
    );
    const fork = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "team", skillId: saved.skill.id },
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const { rows } = await h.admin.query<{
      parent_ref: Record<string, unknown>;
      started_from: string;
      content_hash: string;
    }>(
      `SELECT d.parent_ref, d.started_from, v.content_hash FROM skill_drafts d
         JOIN team_skill_versions v ON v.skill_id = $2 AND v.version = 1
        WHERE d.id = $1`,
      [fork.json.draft.id, saved.skill.id],
    );
    expect(rows[0]).toMatchObject({
      started_from: "fork",
      parent_ref: {
        kind: "team",
        skillId: saved.skill.id,
        semver: "0.1.0",
        hash: rows[0]?.content_hash,
      },
    });
    expect(await filesOf(author, fork.json.draft.id)).toEqual(["SKILL.md", "kobe.skill.yaml"]);
    // The team's audit names the version copied (review N3).
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'skill.draft.created'
          AND target ->> 'draftId' = $2`,
      [team, fork.json.draft.id],
    );
    expect(audit.rows[0]?.target).toMatchObject({
      startedFrom: "fork",
      parent: { kind: "team", skillId: saved.skill.id, semver: "0.1.0" },
    });
    // The team's content stays the team's: no personal save of it (the KOBE-320 contract).
    const personal = await saveAs(author, fork.json.draft.id, "personal", "0.1.0");
    expect([personal.status, personal.json.code]).toEqual([409, "team_content"]);
  });

  it("edits an existing skill: fork under its own name, change it, save its next version", async () => {
    const saved = await upload(
      builder,
      "team",
      zip("edited-skill", { "kobe.skill.yaml": MANIFEST("edited-skill", "0.1.0") }),
    );
    const fork = (
      await builder.post("/v1/skills/drafts/fork", {
        source: { kind: "team", skillId: saved.skill.id },
      })
    ).json.draft;
    const rev = (await builder.get(`/v1/skills/drafts/${fork.id}`)).json.draft.rev as number;
    const put = await builder.request(
      "PUT",
      `/v1/skills/drafts/${fork.id}/files/SKILL.md`,
      text(skillMd("edited-skill", "Be briefer.")),
      ifMatch(rev),
    );
    expect(put.status).toBe(200);
    const bump = await builder.get(`/v1/skills/drafts/${fork.id}/bump?destination=team`);
    expect(bump.json).toMatchObject({
      latest: { semver: "0.1.0" },
      kind: "minor",
      suggested: "0.2.0",
    });
    // The copied manifest says 0.1.0; the save writes the number chosen into it.
    const next = await saveAs(builder, fork.id, "team", "0.2.0");
    expect(next.status, JSON.stringify(next.json)).toBe(201);
    expect(next.json).toMatchObject({
      skill: { id: saved.skill.id },
      version: { semver: "0.2.0" },
    });
  });

  it("forks the caller's own personal version (savable as personal) and renames on request", async () => {
    const mine = await upload(author, "personal", zip("my-own"));
    const fork = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "personal", skillId: mine.skill.id, version: 1 },
      name: "my-own-copy",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    expect(fork.json.draft).toMatchObject({
      name: "my-own-copy",
      parentRef: { kind: "personal", ownerUserId: authorId },
    });
    const md = await author.get(`/v1/skills/drafts/${fork.json.draft.id}/files/SKILL.md`);
    expect(md.text).toContain("name: my-own-copy");
    const saved = await saveAs(author, fork.json.draft.id, "personal", "0.1.0");
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    // Someone else's personal skill is not there to copy.
    const other = await builder.post("/v1/skills/drafts/fork", {
      source: { kind: "personal", skillId: mine.skill.id },
    });
    expect(other.status).toBe(404);
  });

  it("copies an installed catalog version; a catalog skill the team hasn't installed is not found", async () => {
    await seedKobeSkills({
      db: h.deps.database.db,
      blobs: h.deps.blobs as NonNullable<typeof h.deps.blobs>,
      log: silent,
    });
    const { rows } = await h.admin.query<{
      skill_id: string;
      version_id: string;
      runtime_hash: string;
      semver: string;
      name: string;
    }>(
      `SELECT s.id AS skill_id, v.id AS version_id, v.runtime_hash, v.semver, s.name
         FROM registry_skills s JOIN registry_versions v ON v.skill_id = s.id
        WHERE s.name IN ('skill-creator', 'charts') ORDER BY s.name, v.seq DESC`,
    );
    const creator = rows.find((r) => r.name === "skill-creator");
    const charts = rows.find((r) => r.name === "charts");
    if (!creator || !charts) throw new Error("Kobe skills not seeded");
    await h.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
       VALUES ($1, $2, $3, 'pinned', 'available', $4)`,
      [team, creator.skill_id, creator.version_id, authorId],
    );
    const fork = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "catalog", skillId: creator.skill_id },
      name: "my-skill-creator",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    expect(fork.json.draft.parentRef).toEqual({
      kind: "catalog",
      skillId: creator.skill_id,
      semver: creator.semver,
      hash: creator.runtime_hash,
    });
    expect(await filesOf(author, fork.json.draft.id)).toContain("scripts/init_skill.py");
    const absent = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "catalog", skillId: charts.skill_id },
    });
    expect(absent.status).toBe(404);
    // A catalog fork may become the author's personal skill (the catalog is already Site-wide).
    expect((await saveAs(author, fork.json.draft.id, "personal", "0.1.0")).status).toBe(201);
  });
});

/** Seeds a synced workspace file of `userId` in the team, as a sandbox push would leave it. */
async function seedWorkspace(userId: string, path: string, content: string, inTeam = team) {
  const data = Buffer.from(content);
  const owner = { teamId: inTeam, userId };
  const hash = createHash("sha256").update(data).digest("hex");
  const key = workspaceBlobKey("", owner, hash);
  workspaceObjects.objects.set(key, data);
  await withTeam(h.deps.database.db, inTeam, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256: hash, size: data.length, blobKey: key }, "user"),
  );
}

describe("from a conversation: Save to Workbench (ac-1, ac-2)", () => {
  it("syncs /workspace/skills/<name>/ through upload validation and records the conversation", async () => {
    const thread = await author.post("/v1/threads", { title: "Monthly close" });
    expect(thread.status, JSON.stringify(thread.json)).toBe(201);
    const threadId = thread.json.thread_id as string;
    await seedWorkspace(authorId, "skills/close-helper/SKILL.md", skillMd("close-helper"));
    await seedWorkspace(authorId, "skills/close-helper/references/steps.md", "Steps.");
    await seedWorkspace(authorId, "skills/close-helper-tests/eval-1/out.md", "Not part of it.");
    const first = await author.post("/v1/skills/drafts/from-workspace", {
      threadId,
      folder: "close-helper",
    });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.draft).toMatchObject({
      name: "close-helper",
      startedFrom: "thread",
      fromConversation: true,
    });
    expect(await filesOf(author, first.json.draft.id)).toEqual(["SKILL.md", "references/steps.md"]);
    const { rows } = await h.admin.query<{ from_thread_id: string }>(
      `SELECT from_thread_id FROM skill_drafts WHERE id = $1`,
      [first.json.draft.id],
    );
    expect(rows[0]?.from_thread_id).toBe(threadId);
    const audit = await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'skill.draft.created' AND target ->> 'draftId' = $1`,
      [first.json.draft.id],
    );
    expect(audit.rows[0]?.target).toMatchObject({ startedFrom: "thread", fromThreadId: threadId });
    // Saving again from the same conversation updates that draft.
    await seedWorkspace(authorId, "skills/close-helper/references/more.md", "More.");
    const again = await author.post("/v1/skills/drafts/from-workspace", {
      threadId,
      folder: "close-helper",
    });
    expect([again.status, again.json.created, again.json.draft.id]).toEqual([
      200,
      false,
      first.json.draft.id,
    ]);
    expect(await filesOf(author, first.json.draft.id)).toEqual([
      "SKILL.md",
      "references/more.md",
      "references/steps.md",
    ]);
    // A personal save of it asks first (SK11).
    const personal = await saveAs(author, first.json.draft.id, "personal", "0.1.0");
    expect([personal.status, personal.json.code]).toEqual([409, "confirm_personal_required"]);
  });

  it("refuses what an upload refuses, an empty folder, and a conversation the caller can't read", async () => {
    const threadId = (await author.post("/v1/threads", { title: "Other" })).json
      .thread_id as string;
    await seedWorkspace(authorId, "skills/no-frontmatter/SKILL.md", "Just text.");
    const bad = await author.post("/v1/skills/drafts/from-workspace", {
      threadId,
      folder: "no-frontmatter",
    });
    expect([bad.status, bad.json.code]).toEqual([400, "invalid_skill_md"]);
    const empty = await author.post("/v1/skills/drafts/from-workspace", {
      threadId,
      folder: "nothing-here",
    });
    expect([empty.status, empty.json.code]).toEqual([404, "folder_empty"]);
    // The builder can't read the author's private conversation.
    const builderThread = await builder.post("/v1/skills/drafts/from-workspace", {
      threadId,
      folder: "no-frontmatter",
    });
    expect(builderThread.status).toBe(404);
    expect(
      (
        await author.post("/v1/skills/drafts/from-workspace", {
          threadId: randomUUID(),
          folder: "close-helper",
        })
      ).status,
    ).toBe(404);
    expect(
      (await author.post("/v1/skills/drafts/from-workspace", { threadId, folder: "../x" })).status,
    ).toBe(400);
  });
});

/** Runs `fn` with the author's active team set to the other team, then back. */
async function inOtherTeam<T>(fn: () => Promise<T>): Promise<T> {
  expect((await author.put("/v1/me/teams/active", { teamId: otherTeam })).status).toBe(200);
  author.team = otherTeam;
  try {
    return await fn();
  } finally {
    expect((await author.put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
    author.team = team;
  }
}

describe("teams are walls (review S3)", () => {
  it("forks nothing of another team: its skill, its catalog install, its versions", async () => {
    await seedKobeSkills({
      db: h.deps.database.db,
      blobs: h.deps.blobs as NonNullable<typeof h.deps.blobs>,
      log: silent,
    });
    const other = await inOtherTeam(() => upload(author, "team", zip("other-team-skill")));
    const local = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "team", skillId: other.skill.id, version: 1 },
    });
    expect(local.status).toBe(404);
    const { rows } = await h.admin.query<{ skill_id: string; version_id: string }>(
      `SELECT s.id AS skill_id, v.id AS version_id FROM registry_skills s
         JOIN registry_versions v ON v.skill_id = s.id
        WHERE s.name = 'charts' ORDER BY v.seq DESC LIMIT 1`,
    );
    const charts = rows[0];
    if (!charts) throw new Error("Kobe skills not seeded");
    await h.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
       VALUES ($1, $2, $3, 'pinned', 'available', $4) ON CONFLICT DO NOTHING`,
      [otherTeam, charts.skill_id, charts.version_id, authorId],
    );
    const catalog = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "catalog", skillId: charts.skill_id },
    });
    expect(catalog.status).toBe(404);
  });

  it("copies only published catalog versions: submitted, withdrawn or revoked ones are not found", async () => {
    await seedKobeSkills({
      db: h.deps.database.db,
      blobs: h.deps.blobs as NonNullable<typeof h.deps.blobs>,
      log: silent,
    });
    const { rows } = await h.admin.query<{ id: string; skill_id: string }>(
      `SELECT v.id, v.skill_id FROM registry_skills s JOIN registry_versions v ON v.skill_id = s.id
        WHERE s.name = 'skill-creator' ORDER BY v.seq DESC LIMIT 1`,
    );
    const latest = rows[0];
    if (!latest) throw new Error("Kobe skills not seeded");
    await h.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
       VALUES ($1, $2, $3, 'pinned', 'available', $4) ON CONFLICT DO NOTHING`,
      [team, latest.skill_id, latest.id, authorId],
    );
    const states = ["submitted", "withdrawn", "revoked"] as const;
    for (const [i, state] of states.entries()) {
      await h.admin.query(
        `INSERT INTO registry_versions (skill_id, publisher, semver, seq, runtime_hash, package_hash,
           runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, state,
           source, scan, verdict, approved_at)
         SELECT skill_id, publisher, $2, seq + 100 + $3, runtime_hash, package_hash,
           runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance,
           $4::registry_version_state, source, scan, verdict,
           CASE WHEN $4 = 'submitted' THEN NULL ELSE now() END
           FROM registry_versions WHERE id = $1`,
        [latest.id, `9.9.${i}`, i, state],
      );
      const fork = await author.post("/v1/skills/drafts/fork", {
        source: { kind: "catalog", skillId: latest.skill_id, semver: `9.9.${i}` },
      });
      expect([state, fork.status]).toEqual([state, 404]);
    }
  });

  it("copies no catalog skill that is archived or that this team blocked (review N4)", async () => {
    await seedKobeSkills({
      db: h.deps.database.db,
      blobs: h.deps.blobs as NonNullable<typeof h.deps.blobs>,
      log: silent,
    });
    const { rows } = await h.admin.query<{ id: string; skill_id: string; status: string }>(
      `SELECT v.id, v.skill_id, s.status FROM registry_skills s
         JOIN registry_versions v ON v.skill_id = s.id
        WHERE s.name = 'skill-creator' AND v.state = 'approved' ORDER BY v.seq DESC LIMIT 1`,
    );
    const creator = rows[0];
    if (!creator) throw new Error("Kobe skills not seeded");
    await h.admin.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, installed_by)
       VALUES ($1, $2, $3, 'pinned', 'available', $4) ON CONFLICT DO NOTHING`,
      [team, creator.skill_id, creator.id, authorId],
    );
    await h.admin.query(`DELETE FROM rate_limits WHERE key = $1`, [
      `kobe:skill-upload:${authorId}`,
    ]);
    const fork = () =>
      author.post("/v1/skills/drafts/fork", {
        source: { kind: "catalog", skillId: creator.skill_id },
        name: "creator-copy",
      });
    const block = (inTeam: string) =>
      h.admin.query(
        `INSERT INTO team_skill_blocks (team_id, skill_id, blocked_by) VALUES ($1, $2, $3)`,
        [inTeam, creator.skill_id, authorId],
      );
    const unblock = () =>
      h.admin.query(`DELETE FROM team_skill_blocks WHERE skill_id = $1`, [creator.skill_id]);
    try {
      await h.admin.query(`UPDATE registry_skills SET status = 'archived' WHERE id = $1`, [
        creator.skill_id,
      ]);
      expect((await fork()).status).toBe(404);
      await h.admin.query(`UPDATE registry_skills SET status = $2 WHERE id = $1`, [
        creator.skill_id,
        creator.status,
      ]);
      await block(otherTeam);
      const elsewhere = await fork();
      expect(elsewhere.status, JSON.stringify(elsewhere.json)).toBe(201);
      await block(team);
      expect((await fork()).status).toBe(404);
    } finally {
      await unblock();
      await h.admin.query(`UPDATE registry_skills SET status = $2 WHERE id = $1`, [
        creator.skill_id,
        creator.status,
      ]);
    }
  });

  it("saves nothing from another team's conversation or the caller's workspace there", async () => {
    const otherThread = await inOtherTeam(async () => {
      const res = await author.post("/v1/threads", { title: "Elsewhere" });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      return res.json.thread_id as string;
    });
    await seedWorkspace(authorId, "skills/walled/SKILL.md", skillMd("walled"), otherTeam);
    const theirs = await author.post("/v1/skills/drafts/from-workspace", {
      threadId: otherThread,
      folder: "walled",
    });
    expect(theirs.status).toBe(404);
    const ownThread = (await author.post("/v1/threads", { title: "Here" })).json
      .thread_id as string;
    const mine = await author.post("/v1/skills/drafts/from-workspace", {
      threadId: ownThread,
      folder: "walled",
    });
    expect([mine.status, mine.json.code]).toEqual([404, "folder_empty"]);
  });
});

describe("start rates (review S2)", () => {
  it("charges a fork to the upload rate, as the other heavy starts are", async () => {
    const mine = await upload(builder, "personal", zip("rated-fork"));
    const key = `kobe:skill-upload:${builderId}`;
    const count = async () =>
      (
        await h.admin.query<{ count: number }>(`SELECT count FROM rate_limits WHERE key = $1`, [
          key,
        ])
      ).rows[0]?.count ?? 0;
    const before = await count();
    const fork = await builder.post("/v1/skills/drafts/fork", {
      source: { kind: "personal", skillId: mine.skill.id },
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    expect(await count()).toBe(before + 1);
    await h.admin.query(`UPDATE rate_limits SET count = 1000 WHERE key = $1`, [key]);
    const refused = await builder.post("/v1/skills/drafts/fork", {
      source: { kind: "personal", skillId: mine.skill.id },
    });
    expect([refused.status, refused.json.code]).toEqual([429, "rate_limited"]);
    await h.admin.query(`DELETE FROM rate_limits WHERE key = $1`, [key]);
  });
});

describe("personal saves of the team's skills (review S4)", () => {
  // The file's earlier starts used up most of the shared upload rate.
  beforeEach(async () => {
    await h.admin.query(`DELETE FROM rate_limits WHERE key = ANY($1)`, [
      [authorId, builderId].map((id) => `kobe:skill-upload:${id}`),
    ]);
  });
  const confirmed = async (id: string) => {
    const rev = (await author.get(`/v1/skills/drafts/${id}`)).json.draft.rev as number;
    return author.request(
      "POST",
      `/v1/skills/drafts/${id}/versions`,
      { destination: "personal", semver: "0.1.0", changelog: "Mine.", confirmPersonal: true },
      ifMatch(rev),
    );
  };
  const uploadDraft = async (body: RawBody) => {
    const res = await author.request("POST", "/v1/skills/drafts/upload?kind=zip", body);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.draft.id as string;
  };

  it("refuses a verbatim copy of a team version, uploaded or saved from a conversation", async () => {
    const files = { "references/how.md": "How the team does it." };
    await upload(builder, "team", zip("verbatim-team", files));
    const uploaded = await uploadDraft(zip("verbatim-team", files));
    const viaUpload = await confirmed(uploaded);
    expect([viaUpload.status, viaUpload.json.code]).toEqual([409, "team_content"]);
    expect(viaUpload.json.message).toContain("holds a Finance skill");
    expect(viaUpload.json.message).not.toContain("forked");

    const threadId = (await author.post("/v1/threads", { title: "Copy" })).json.thread_id as string;
    await seedWorkspace(authorId, "skills/verbatim-team/SKILL.md", skillMd("verbatim-team"));
    await seedWorkspace(
      authorId,
      "skills/verbatim-team/references/how.md",
      files["references/how.md"],
    );
    const saved = await author.post("/v1/skills/drafts/from-workspace", {
      threadId,
      folder: "verbatim-team",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
    const viaWorkspace = await confirmed(saved.json.draft.id as string);
    expect([viaWorkspace.status, viaWorkspace.json.code]).toEqual([409, "team_content"]);
  });

  it("matches any version of the team's skill, not only the latest", async () => {
    await upload(
      builder,
      "team",
      zip("older-team", { "kobe.skill.yaml": MANIFEST("older-team", "0.1.0") }),
    );
    await upload(
      builder,
      "team",
      zip("older-team", {
        "kobe.skill.yaml": MANIFEST("older-team", "0.2.0"),
        "references/new.md": "New.",
      }),
    );
    const res = await confirmed(await uploadDraft(zip("older-team")));
    expect([res.status, res.json.code]).toEqual([409, "team_content"]);
  });

  it("lets an edited copy through (accepted limit) and never looks at another team's skills", async () => {
    await upload(builder, "team", zip("edited-copy"));
    const edited = await confirmed(
      await uploadDraft(zip("edited-copy", { "references/extra.md": "One more line." })),
    );
    expect(edited.status, JSON.stringify(edited.json)).toBe(201);
    await inOtherTeam(() => upload(author, "team", zip("elsewhere-skill")));
    const elsewhere = await confirmed(await uploadDraft(zip("elsewhere-skill")));
    expect(elsewhere.status, JSON.stringify(elsewhere.json)).toBe(201);
  });
});
