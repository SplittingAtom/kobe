import { createHash, randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'starts', 'Finance'), ($2, 'starts-2', 'Other')`,
    [team, otherTeam],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'builder'), ($4, $2, 'member')`,
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
    const notInstalled = await author.post("/v1/skills/drafts/fork", {
      source: { kind: "catalog", skillId: charts.skill_id },
    });
    expect(notInstalled.status).toBe(404);
    // A catalog fork may become the author's personal skill (the catalog is already Site-wide).
    expect((await saveAs(author, fork.json.draft.id, "personal", "0.1.0")).status).toBe(201);
  });
});

/** Seeds a synced workspace file of `userId` in the team, as a sandbox push would leave it. */
async function seedWorkspace(userId: string, path: string, content: string) {
  const data = Buffer.from(content);
  const owner = { teamId: team, userId };
  const hash = createHash("sha256").update(data).digest("hex");
  const key = workspaceBlobKey("", owner, hash);
  workspaceObjects.objects.set(key, data);
  await withTeam(h.deps.database.db, team, (tx) =>
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
